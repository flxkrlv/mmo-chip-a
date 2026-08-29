/**
 * Import the pphilip/analog-circuits-sky130 dataset (or any NDJSON of the same
 * shape) into a vyges-lvs reference library under data/reference-library/<libId>.
 *
 * The netlist normalizer is the SAME code path the discuss tool / "Check by LVS"
 * button use (lib/normalizeNetlist.normalizeForVyges + lvsLibrary.netlistJsonToSpice),
 * so the persisted cells are guaranteed to parse cleanly when a candidate is later
 * matched against them.
 *
 * Usage:
 *   # Stream directly from HuggingFace (needs python3 + `datasets` on PATH):
 *   tsx scripts/import-analog-circuits.ts --hf pphilip/analog-circuits-sky130 --data ../../data
 *
 *   # Or from a pre-exported NDJSON (each line: {circuit_id, topology, netlist_json, metrics?}):
 *   tsx scripts/import-analog-circuits.ts --ndjson rows.ndjson --data ../../data
 *
 *   # Filter to one topology family and cap the import size:
 *   tsx scripts/import-analog-circuits.ts --hf pphilip/analog-circuits-sky130 --topology operational_amplifier --limit 5000
 *
 * Defaults: --libId analog-circuits-sky130, --limit 5000, --maxPerSignature 4, --split train.
 * Pass --limit 0 to import everything (heavy: ~130k rows / ~63k distinct graphs).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { netlistJsonToSpice, buildLibraryFromRows, writeLibrary, type LibraryRow } from "../src/assistant/lvsLibrary.js";
import { normalizeForVyges } from "../src/lib/normalizeNetlist.js";
import { signatureFromSpice } from "../src/assistant/subcircuitExtract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  data: string;
  libId: string;
  hf?: string;
  ndjson?: string;
  split: string;
  topology?: string;
  limit: number;
  maxPerSignature: number;
  python?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    data: path.resolve(__dirname, "..", "..", "data"),
    libId: "analog-circuits-sky130",
    split: "train",
    limit: 5000,
    maxPerSignature: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--data": out.data = path.resolve(next()!); break;
      case "--libId": out.libId = next()!; break;
      case "--hf": out.hf = next()!; break;
      case "--ndjson": out.ndjson = next()!; break;
      case "--split": out.split = next()!; break;
      case "--topology": out.topology = next()!; break;
      case "--limit": out.limit = Number(next()); break;
      case "--maxPerSignature": out.maxPerSignature = Number(next()); break;
      case "--python": out.python = next()!; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!out.hf && !out.ndjson) {
    throw new Error("Provide either --hf <dataset-id> or --ndjson <file>.");
  }
  return out;
}

const PY_STREAM = (dataset: string, split: string) => `
import sys, json
from datasets import load_dataset
ds = load_dataset("${dataset}", split="${split}", streaming=True)
for row in ds:
    out = {
        "circuit_id": row.get("circuit_id"),
        "topology": row.get("topology"),
        "netlist_json": row.get("netlist_json"),
        "metrics": row.get("metrics"),
    }
    if out["circuit_id"] is None or out["netlist_json"] is None:
        continue
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\\n")
    sys.stdout.flush()
`;

async function* streamNdjson(filePath: string): AsyncGenerator<LibraryRow> {
  const rl = createInterface({ input: (await fsp.open(filePath, "r")).createReadStream() });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    const obj = JSON.parse(t) as Record<string, unknown>;
    if (typeof obj.circuit_id !== "string" || typeof obj.netlist_json !== "string") continue;
    yield {
      circuit_id: obj.circuit_id,
      topology: typeof obj.topology === "string" ? obj.topology : undefined,
      netlist_json: obj.netlist_json,
      metrics: obj.metrics,
    };
  }
}

async function* streamHf(dataset: string, split: string, pythonBin?: string): AsyncGenerator<LibraryRow> {
  const candidates = ["python3", "python"];
  let bin: string | undefined = pythonBin;
  if (!bin) {
    for (const c of candidates) {
      try { await fsp.access(c, fsp.constants.X_OK); bin = c; break; } catch { /* try next */ }
    }
  }
  if (!bin) bin = "python";
  const proc = spawn(bin, ["-"], { stdio: ["pipe", "pipe", "inherit"] });
  proc.stdin.write(PY_STREAM(dataset, split));
  proc.stdin.end();
  const rl = createInterface({ input: proc.stdout });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    const obj = JSON.parse(t) as Record<string, unknown>;
    if (typeof obj.circuit_id !== "string" || typeof obj.netlist_json !== "string") continue;
    yield {
      circuit_id: obj.circuit_id,
      topology: typeof obj.topology === "string" ? obj.topology : undefined,
      netlist_json: obj.netlist_json,
      metrics: obj.metrics,
    };
  }
  await new Promise<void>((res) => proc.on("close", () => res()));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[import] target data root: ${args.data}`);
  console.log(`[import] library id: ${args.libId}  limit=${args.limit}  maxPerSignature=${args.maxPerSignature}${args.topology ? `  topology~=${args.topology}` : ""}`);

  const source = args.hf ? streamHf(args.hf, args.split, args.python) : streamNdjson(args.ndjson!);
  const rows: LibraryRow[] = [];
  let seen = 0;
  let kept = 0;
  for await (const row of source) {
    seen++;
    if (args.topology && row.topology && !row.topology.includes(args.topology)) continue;
    // Validate that the normalizer accepts the record before keeping it.
    try {
      const spice = netlistJsonToSpice(row.netlist_json);
      normalizeForVyges(spice, "top");
      signatureFromSpice(normalizeForVyges(spice, "top"));
    } catch {
      continue;
    }
    rows.push(row);
    kept++;
    if (args.limit && kept >= args.limit) break;
    if (kept % 1000 === 0) console.log(`[import] ...kept ${kept} (scanned ${seen})`);
  }
  console.log(`[import] scanned ${seen}, kept ${kept} valid rows`);

  if (kept === 0) {
    console.error("[import] No valid rows collected — nothing written.");
    process.exit(1);
  }

  const library = buildLibraryFromRows(args.libId, rows, {
    maxPerSignature: args.maxPerSignature,
  });
  console.log(`[import] deduplicated to ${library.cells.length} representative cells`);
  await writeLibrary(args.data, library);
  console.log(`[import] wrote library to ${path.join(args.data, "reference-library", args.libId)}`);
}

main().catch((err) => {
  console.error("[import] failed:", err);
  process.exit(1);
});
