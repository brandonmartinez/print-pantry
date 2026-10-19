import { extname, basename } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { isOsMetadata } from './os-metadata.js';

export const sourceSidecarLimit = 128 * 1024;

export class SourceSidecarError extends Error {}

export function isSourceSidecar(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (isOsMetadata(path)) return false;
  return ['.webloc', '.url'].includes(extname(name)) ||
    ['project.json', 'metadata.json', 'agentic-plan.json'].includes(name);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(bytes: Buffer): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c ? 'utf-16be'
      : bytes[0] === 0x3c && bytes[1] === 0 ? 'utf-16le' : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function binaryPlistUrls(bytes: Buffer): string[] {
  if (bytes.length < 40 || bytes.subarray(0, 8).toString() !== 'bplist00') throw new SourceSidecarError('Invalid binary plist header');
  const trailer = bytes.length - 32;
  function uint(offset: number, size: number, end = bytes.length): number {
    if (!Number.isInteger(offset) || size < 1 || size > 8 || offset < 0 || offset + size > end) {
      throw new SourceSidecarError('Invalid binary plist offset');
    }
    let value = 0n;
    for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new SourceSidecarError('Binary plist integer exceeds safe limits');
    return Number(value);
  }
  const offsetSize = bytes[trailer + 6];
  const refSize = bytes[trailer + 7];
  const count = uint(trailer + 8, 8);
  const root = uint(trailer + 16, 8);
  const table = uint(trailer + 24, 8);
  if (!count || count > 4096 || root >= count || table < 8 || table + count * offsetSize > trailer ||
      offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) {
    throw new SourceSidecarError('Binary plist object table exceeds validation limits');
  }
  function entry(id: number) {
    if (id >= count) throw new SourceSidecarError('Invalid binary plist object reference');
    const offset = uint(table + id * offsetSize, offsetSize, trailer);
    if (offset < 8 || offset >= table) throw new SourceSidecarError('Invalid binary plist object location');
    const type = bytes[offset] >> 4;
    let length = bytes[offset] & 15;
    let start = offset + 1;
    if (length === 15) {
      if (start >= table || bytes[start] >> 4 !== 1) throw new SourceSidecarError('Invalid binary plist object length');
      const size = 2 ** (bytes[start] & 15);
      length = uint(start + 1, size, table);
      start += 1 + size;
    }
    return { type, length, start };
  }
  function string(id: number): string {
    const value = entry(id);
    const size = value.length * (value.type === 6 ? 2 : 1);
    if (![5, 6, 7].includes(value.type) || value.length > 8192 || value.start + size > table) {
      throw new SourceSidecarError('Source URL or key is not a bounded plist string');
    }
    const data = bytes.subarray(value.start, value.start + size);
    if (value.type === 5 && data.some((byte) => byte > 127)) throw new SourceSidecarError('Invalid ASCII plist string');
    return new TextDecoder(value.type === 6 ? 'utf-16be' : 'utf-8', { fatal: true }).decode(data);
  }
  const dict = entry(root);
  if (dict.type !== 13 || dict.length > 128 || dict.start + dict.length * refSize * 2 > table) {
    throw new SourceSidecarError('Binary webloc must contain a bounded root dictionary');
  }
  const urls: string[] = [];
  for (let i = 0; i < dict.length; i++) {
    const key = string(uint(dict.start + i * refSize, refSize, table));
    if (!['URL', 'URLString'].includes(key)) continue;
    urls.push(string(uint(dict.start + (dict.length + i) * refSize, refSize, table)));
  }
  return urls;
}

function xmlPlistUrls(contents: string): string[] {
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(contents)) throw new SourceSidecarError('XML entity declarations and internal DTD subsets are not allowed');
  const validation = XMLValidator.validate(contents);
  if (validation !== true) throw new SourceSidecarError('Malformed XML webloc');
  const parsed: unknown = new XMLParser({
    preserveOrder: true, parseTagValue: false, maxNestedTags: 16, processEntities: true,
  }).parse(contents);
  function child(nodes: unknown, name: string): unknown[] | undefined {
    if (!Array.isArray(nodes)) return;
    const node: unknown = nodes.find((item: unknown) => object(item) && name in item);
    return object(node) && Array.isArray(node[name]) ? node[name] : undefined;
  }
  function content(nodes: unknown[]): string {
    return nodes.map((node: unknown) => {
      if (!object(node) || typeof node['#text'] !== 'string') throw new SourceSidecarError('Plist URL keys and values must be plain text');
      return node['#text'];
    }).join('');
  }
  const dict = child(child(parsed, 'plist'), 'dict');
  if (!dict || dict.length > 256) throw new SourceSidecarError('XML webloc must contain a bounded root dictionary');
  const urls: string[] = [];
  for (let i = 0; i < dict.length; i++) {
    const key = child([dict[i]], 'key');
    if (!key || !['URL', 'URLString'].includes(content(key))) continue;
    const value = child([dict[i + 1]], 'string');
    if (!value) throw new SourceSidecarError('Plist URL must be followed by a string value');
    urls.push(content(value));
  }
  return urls;
}

export function sidecarUrls(path: string, bytes: Buffer): string[] {
  if (bytes.length > sourceSidecarLimit) throw new SourceSidecarError('Source sidecar exceeds 128 KiB');
  let urls: string[];
  try {
    if (extname(path).toLowerCase() === '.webloc') {
      urls = bytes.subarray(0, 6).toString() === 'bplist' ? binaryPlistUrls(bytes) : xmlPlistUrls(text(bytes));
    } else if (extname(path).toLowerCase() === '.url') {
      let shortcut = false;
      urls = [];
      for (const line of text(bytes).split(/\r?\n/)) {
        const section = line.trim().match(/^\[([^\]]+)\]$/);
        if (section) shortcut = section[1].toLowerCase() === 'internetshortcut';
        else if (shortcut) {
          const url = line.match(/^\s*URL\s*=(.*)$/i);
          if (url) urls.push(url[1].trim());
        }
      }
    } else {
      const data: unknown = JSON.parse(text(bytes));
      if (!object(data)) throw new SourceSidecarError('Source metadata must contain a JSON object');
      const records: Record<string, unknown>[] = [data];
      if (object(data.source)) records.push(data.source);
      if (object(data.metadata)) records.push(data.metadata);
      if (basename(path).toLowerCase() === 'agentic-plan.json' && Array.isArray(data.files)) {
        if (data.files.length > 1000) throw new SourceSidecarError('Organizer metadata exceeds its file-record limit');
        records.push(...data.files.filter(object));
      }
      urls = records.flatMap((record) => ['sourceUrl', 'source_url', ...(record === data.source ? ['url'] : [])]
        .flatMap((key) => typeof record[key] === 'string' ? [record[key]] : []));
    }
  } catch (error) {
    if (error instanceof SourceSidecarError) throw error;
    if (error instanceof Error) throw new SourceSidecarError(`Cannot parse source sidecar: ${error.message.slice(0, 180)}`);
    throw error;
  }
  if (!urls.length) throw new SourceSidecarError('No recognized source URL field was found');
  if (urls.length > 128) throw new SourceSidecarError('Sidecar contains too many source URL fields');
  return [...new Set(urls)];
}
