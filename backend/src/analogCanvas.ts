/**
 * Where the analog-canvas companion lives.
 *
 * The RNL writer is a separate local process (AGPL-3.0), never a linked
 * dependency. A checkout is found from the environment first, then from the
 * usual places this workspace clones it into. A path that does not exist is
 * ignored, so a stale or placeholder environment variable cannot stop a
 * working checkout beside the repository.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "..", "..");

export interface AnalogCanvasPaths {
  mcpPath: string | null;
  headlessPath: string | null;
  /** The checkout both were found in, when they share one. */
  home: string | null;
  /** Environment paths that were set but do not exist. */
  ignored: string[];
  /** Every checkout location tried, for the error message. */
  searched: string[];
}

function isFile(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function checkoutRoots(): string[] {
  const roots = [
    process.env.CHIPTOOL_ANALOG_CANVAS_HOME,
    process.env.ANALOG_CANVAS_HOME,
    path.join(repoRoot, "_refs", "analog-canvas"),
    path.join(repoRoot, "..", "_refs", "analog-canvas"),
    path.join(repoRoot, "..", "analog-canvas"),
    path.join(repoRoot, "analog-canvas"),
  ].filter((value): value is string => !!value);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

const MCP_CANDIDATES = [
  path.join("apps", "mcp-server", "dist", "main.js"),
  path.join("apps", "mcp-server", "bin", "analog-canvas-mcp.mjs"),
  path.join("bin", "analog-canvas-mcp.mjs"),
  "analog-canvas-mcp.mjs",
];

const HEADLESS_CANDIDATES = [
  path.join("output", "headless", "analog-canvas-headless.mjs"),
  "analog-canvas-headless.mjs",
];

export function resolveAnalogCanvasPaths(
  overrides: {
    mcpPath?: string;
    headlessPath?: string;
    /** False keeps the search to explicit paths/environment (tests). */
    discover?: boolean;
  } = {},
): AnalogCanvasPaths {
  const ignored: string[] = [];
  const searched: string[] = [];

  const fromEnv = (name: string): string | null => {
    const value = process.env[name]?.trim();
    if (!value) return null;
    if (isFile(value)) return value;
    ignored.push(value);
    return null;
  };

  let mcpPath = overrides.mcpPath || fromEnv("CHIPTOOL_ANALOG_CANVAS_MCP");
  let headlessPath =
    overrides.headlessPath || fromEnv("CHIPTOOL_ANALOG_CANVAS_HEADLESS");
  let home: string | null = null;

  if ((!mcpPath || !headlessPath) && overrides.discover !== false) {
    for (const root of checkoutRoots()) {
      searched.push(root);
      if (!fs.existsSync(root)) continue;
      if (!mcpPath) {
        const found = MCP_CANDIDATES.map((file) => path.join(root, file)).find(
          isFile,
        );
        if (found) {
          mcpPath = found;
          home ??= root;
        }
      }
      if (!headlessPath) {
        const found = HEADLESS_CANDIDATES.map((file) =>
          path.join(root, file),
        ).find(isFile);
        if (found) {
          headlessPath = found;
          home ??= root;
        }
      }
      if (mcpPath && headlessPath) break;
    }
  } else if (mcpPath) {
    const marker = `${path.sep}apps${path.sep}mcp-server${path.sep}`;
    home = mcpPath.includes(marker)
      ? path.resolve(path.dirname(mcpPath), "..", "..", "..")
      : null;
  }

  return { mcpPath, headlessPath, home, ignored, searched };
}

/** The setup sentence an unconfigured export shows. */
export function analogCanvasSetupHint(paths: AnalogCanvasPaths): string {
  const parts = [
    "RNL export needs the analog-canvas companion as a separate local process.",
  ];
  if (!paths.mcpPath || !paths.headlessPath) {
    parts.push(
      `Set CHIPTOOL_ANALOG_CANVAS_HOME to the checkout, or set CHIPTOOL_ANALOG_CANVAS_MCP and CHIPTOOL_ANALOG_CANVAS_HEADLESS to existing files.`,
    );
    if (paths.searched.length)
      parts.push(`Looked in: ${paths.searched.join(", ")}.`);
    if (paths.ignored.length)
      parts.push(
        `Ignored missing environment paths: ${paths.ignored.join(", ")}.`,
      );
    parts.push(
      "In the checkout run: pnpm build; pnpm headless:package; pnpm --filter @icm/mcp-server build.",
    );
  }
  return parts.join(" ");
}
