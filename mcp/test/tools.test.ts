import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DieAnnotations, DieSummary } from "shared";
import {
  connect,
  isErrorResult,
  jsonResult,
  jsonResponse,
  recordingFetch,
  testConfig
} from "./helpers.js";

const EXPECTED_TOOLS = [
  "cell_detection",
  "edit_cells",
  "edit_comments",
  "edit_floorplans",
  "edit_nets",
  "edit_pins",
  "edit_rulers",
  "export_project",
  "get_analog_devices",
  "get_annotations",
  "get_crop",
  "get_metal_stack",
  "get_project",
  "get_spice_config",
  "list_projects",
  "ml_job",
  "run_lvs",
  "run_ngspice",
  "set_scale"
].sort();

const tmpRoot = path.join(os.tmpdir(), `mmo-mcp-test-${process.pid}`);

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function config() {
  return testConfig({
    cropsDir: path.join(tmpRoot, "crops"),
    exportDir: path.join(tmpRoot, "exports")
  });
}

const DIE: DieSummary = {
  id: "die-1",
  name: "demo chip",
  originalFilename: "demo.png",
  width: 1200,
  height: 900,
  tileSize: 256,
  maxZoomLevel: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  tileProgress: { total: 10, done: 4 } as unknown as DieSummary["tileProgress"],
  cellScale: 10
};

const ANNOTATIONS: DieAnnotations = {
  version: 2,
  rev: 11,
  umPerPx: 0.002,
  nets: [{ id: "n1", name: "VCC", nodes: [{ id: "a", x: 1, y: 1 }], edges: [] }],
  cellTypes: [{ id: "ct1", name: "inv", cropRect: { x: 0, y: 0, width: 40, height: 20 } }],
  cells: [{ id: "c1", cellTypeId: "ct1", x: 100, y: 50, rotation: 90 }],
  grids: []
};

test("registers exactly the v0 tool set", async () => {
  const { impl } = recordingFetch(() => jsonResponse([]));
  const session = await connect(config(), impl);
  try {
    assert.deepEqual(await session.list(), EXPECTED_TOOLS);
    assert.equal(session.tools.length, EXPECTED_TOOLS.length);
  } finally {
    await session.close();
  }
});

test("list_projects strips build noise and keeps identity fields", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse([DIE]));
  const session = await connect(config(), impl);
  try {
    const rows = jsonResult<Array<Record<string, unknown>>>(await session.call("list_projects"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "die-1");
    assert.equal(rows[0].cellScale, 10);
    assert.equal(rows[0].location, "managed");
    assert.equal(rows[0].tileProgress, undefined);
    assert.equal(requests[0].url, "http://mmo.test:3001/api/dies");
  } finally {
    await session.close();
  }
});

test("get_annotations summary returns counts, rev and per-kind rows", async () => {
  const { impl } = recordingFetch((url) =>
    url.endsWith("/annotations") ? jsonResponse(ANNOTATIONS) : jsonResponse(DIE)
  );
  const session = await connect(config(), impl);
  try {
    const summary = jsonResult<Record<string, any>>(await session.call("get_annotations", { dieId: "die-1" }));
    assert.equal(summary.rev, 11);
    assert.equal(summary.umPerPx, 0.002);
    assert.equal(summary.counts.cells, 1);
    assert.equal(summary.counts.nets, 1);
    const cells = summary.cells as Array<Record<string, unknown>>;
    assert.equal(cells[0].id, "c1");
    assert.deepEqual(cells[0].rect, { x: 110, y: 40, width: 20, height: 40 });
    assert.equal(summary.truncated, undefined);
  } finally {
    await session.close();
  }
});

