import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

const MAX_ENTRIES = 4096;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

export class Invalid3mfError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Invalid3mfError';
  }
}

function archiveError(error: unknown): Error {
  if (error instanceof Invalid3mfError) return error;
  if (error instanceof Error && /^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code ?? '')) return error;
  return new Invalid3mfError('Invalid 3MF archive', { cause: error });
}

function openZip(handle: FileHandle): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromFd(handle.fd, { lazyEntries: true, autoClose: false, strictFileNames: true,
      validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) reject(archiveError(error ?? new Invalid3mfError('Unable to open 3MF archive')));
      else resolve(archive);
    });
  });
}

function listEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    let filenameBytes = 0;
    zip.on('entry', (entry: Entry) => {
      filenameBytes += Buffer.byteLength(entry.fileName);
      if (entries.length >= MAX_ENTRIES || filenameBytes > 1024 * 1024) {
        reject(new Invalid3mfError('3MF archive exceeds metadata limits'));
        return;
      }
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', (error) => reject(archiveError(error)));
    zip.readEntry();
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_THUMBNAIL_BYTES) throw new Invalid3mfError('3MF thumbnail exceeds size limit');
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(archiveError(error ?? new Invalid3mfError('Unable to read 3MF thumbnail')));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_THUMBNAIL_BYTES) stream.destroy(new Invalid3mfError('3MF thumbnail exceeds size limit'));
        else chunks.push(chunk);
      });
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', (error) => reject(archiveError(error)));
    });
  });
}

function readPrefix(zip: ZipFile, entry: Entry, limit = 64 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(archiveError(error ?? new Invalid3mfError('Unable to read 3MF model')));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        const remaining = limit - total;
        chunks.push(chunk.subarray(0, remaining));
        total += Math.min(chunk.length, remaining);
        if (total >= limit) {
          resolve(Buffer.concat(chunks));
          stream.destroy();
        }
      });
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', (error) => reject(archiveError(error)));
    });
  });
}

function imageType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 32_000_000) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export async function validateImage(file: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const valid = imageType(bytes.subarray(0, bytesRead)) !== null
      || (ext === '.gif' && bytes.subarray(0, 4).toString() === 'GIF8')
      || (ext === '.webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
      || (ext === '.svg' && /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(bytes.subarray(0, bytesRead).toString()));
    if (!valid) throw new Error('Image header does not match a supported image format');
  } finally {
    await handle.close();
  }
}

async function inspectZip(zip: ZipFile): Promise<{ entryName: string; bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' } | null> {
  const entries = await listEntries(zip);
  const types = entries.find((entry) => entry.fileName === '[Content_Types].xml');
  const model = entries.find((entry) => /^3D\/.+\.model$/i.test(entry.fileName));
  if (!types || !model) throw new Invalid3mfError('3MF archive is missing its content types or model');
  if (!/<Types(?:\s|\/|>)/.test((await readPrefix(zip, types)).toString())
    || !/<model(?:\s|\/|>)/.test((await readPrefix(zip, model)).toString())) {
    throw new Invalid3mfError('3MF archive has invalid content types or model XML');
  }
  const thumbnail = entries.find((entry) => /(?:^|\/)thumbnail\.(?:png|jpe?g)$/i.test(entry.fileName));
  if (!thumbnail) return null;
  const bytes = await readEntry(zip, thumbnail);
  const mimeType = imageType(bytes);
  if (!mimeType) throw new Invalid3mfError(`Invalid 3MF thumbnail: ${thumbnail.fileName}`);
  return { entryName: thumbnail.fileName, bytes, mimeType };
}

export async function inspectThreeMf(file: string): Promise<string | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return (await inspectZip(await openZip(handle)))?.entryName ?? null;
  } finally {
    await handle.close();
  }
}

export async function readThreeMfThumbnail(file: string, entryName: string): Promise<{ bytes: Buffer; contentType: string }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const zip = await openZip(handle);
    const entries = await listEntries(zip);
    const entry = entries.find((candidate) => candidate.fileName === entryName
      && /(?:^|\/)thumbnail\.(?:png|jpe?g)$/i.test(candidate.fileName));
    if (!entry) throw new Invalid3mfError('3MF thumbnail not found');
    const bytes = await readEntry(zip, entry);
    const contentType = imageType(bytes);
    if (!contentType) throw new Invalid3mfError('Invalid 3MF thumbnail');
    return { bytes, contentType };
  } finally {
    await handle.close();
  }
}

export async function read3mfThumbnailFromHandle(
  handle: FileHandle,
): Promise<{ mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer } | null> {
  const preview = await inspectZip(await openZip(handle));
  return preview ? { bytes: preview.bytes, mimeType: preview.mimeType } : null;
}

export async function read3mfThumbnail(file: string): Promise<{ mimeType: 'image/png' | 'image/jpeg'; bytes: Buffer } | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await read3mfThumbnailFromHandle(handle);
  } finally {
    await handle.close();
  }
}
