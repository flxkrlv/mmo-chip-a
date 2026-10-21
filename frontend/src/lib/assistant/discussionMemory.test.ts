import { describe, expect, test } from "vitest";
import type { AssistantLvsCheckResponse } from "shared";
import {
  CONTINUE_PROMPT,
  failureFromError,
  lvsResultsDigest,
  spiceRunDigest,
} from "./discussionMemory";

/**
 * The discussion memory: what the assistant carries from one turn to the next.
 *
 * A failed turn must say WHAT to change, and a tool result must be summarised
 * in a form the model can read — otherwise the next turn starts blind.
 */
describe("the discussion memory", () => {
  test("an empty answer is remembered as 'answer shorter, do not loop tools'", () => {
    const failure = failureFromError(
      "Assistant discussion failed: LLM returned empty content after 5 tool iteration(s)",
    );
    expect(failure.reason).toMatch(/no answer/i);
    expect(failure.hint).toMatch(/briefly/i);
    expect(failure.hint).toMatch(/clarifying question/i);
  });

  test("a rate limit is not the model's fault", () => {
    const failure = failureFromError("Assistant discussion failed: LLM HTTP 429");
    expect(failure.hint).toMatch(/not the model's fault/i);
  });

  test("an unknown error still carries an actionable hint", () => {
    const failure = failureFromError("something exploded");
    expect(failure.reason).toBe("something exploded");
    expect(failure.hint.length).toBeGreaterThan(10);
  });

  test("a SPICE run is summarised for the model", () => {
    const digest = spiceRunDigest({
      ok: true,
      summary: "Operating Point — 86 variables, 1 point",
      netlist: "* netlist",
      measurements: { vout: 0.21 },
      at: 1,
    });
    expect(digest).toContain("Operating Point");
    expect(digest).toContain("vout=0.21");
  });

  test("a failed SPICE run carries its error", () => {
    const digest = spiceRunDigest({
      ok: false,
      summary: "failed",
      netlist: "* netlist",
      error: "singular matrix",
      at: 1,
    });
    expect(digest).toContain("singular matrix");
  });

  test("the LVS check is summarised for the model", () => {
    const data: AssistantLvsCheckResponse["data"] = {
      candidateSignature: { Q1: 1 },
      checkedCount: 12,
      matches: [],
      best: {
        cellId: "bandgap",
        topology: "bandgap_reference",
        matched: false,
        distance: 1,
        engine: "vyges-lvs",
        report: "",
        extraDevices: ["Q3"],
        missingDevices: ["R5"],
      },
    };
    const digest = lvsResultsDigest([data]);
    expect(digest).toContain("12 candidate(s) compared");
    expect(digest).toContain("bandgap");
    expect(digest).toContain("extra: Q3");
    expect(digest).toContain("missing: R5");
  });

  test("the continue prompt tells the model not to repeat itself", () => {
    expect(CONTINUE_PROMPT).toMatch(/не повторяй/i);
  });
});
