import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantAnalysisRequest, AssistantCircuitDeviceInput } from "shared";
import { prepareAssistantSnapshot } from "./assistantSnapshot.js";
import { analyseFullGraphWithLlm } from "./llmGraphAnalysis.js";

function mos(uuid: string, instanceName: string, d: number, g: number, s: number, b: number): AssistantCircuitDeviceInput {
  return {
    uuid, instanceName, kind: "mos", modelName: "pmos",
    geometry: { W_um: 10, L_um: 1, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "pmos" },
    terminals: [{ name: "D", netId: d }, { name: "G", netId: g }, { name: "S", netId: s }, { name: "B", netId: b }],
  };
}

function bjt(uuid: string, instanceName: string, c: number, b: number, e: number): AssistantCircuitDeviceInput {
  return {
    uuid, instanceName, kind: "bjt_npn", modelName: "npn",
    geometry: { AE_um2: 1, PE_um: 8, multiplier: 1, totalAE_um2: 1, emitterFingers: 1, bjtType: "npn" },
    terminals: [{ name: "C", netId: c }, { name: "B", netId: b }, { name: "E", netId: e }],
  };
}

function request(): AssistantAnalysisRequest {
  return {
    expectedRev: 7,
    scope: "die",
    circuit: {
      devices: [
        mos("mref", "MREF", 11, 11, 1, 1),
        mos("mout", "MOUT", 41, 11, 1, 1),
        bjt("qa", "QA", 51, 61, 0),
        bjt("qb", "QB", 52, 62, 0),
      ],
      namedNets: [
        { id: 0, name: "GND" }, { id: 1, name: "VDD" }, { id: 11, name: "NREF" }, { id: 41, name: "OUT" },
        { id: 51, name: "NCA" }, { id: 52, name: "NCB" }, { id: 61, name: "INA" }, { id: 62, name: "INB" },
      ],
      warnings: ["MOUT: terminal B was auto-connected to VDD", "QA: extracted polarity needs review"],
    },
    brief: { chipName: "LM2937", chipDescription: "BJT LDO", prompt: "Find bandgap, Widlar current sources, error amplifier and protection blocks." },
    requestLlmExplanation: true,
  };
}

test("LLM-only preparation produces no hard-coded functional findings", () => {
  const result = prepareAssistantSnapshot("die-a", 7, request());
  assert.equal(result.readOnly, true);
  assert.equal(result.annotationsRev, 7);
  assert.equal(result.devicesAnalyzed, 4);
  assert.deepEqual(result.findings, []);
  assert.ok(result.diagnostics.some((item) => item.includes("No hard-coded functional-block findings")));
});

test("LLM-first analysis keeps every parsed hypothesis", async () => {
  const before = {
    apiKey: process.env.ASSISTANT_LLM_API_KEY,
    baseUrl: process.env.ASSISTANT_LLM_BASE_URL,
    model: process.env.ASSISTANT_LLM_MODEL,
  };
  const originalFetch = globalThis.fetch;
  process.env.ASSISTANT_LLM_API_KEY = "test-key";
  process.env.ASSISTANT_LLM_BASE_URL = "https://example.invalid/v1";
  process.env.ASSISTANT_LLM_MODEL = "test-model";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "**Наблюдение.** MREF/MOUT образуют связный фрагмент около NREF; он может относиться к bias или current-source network.\n\n```json\n{\"summary\":\"Тестовый обзор\",\"hypotheses\":[{\"label\":\"Локальная bias/current-source ветвь\",\"deviceInstances\":[\"MREF\",\"MOUT\"],\"netNames\":[\"NREF\"],\"reasoning\":\"Устройства соединены через NREF, который не является глобальной шиной.\",\"missingEvidence\":\"Нужны токовый путь и operating point.\",\"nextChecks\":[\"Открыть Net Graph\"],\"confidence\":\"medium\"},{\"label\":\"Ложная пара через землю\",\"deviceInstances\":[\"QA\",\"QB\"],\"netNames\":[\"GND\"],\"reasoning\":\"У обоих эмиттер на земле.\",\"missingEvidence\":\"Нет локального узла.\",\"nextChecks\":[],\"confidence\":\"high\"}]}\n```" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    const input = request();
    input.mode = "netlist_problems";
    const result = await analyseFullGraphWithLlm(prepareAssistantSnapshot("die-a", 7, input), input.circuit);
    assert.equal(result.llm.used, true);
    assert.match(result.llm.narrative ?? "", /Наблюдение/);
    assert.equal(result.llm.hypothesesShown, 2);
    assert.equal(result.findings.length, 2);
    assert.equal(result.findings[0]?.origin, "llm");
    assert.equal(result.findings[0]?.kind, "netlist_problem");
    assert.deepEqual(result.findings[0]?.instanceNames, ["MREF", "MOUT"]);
    assert.deepEqual(result.findings[1]?.instanceNames, ["QA", "QB"]);
    assert.equal(result.findings[1]?.status, "needs_verification");
    assert.ok(!result.diagnostics.some((note) => note.includes("not shown") || note.includes("rejected")));
  } finally {
    globalThis.fetch = originalFetch;
    if (before.apiKey == null) delete process.env.ASSISTANT_LLM_API_KEY; else process.env.ASSISTANT_LLM_API_KEY = before.apiKey;
    if (before.baseUrl == null) delete process.env.ASSISTANT_LLM_BASE_URL; else process.env.ASSISTANT_LLM_BASE_URL = before.baseUrl;
    if (before.model == null) delete process.env.ASSISTANT_LLM_MODEL; else process.env.ASSISTANT_LLM_MODEL = before.model;
  }
});

test("LLM-only preparation rejects oversized snapshots before an external call", () => {
  const input = request();
  input.circuit.devices = Array.from({ length: 10_001 }, (_, index) => mos(`m${index}`, `M${index}`, 10, 11, 1, 1));
  assert.throws(() => prepareAssistantSnapshot("die-big", 1, input), /exceeds/);
});
