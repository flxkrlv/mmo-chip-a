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
  assert.equal(
    path.basename(exported.body.file),
    "bandgap.rnl",
  );

  const loaded = await request(app).get(
    "/api/dies/die-1/rnl?moduleName=bandgap",
  );
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.text, exported.body.text);

  const saved = await request(app)
    .put("/api/dies/die-1/rnl")
    .send({ moduleName: "bandgap", text: "* edited\n" });
  assert.equal(saved.status, 200);
  const reread = await request(app).get(
    "/api/dies/die-1/rnl?moduleName=bandgap",
  );
  assert.equal(reread.body.text, "* edited\n");

  const missing = await request(app).get(
    "/api/dies/die-1/rnl?moduleName=absent",
  );
  assert.equal(missing.status, 404);
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
