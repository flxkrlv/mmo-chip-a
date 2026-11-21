import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { EXTENDED_TOOLS } from "./mcpExtended.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const tool = (name: string) => {
  const found = EXTENDED_TOOLS.find((item) => item.name === name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

test("the agent reads and writes the RNL file the tab uses", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mmo-mcp-rnl-"));
  roots.push(dataRoot);
  const context = { dataRoot, dieId: "die-1", clientName: null };

  const saved = await tool("rnl_write").run(context, {
    moduleName: "bandgap",
    text: '* @RNL(type="header") {}\n',
    note: "first drawing",
  });
  assert.equal(saved.isError, undefined);
  const savedBody = JSON.parse(saved.content[0]?.text ?? "{}");
  assert.equal(savedBody.revision.author, "agent");
  assert.equal(savedBody.revision.note, "first drawing");

  const read = await tool("rnl_read").run(context, { moduleName: "bandgap" });
  assert.equal(read.content[0]?.text, '* @RNL(type="header") {}\n');
  assert.equal(read.content[0]?.type, "text");

  const history = await tool("rnl_history").run(context, {
    moduleName: "bandgap",
  });
  const historyBody = JSON.parse(history.content[0]?.text ?? "{}");
  assert.equal(historyBody.revisions.length, 1);
  assert.equal(historyBody.revisions[0].author, "agent");
  assert.equal(historyBody.state.edited, true);

  const detail = await tool("rnl_history").run(context, {
    moduleName: "bandgap",
    revisionId: historyBody.revisions[0].id,
  });
  const detailBody = JSON.parse(detail.content[0]?.text ?? "{}");
  assert.equal(detailBody.text, '* @RNL(type="header") {}\n');

  const missing = await tool("rnl_read").run(context, {
    moduleName: "absent",
  });
  assert.equal(missing.isError, true);
});
