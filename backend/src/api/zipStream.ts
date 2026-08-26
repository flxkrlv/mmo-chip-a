import { createInflateRaw } from "node:zlib";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const MAX_EOCD_SEARCH_BYTES = 0xffff + 22;
const MAX_CENTRAL_DIRECTORY_BYTES = 128 * 1024 * 1024;
const MAX_SAFE_ARCHIVE_NUMBER = Number.MAX_SAFE_INTEGER;

export const MAX_PROJECT_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_PROJECT_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024;

export class ZipStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipStreamError";
  }
}

export type ZipEntry = {
  entryName: string;
  isDirectory: boolean;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

type CentralDirectory = {
  entryCount: number;
  offset: number;
  size: number;
};

function readUInt64LE(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(MAX_SAFE_ARCHIVE_NUMBER)) {
    throw new ZipStreamError("ZIP entry offset or size exceeds supported range");
  }
  return Number(value);
}

function checkedNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_SAFE_ARCHIVE_NUMBER) {
    throw new ZipStreamError(`Invalid ZIP ${label}`);
  }
  return value;
}

function findSignatureBackwards(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function parseZip64Extra(
  extra: Buffer,
  compressedSize: number,
  uncompressedSize: number,
  localHeaderOffset: number
): { compressedSize: number; uncompressedSize: number; localHeaderOffset: number } {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor);
    const dataSize = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + dataSize > extra.length) throw new ZipStreamError("Malformed ZIP extra field");
    if (headerId !== ZIP64_EXTRA_FIELD) {
      cursor += dataSize;
      continue;
    }

    let valueCursor = cursor;
    const valueEnd = cursor + dataSize;
    const readZip64 = (): number => {
      if (valueCursor + 8 > valueEnd) throw new ZipStreamError("Malformed ZIP64 extra field");
      const value = readUInt64LE(extra, valueCursor);
      valueCursor += 8;
      return value;
    };

    if (uncompressedSize === 0xffffffff) uncompressedSize = readZip64();
    if (compressedSize === 0xffffffff) compressedSize = readZip64();
    if (localHeaderOffset === 0xffffffff) localHeaderOffset = readZip64();
    return { compressedSize, uncompressedSize, localHeaderOffset };
  }

  if (
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    localHeaderOffset === 0xffffffff
  ) {
    throw new ZipStreamError("ZIP64 fields are missing from archive entry");
  }
  return { compressedSize, uncompressedSize, localHeaderOffset };
}

async function readAt(handle: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new ZipStreamError("Unexpected end of ZIP file");
  return buffer;
}

async function readCentralDirectory(handle: fs.FileHandle, archiveSize: number): Promise<CentralDirectory> {
  const tailLength = Math.min(archiveSize, MAX_EOCD_SEARCH_BYTES);
  const tailStart = archiveSize - tailLength;
  const tail = await readAt(handle, tailLength, tailStart);
  const eocdOffsetInTail = findSignatureBackwards(tail, END_OF_CENTRAL_DIRECTORY);
  if (eocdOffsetInTail < 0 || eocdOffsetInTail + 22 > tail.length) {
    throw new ZipStreamError("ZIP end-of-directory record was not found");
  }

  const standardEntryCount = tail.readUInt16LE(eocdOffsetInTail + 10);
  const standardSize = tail.readUInt32LE(eocdOffsetInTail + 12);
  const standardOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
  const requiresZip64 =
    standardEntryCount === 0xffff ||
    standardSize === 0xffffffff ||
    standardOffset === 0xffffffff;

  if (!requiresZip64) {
    return { entryCount: standardEntryCount, size: standardSize, offset: standardOffset };
  }

  const eocdAbsoluteOffset = tailStart + eocdOffsetInTail;
  const locatorOffset = eocdAbsoluteOffset - 20;
  if (locatorOffset < 0) throw new ZipStreamError("ZIP64 locator was not found");
  const locator = await readAt(handle, 20, locatorOffset);
  if (locator.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
    throw new ZipStreamError("ZIP64 locator was not found");
  }
  const zip64EocdOffset = readUInt64LE(locator, 8);
  const zip64Header = await readAt(handle, 56, zip64EocdOffset);
  if (zip64Header.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
    throw new ZipStreamError("ZIP64 end-of-directory record was not found");
  }

  return {
    entryCount: readUInt64LE(zip64Header, 32),
    size: readUInt64LE(zip64Header, 40),
    offset: readUInt64LE(zip64Header, 48)
  };
}

