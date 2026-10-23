# MCP server (`mcp/`)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes this
app's REST API to external agents (opencode, Claude Code, any MCP client). It is a thin,
stateless wrapper: every call goes to the running backend on `localhost:3001`, the same
routes the UI uses. The in-app assistant is untouched — the two sit side by side.

```
agent  --stdio/MCP-->  mcp/src/server.ts  --HTTP-->  backend :3001  -->  project data
```

## Quick start

```bash
npm run dev                 # backend must be up (port 3001)

# one-shot check: spawns the server, lists tools, calls list_projects
npm run smoke -w mcp

# manual run (stdio; logs go to stderr only)
node --import tsx mcp/src/server.ts
```

opencode picks the server up from `opencode.json` in the repo root:

```json
{
  "mcp": {
    "mmo-chip": {
      "type": "local",
      "command": ["node", "--import", "tsx", "mcp/src/server.ts"],
      "timeout": 20000,
      "enabled": true,
      "environment": { "MMO_BASE_URL": "http://127.0.0.1:3001" }
    }
  }
}
```

Then prompt with e.g. `list the mmo-chip projects and summarise the annotations of the
first one`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MMO_BASE_URL` | `http://127.0.0.1:3001` | Backend origin |
| `MMO_TOKEN` | *(unset)* | Bearer token; only needed if the backend runs with `JWT_SECRET` set (writes are protected, public GETs are not) |
| `MMO_AGENT_NAME` | `mcp-agent` | Name stamped on comments/floorplans this agent authors |
| `MMO_CROPS_DIR` | `<os tmp>/mmo-crops` | Where `get_crop` writes images (files >24 h are swept at startup) |
| `MMO_EXPORT_DIR` | `<os tmp>/mmo-exports` | Where `export_project` writes ZIPs when no `outPath` is given |

## Tools (24)

**Read**

| Tool | Does |
| --- | --- |
| `list_projects` | Every die: id, name, image size, cell library/scale, location, availability. Start here for `dieId`s. |
| `get_project` | One project's full record (geometry, progress, location). |
| `get_annotations` | `mode:"summary"` (default): `rev`, `umPerPx`, counts for all 12 collections + an index capped at `limit` rows (500) with die-pixel `rect` per resolvable cell. `mode:"full"`: raw collections, **requires `kinds`**, payloads >4 MB are rejected. |
| `list_overlay_layers` | The image layers: `__base__` plus every uploaded overlay (e.g. `sirtl`), with id, name, dimensions, format and tile-build progress. Call this before inspecting a layer. |
| `get_die_image` | Full-die preview of the base photograph (JPEG, longest side ≤4096), written to disk. |
| `get_overlay_image` | Full-layer preview of one overlay (JPEG, longest side ≤4096), written to disk. Resolves `overlayId` by id or display name. |
| `get_crop` | Image crop → file on disk. One target: `cellId` (backend-resolved footprint), `cellTypeId`, or a raw rect `x/y/w/h` (≤4096 px/side, clipped and flagged). `padding` (cellId only) is computed locally; `px` asks for a preview. Pass `overlayId` (id or name) to composite an overlay over the base — this is how you check whether metal actually connects two devices. Returns `path` (+`base64` under 1.5 MB when asked). |
| `get_region_summary` | Spatial query over `x/y/w/h`: cells (with their computed rect), nets with bounding boxes, pins, comments, floorplans and rulers that intersect. Cheaper than reading all annotations when studying one block. |
| `get_metal_stack` | Interconnect stack (metals, vias, defaults). |
| `get_spice_config` | Saved SPICE technology config (`{}` if none). |
| `get_analog_devices` | Device-name store used by netlist export. |

**Act**

| Tool | Does |
| --- | --- |
| `run_ngspice` | Simulate. Needs `netlist`, or `subcircuit` + `directives`. Trims waveform arrays (opt back in with `includeRawData`), truncates output/netlist; `success:false` comes back as an error result. |
| `run_lvs` | LVS compare (`vyges-lvs` or `name-based` engine); timeouts/missing CLI surface as error results with detail. |
| `ml_job` | `status` / `start` / `stop` the via-inference sweep (needs the ML sidecar; 503 if it is down). |
| `cell_detection` | `status` / `start` / `stop` / `list` proposals of a cell type. Start needs `cellTypeId`; one job per die (409 while busy). Proposals are approved in the UI, never written here. |

**Write** (per-entity `PUT`/`DELETE`, each returns the new `rev`)

