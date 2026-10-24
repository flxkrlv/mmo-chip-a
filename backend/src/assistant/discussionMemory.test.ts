import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantChatMessage } from "shared";
import { buildHistoryTurns, MAX_HISTORY_TURNS, toHistoryTurn } from "./llmGraphAnalysis.js";

/**
 * The discussion memory: what the model sees of the past turns.
 *
 * The browser stores what the USER saw — a tool result lives in a separate
 * payload and a failed turn is not stored at all. Replaying the raw content
 * would hand the model a blank assistant message: it would not know what its
 * tool returned, nor that the previous attempt died. These tests pin that
 * translation down.
 */

test("a tool result becomes the assistant's own words", () => {
  const message: AssistantChatMessage = {
    role: "assistant",
    content: "",
    digest: "SPICE run: Operating Point — 86 variables, 1 point | measures: vout=0.21",
  };
  assert.deepEqual(toHistoryTurn(message), {
    role: "assistant",
    content: "SPICE run: Operating Point — 86 variables, 1 point | measures: vout=0.21",
  });
});

test("a failed turn becomes a note the model must react to", () => {
  const message: AssistantChatMessage = {
    role: "assistant",
    content: "",
    failed: {
      reason: "The model produced no answer.",
      hint: "Answer briefly, do not call tools in a loop.",
    },
  };
  const turn = toHistoryTurn(message);
  assert.ok(turn);
  assert.equal(turn.role, "user");
  assert.match(turn.content, /previous attempt failed/);
  assert.match(turn.content, /The model produced no answer\./);
  assert.match(turn.content, /Answer briefly/);
});

test("a turn with nothing to say is dropped", () => {
  // An empty assistant message is invalid for some providers — it must never
  // reach the provider.
  assert.equal(toHistoryTurn({ role: "assistant", content: "" }), null);
  assert.equal(toHistoryTurn({ role: "assistant", content: "   " }), null);
});

test("a normal turn is passed through", () => {
  assert.deepEqual(toHistoryTurn({ role: "user", content: "что это за блок?" }), {
    role: "user",
    content: "что это за блок?",
  });
});

test("the history is bounded, the failures are summarised in the prompt", () => {
  const messages: AssistantChatMessage[] = [];
  for (let i = 0; i < MAX_HISTORY_TURNS + 10; i++) {
    messages.push({ role: "user", content: `вопрос ${i}` });
  }
  const turns = buildHistoryTurns(messages);
  assert.equal(turns.length, MAX_HISTORY_TURNS);
  // The oldest turns fall off — the ledger in the system prompt keeps the
  // failures visible even when they do.
  assert.equal(turns[0].content, "вопрос 10");
  assert.equal(turns[turns.length - 1].content, `вопрос ${MAX_HISTORY_TURNS + 9}`);
});
