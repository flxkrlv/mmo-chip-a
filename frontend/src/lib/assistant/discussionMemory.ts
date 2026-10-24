/**
 * discussionMemory.ts — what the assistant remembers between the turns of a
 * discussion about one finding card.
 *
 * The browser stores what the USER saw. The model, on the other hand, must
 * see:
 *   - what its own tools returned (otherwise it re-runs the same tool and
 *     repeats the same failure),
 *   - that the previous attempt died and why (otherwise it walks into the
 *     same wall again).
 *
 * So every failed turn is written into the thread as a `failed` record and
 * every tool result carries a text `digest` the backend replays to the model.
 */

import type {
  AssistantFailedTurn,
  AssistantLvsCheckResponse,
  AssistantSpiceRun,
} from "shared";

/** What the "Continue" button sends after a failed turn. */
export const CONTINUE_PROMPT =
  "Продолжи с того места, где остановился. Не повторяй подход, который уже не сработал: " +
  "если данных не хватает — задай уточняющий вопрос, иначе ответь коротко.";

/**
 * Turn a failed request into the record the model must react to.
 *
 * The reason says what happened; the hint says what to do differently. Without
 * the hint the model has no idea that "answer shorter" or "ask a question"
 * would have worked.
 */
export function failureFromError(message: string): AssistantFailedTurn {
  const text = message.toLowerCase();
  if (text.includes("empty content")) {
    return {
      reason: "The model produced no answer — the output budget went into reasoning instead of a reply.",
      hint: "Answer briefly, do not repeat a long reasoning pass and do not call tools in a loop; if the data is missing, ask a clarifying question.",
    };
  }
  if (text.includes("429")) {
    return {
      reason: "The provider rate-limited the request (HTTP 429).",
      hint: "This is not the model's fault — retry the same request a bit later.",
    };
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return {
      reason: "The request did not fit into the timeout.",
      hint: "Answer shorter and without tool calls.",
    };
  }
  if (text.includes("http 5")) {
    return {
      reason: "The LLM provider failed (HTTP 5xx).",
      hint: "This is not the model's fault — retry the same request.",
    };
  }
  return {
    reason: message.slice(0, 300) || "The request failed.",
    hint: "Do not repeat the same approach; if the request is ambiguous, ask a clarifying question.",
  };
}

/** The text the model must see from one SPICE run. */
export function spiceRunDigest(run: AssistantSpiceRun): string {
  const parts = [`SPICE run: ${run.summary || (run.ok ? "ok" : "failed")}`];
  if (run.error) parts.push(`error: ${run.error}`);
  const measurements = Object.entries(run.measurements ?? {}).slice(0, 8);
  if (measurements.length) {
    parts.push(`measures: ${measurements.map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
  if (run.notes?.length) parts.push(`notes: ${run.notes.join("; ")}`);
  return parts.join(" | ");
}

/** The text the model must see from the LVS reference check. */
export function lvsResultsDigest(
  results: Array<AssistantLvsCheckResponse["data"]>,
): string {
  const parts: string[] = [];
  for (const result of results) {
    const best = result.best;
    parts.push(
      `LVS check: ${result.checkedCount} candidate(s) compared` +
        (best
          ? `, best ${best.cellId} (topology ${best.topology ?? "?"}, distance ${best.distance})`
          : ", no match") +
        (best?.extraDevices?.length ? `, extra: ${best.extraDevices.join(", ")}` : "") +
        (best?.missingDevices?.length ? `, missing: ${best.missingDevices.join(", ")}` : ""),
    );
  }
  return parts.join(" | ");
}