| Tool | Does |
| --- | --- |
| `edit_nets` | `upsert_net` (create/reshape), `delete_net`, `upsert_node`, `delete_node` (cascades edges), `upsert_edge` (endpoint-checked), `delete_edge`. |
| `edit_cells` | `upsert` merges into a stored instance (move with just `x/y`), creates when `cellTypeId`+`x`+`y` are given; `delete`. `rotation` ∈ 0/90/180/270. |
| `edit_pins` | `upsert` / `delete` I/O pads (`x`, `y`, `pin`, `name`). |
| `edit_rulers` | `upsert` / `delete`; recomputes `lengthPx`/`lengthUm` from the die's `umPerPx`. |
| `edit_comments` | `add` / `reply` / `delete`; author stamped as `mcp` + `MMO_AGENT_NAME`. |
| `edit_floorplans` | `upsert` / `delete` regions (rect = 2 points, polygon ≥3); default colour `#4dabf7`. |
| `set_scale` | Sets `umPerPx` (the ruler "set scale" workflow). |
| `export_project` | ZIP (`light`/`full`) → disk, returns the absolute path and byte count. |

## Layers and images

The base photograph often hides the layer that answers the question. Before
claiming that two devices are (or are not) connected, look at the relevant
overlay — for this project `sirtl` is the developed-silicon image, and metal
layers usually carry `me`/`metal` plus a number in their name.

```jsonc
// 1. which layers exist?
{ "tool": "list_overlay_layers", "args": { "dieId": "..." } }
// -> layers: [ {id:"__base__", kind:"base"},
//              {id:"<uuid>", name:"sirtl", kind:"overlay", width, height, ...} ]

// 2. native-resolution crop of one layer, composited over the base
{ "tool": "get_crop", "args": {
    "dieId": "...", "overlayId": "sirtl",
    "x": 3000, "y": 6000, "w": 900, "h": 900
} }

// 3. cheap full-layer overview (JPEG, ≤4096 px)
{ "tool": "get_overlay_image", "args": { "dieId": "...", "overlayId": "sirtl" } }

// 4. full-die base overview
{ "tool": "get_die_image", "args": { "dieId": "..." } }
```

`get_crop` keeps overlay crops in a separate file (`..._ov-<id>.jpg`), so a
base crop and the same rect on a layer never overwrite each other. Overlay ids
and names are resolved case-insensitively; an unknown name returns the list of
available layers instead of a generic 404.

## Conventions and contracts

- **Coordinates are source pixels** (the imported image's own grid), top-left origin —
  exactly what the UI stores. No device coordinates; µm come from `umPerPx`.
- **Read before you write.** `rev` increments on every annotation write; a summary read
  is cheap enough to precede every `edit_*`.
- **No bulk writes.** The server deliberately exposes per-entity routes only, so an agent
  cannot accidentally replace the whole annotation file.
- **Ids**: ids you do not supply are generated as `mcp-<kind>-<time>-<rand>`; the agent
  identity stamped on authored items is `mcp` / `MMO_AGENT_NAME`.
- **Cell footprint** equals the region the app's own crop endpoints serve (backend
  `cellDieRect`: mirror, then rotate about the type-box centre — a 90° cell of a W×H type
  covers H×W). Cells whose type only resolves through a library scan come back without
  `rect` (drop `padding` and target them by `cellId` instead).
- **Errors are results**: anything the caller can fix (bad arguments, unknown ids,
  backend HTTP errors) arrives as `isError` with a human-readable message, not as a
  protocol fault. A failed simulation is an error result too — it is never dressed up as
  data.

## Not covered (v0)

Importing/creating projects, uploading/deleting overlay images, bulk annotation
replacement, running or approving ML/CV extraction, editing cell-type layer
shapes, saving metal-stack / SPICE config / analog device stores (read-only
here), and destructive ML clears (delete all detections). Those stay in the UI
until there is a real agent workflow behind them.

## Development

```bash
npx tsc -p mcp/tsconfig.json --noEmit   # typecheck (shared types imported from the workspace)
npm run test -w mcp                     # 45 unit/integration tests, mock fetch + in-memory MCP transport
npm run smoke -w mcp                    # end-to-end against a live backend (exit 2 = backend down)
```

Layout: `src/config.ts` (env), `src/client.ts` (HTTP + error mapping), `src/result.ts`
(MCP result helpers), `src/footprint.ts` (cell footprint/rect maths), `src/summary.ts`
(pure summary/full builders), `src/tools/*.ts` (tool modules), `src/build.ts` (wiring,
side-effect free → used by tests), `src/server.ts` (stdio entry point).

Windows note: the server logs to **stderr** only — stdout is the MCP protocol.