function parseEntries(data: Buffer, entryCount: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new ZipStreamError("Malformed ZIP central directory");
    }

    const flags = data.readUInt16LE(cursor + 8);
    const compressionMethod = data.readUInt16LE(cursor + 10);
    let compressedSize = data.readUInt32LE(cursor + 20);
    let uncompressedSize = data.readUInt32LE(cursor + 24);
    const fileNameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const externalAttributes = data.readUInt32LE(cursor + 38);
    let localHeaderOffset = data.readUInt32LE(cursor + 42);
    const headerLength = 46 + fileNameLength + extraLength + commentLength;
    if (cursor + headerLength > data.length) throw new ZipStreamError("Malformed ZIP entry header");

    const fileNameStart = cursor + 46;
    const fileName = data.subarray(fileNameStart, fileNameStart + fileNameLength).toString("utf8");
    const extraStart = fileNameStart + fileNameLength;
    const extra = data.subarray(extraStart, extraStart + extraLength);
    ({ compressedSize, uncompressedSize, localHeaderOffset } = parseZip64Extra(
      extra,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    ));

    compressedSize = checkedNumber(compressedSize, "compressed size");
    uncompressedSize = checkedNumber(uncompressedSize, "uncompressed size");
    localHeaderOffset = checkedNumber(localHeaderOffset, "local header offset");
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new ZipStreamError(`Unsupported ZIP compression method for ${fileName}`);
    }

    const unixDirectory = (externalAttributes >>> 16) & 0o170000;
    entries.push({
      entryName: fileName,
      isDirectory: fileName.endsWith("/") || unixDirectory === 0o040000,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0
    });
    cursor += headerLength;
  }
  return entries;
}

export class ZipStreamReader {
  private constructor(
    private readonly archivePath: string,
    private readonly archiveSize: number,
    private readonly handle: fs.FileHandle,
    readonly entries: ZipEntry[]
  ) {}

  static async open(archivePath: string): Promise<ZipStreamReader> {
    const stat = await fs.stat(archivePath);
    if (!stat.isFile()) throw new ZipStreamError("Uploaded ZIP file is not a regular file");
    if (stat.size > MAX_PROJECT_ARCHIVE_BYTES) {
      throw new ZipStreamError(`ZIP exceeds the ${Math.floor(MAX_PROJECT_ARCHIVE_BYTES / 1024 ** 3)} GB import limit`);
    }

    const handle = await fs.open(archivePath, "r");
    try {
      const directory = await readCentralDirectory(handle, stat.size);
      if (directory.size > MAX_CENTRAL_DIRECTORY_BYTES) {
        throw new ZipStreamError("ZIP central directory is too large");
      }
      if (directory.offset + directory.size > stat.size) {
        throw new ZipStreamError("ZIP central directory is outside the archive");
      }
      const entries = parseEntries(
        await readAt(handle, directory.size, directory.offset),
        directory.entryCount
      );
      const totalUncompressed = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
      if (totalUncompressed > MAX_PROJECT_UNCOMPRESSED_BYTES) {
        throw new ZipStreamError(`ZIP expands beyond the ${Math.floor(MAX_PROJECT_UNCOMPRESSED_BYTES / 1024 ** 3)} GB safety limit`);
      }
      return new ZipStreamReader(archivePath, stat.size, handle, entries);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private async dataOffset(entry: ZipEntry): Promise<number> {
    if (entry.encrypted) throw new ZipStreamError(`Encrypted ZIP entry is not supported: ${entry.entryName}`);
    if (entry.localHeaderOffset + 30 > this.archiveSize) {
      throw new ZipStreamError(`Invalid local header offset: ${entry.entryName}`);
    }
    const localHeader = await readAt(this.handle, 30, entry.localHeaderOffset);
    if (localHeader.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
      throw new ZipStreamError(`Malformed ZIP local header: ${entry.entryName}`);
    }
    const fileNameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
    if (dataOffset + entry.compressedSize > this.archiveSize) {
      throw new ZipStreamError(`ZIP entry data is outside the archive: ${entry.entryName}`);
    }
    return dataOffset;
  }

  async createEntryStream(entry: ZipEntry) {
    if (entry.isDirectory) throw new ZipStreamError(`Cannot read ZIP directory: ${entry.entryName}`);
    const start = await this.dataOffset(entry);
    const source = createReadStream(this.archivePath, {
      start,
      end: start + entry.compressedSize - 1
    });
    return entry.compressionMethod === 0 ? source : source.pipe(createInflateRaw());
  }

  async readEntryText(entry: ZipEntry, maxBytes: number): Promise<string> {
    if (entry.uncompressedSize > maxBytes) {
      throw new ZipStreamError(`${entry.entryName} is too large`);
    }
    const stream = await this.createEntryStream(entry);
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) throw new ZipStreamError(`${entry.entryName} is too large`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async extractEntry(
    entry: ZipEntry,
    target: string,
    onBytes?: (bytes: number) => void
  ): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const source = await this.createEntryStream(entry);
    let extractedBytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        extractedBytes += chunk.length;
        if (extractedBytes > entry.uncompressedSize) {
          callback(new ZipStreamError(`ZIP entry expands beyond its declared size: ${entry.entryName}`));
          return;
        }
        onBytes?.(chunk.length);
        callback(null, chunk);
      },
      flush(callback) {
        if (extractedBytes !== entry.uncompressedSize) {
          callback(new ZipStreamError(`ZIP entry size does not match its declared size: ${entry.entryName}`));
          return;
        }
        callback();
      }
    });
    await pipeline(source, counter, createWriteStream(target));
  }
}
