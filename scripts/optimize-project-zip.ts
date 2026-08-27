import { ZipArchive } from "archiver";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { ZipStreamReader, type ZipEntry } from "../backend/src/api/zipStream.ts";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: optimize-project-zip.ts <input.zip> <output.zip>");
}
if (path.resolve(inputPath) === path.resolve(outputPath)) {
  throw new Error("The output ZIP must be different from the source ZIP.");
}

const overlayOriginal = /^overlay-images\/([a-zA-Z0-9_-]+)\/original\.png$/;
const overlayManifest = /^overlay-images\/([a-zA-Z0-9_-]+)\/manifest\.json$/;
const quality = 95;
const workDir = `${outputPath}.work-${Date.now()}`;
const partialPath = `${outputPath}.partial`;
const reportPath = `${outputPath}.report.json`;

type PortableManifest = {
  id: string;
  originalPath: string;
  originalFilename?: string;
  size: number;
  width: number;
  height: number;
  tileFormat: "jpg" | "png";
  hasAlpha: boolean;
  [key: string]: unknown;
};

type Conversion = {
  sourceId: string;
  entryName: string;
  width: number;
  height: number;
  sourceBytes: number;
  jpegBytes: number;
  alphaMin: number | null;
  alphaMax: number | null;
};

const manifests = new Map<string, PortableManifest>();
const conversions = new Map<string, Conversion>();

async function appendEntry(
  archive: archiver.Archiver,
  reader: ZipStreamReader,
  entry: ZipEntry
): Promise<void> {
  if (entry.isDirectory) return;
  const source = await reader.createEntryStream(entry);
  archive.append(source, { name: entry.entryName, store: true });
}

async function readText(reader: ZipStreamReader, entry: ZipEntry): Promise<string> {
  return reader.readEntryText(entry, 16 * 1024 * 1024);
}

function appendText(archive: archiver.Archiver, name: string, text: string): void {
  archive.append(text, { name, store: true });
}

async function convertOverlayOriginal(
  archive: archiver.Archiver,
  reader: ZipStreamReader,
  entry: ZipEntry,
  sourceId: string
): Promise<void> {
  const sourcePng = path.join(workDir, `${sourceId}.png`);
  const targetJpg = path.join(workDir, `${sourceId}.jpg`);
  const stream = await reader.createEntryStream(entry);
  await pipeline(stream, createWriteStream(sourcePng));

  const image = sharp(sourcePng, { limitInputPixels: false, sequentialRead: false });
  const metadata = await image.metadata();
  const stats = await image.stats();
  const alpha = stats.channels.find((channel) => channel.channel === "alpha");

  // The user confirmed that alpha is represented by the canvas configuration,
  // not by the raster source. JPEG quality 95 and 4:4:4 sampling preserve
  // fine die features while avoiding the very expensive transparent PNG path.
  await image
    .removeAlpha()
    .jpeg({ quality, chromaSubsampling: "4:4:4", progressive: true })
    .toFile(targetJpg);

  const targetStat = await fs.stat(targetJpg);
  conversions.set(sourceId, {
    sourceId,
    entryName: entry.entryName,
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    sourceBytes: entry.uncompressedSize,
    jpegBytes: targetStat.size,
    alphaMin: alpha?.min ?? null,
    alphaMax: alpha?.max ?? null
  });
  archive.file(targetJpg, {
    name: `overlay-images/${sourceId}/original.jpg`,
    store: true
  });
}

async function main(): Promise<void> {
  if (await exists(outputPath)) {
    throw new Error(`Refusing to overwrite existing output ZIP: ${outputPath}`);
  }
  await fs.mkdir(workDir, { recursive: true });
  const reader = await ZipStreamReader.open(inputPath);
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const output = createWriteStream(partialPath);
  archive.pipe(output);

  const completed = new Promise<void>((resolve, reject) => {
    archive.on("error", reject);
    output.on("error", reject);
    output.on("close", resolve);
  });

  try {
    for (const entry of reader.entries) {
      const manifestMatch = overlayManifest.exec(entry.entryName);
      if (manifestMatch) {
        const raw = await readText(reader, entry);
        manifests.set(manifestMatch[1], JSON.parse(raw) as PortableManifest);
        continue;
      }

      const originalMatch = overlayOriginal.exec(entry.entryName);
      if (originalMatch) {
        await convertOverlayOriginal(archive, reader, entry, originalMatch[1]);
        continue;
      }

      await appendEntry(archive, reader, entry);
    }

    if (conversions.size === 0) {
      throw new Error("No overlay original.png files were found in the source ZIP.");
    }
    for (const [sourceId, manifest] of manifests) {
      const converted = conversions.get(sourceId);
      if (!converted) {
        throw new Error(`Manifest ${sourceId} has no converted original.png entry.`);
      }
      const originalFilename = (manifest.originalFilename || "original.png").replace(/\.png$/i, ".jpg");
      const updated: PortableManifest = {
        ...manifest,
        originalPath: "original.jpg",
        originalFilename,
        size: converted.jpegBytes,
        width: converted.width || manifest.width,
        height: converted.height || manifest.height,
        hasAlpha: false,
        tileFormat: "jpg"
      };
      appendText(archive, `overlay-images/${sourceId}/manifest.json`, `${JSON.stringify(updated, null, 2)}\n`);
    }

    await archive.finalize();
    await completed;
    await fs.rename(partialPath, outputPath);
    await fs.writeFile(
      reportPath,
      `${JSON.stringify({ inputPath, outputPath, quality, conversions: [...conversions.values()] }, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    archive.abort();
    await fs.rm(partialPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await reader.close().catch(() => {});
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

void main();
