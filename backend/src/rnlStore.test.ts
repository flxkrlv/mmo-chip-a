import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import {
  diffRnlLines,
  normalizeRnlText,
  readRnlStatus,
  restoreRnlRevision,
  setRnlFrozen,
  writeRnl,
} from "./rnlStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mmo-rnl-store-"));
  tempRoots.push(root);
  return root;
}

const wrapped = [
  ".subckt amp VIN VOUT",
  "R1 VIN VOUT 1000",
  '* @RNL(author="analog-canvas") {',
  "*   #R1 @SET-SYMBOL $RESISTOR => @PLACE(2, 2) => @ORIENT(\"R0\");",
  "*   #R1",
  '*       @TEXT("\\textbf{\\textit{R1}}", key="name", dx=1, dy=3, bold=false,',
  "*       textvisible=true);",
  "*   %port1 @TEXT(",
  '*   "${p}", key="netname", textvisible=false);',
  "* }",
  ".ends amp",
  "",
].join("\n");

test("normalizeRnlText joins wrapped RNL records", () => {
  const text = normalizeRnlText(wrapped);
  assert.ok(
    text.includes(
      '*   #R1 @TEXT("\\textbf{\\textit{R1}}", key="name", dx=1, dy=3, bold=false, textvisible=true);',
    ),
  );
  assert.ok(
    text.includes('*   %port1 @TEXT("${p}", key="netname", textvisible=false);'),
  );
  assert.equal(text.split("\n").filter((line) => line.includes("@TEXT(")).length, 2);
  assert.ok(text.endsWith(".ends amp\n"));
});

test("normalizeRnlText closes the last record of a block", () => {
  const text = normalizeRnlText(
    ['.subckt amp A B', '* @RNL(author="x") {', '*   %p @TEXT("${p}", textvisible=false)', "* }", ".ends amp"].join("\n"),
  );
  assert.ok(text.includes('*   %p @TEXT("${p}", textvisible=false);'));
});

test("normalizeRnlText leaves the netlist and plain comments alone", () => {
  const netlist = [
    ".subckt amp A B",
    "+ C",
    "* a plain comment without records;",
    "R1 A B 10",
    '* @RNL(type="header") {',
    '*   @VERSION("0.4");',
    "* }",
    ".ends amp",
  ].join("\r\n");
  assert.equal(normalizeRnlText(netlist), netlist);
});

test("normalizeRnlText is idempotent", () => {
  const once = normalizeRnlText(wrapped);
  assert.equal(normalizeRnlText(once), once);
});

test("diffRnlLines counts the changed lines", () => {
  const diff = diffRnlLines("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(
    diff.lines.map((line) => `${line.type}:${line.text}`),
    ["context:a", "remove:b", "add:B", "context:c", "context:"],
  );
});

test("a schematic export is the baseline and an agent edit is a version", async () => {
  const root = await createRoot();
  const first = await writeRnl(root, "die-1", "bandgap", "R1 a b 1\n", {
    author: "schematic",
    format: "spice",
    sourceHash: "hash-1",
    forceRevision: true,
  });
  assert.ok(first.revision);
  assert.equal(first.revision.author, "schematic");
  assert.equal(first.state.baselineRevisionId, first.revision.id);
  assert.equal(first.state.latestRevisionId, first.revision.id);
  assert.equal(first.state.edited, false);
  assert.equal(first.state.sourceHash, "hash-1");
  assert.ok(first.state.exportedAt);

  const second = await writeRnl(root, "die-1", "bandgap", "R1 a b 2\n", {
    author: "agent",
    note: "raised R1",
  });
  assert.ok(second.revision);
  assert.equal(second.revision.author, "agent");
  assert.equal(second.revision.note, "raised R1");
  assert.equal(second.revision.added, 1);
  assert.equal(second.revision.removed, 1);
  assert.equal(second.state.edited, true);
  assert.equal(second.state.baselineRevisionId, first.revision.id);
  assert.equal(second.state.latestAuthor, "agent");

  const status = await readRnlStatus(root, "die-1", "bandgap");
  assert.equal(status.exists, true);
  assert.equal(status.revisions.length, 2);
  assert.equal(status.revisions[0].id, second.revision.id, "newest first");
  assert.equal(status.revisions[1].id, first.revision.id);
});

test("an existing RNL file is adopted so the first overwrite is recoverable", async () => {
  const root = await createRoot();
  const dir = path.join(root, "dies", "die-1", "rnl");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "bandgap.rnl"), "R1 a b 1\n", "utf8");

  const before = await readRnlStatus(root, "die-1", "bandgap");
  assert.equal(before.revisions.length, 0);
  assert.equal(before.state.edited, true, "no history means it may be edited");
  assert.equal(before.state.frozen, false);

  const edit = await writeRnl(root, "die-1", "bandgap", "R1 a b 2\n", {
    author: "agent",
  });
  const status = await readRnlStatus(root, "die-1", "bandgap");
  assert.equal(status.revisions.length, 2);
  const adopted = status.revisions[1];
  assert.equal(adopted.author, "saved");
  assert.equal(status.state.baselineRevisionId, adopted.id);
  assert.equal(edit.state.edited, true);

  const restored = await restoreRnlRevision(root, "die-1", "bandgap", adopted.id);
  assert.ok(restored);
  assert.equal(restored.text, "R1 a b 1\n");
  assert.equal(restored.revision?.author, "user");
  assert.equal(restored.revision?.restores, adopted.id);
  assert.equal(restored.state.latestAuthor, "user");
});

test("restoring the schematic baseline clears the edited flag", async () => {
  const root = await createRoot();
  const baseline = await writeRnl(root, "die-1", "bandgap", "R1 a b 1\n", {
    author: "schematic",
    forceRevision: true,
  });
  await writeRnl(root, "die-1", "bandgap", "R1 a b 2\n", { author: "agent" });
  const restored = await restoreRnlRevision(
    root,
    "die-1",
    "bandgap",
    baseline.revision!.id,
  );
  assert.ok(restored);
  assert.equal(restored.text, "R1 a b 1\n");
  assert.equal(restored.state.edited, false, "the text equals the baseline");
  const status = await readRnlStatus(root, "die-1", "bandgap");
  assert.equal(status.state.edited, false);
});

test("the frozen flag persists and survives the next read", async () => {
  const root = await createRoot();
  await writeRnl(root, "die-1", "bandgap", "R1 a b 1\n", {
    author: "schematic",
    forceRevision: true,
  });
  const state = await setRnlFrozen(root, "die-1", "bandgap", true);
  assert.equal(state.frozen, true);
  const status = await readRnlStatus(root, "die-1", "bandgap");
  assert.equal(status.state.frozen, true);
  assert.equal((await setRnlFrozen(root, "die-1", "bandgap", false)).frozen, false);
});

test("an identical write does not add a version", async () => {
  const root = await createRoot();
  const first = await writeRnl(root, "die-1", "bandgap", "R1 a b 1\n", {
    author: "agent",
  });
  const again = await writeRnl(root, "die-1", "bandgap", "R1 a b 1\n", {
    author: "agent",
  });
  assert.equal(again.revision, null);
  assert.equal(again.state.latestRevisionId, first.revision?.id);
  const status = await readRnlStatus(root, "die-1", "bandgap");
  assert.equal(status.revisions.length, 1);
});