test("get_annotations full mode requires kinds and returns raw rows only", async () => {
  const { impl } = recordingFetch((url) =>
    url.endsWith("/annotations") ? jsonResponse(ANNOTATIONS) : jsonResponse(DIE)
  );
  const session = await connect(config(), impl);
  try {
    const missing = await session.call("get_annotations", { dieId: "die-1", mode: "full" });
    assert.equal(isErrorResult(missing), true);
    assert.match(JSON.stringify(missing), /kinds is required/);

    const picked = jsonResult<Record<string, unknown>>(
      await session.call("get_annotations", { dieId: "die-1", mode: "full", kinds: ["cells"] })
    );
    assert.equal(Array.isArray(picked.cells), true);
    assert.equal(picked.nets, undefined);
    assert.equal(picked.rev, 11);

    const unknownKind = await session.call("get_annotations", { dieId: "die-1", kinds: ["bogus"] });
    assert.equal(isErrorResult(unknownKind), true);
    assert.match(JSON.stringify(unknownKind), /Unknown kind/);
  } finally {
    await session.close();
  }
});

test("schema violations surface as error results, not protocol faults", async () => {
  const { impl } = recordingFetch(() => jsonResponse([]));
  const session = await connect(config(), impl);
  try {
    const result = await session.call("get_annotations", {});
    assert.equal(isErrorResult(result), true);
  } finally {
    await session.close();
  }
});

test("a backend 404 comes back as a readable error result", async () => {
  const { impl } = recordingFetch(() => jsonResponse({ error: "Not found" }, 404));
  const session = await connect(config(), impl);
  try {
    const result = await session.call("get_project", { dieId: "gone" });
    assert.equal(isErrorResult(result), true);
    assert.match(JSON.stringify(result), /HTTP 404: Not found/);
  } finally {
    await session.close();
  }
});

test("edit_nets validates per-action arguments before touching the backend", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({ ok: true, rev: 12 }));
  const session = await connect(config(), impl);
  try {
    const missing = await session.call("edit_nets", { dieId: "die-1", action: "delete_net" });
    assert.equal(isErrorResult(missing), true);
    assert.match(JSON.stringify(missing), /delete_net requires: netId/);
    assert.equal(requests.length, 0);

    const created = jsonResult<{ netId: string; rev: number }>(
      await session.call("edit_nets", { dieId: "die-1", action: "upsert_net", name: "VSS" })
    );
    assert.match(created.netId, /^mcp-net-/);
    assert.equal(created.rev, 12);
    const put = requests.find((r) => r.method === "PUT");
    assert.ok(put);
    assert.match(put.url, /\/api\/dies\/die-1\/nets\//);
    const body = JSON.parse(put.body ?? "{}");
    assert.equal(body.name, "VSS");
    assert.deepEqual(body.nodes, []);
    assert.deepEqual(body.edges, []);
  } finally {
    await session.close();
  }
});

test("edit_nets upsert_edge refuses endpoints that are not nodes of the net", async () => {
  const { impl, requests } = recordingFetch((url) =>
    url.endsWith("/annotations") ? jsonResponse(ANNOTATIONS) : jsonResponse({ ok: true, rev: 12 })
  );
  const session = await connect(config(), impl);
  try {
    const result = await session.call("edit_nets", {
      dieId: "die-1",
      action: "upsert_edge",
      netId: "n1",
      edgeId: "e1",
      from: "a",
      to: "ghost"
    });
    assert.equal(isErrorResult(result), true);
    assert.match(JSON.stringify(result), /are not nodes of net/);
    assert.equal(requests.filter((r) => r.method === "PUT").length, 0);
  } finally {
    await session.close();
  }
});

test("edit_comments stamps the MCP agent as author", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({ ok: true, rev: 13 }));
  const session = await connect(config(), impl);
  try {
    await session.call("edit_comments", {
      dieId: "die-1",
      action: "add",
      x: 12,
      y: 34,
      text: "pad 3 looks shifted"
    });
    const put = requests.find((r) => r.method === "PUT");
    assert.ok(put);
    assert.match(put.url, /\/api\/dies\/die-1\/comments\//);
    const body = JSON.parse(put.body ?? "{}");
    assert.equal(body.authorId, "mcp");
    assert.equal(body.authorName, "test-agent");
    assert.equal(body.text, "pad 3 looks shifted");
    assert.deepEqual(body.replies, []);
    assert.match(body.id, /^mcp-cmt-/);
  } finally {
    await session.close();
  }
});

