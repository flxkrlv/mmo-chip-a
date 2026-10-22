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

## Tools (19)

**Read**

| Tool | Does |
| --- | --- |
| `list_projects` | Every die: id, name, image size, cell library/scale, location, availability. Start here for `dieId`s. |
| `get_project` | One project's full record (geometry, progress, location). |
| `get_annotations` | `mode:"summary"` (default): `rev`, `umPerPx`, counts for all 12 collections + an index capped at `limit` rows (500) with die-pixel `rect` per resolvable cell. `mode:"full"`: raw collections, **requires `kinds`**, payloads >4 MB are rejected. |
| `get_crop` | Image crop → file on disk. One target: `cellId` (backend-resolved footprint), `cellTypeId`, or a raw rect `x/y/w/h` (≤4096 px/side, clipped and flagged). `padding` (cellId only) is computed locally; `px` asks for a preview. Returns `path` (+`base64` under 1.5 MB when asked). |
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

Importing/creating projects, bulk annotation replacement, running or approving ML/CV
extraction, editing cell-type layer shapes, saving metal-stack / SPICE config / analog
device stores (read-only here), and destructive ML clears (delete all detections).
Those stay in the UI until there is a real agent workflow behind them.

## Development

```bash
npx tsc -p mcp/tsconfig.json --noEmit   # typecheck (shared types imported from the workspace)
npm run test -w mcp                     # 41 unit/integration tests, mock fetch + in-memory MCP transport
npm run smoke -w mcp                    # end-to-end against a live backend (exit 2 = backend down)
```

Layout: `src/config.ts` (env), `src/client.ts` (HTTP + error mapping), `src/result.ts`
(MCP result helpers), `src/footprint.ts` (cell footprint/rect maths), `src/summary.ts`
(pure summary/full builders), `src/tools/*.ts` (tool modules), `src/build.ts` (wiring,
side-effect free → used by tests), `src/server.ts` (stdio entry point).

Windows note: the server logs to **stderr** only — stdout is the MCP protocol.
