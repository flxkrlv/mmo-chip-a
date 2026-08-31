/**
 * Streaming client for OpenAI-compatible /chat/completions.
 *
 * Sends `stream: true` and parses the Server-Sent Events response, emitting
 * content / reasoning (thinking) deltas as they arrive. Falls back to a plain
 * non-streaming read when the provider ignores `stream: true` and returns a
 * regular JSON body. Rate-limit (429) responses are surfaced as
 * {@link LlmRateLimitError} so callers can retry with backoff.
 */

export interface LlmStreamDelta {
  content?: string;
  reasoning?: string;
}

export interface LlmStreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmStreamResult {
  content: string;
  reasoning: string;
  toolCalls: LlmStreamToolCall[];
  finishReason: string | null;
}

export interface LlmStreamRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: unknown[];
  maxTokens: number;
  timeoutMs: number;
  /** Extra body fields, e.g. tools/tool_choice/response_format. */
  extra?: Record<string, unknown>;
  /** Called for each content/reasoning delta (excludes tool-call accumulation). */
  onDelta?: (delta: LlmStreamDelta) => void;
}

export class LlmRateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "LlmRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

function splitSseLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines, rest };
}

export async function streamChatCompletion(req: LlmStreamRequest): Promise<LlmStreamResult> {
  const { baseUrl, apiKey, model, messages, maxTokens, timeoutMs, extra, onDelta } = req;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages, stream: true, ...extra }),
    });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    clearTimeout(timeout);
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
      throw new LlmRateLimitError(`LLM HTTP 429${text ? `: ${text.slice(0, 200)}` : ""}`, retryAfterMs);
    }
    throw new Error(`LLM HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  // Provider ignored stream:true and returned a plain JSON body — read it whole.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const raw = await response.text();
    clearTimeout(timeout);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const message = ((body.choices as Array<{ message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments?: string } }> } }> | undefined)?.[0]?.message) ?? {};
    const result: LlmStreamResult = {
      content: typeof message.content === "string" ? message.content : "",
      reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
      toolCalls: (message.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments ?? "{}",
      })),
      finishReason: null,
    };
    if (result.content) onDelta?.({ content: result.content });
    if (result.reasoning) onDelta?.({ reasoning: result.reasoning });
    return result;
  }

  if (!response.body) {
    clearTimeout(timeout);
    throw new Error("LLM stream returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCalls: LlmStreamToolCall[] = [];
  let finishReason: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = splitSseLines(buffer);
      buffer = rest;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finishReason = finishReason ?? "stop";
          break;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = (parsed as { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> }).choices?.[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        const emitted: LlmStreamDelta = {};
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          emitted.content = delta.content;
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          emitted.reasoning = delta.reasoning_content;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
            const idx = tc.index ?? 0;
            const entry = toolCalls[idx] ?? { id: "", name: "", arguments: "" };
            if (tc.id) entry.id += tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            toolCalls[idx] = entry;
          }
        }
        if (emitted.content || emitted.reasoning) onDelta?.(emitted);
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return { content, reasoning, toolCalls, finishReason };
}

/** Calls {@link streamChatCompletion}, retrying with backoff on HTTP 429. */
export async function streamWithRetries(req: LlmStreamRequest): Promise<LlmStreamResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await streamChatCompletion(req);
    } catch (err) {
      if (!(err instanceof LlmRateLimitError) || attempt >= MAX_RETRIES) throw err;
      lastError = err;
      const waitMs = err.retryAfterMs ?? RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)));
    }
  }
  throw lastError;
}