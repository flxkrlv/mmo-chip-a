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
  /**
   * IDLE timeout for the stream: the request is aborted only when the provider
   * stops sending chunks for this long. While the model keeps streaming tokens
   * (content or reasoning_content) the timer keeps resetting, so a long reasoning
   * model is never cut off mid-thought. Does NOT cap total elapsed time.
   */
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

/**
 * Decides whether an upstream failure should be retried: HTTP 429, gateway
 * connection drops ("terminated", "fetch failed"), network/TLS errors. Client
 * aborts (idle timeout, caller cancellation) are NOT retried — the model was
 * cut off mid-thought, so a fresh attempt would likely face the same silence.
 */
function isRetryableStreamError(err: unknown): boolean {
  if (isClientAbortError(err)) return false;
  if (err instanceof LlmRateLimitError) return true;
  if (err instanceof Error) {
    const msg = `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`.toLowerCase();
    if (/fetch failed|terminated|econnreset|econnrefused|socket|timeout|network|tls|stream/i.test(msg)) return true;
  }
  return false;
}

/** Calls {@link streamChatCompletion}, retrying with backoff on retryable failures
 *  (429 rate limits, transient network/gateway drops). Client aborts are rethrown. */
export async function streamWithRetries(req: LlmStreamRequest): Promise<LlmStreamResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await streamChatCompletion(req);
    } catch (err) {
      if (!isRetryableStreamError(err) || attempt >= MAX_RETRIES) throw err;
      lastError = err;
      const waitMs = err instanceof LlmRateLimitError && err.retryAfterMs
        ? err.retryAfterMs
        : RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[llm-stream] retry ${attempt + 1}/${MAX_RETRIES} after ${err instanceof Error ? err.message : String(err)} (wait ${Math.min(waitMs, 30_000)}ms)`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)));
    }
  }
  throw lastError;
}

function splitSseLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines, rest };
}

// Shared with callers: distinguishes a provider/network failure (retryable)
// from a client-side abort (idle timeout or caller cancellation) which must not
// be retried — the model was cut, not the network.
export function isClientAbortError(err: unknown): boolean {
  return err instanceof Error && (/abort/i.test(err.message) || /canceled|aborted/i.test(err.name));
}

export async function streamChatCompletion(req: LlmStreamRequest): Promise<LlmStreamResult> {
  const { baseUrl, apiKey, model, messages, maxTokens, timeoutMs, extra, onDelta } = req;
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | null = null;
  // idle semantics: aborts only when no chunks arrive within timeoutMs.
  const armIdleTimer = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  };
  armIdleTimer();
  const clearIdleTimer = () => {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  };
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages, stream: true, ...extra }),
    });
  } catch (err) {
    clearIdleTimer();
    throw err;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    clearIdleTimer();
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
    clearIdleTimer();
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
    clearIdleTimer();
    throw new Error("LLM stream returned no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCalls: LlmStreamToolCall[] = [];
  let finishReason: string | null = null;
  let chunkCount = 0;
  const streamStart = Date.now();
  // Only actual token data (content/reasoning/tool_calls/[DONE]) re-arms the
  // idle timer. SSE comments / blank / keepalive lines must NOT, otherwise a
  // gateway that keeps the socket alive but never delivers tokens would reset
  // the idle timer forever and the stream would hang silently.
  let lastSignalAt = Date.now();
  let silenceLogHandle: NodeJS.Timeout | null = null;
  const SILENCE_LOG_MS = 15_000;
  const SEND_DATA_MS = 3_000;

  try {
    // Periodically log "still waiting but no tokens arrived" so an operator can
    // tell a reasoning model that is quietly thinking from a dead upstream.
    silenceLogHandle = setInterval(() => {
      const silent = Date.now() - lastSignalAt;
      if (silent >= SILENCE_LOG_MS) {
        console.warn(
          `[llm-stream] waiting… silent=${(silent / 1000).toFixed(0)}s after ${Date.now() - streamStart}ms total (chunks=${chunkCount}, content=${content.length} chars, reasoning=${reasoning.length} chars, toolCalls=${toolCalls.length})`,
        );
      }
    }, SEND_DATA_MS);

    while (true) {
      let value: Uint8Array;
      try {
        const read = await reader.read();
        if (read.done) break;
        value = read.value;
      } catch (err) {
        // Network/cancel error mid-stream. Log what we already received so the
        // operator can tell a server-side drop (lots of chunks, then silence)
        // from a provider that never streamed at all.
        console.warn(
          `[llm-stream] lost mid-stream after ${Date.now() - streamStart}ms (chunks=${chunkCount}, content=${content.length} chars, reasoning=${reasoning.length} chars, toolCalls=${toolCalls.length}): ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      chunkCount += 1;
      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = splitSseLines(buffer);
      buffer = rest;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finishReason = finishReason ?? "stop";
          lastSignalAt = Date.now();
          armIdleTimer();
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
        if (emitted.content || emitted.reasoning) {
          // Real token data — restart the idle countdown and note liveness.
          lastSignalAt = Date.now();
          armIdleTimer();
          onDelta?.(emitted);
        }
      }
    }
  } finally {
    clearIdleTimer();
    if (silenceLogHandle) { clearInterval(silenceLogHandle); silenceLogHandle = null; }
  }

  return { content, reasoning, toolCalls, finishReason };
}