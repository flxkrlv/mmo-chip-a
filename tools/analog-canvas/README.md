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

## RNL drawing (RNL tab)

The **RNL** tab writes the same project as **SPICE+RNL** and shows it in the
official MIT RNL viewer (embedded, `embed=1`, text sent by `postMessage`).
The netlist stays authoritative; the RNL comments are the drawing, so an agent
can redraw without touching connectivity.

The generator is analog-canvas's own Netlist-panel export. It runs as a
**separate local process** (the analog-canvas MCP in `--local` mode), not as a
linked library: this MIT app never copies AGPL-3.0 code.

The backend finds the checkout by itself: `CHIPTOOL_ANALOG_CANVAS_HOME` /
`ANALOG_CANVAS_HOME`, then `_refs/analog-canvas` beside the repository (and
`../_refs/analog-canvas`). A stale or placeholder path in the environment is
ignored, not fatal. To see what was found:

```powershell
npm run analog:rnl:setup
```

It prints the exact `CHIPTOOL_ANALOG_CANVAS_MCP` /
`CHIPTOOL_ANALOG_CANVAS_HEADLESS` lines for another machine; `-- --build`
builds the checkout first. The two artifacts are:

```
<checkout>/apps/mcp-server/dist/main.js
<checkout>/output/headless/analog-canvas-headless.mjs
```

Build them with `pnpm build`, `pnpm headless:package`, and
`pnpm --filter @icm/mcp-server build`. The `netlist_code` tool must accept
`rnl:true`; that is the headless-export change proposed upstream (the local
`feature/headless-rnl-export` branch has it). Without the change the RNL tab
reports the missing capability instead of inventing a drawing.

`GET /api/rnl/status` reports the resolved paths (and the search list when
nothing was found), so a misconfigured deployment can be diagnosed without a
drawing attempt.

Flow:

```
Schematic → RNL button
  → backend writes project.icproj.json to a temp dir
  → analog-canvas MCP --local --http netlist_code {action:"read", rnl:true}
  → SPICE+RNL saved beside the project (rnl/<module>.rnl)
  → RNL tab: text editor + official viewer
  → MCP rnl_read / rnl_write: the agent edits the same file
```

The backend endpoints are `POST /api/dies/:id/rnl/export`,
`GET /api/dies/:id/rnl?moduleName=…` and `PUT /api/dies/:id/rnl`. The RNL
viewer fetches `analog-canvas-extensions` from the public RNL package catalog,
so the tab needs network access for the drawing; the text and diagnostics work
offline.

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
