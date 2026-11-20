import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { ensureDataStore } from "../store.js";
import { importDieShot } from "./importer.js";

// Never cache open input files — see backend/src/index.ts: a pyramidal TIFF
// read through a stored level stays locked on Windows until the process exits.
sharp.cache({ memory: 256, files: 0, items: 200 });

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "image/jpeg";
}

// Imports a die shot straight from disk: no upload, the original stored as a
// tiled pyramidal TIFF. Suited to gigapixel JPEGs, where per-request lazy
// decodes of the original make tiles and crops unusable.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.image) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const filePath = path.resolve(options.image);
  const mimeType = mimeTypeForPath(filePath);
  await ensureDataStore(config.dataRoot);
  const started = Date.now();
  const record = await importDieShot({
    dataRoot: config.dataRoot,
    filePath,
    originalFilename: path.basename(filePath),
    mimeType,
    tileSize: config.tileSize,
    limitInputPixels: config.limitInputPixels,
    tileConcurrency: config.tileConcurrency,
    tiledOriginal: !options.keepOriginal,
    onProgress: (update) => console.log(`[${update.phase}] ${update.message}`),
    logger: (message) => console.log(message)
  });

  console.log(
    `\nImported ${record.name} (${record.width}x${record.height}, ${record.levels.length} levels) as die ${record.id} in ${((Date.now() - started) / 1000).toFixed(0)}s.`
  );
}

function parseArgs(args: string[]) {
  const options: {
    image?: string;
    keepOriginal: boolean;
    help: boolean;
  } = {
    keepOriginal: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep-original") {
      options.keepOriginal = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      options.image = arg;
    }
  }
  return options;
}

function printUsage() {
  console.log(
    [
      "Usage: npm run import-die -w backend -- <image> [--keep-original]",
      "",
      "Imports a die shot (PNG/JPEG/TIFF) from disk into the local data store.",
      "By default the original is converted to a lossless tiled pyramidal TIFF;",
      "--keep-original stores the file as-is.",
      "",
      "Env: CHIPTOOL_DATA_ROOT (default data/ or the desktop portable-data root)."
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