test("edit_cells rejects a new cell whose type is unknown here", async () => {
  const { impl, requests } = recordingFetch((url) =>
    url.endsWith("/annotations") ? jsonResponse(ANNOTATIONS) : jsonResponse({ ok: true, rev: 14 })
  );
  const session = await connect(config(), impl);
  try {
    const bad = await session.call("edit_cells", {
      dieId: "die-1",
      action: "upsert",
      cellTypeId: "nope",
      x: 1,
      y: 2
    });
    assert.equal(isErrorResult(bad), true);
    assert.match(JSON.stringify(bad), /not defined on this die/);
    assert.equal(requests.filter((r) => r.method === "PUT").length, 0);

    const moved = jsonResult<{ rev: number }>(
      await session.call("edit_cells", { dieId: "die-1", action: "upsert", cellId: "c1", x: 500 })
    );
    assert.equal(moved.rev, 14);
    const put = requests.find((r) => r.method === "PUT");
    assert.ok(put);
    const body = JSON.parse(put.body ?? "{}");
    assert.equal(body.x, 500);
    assert.equal(body.y, 50);
    assert.equal(body.cellTypeId, "ct1");
    assert.equal(body.rotation, 90);
  } finally {
    await session.close();
  }
});

test("get_crop writes the image to disk and reports its path", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const { impl, requests } = recordingFetch(
    () =>
      new Response(jpeg, {
        status: 200,
        headers: { "content-type": "image/jpeg" }
      })
  );
  const session = await connect(config(), impl);
  try {
    const payload = jsonResult<{ path: string; bytes: number; rect: { width: number } }>(
      await session.call("get_crop", { dieId: "die-1", x: 10, y: 20, w: 64, h: 32 })
    );
    assert.equal(payload.bytes, 4);
    assert.deepEqual(payload.rect, { x: 10, y: 20, width: 64, height: 32 });
    assert.match(payload.path, /crop_die-1_10_20_64x32\.jpg$/);
    assert.deepEqual([...(await fs.readFile(payload.path))], [...jpeg]);
    assert.match(requests[0].url, /\/api\/dies\/die-1\/crop\?x=10&y=20&w=64&h=32$/);
  } finally {
    await session.close();
  }
});

test("get_crop refuses ambiguous or incomplete targets", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({}));
  const session = await connect(config(), impl);
  try {
    const nothing = await session.call("get_crop", { dieId: "die-1" });
    assert.equal(isErrorResult(nothing), true);
    assert.match(JSON.stringify(nothing), /exactly one target/);

    const partial = await session.call("get_crop", { dieId: "die-1", x: 1, y: 2 });
    assert.equal(isErrorResult(partial), true);
    assert.match(JSON.stringify(partial), /get_crop rect requires: w, h/);

    const both = await session.call("get_crop", { dieId: "die-1", cellId: "c1", w: 8, h: 8, x: 0, y: 0 });
    assert.equal(isErrorResult(both), true);
    assert.equal(requests.length, 0);
  } finally {
    await session.close();
  }
});

test("run_ngspice demands a deck and strips waveform arrays by default", async () => {
  const { impl, requests } = recordingFetch((url) =>
    url.endsWith("/api/ngspice/run")
      ? jsonResponse({
          ok: true,
          success: true,
          variables: ["v(out)"],
          numPoints: 3,
          measurements: { "max": 1.2 },
          notes: ["added .op"],
          output: "ngspice output line",
          simulatedNetlist: "* deck",
          rawData: "huge raw payload",
          varTypes: ["frequency"],
          dataColumns: { "v(out)": [1, 2, 3] }
        })
      : jsonResponse({})
  );
  const session = await connect(config(), impl);
  try {
    const noDeck = await session.call("run_ngspice", {});
    assert.equal(isErrorResult(noDeck), true);
    assert.match(JSON.stringify(noDeck), /Provide netlist, or subcircuit \+ directives/);
    assert.equal(requests.length, 0);

    const ok = jsonResult<Record<string, unknown>>(
      await session.call("run_ngspice", { netlist: "* test\nV1 in 0 1\nR1 in 0 1k\n.end" })
    );
    assert.equal(ok.success, true);
    assert.deepEqual(ok.measurements, { max: 1.2 });
    assert.equal(ok.rawData, undefined);
    assert.equal(ok.simulatedNetlist, "* deck");
    const body = JSON.parse(requests[0].body ?? "{}");
    assert.equal(body.netlist.startsWith("* test"), true);
    assert.equal(body.includeRawData, undefined);
  } finally {
    await session.close();
  }
});

