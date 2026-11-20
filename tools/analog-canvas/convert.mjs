#!/usr/bin/env node
/**
 * convert.mjs — neutral mmo schematic layout → analog-canvas `.icproj.json`.
 *
 *   node tools/analog-canvas/convert.mjs <layout.json> [-o out.icproj.json]
 *
 * The conversion itself lives in the frontend module
 * `frontend/src/lib/schematic/analogCanvasProject.ts` so the canvas button and
 * this CLI produce byte-identical projects. Node ≥ 22.18 runs the TypeScript
 * module directly (erasable syntax only).
 *
 * The output is portable Project schema 58 whose instances name the editor's
 * own reviewed library symbols: nothing is copied from analog-canvas
 * (AGPL-3.0-only). Hierarchy blocks become child Cell documents, so the
 * project is a real hierarchy rather than a flat drawing with dropped blocks.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { convertLayoutToProject } from "../../frontend/src/lib/schematic/analogCanvasProject.ts";

/** Backwards-compatible name used by the converter tests. */
const convert = convertLayoutToProject;

function parseArgs(argv) {
  const args = { input: null, out: null, grid: null, scale: null, routes: true, name: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else if (arg === "--grid") args.grid = Number(argv[++i]);
    else if (arg === "--scale") args.scale = Number(argv[++i]);
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--no-routes") args.routes = false;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (!args.input) args.input = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "usage: node tools/analog-canvas/convert.mjs <layout.json> [options]",
    "",
    "  -o, --out <file>   output .icproj.json (default: next to the input)",
    "      --scale <n>    coordinate scale (default: the document's hint, usually 1)",
    "      --grid <n>     document grid (default: the document's hint, usually 10)",
    "      --name <text>  project name",
    "      --no-routes    export topology only, without wire geometry",
  ].join("\n");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(String(error.message ?? error));
    console.error(usage());
    process.exit(2);
  }
  if (args.help || !args.input) {
    console.log(usage());
    process.exit(args.help ? 0 : 2);
  }

  const inputPath = resolve(args.input);
  const outputPath = args.out
    ? resolve(args.out)
    : resolve(
        dirname(inputPath),
        `${basename(inputPath).replace(/\.layout\.json$/i, "").replace(/\.json$/i, "")}.icproj.json`,
      );

  const layout = JSON.parse(readFileSync(inputPath, "utf8"));
  const { project, warnings, stats } = convertLayoutToProject(layout, args);
  writeFileSync(outputPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

  console.log(`wrote ${outputPath}`);
  console.log(
    `  ${stats.symbols} symbols, ${stats.instances} instances, ${stats.nets} nets, ` +
      `${stats.routes} routes, ${stats.cells} hierarchy cells`,
  );
  for (const warning of warnings) console.warn(`  ! ${warning}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(1);
  }
}

export { convert, convertLayoutToProject };
