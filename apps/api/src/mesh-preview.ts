import type { FileHandle } from 'node:fs/promises';

const maxMeshBytes = 32 * 1024 * 1024;
const maxTriangles = 250_000;
const previewTriangles = 5_000;
export const interactivePreviewTriangles = 75_000;
export type Point = [number, number, number];
export type Triangle = [Point, Point, Point];

export class InvalidMeshError extends Error {}
export class MeshChangedError extends Error {}

function project([x, y, z]: Point): [number, number] {
  return [x * .87 - y * .87, x * .5 + y * .5 - z];
}

function render(triangles: Triangle[]): Buffer {
  if (!triangles.length) throw new InvalidMeshError('Mesh has no usable triangles');
  const faces = triangles.map((triangle) => ({
    triangle,
    projected: triangle.map(project),
    depth: triangle.reduce((sum, [x, y, z]) => sum + x + y + z, 0) / 3,
  })).sort((left, right) => left.depth - right.depth);
  const coordinates = faces.flatMap((face) => face.projected);
  const bounds = [
    Math.min(...coordinates.map(([x]) => x)), Math.min(...coordinates.map(([, y]) => y)),
    Math.max(...coordinates.map(([x]) => x)), Math.max(...coordinates.map(([, y]) => y)),
  ];
  const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 1);
  const scale = 172 / span;
  const offsetX = (224 - (bounds[2] - bounds[0]) * scale) / 2;
  const offsetY = (224 - (bounds[3] - bounds[1]) * scale) / 2;
  const polygons = faces.map(({ triangle, projected }) => {
    const [first, second, third] = triangle;
    const edgeOne = second.map((value, axis) => value - first[axis]);
    const edgeTwo = third.map((value, axis) => value - first[axis]);
    const normal = [
      edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
      edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
      edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
    ];
    const normalLength = Math.hypot(...normal) || 1;
    const diffuse = Math.abs((normal[0] * .32 - normal[1] * .42 + normal[2] * .85) / normalLength);
    const intensity = .62 + diffuse * .38;
    const color = [112, 145, 118].map((channel) => Math.min(255, Math.round(channel * intensity)));
    const fill = `rgb(${color.join(' ')})`;
    const points = projected.map(([x, y]) =>
      `${((x - bounds[0]) * scale + offsetX).toFixed(2)},${((y - bounds[1]) * scale + offsetY).toFixed(2)}`).join(' ');
    return `<polygon points="${points}" fill="${fill}" stroke="${fill}" stroke-width=".35" stroke-linejoin="round"/>`;
  },
  ).join('');
  const shadowY = Math.min(211, (bounds[3] - bounds[1]) * scale + offsetY + 3);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="224" height="224" viewBox="0 0 224 224" role="img" aria-label="Generated mesh preview"><rect width="224" height="224" fill="#f1f2ec"/><ellipse cx="112" cy="${shadowY.toFixed(2)}" rx="68" ry="7" fill="#34483c" opacity=".14"/>${polygons}</svg>`);
}

export async function readStlTriangles(
  file: FileHandle,
  size: number,
  triangleLimit = previewTriangles,
): Promise<Triangle[]> {
  if (size < 84 || size > maxMeshBytes) throw new InvalidMeshError('Mesh is too large or incomplete for preview');
  const header = Buffer.alloc(84);
  const read = await file.read(header, 0, 84, 0);
  if (read.bytesRead !== 84) throw new MeshChangedError('Mesh changed during preview');
  const count = header.readUInt32LE(80);
  const binary = count > 0 && count <= maxTriangles && 84 + count * 50 === size;
  const triangles: Triangle[] = [];
  if (binary) {
    const stride = Math.max(1, Math.ceil(count / triangleLimit));
    const record = Buffer.alloc(50);
    for (let index = 0; index < count; index += stride) {
      const result = await file.read(record, 0, 50, 84 + index * 50);
      if (result.bytesRead !== 50) throw new MeshChangedError('Mesh changed during preview');
      const triangle = [0, 1, 2].map((vertex) => [0, 1, 2].map((axis) =>
        record.readFloatLE(12 + vertex * 12 + axis * 4)) as Point) as Triangle;
      if (triangle.flat().every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e9)) {
        triangles.push(triangle);
      }
    }
  } else {
    if (size > 8 * 1024 * 1024) throw new InvalidMeshError('ASCII mesh is too large for preview');
    const text = Buffer.alloc(size);
    const result = await file.read(text, 0, size, 0);
    if (result.bytesRead !== size) throw new MeshChangedError('Mesh changed during preview');
    const ascii = text.toString('utf8');
    if (!/^\s*solid\b/i.test(ascii) || !/\bendsolid\b/i.test(ascii)) {
      throw new InvalidMeshError('Invalid STL mesh');
    }
    const vertices: Point[] = [];
    let count = 0;
    for (const match of ascii.matchAll(/\bvertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/gi)) {
      vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
      if (vertices.length === 3) {
        count++;
        if (count > maxTriangles) throw new InvalidMeshError('Mesh has too many triangles');
        if (vertices.flat().every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e9) &&
          count <= triangleLimit) triangles.push([...vertices] as Triangle);
        else if (count % Math.ceil(count / triangleLimit) === 0) {
          if (vertices.flat().every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e9)) {
            triangles[count % triangleLimit] = [...vertices] as Triangle;
          }
        }
        vertices.length = 0;
      }
    }
    if (vertices.length) throw new InvalidMeshError('Incomplete STL triangle');
  }
  if (!triangles.length) throw new InvalidMeshError('Mesh has no usable triangles');
  return triangles;
}

export async function renderStlPreview(file: FileHandle, size: number): Promise<Buffer> {
  return render(await readStlTriangles(file, size));
}
