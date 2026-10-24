import type { McpConfig } from "./config.js";

/** A backend call that failed: non-2xx status, unparseable body, or unreachable. */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export interface RawResponse {
  data: Buffer;
  contentType: string;
  filename?: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const JSON_TYPE = "application/json";

export class BackendClient {
  constructor(
    private readonly config: McpConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 120_000
  ) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  private url(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${this.config.baseUrl}${path}`;
  }

  private async send(
    path: string,
    init: RequestInit,
    timeoutMs?: number
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init.body === undefined ? {} : { "Content-Type": JSON_TYPE }),
      ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
      ...(init.headers as Record<string, string> | undefined)
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs)
      });
    } catch (error) {
      throw new BackendError(
        0,
        `Backend unreachable at ${this.config.baseUrl}: ${describeCause(error)}`
      );
    }
    if (response.ok) return response;
    throw await toBackendError(response);
  }

  async getJson<T>(path: string, timeoutMs?: number): Promise<T> {
    const response = await this.send(path, { method: "GET" }, timeoutMs);
    return await readJson<T>(response);
  }

  async postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const response = await this.send(
      path,
      { method: "POST", body: JSON.stringify(body ?? {}) },
      timeoutMs
    );
    return await readJson<T>(response);
  }

  async putJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const response = await this.send(
      path,
      { method: "PUT", body: JSON.stringify(body ?? {}) },
      timeoutMs
    );
    return await readJson<T>(response);
  }

  async deleteJson<T>(path: string, timeoutMs?: number): Promise<T> {
    const response = await this.send(path, { method: "DELETE" }, timeoutMs);
    return await readJson<T>(response);
  }

  async getRaw(path: string, timeoutMs?: number): Promise<RawResponse> {
    const response = await this.send(path, { method: "GET" }, timeoutMs);
    return await readRaw(response);
  }

  async postRaw(path: string, body: unknown, timeoutMs?: number): Promise<RawResponse> {
    const response = await this.send(
      path,
      { method: "POST", body: JSON.stringify(body ?? {}) },
      timeoutMs
    );
    return await readRaw(response);
  }
}

async function readRaw(response: Response): Promise<RawResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    const payload = await response.json().catch(() => ({}));
    throw new BackendError(
      response.status,
      (payload as { error?: string }).error ?? "Backend returned JSON instead of a file",
      payload
    );
  }
  return {
    data: Buffer.from(await response.arrayBuffer()),
    contentType,
    filename: response.headers.get("x-filename") ?? undefined
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BackendError(
      response.status,
      `Backend returned a non-JSON body (${response.status} ${response.headers.get("content-type") ?? ""}): ${text.slice(0, 200)}`,
      text
    );
  }
}

async function toBackendError(response: Response): Promise<BackendError> {
  const text = await response.text().catch(() => "");
  const statusLine = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmed) as { error?: string; message?: string };
      const detail = payload.error ?? payload.message;
      return new BackendError(
        response.status,
        detail ? `${statusLine}: ${detail}` : statusLine,
        payload
      );
    } catch {
      return new BackendError(response.status, `${statusLine}: ${trimmed.slice(0, 300)}`, text);
    }
  }
  return new BackendError(
    response.status,
    trimmed ? `${statusLine}: ${trimmed.slice(0, 300)}` : statusLine,
    text
  );
}

function describeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeMessage =
    cause instanceof Error && cause.message ? ` (${cause.message})` : "";
  return `${message}${causeMessage}`;
}
