import type { FileHandle } from 'node:fs/promises';

const maxMeshBytes = 32 * 1024 * 1024;
const maxTriangles = 100_000;
const previewTriangles = 1_500;
type Point = [number, number, number];
type Triangle = [Point, Point, Point];

function project([x, y, z]: Point): [number, number] {
  return [x * .87 - y * .87, x * .5 + y * .5 - z];
}

function render(triangles: Triangle[]): Buffer {
  if (!triangles.length) throw new Error('Mesh has no usable triangles');
  const projected = triangles.map((triangle) => triangle.map(project));
  const coordinates = projected.flat();
  const bounds = [
    Math.min(...coordinates.map(([x]) => x)), Math.min(...coordinates.map(([, y]) => y)),
    Math.max(...coordinates.map(([x]) => x)), Math.max(...coordinates.map(([, y]) => y)),
  ];
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 1);
  const scale = 200 / span;
  const polygons = projected.map((triangle) =>
    `<polygon points="${triangle.map(([x, y]) =>
      `${((x - bounds[0]) * scale + 12).toFixed(2)},${((y - bounds[1]) * scale + 12).toFixed(2)}`).join(' ')}"/>`,
  ).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 224 224" role="img" aria-label="Generated mesh preview"><rect width="224" height="224" fill="#f1f0ea"/><g fill="#c9d9c8" stroke="#526b58" stroke-width=".65" stroke-linejoin="round">${polygons}</g></svg>`);
}

export async function renderStlPreview(file: FileHandle, size: number): Promise<Buffer> {
  if (size < 84 || size > maxMeshBytes) throw new Error('Mesh is too large or incomplete for preview');
  const header = Buffer.alloc(84);
  const read = await file.read(header, 0, 84, 0);
  if (read.bytesRead !== 84) throw new Error('Mesh changed during preview');
  const count = header.readUInt32LE(80);
  const binary = count > 0 && count <= maxTriangles && 84 + count * 50 === size;
  const triangles: Triangle[] = [];
  if (binary) {
    const stride = Math.max(1, Math.ceil(count / previewTriangles));
    const record = Buffer.alloc(50);
    for (let index = 0; index < count; index += stride) {
      const result = await file.read(record, 0, 50, 84 + index * 50);
      if (result.bytesRead !== 50) throw new Error('Mesh changed during preview');
      const triangle = [0, 1, 2].map((vertex) => [0, 1, 2].map((axis) =>
        record.readFloatLE(12 + vertex * 12 + axis * 4)) as Point) as Triangle;
      if (triangle.flat().every(Number.isFinite)) triangles.push(triangle);
    }
  } else {
    if (size > 8 * 1024 * 1024) throw new Error('ASCII mesh is too large for preview');
    const text = Buffer.alloc(size);
    const result = await file.read(text, 0, size, 0);
    if (result.bytesRead !== size) throw new Error('Mesh changed during preview');
    const ascii = text.toString('utf8');
    if (!ascii.trimStart().startsWith('solid') || !ascii.includes('endsolid')) {
      throw new Error('Invalid STL mesh');
    }
    const vertices: Point[] = [];
    let count = 0;
    for (const match of ascii.matchAll(/\bvertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/gi)) {
      vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
      if (vertices.length === 3) {
        count++;
        if (count > maxTriangles) throw new Error('Mesh has too many triangles');
        if (count <= previewTriangles) triangles.push([...vertices] as Triangle);
        else if (count % Math.ceil(count / previewTriangles) === 0) {
          triangles[count % previewTriangles] = [...vertices] as Triangle;
        }
        vertices.length = 0;
      }
    }
    if (vertices.length) throw new Error('Incomplete STL triangle');
  }
  return render(triangles);
}
