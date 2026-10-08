import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

const MAX_ENTRIES = 4096;
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_TRIANGLES = 250_000;
const PREVIEW_TRIANGLES = 75_000;
export type Point3mf = [number, number, number];
export type Triangle3mf = [Point3mf, Point3mf, Point3mf];

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

function readModelEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_MODEL_BYTES) throw new Invalid3mfError('3MF model exceeds size limit');
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(archiveError(error ?? new Invalid3mfError('Unable to read 3MF model')));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_MODEL_BYTES) stream.destroy(new Invalid3mfError('3MF model exceeds size limit'));
        else chunks.push(chunk);
      });
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', (reason) => reject(archiveError(reason)));
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

type Transform3mf = [number, number, number, number, number, number, number, number, number, number, number, number];
const identityTransform: Transform3mf = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e9) throw new Invalid3mfError(`Invalid 3MF ${label}`);
  return number;
}

function transform(value: unknown): Transform3mf {
  if (value == null || value === '') return identityTransform;
  const values = String(value).trim().split(/\s+/).map((item) => finiteNumber(item, 'transform'));
  if (values.length !== 12) throw new Invalid3mfError('Invalid 3MF transform');
  return values as Transform3mf;
}

function transformPoint([x, y, z]: Point3mf, matrix: Transform3mf): Point3mf {
  return [
    x * matrix[0] + y * matrix[3] + z * matrix[6] + matrix[9],
    x * matrix[1] + y * matrix[4] + z * matrix[7] + matrix[10],
    x * matrix[2] + y * matrix[5] + z * matrix[8] + matrix[11],
  ];
}

function parse3mfModel(documents: { path: string; xml: string }[]): { triangles: Triangle3mf[]; sampled: boolean } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true });
  const models = new Map<string, Record<string, unknown>>();
  for (const document of documents) {
    if (XMLValidator.validate(document.xml) !== true) throw new Invalid3mfError('3MF model XML is invalid');
    const parsed = parser.parse(document.xml) as { model?: Record<string, unknown> };
    if (!parsed.model) throw new Invalid3mfError('3MF model root is missing');
    models.set(document.path.replace(/^\//, ''), parsed.model);
  }
  const rootPath = documents.find((document) => /^3D\/3dmodel\.model$/i.test(document.path))?.path
    ?? documents[0]?.path;
  const rootModel = rootPath ? models.get(rootPath.replace(/^\//, '')) : undefined;
  const build = rootModel?.build as Record<string, unknown> | undefined;
  if (!rootModel || !build) throw new Invalid3mfError('3MF model has no buildable objects');

  const resolveObject = (partPath: string, id: string, ancestry: Set<string>): Triangle3mf[] => {
    const normalizedPath = partPath.replace(/^\//, '');
    const objectKey = `${normalizedPath}#${id}`;
    if (ancestry.has(objectKey) || ancestry.size > 32) throw new Invalid3mfError('3MF component cycle exceeds limits');
    const part = models.get(normalizedPath);
    const resources = part?.resources as Record<string, unknown> | undefined;
    const objects = new Map(nodes(resources?.object).map((object) => [String(object.id), object]));
    const object = objects.get(id);
    if (!object) throw new Invalid3mfError('3MF component references an unknown object');
    const nextAncestry = new Set(ancestry).add(objectKey);
    const mesh = object.mesh as Record<string, unknown> | undefined;
    if (mesh) {
      const verticesNode = mesh.vertices as Record<string, unknown> | undefined;
      const trianglesNode = mesh.triangles as Record<string, unknown> | undefined;
      const vertices = nodes(verticesNode?.vertex).map((vertex): Point3mf => [
        finiteNumber(vertex.x, 'vertex'), finiteNumber(vertex.y, 'vertex'), finiteNumber(vertex.z, 'vertex'),
      ]);
      const result = nodes(trianglesNode?.triangle).map((triangle): Triangle3mf => {
        const indices = [triangle.v1, triangle.v2, triangle.v3].map((value) => finiteNumber(value, 'triangle index'));
        if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertices.length)) {
          throw new Invalid3mfError('3MF triangle references an invalid vertex');
        }
        return [vertices[indices[0]], vertices[indices[1]], vertices[indices[2]]];
      });
      if (result.length > MAX_MODEL_TRIANGLES) throw new Invalid3mfError('3MF model has too many triangles');
      return result;
    }
    const components = object.components as Record<string, unknown> | undefined;
    const result: Triangle3mf[] = [];
    for (const component of nodes(components?.component)) {
      const matrix = transform(component.transform);
      const componentPath = component.path == null ? normalizedPath : String(component.path).replace(/^\//, '');
      for (const triangle of resolveObject(componentPath, String(component.objectid), nextAncestry)) {
        result.push(triangle.map((point) => transformPoint(point, matrix)) as Triangle3mf);
        if (result.length > MAX_MODEL_TRIANGLES) throw new Invalid3mfError('3MF model has too many triangles');
      }
    }
    return result;
  };

  const triangles: Triangle3mf[] = [];
  for (const item of nodes(build.item)) {
    const matrix = transform(item.transform);
    const itemPath = item.path == null ? rootPath! : String(item.path).replace(/^\//, '');
    for (const triangle of resolveObject(itemPath, String(item.objectid), new Set())) {
      triangles.push(triangle.map((point) => transformPoint(point, matrix)) as Triangle3mf);
      if (triangles.length > MAX_MODEL_TRIANGLES) throw new Invalid3mfError('3MF model has too many triangles');
    }
  }
  if (!triangles.length) throw new Invalid3mfError('3MF model has no mesh triangles');
  if (triangles.length <= PREVIEW_TRIANGLES) return { triangles, sampled: false };
  const stride = triangles.length / PREVIEW_TRIANGLES;
  return {
    triangles: Array.from({ length: PREVIEW_TRIANGLES }, (_, index) => triangles[Math.floor(index * stride)]),
    sampled: true,
  };
}

export async function read3mfGeometryFromHandle(
  handle: FileHandle,
): Promise<{ triangles: Triangle3mf[]; sampled: boolean }> {
  const zip = await openZip(handle);
  const entries = await listEntries(zip);
  const models = entries.filter((entry) => /^3D\/.+\.model$/i.test(entry.fileName));
  if (!models.length) throw new Invalid3mfError('3MF model part is missing');
  if (models.reduce((size, entry) => size + entry.uncompressedSize, 0) > MAX_MODEL_BYTES) {
    throw new Invalid3mfError('3MF model exceeds size limit');
  }
  const documents = [];
  for (const model of models) {
    documents.push({ path: model.fileName, xml: (await readModelEntry(zip, model)).toString('utf8') });
  }
  return parse3mfModel(documents);
}
