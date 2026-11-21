import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRnlText } from "./rnlStore.js";

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
