#!/usr/bin/env node
/**
 * Find the analog-canvas checkout the RNL tab uses, optionally build the two
 * artifacts it needs, and print the environment lines for another machine.
 *
 *   node scripts/analog-canvas-rnl-setup.mjs [--build]
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const candidates = [
  process.env.CHIPTOOL_ANALOG_CANVAS_HOME,
  process.env.ANALOG_CANVAS_HOME,
  path.join(repoRoot, "_refs", "analog-canvas"),
  path.join(repoRoot, "..", "_refs", "analog-canvas"),
  path.join(repoRoot, "..", "analog-canvas"),
  path.join(repoRoot, "analog-canvas"),
].filter(Boolean);

const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const find = (root, files) =>
  files.map((file) => path.join(root, file)).find(isFile) ?? null;

let home = null;
let mcpPath = null;
let headlessPath = null;
for (const root of candidates) {
  if (!existsSync(root)) continue;
  mcpPath ??= find(root, [
    "apps/mcp-server/dist/main.js",
    "apps/mcp-server/bin/analog-canvas-mcp.mjs",
    "bin/analog-canvas-mcp.mjs",
    "analog-canvas-mcp.mjs",
  ]);
  headlessPath ??= find(root, [
    "output/headless/analog-canvas-headless.mjs",
    "analog-canvas-headless.mjs",
  ]);
  if (mcpPath && headlessPath) {
    home = root;
    break;
  }
}

if (!mcpPath || !headlessPath) {
  console.error("analog-canvas checkout not found or not built.");
  console.error(`Looked in: ${candidates.join(", ")}`);
  console.error("Build it with:");
  console.error("  pnpm build");
  console.error("  pnpm headless:package");
  console.error("  pnpm --filter @icm/mcp-server build");
  process.exit(1);
}

if (process.argv.includes("--build")) {
  for (const args of [
    ["build"],
    ["headless:package"],
    ["--filter", "@icm/mcp-server", "build"],
  ]) {
    console.log(`> pnpm ${args.join(" ")}`);
    const run = spawnSync("pnpm", args, {
      cwd: home,
      stdio: "inherit",
      shell: true,
    });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
}

console.log(`checkout: ${home}`);
console.log("");
console.log("PowerShell:");
console.log(`  $env:CHIPTOOL_ANALOG_CANVAS_MCP = "${mcpPath}"`);
console.log(`  $env:CHIPTOOL_ANALOG_CANVAS_HEADLESS = "${headlessPath}"`);
console.log("");
console.log(
  "The backend also finds this checkout by itself; the variables are for other machines.",
);
