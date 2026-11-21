import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import express from "express";
import request from "supertest";
import { resolveAnalogCanvasPaths } from "../analogCanvas.js";
import { createRnlRouter } from "./rnl.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

async function createRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function appWith(options: Parameters<typeof createRnlRouter>[0]) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(createRnlRouter(options));
  return app;
}

/** A stand-in for the analog-canvas MCP: echoes the request as RNL. */
async function fakeMcp(root: string): Promise<string> {
  const file = path.join(root, "fake-analog-canvas-mcp.mjs");
  await fs.writeFile(
    file,
    `import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
const netlist = {
  documentId: "main",
  format: request.format,
  rnl: true,
  status: "ready",
  text: '* @RNL(type="header") { @VERSION("0.4") }\\n* ' +
    JSON.stringify(request) + "\\n",
  diagnostics: [],
};
process.stdout.write(JSON.stringify({
  content: [{ type: "text", text: JSON.stringify({
    apiVersion: "3.0",
    requestId: "fake",
    operation: "read-netlist",
    ok: true,
    structureRevision: 1,
    netlist,
    cells: [],
  }) }],
}));
`,
    "utf8",
  );
  return file;
}

test("exports RNL through the analog-canvas MCP and stores it", async () => {
  const root = await createRoot("mmo-rnl-");
  const mcpPath = await fakeMcp(root);
  const app = appWith({
    dataRoot: root,
    mcpPath,
    headlessPath: path.join(root, "headless.mjs"),
  });

  const exported = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project: { schemaVersion: 58 }, moduleName: "bandgap" });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.ok, true);
  assert.equal(exported.body.format, "spice");
  assert.match(exported.body.text, /@RNL\(type="header"\)/);
  assert.match(exported.body.text, /"rnl":true/);
  assert.equal(path.basename(exported.body.file), "bandgap.rnl");
  assert.equal(exported.body.revision.author, "schematic");
  assert.equal(exported.body.state.edited, false);
  assert.equal(exported.body.state.baselineRevisionId, exported.body.revision.id);

  const loaded = await request(app).get(
    "/api/dies/die-1/rnl?moduleName=bandgap",
  );
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.text, exported.body.text);
  assert.equal(loaded.body.state.latestRevisionId, exported.body.revision.id);

  const saved = await request(app)
    .put("/api/dies/die-1/rnl")
    .send({ moduleName: "bandgap", text: "* edited\n", note: "hand edit" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision.author, "user");
  assert.equal(saved.body.revision.note, "hand edit");
  assert.equal(saved.body.state.edited, true);
  const reread = await request(app).get(
    "/api/dies/die-1/rnl?moduleName=bandgap",
  );
  assert.equal(reread.body.text, "* edited\n");

  const history = await request(app).get(
    "/api/dies/die-1/rnl/history?moduleName=bandgap",
  );
  assert.equal(history.status, 200);
  assert.equal(history.body.revisions.length, 2);
  assert.equal(history.body.revisions[0].id, saved.body.revision.id);
  assert.equal(history.body.revisions[1].id, exported.body.revision.id);

  const detail = await request(app).get(
    `/api/dies/die-1/rnl/history/${saved.body.revision.id}?moduleName=bandgap`,
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.text, "* edited\n");
  assert.equal(detail.body.diff.removed, 2);
  assert.equal(detail.body.diff.added, 1);

  const restored = await request(app)
    .post(`/api/dies/die-1/rnl/history/${exported.body.revision.id}/restore`)
    .send({ moduleName: "bandgap" });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.text, exported.body.text);
  assert.equal(restored.body.revision.author, "user");
  assert.equal(restored.body.revision.restores, exported.body.revision.id);

  const missing = await request(app).get(
    "/api/dies/die-1/rnl?moduleName=absent",
  );
  assert.equal(missing.status, 404);
});

test("refuses to overwrite an edited drawing or a pinned snapshot", async () => {
  const root = await createRoot("mmo-rnl-");
  const mcpPath = await fakeMcp(root);
  const app = appWith({
    dataRoot: root,
    mcpPath,
    headlessPath: path.join(root, "headless.mjs"),
  });
  const project = { schemaVersion: 58 };

  const first = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project, moduleName: "bandgap", sourceHash: "circuit-1" });
  assert.equal(first.status, 200);

  await request(app)
    .put("/api/dies/die-1/rnl")
    .send({ moduleName: "bandgap", text: "* agent drawing\n" });

  const blocked = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project, moduleName: "bandgap" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "agent-edits");
  assert.equal(blocked.body.state.edited, true);

  const overwritten = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({
      project,
      moduleName: "bandgap",
      confirmOverwrite: true,
      sourceHash: "circuit-1",
    });
  assert.equal(overwritten.status, 200);
  assert.equal(overwritten.body.state.edited, false);
  assert.equal(overwritten.body.state.sourceHash, "circuit-1");

  const history = await request(app).get(
    "/api/dies/die-1/rnl/history?moduleName=bandgap",
  );
  assert.equal(history.body.revisions.length, 3);
  assert.equal(history.body.revisions[1].author, "user");

  const pinned = await request(app)
    .put("/api/dies/die-1/rnl/state")
    .send({ moduleName: "bandgap", frozen: true });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.state.frozen, true);

  const frozen = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project, moduleName: "bandgap", confirmOverwrite: true });
  assert.equal(frozen.status, 409);
  assert.equal(frozen.body.code, "frozen");

  await request(app)
    .put("/api/dies/die-1/rnl/state")
    .send({ moduleName: "bandgap", frozen: false });
  const afterUnpin = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project, moduleName: "bandgap" });
  assert.equal(afterUnpin.status, 200);
});

