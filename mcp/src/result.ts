import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BackendError } from "./client.js";

/** Bad arguments the caller can fix: shown as an error, not as data. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(reason: string | object): CallToolResult {
  const text = typeof reason === "string" ? reason : JSON.stringify(reason, null, 2);
  return { content: [{ type: "text", text }], isError: true };
}

export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return fail(describeError(error));
  }
}

export function describeError(error: unknown): string {
  if (error instanceof BackendError || error instanceof InputError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function requireFields(
  action: string,
  args: Record<string, unknown>,
  fields: readonly string[]
): void {
  const missing = fields.filter((field) => args[field] === undefined || args[field] === "");
  if (missing.length > 0) {
    throw new InputError(`${action} requires: ${missing.join(", ")}`);
  }
}

export function idOf(prefix: string): string {
  const stamp = Date.now().toString(36);
  const salt = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, "0");
  return `mcp-${prefix}-${stamp}-${salt}`;
}

export function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

export function truncate(text: string | undefined, max: number): string | undefined {
  if (text === undefined || text.length <= max) return text;
  const head = Math.ceil(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n... [${text.length - max} chars omitted] ...\n${text.slice(text.length - tail)}`;
}
