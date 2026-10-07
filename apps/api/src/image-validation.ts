export function validatedImageType(bytes: Buffer): string | null {
  if (bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
    bytes.subarray(-8, -4).equals(Buffer.from('IEND')) &&
    bytes.readUInt32BE(bytes.length - 12) === 0) {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return null;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      offset += length + 12;
      if (type === 'IEND') return offset === bytes.length ? 'image/png' : null;
    }
  }
  if (bytes.length >= 32 && bytes[0] === 255 && bytes[1] === 216 &&
    bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217 &&
    bytes.includes(Buffer.from([255, 218]))) return 'image/jpeg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) &&
    bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 &&
    bytes[bytes.length - 1] === 0x3b) return 'image/gif';
  return null;
}