test("asks before replacing a drawing that predates the history", async () => {
  const root = await createRoot("mmo-rnl-");
  const mcpPath = await fakeMcp(root);
  const app = appWith({
    dataRoot: root,
    mcpPath,
    headlessPath: path.join(root, "headless.mjs"),
  });
  const dir = path.join(root, "dies", "die-1", "rnl");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "bandgap.rnl"), "* old drawing\n", "utf8");

  const loaded = await request(app).get(
    "/api/dies/die-1/rnl?moduleName=bandgap",
  );
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.state.revisionCount, 0);
  assert.equal(loaded.body.state.edited, true);

  const blocked = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project: {}, moduleName: "bandgap" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "agent-edits");

  const confirmed = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project: {}, moduleName: "bandgap", confirmOverwrite: true });
  assert.equal(confirmed.status, 200);
  const history = await request(app).get(
    "/api/dies/die-1/rnl/history?moduleName=bandgap",
  );
  assert.equal(history.body.revisions.length, 2);
  assert.equal(history.body.revisions[1].author, "saved");
  assert.match(history.body.revisions[1].note, /adopted/);
});

test("reports the resolved paths before a drawing attempt", async () => {
  const root = await createRoot("mmo-rnl-");
  const mcpPath = await fakeMcp(root);
  const headlessPath = path.join(root, "headless.mjs");
  const app = appWith({ dataRoot: root, mcpPath, headlessPath });
  const response = await request(app).get("/api/rnl/status");
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.mcpPath, mcpPath);
  assert.equal(response.body.headlessPath, headlessPath);
});

test("answers 503 with setup instructions when the writer is not configured", async () => {
  const root = await createRoot("mmo-rnl-");
  const app = appWith({
    dataRoot: root,
    mcpPath: "",
    headlessPath: "",
    discover: false,
  });
  const response = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project: {} });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /CHIPTOOL_ANALOG_CANVAS_MCP/);
});

test("ignores a placeholder env path and finds the checkout by its home", async () => {
  const root = await createRoot("mmo-rnl-home-");
  const checkout = path.join(root, "analog-canvas");
  const mcp = path.join(checkout, "apps", "mcp-server", "dist", "main.js");
  const headless = path.join(
    checkout,
    "output",
    "headless",
    "analog-canvas-headless.mjs",
  );
  await fs.mkdir(path.dirname(mcp), { recursive: true });
  await fs.mkdir(path.dirname(headless), { recursive: true });
  await fs.writeFile(mcp, "");
  await fs.writeFile(headless, "");

  const saved = {
    home: process.env.CHIPTOOL_ANALOG_CANVAS_HOME,
    mcp: process.env.CHIPTOOL_ANALOG_CANVAS_MCP,
    headless: process.env.CHIPTOOL_ANALOG_CANVAS_HEADLESS,
  };
  process.env.CHIPTOOL_ANALOG_CANVAS_HOME = checkout;
  process.env.CHIPTOOL_ANALOG_CANVAS_MCP = "F:\\...\\missing\\main.js";
  process.env.CHIPTOOL_ANALOG_CANVAS_HEADLESS = "F:\\...\\missing\\headless.mjs";
  try {
    const paths = resolveAnalogCanvasPaths();
    assert.equal(paths.mcpPath, mcp);
    assert.equal(paths.headlessPath, headless);
    assert.equal(paths.home, path.resolve(checkout));
    assert.equal(paths.ignored.length, 2);
  } finally {
    for (const [key, value] of [
      ["CHIPTOOL_ANALOG_CANVAS_HOME", saved.home],
      ["CHIPTOOL_ANALOG_CANVAS_MCP", saved.mcp],
      ["CHIPTOOL_ANALOG_CANVAS_HEADLESS", saved.headless],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("refuses a failed CLI run without saving a file", async () => {
  const root = await createRoot("mmo-rnl-");
  const failing = path.join(root, "fail.mjs");
  await fs.writeFile(failing, "process.exit(3);\n", "utf8");
  const app = appWith({
    dataRoot: root,
    mcpPath: failing,
    headlessPath: path.join(root, "headless.mjs"),
  });
  const response = await request(app)
    .post("/api/dies/die-1/rnl/export")
    .send({ project: {} });
  assert.equal(response.status, 502);
  await assert.rejects(
    fs.readFile(path.join(root, "dies", "die-1", "rnl", "schematic.rnl")),
  );
});
