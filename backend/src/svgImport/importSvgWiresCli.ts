import path from "node:path";
import { config } from "../config.js";
import { formatImportPlan, importSvgData, type SvgImportMode } from "./svgWireImport.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.die || !options.svg) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const plan = await importSvgData({
    dataRoot: config.dataRoot,
    dieSelector: options.die,
    svgPath: path.resolve(options.svg),
    mode: options.importMode,
    dryRun: options.dryRun,
    namePrefix: options.prefix,
    chip: options.chip,
    identCellsPath: options.identCellsPath
  });

  console.log(formatImportPlan(plan));
  console.log(
    options.dryRun
      ? "\nDry run only. No annotations were written."
      : `\nImported ${plan.nets.length} nets and ${plan.cells.length} cells into die ${plan.die.name}.`
  );
}

function parseArgs(args: string[]) {
  const options: {
    die?: string;
    svg?: string;
    importMode: SvgImportMode;
    dryRun: boolean;
    prefix: string;
    chip?: string;
    identCellsPath?: string;
    help: boolean;
  } = {
    importMode: "wires",
    dryRun: false,
    prefix: "",
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--die") {
      options.die = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--svg") {
      options.svg = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--prefix") {
      options.prefix = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--chip") {
      options.chip = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--ident-cells") {
      options.identCellsPath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--import") {
      const value = args[index + 1] as SvgImportMode | undefined;
      if (value !== "wires" && value !== "cells" && value !== "all") {
        throw new Error(`Invalid --import mode: ${value ?? "<missing>"}`);
      }
      options.importMode = value;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run import-svg-wires -w backend -- --die <die-id-or-name> --svg <path> [--import wires|cells|all] [--chip <chip>] [--ident-cells <path>] [--dry-run] [--prefix <name-prefix>]",
      "",
      "Examples:",
      "  npm run import-svg-wires -w backend -- --die ic19 --svg /path/to/ic19_trace.svg --import cells --chip ic19 --ident-cells /path/to/ident_cells --dry-run",
      "  npm run import-svg-wires -w backend -- --die 1234-abcd --svg /path/to/ic19_trace.svg --prefix old:"
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