test("run_lvs surfaces engine failures as error results", async () => {
  const { impl } = recordingFetch(() =>
    jsonResponse({
      ok: false,
      error: "vyges-lvs CLI not found",
      detail: "Install vyges-lvs via cargo install ..."
    })
  );
  const session = await connect(config(), impl);
  try {
    const failed = await session.call("run_lvs", {
      dieId: "die-1",
      layoutNetlist: "X1 a b d",
      schematicNetlist: "X1 a b d"
    });
    assert.equal(isErrorResult(failed), true);
    const text = JSON.stringify(failed);
    assert.match(text, /vyges-lvs CLI not found/);
    assert.match(text, /cargo install/);
  } finally {
    await session.close();
  }
});

test("run_lvs returns the comparison report on success", async () => {
  const { impl, requests } = recordingFetch(() =>
    jsonResponse({ ok: true, data: { engine: "name-based", matched: true, report: "all good" } })
  );
  const session = await connect(config(), impl);
  try {
    const report = jsonResult<{ matched: boolean; engine: string }>(
      await session.call("run_lvs", {
        dieId: "die-1",
        layoutNetlist: "X1 a b d",
        schematicNetlist: "X1 a b d",
        engine: "name-based"
      })
    );
    assert.equal(report.matched, true);
    assert.equal(report.engine, "name-based");
    const body = JSON.parse(requests[0].body ?? "{}");
    assert.equal(body.engine, "name-based");
  } finally {
    await session.close();
  }
});

test("export_project writes the ZIP and names the file from the response", async () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const { impl, requests } = recordingFetch(
    () =>
      new Response(zip, {
        status: 200,
        headers: { "content-type": "application/zip", "x-filename": "mmochip-demo-light.zip" }
      })
  );
  const session = await connect(config(), impl);
  try {
    const payload = jsonResult<{ path: string; bytes: number; filename: string }>(
      await session.call("export_project", { dieId: "die-1", mode: "light" })
    );
    assert.equal(payload.bytes, 4);
    assert.equal(payload.filename, "mmochip-demo-light.zip");
    assert.match(payload.path, /mmochip-demo-light\.zip$/);
    assert.deepEqual([...(await fs.readFile(payload.path))], [...zip]);
    const body = JSON.parse(requests[0].body ?? "{}");
    assert.equal(body.mode, "light");
  } finally {
    await session.close();
  }
});

test("cell_detection requires cellTypeId to start and passes flags through", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({ state: "running" }));
  const session = await connect(config(), impl);
  try {
    const missing = await session.call("cell_detection", { dieId: "die-1", action: "start" });
    assert.equal(isErrorResult(missing), true);
    assert.match(JSON.stringify(missing), /start requires: cellTypeId/);

    await session.call("cell_detection", {
      dieId: "die-1",
      action: "start",
      cellTypeId: "ct1",
      avoidExistingCells: true
    });
    const post = requests.find((r) => r.method === "POST");
    assert.ok(post);
    assert.match(post.url, /\/cell-detections\/job\/start$/);
    const body = JSON.parse(post.body ?? "{}");
    assert.equal(body.cellTypeId, "ct1");
    assert.equal(body.avoidExistingCells, true);
    assert.equal(body.allowFlipX, undefined);
  } finally {
    await session.close();
  }
});

test("set_scale posts umPerPx and echoes the new value", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({ ok: true, rev: 21 }));
  const session = await connect(config(), impl);
  try {
    const result = jsonResult<{ rev: number; umPerPx: number }>(
      await session.call("set_scale", { dieId: "die-1", umPerPx: 0.0025 })
    );
    assert.equal(result.rev, 21);
    assert.equal(result.umPerPx, 0.0025);
    assert.match(requests[0].url, /\/api\/dies\/die-1\/config$/);
    assert.deepEqual(JSON.parse(requests[0].body ?? "{}"), { umPerPx: 0.0025 });
  } finally {
    await session.close();
  }
});
