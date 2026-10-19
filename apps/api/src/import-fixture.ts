import { crc32, deflateRawSync } from 'node:zlib';

export function binaryWebloc(url: string, key = 'URL'): Buffer {
  function string(value: string) {
    const unicode = [...value].some((character) => character.charCodeAt(0) > 127);
    const data = unicode ? Buffer.from(value, 'utf16le').swap16() : Buffer.from(value);
    return Buffer.concat([Buffer.from(value.length < 15
      ? [(unicode ? 0x60 : 0x50) | value.length]
      : [unicode ? 0x6f : 0x5f, 0x10, value.length]), data]);
  }
  const objects = [Buffer.from([0xd1, 1, 2]), string(key), string(url)];
  const offsets: number[] = [];
  let size = 8;
  for (const data of objects) { offsets.push(size); size += data.length; }
  const table = Buffer.alloc(objects.length * 2);
  offsets.forEach((offset, index) => table.writeUInt16BE(offset, index * 2));
  const trailer = Buffer.alloc(32);
  trailer[6] = 2;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(size), 24);
  return Buffer.concat([Buffer.from('bplist00'), ...objects, table, trailer]);
}

export function fixtureZip(entries: Array<{ name: string; bytes: Buffer; mode?: number; badCrc?: boolean; compressed?: boolean }>) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = entry.badCrc ? 0 : crc32(entry.bytes);
    const bytes = entry.compressed ? deflateRawSync(entry.bytes) : entry.bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(entry.compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x0314, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x800, 8);
    index.writeUInt16LE(entry.compressed ? 8 : 0, 10);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(bytes.length, 20);
    index.writeUInt32LE(entry.bytes.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    locals.push(header, name, bytes);
    central.push(index, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
