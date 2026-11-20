# analog-canvas bridge

Export the interactive analog schematic layout from mmo-chip-a and open it in
[analog-canvas](https://github.com/cascode-ai/analog-canvas) for manual
polishing.

The two applications are connected **only by files**. Nothing from
analog-canvas (which is AGPL-3.0-only) is copied into this MIT repository, and
mmo-chip-a has no runtime dependency on it.

```
mmo-chip-a                                   analog-canvas
┌───────────────────────────────┐            ┌──────────────────────┐
│ interactive schematic         │            │ stock editor         │
│ "Export to analog-canvas"     │──.icproj──▶│ File → Open project  │
└───────────────────────────────┘   .json    └──────────────────────┘
             │
             └── tools/analog-canvas/convert.mjs (batch / CI, same code)
```

## Open a schematic in analog-canvas

1. Open an analog schematic scope in mmo-chip-a.
2. Press **Export to analog-canvas** in the canvas toolbar (next to *Export
   PNG* / *Export SVG*). The browser downloads `<scope>.icproj.json`. If the
   export had to approximate something, a note panel appears under the
   toolbar — read it before polishing.
3. In the **stock** analog-canvas editor (desktop app or `pnpm dev` from its
   repository) choose *File → Open project* and pick that file.

No library capture or symbol import is needed, because **the project uses the
editor's own library symbols**: `resistor`, `capacitor`, `inductor`, `diode`,
`schottky-diode`, `npn`, `pnp`, `nmos`, `pmos`, `voltage-source`,
`current-source`, `ground`, `vdd-port`, `named-ground` and `port`. That is
what makes the import combine with hand-drawn parts and appear in the netlist:

- a part placed by the export is the same size, on the same grid, as the same
  part placed by hand;
- the netlist sees every device (no *"symbol has no reviewed netlist
  definition"* diagnostics);
- references (`R1`, `Q3`, …), values (`value`, `dc`) and model bindings
  (`NPN`, `PNP`, `D`, MOS `w/l/nf/m`) are written where the editor expects
  them.

> The `.icproj.json` file is the project. A neutral `.layout.json` is **not**
> openable by analog-canvas — it fails with
> `UNSUPPORTED_SCHEMA_VERSION: Project schemaVersion must be an integer`.

## What survives the round trip

The converter's contract is **netlist parity**: the device terminals and their
Net grouping are exactly those of the mmo layout. Verified against the stock
loader/extractor on real exports — including a save/reopen, which is where
schema 83 rebuilds Net membership from wires:

- every device, its reference and every terminal;
- the full Net partition: power rails, shared gates, 19-pin ground, …
- mmo pin names translated to library pin names
  (`PLUS/MINUS` → `1/2`, `+/-` → `A/K`, `C/B/E`, `D/G/S/B`);
- wire geometry re-anchored to the library pins (see below);
- reference labels bound to their instances;
- supply markers (`vcc` → `VDD`-style global Net, `gnd` → SPICE node `0`);
- io pins → Cell terminals with a `port` symbol;
- hierarchy blocks → real child Cells (`.subckt` documents) with their own
  devices, ports and wires — not dropped rectangles;
- net names preserved for the editor's net list (display hints only).

## Hierarchy

A hierarchy block is exported as what analog-canvas draws: one document per
child Cell plus a `hierarchical-symbol-…` instance in the parent, bound with
`netlist.binding = { kind: "subcircuit", childDocumentId }`. The block's pins
are the child's Cell terminals, so the SPICE netlist contains

```spice
.subckt amp VIN VOUT
R10 VIN MID 2k
R11 MID VOUT 4k
.ends amp

.subckt Hierarchy VSS VIN VOUT
XA VIN VOUT amp
.ends Hierarchy
```

Each region keeps its devices and *all* of its nets: internal nets stay inside
the child, boundary nets become Cell pins, and power markers stay global. The
child's block body and pin rows are written to `presentation.cellSymbol`
(`minimumBodySize` + `pinPlacements`), so the editor derives exactly the
geometry the parent's wires are anchored to.

The region's saved canvas layout is reused when the user has opened it before.
Otherwise the child starts on a deterministic grid (devices in rows, inputs
left, outputs right, supplies above, grounds below) and the converter links
every Net member with orthogonal wires; the drawing is complete and editable,
just not prettified. Blocks whose Cell data is missing (an old `.layout.json`
exported before this feature) still fall back to the old behaviour: the block
is reported and left out.

## RNL

Once open, analog-canvas can export the project as **RNL** (SPICE/Spectre plus
a drawing transaction). That is a second, independent interchange path: the
netlist stays authoritative while an AI agent or a person edits only the
drawing ops, and RNL-aware tools can consume the result. This repository never
implements RNL and gains no dependency on it — the `.icproj.json` export is
the only contract.

## Wires

mmo routes are followed, but they end on the *library* pins, which sit at
different offsets than mmo's own skins. Each segment stays axis-aligned and
leaves a pin along the axis that pin faces, so the drawing contains no stray
diagonals and no wire is detached from its terminal. A Net member that no
mmo route reaches is linked to a routed member, so nothing disappears when
the editor re-saves the project.

## Command line (batch conversion)

Useful for CI, scripted exports, or converting saved neutral layouts. Node.js
≥ 22.18 (the converter imports the TypeScript core directly; this repository
targets Node 24).

```bash
node tools/analog-canvas/convert.mjs path/to/<scope>.layout.json
# → path/to/<scope>.icproj.json
```

Options:

```bash
-o, --out <file>    output path (default: input path with .icproj.json)
    --name <text>   project name shown in analog-canvas
    --scale <n>     coordinate scale (default: document hint, 1)
    --grid <n>      document grid (default: document hint, 10)
    --no-routes     export topology only, without wires
```

The neutral `mmo.schematic-layout` v1 document is the intermediate contract
between the canvas and this converter. It contains:

| field | meaning |
| --- | --- |
| `symbols` | symbol geometry per skin template: box size, pins (mmo terminal names, local offsets, facing), primitives |
| `instances` | one per placed device, power rail, io pin and hierarchy block: `kind`, symbol id, origin, rotation, mirror, device value/model/parameters |
| `nets` | logical nets with every `{instance, pin}` member |
| `routes` | mmo wire geometry that could be expressed as a terminal-to-terminal path, with interior bend points |
| `cells` | optional child Cells of hierarchy blocks: `{ id, name, netlistName, document }`, each a neutral document of its own |
| `warnings` | anything the exporter had to drop or approximate |

`kind`, `value`, `model` and `parameters` are optional: layouts written by an
older build still convert (the kind is then inferred from the symbol id).

## Format notes

- Output is portable Project schema **58**. analog-canvas supports schema 24
  and up and upgrades to the current schema on the first save.
- No `componentDefinitions` are emitted: every instance names a reviewed
  symbol of the built-in library, which the editor resolves itself.
- Coordinates are on the document `grid` (10). Library pin offsets are
  multiples of 10, so every pin — and therefore every wire end — is on that
  grid.
- Instance placement centres the library symbol on the mmo symbol's box,
  keeping mmo's rotation and mirror (the horizontal mmo skins are mapped onto
  the vertical library symbol plus a 90° base rotation).
- Hierarchy Cells describe their block with `minimumBodySize` + explicit
  `pinPlacements`, which schema 58 accepts. `bodyBounds` would need Project
  schema 74, so the converter deliberately does not use it.

## What is *not* round-tripped (MVP)

- Edits made in analog-canvas are not imported back into mmo-chip-a.
- Device values that the layout extraction does not measure (inductance, or a
  resistor without a sheet resistance) are exported as `1n` / `1k` with a
  warning, so the netlist stays complete.
- Transistors and diodes without a model name in the source are bound to the
  generic `NPN` / `PNP` / `D` / `NMOS` / `PMOS` model, with a warning; bind a
  real model card in the editor before simulating.
- A hierarchy block whose child Cell is missing from the neutral document is
  still reported and left out (old exports). New exports carry their regions,
  so this only affects files written by an older build.
- Child Cells that were never opened start on the deterministic grid described
  above; open the region in mmo first (or re-arrange in analog-canvas) for the
  drawing you already know.
- a `gnd` symbol always names its Net `0` (SPICE ground), even when the mmo
  Net had a name such as `GND`; the warning reports the rename.
- Junction dots and multi-branch wire trees are not reproduced as junctions;
  the Net membership is still complete.

## Tests

```bash
# frontend exporter + converter core
npm run test -w frontend -- src/lib/schematic

# converter CLI (node:test)
node --test tools/analog-canvas/convert.test.mjs
```

To verify a generated project against a real analog-canvas checkout, load it
with `parseProject` in a Vitest test inside that repository, run
`analyzeDesignNetlist`, render it (`renderDocumentSvg`) and re-save it
(`serializeProject`). The output is a normal portable project file.
