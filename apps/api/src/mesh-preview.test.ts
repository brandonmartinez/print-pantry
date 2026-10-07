import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { readStlTriangles, renderStlPreview } from './mesh-preview.js';

it('renders a bounded generated SVG for validated binary STL content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pantry-stl-'));
  try {
    const bytes = Buffer.alloc(134);
    bytes.writeUInt32LE(1, 80);
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((point, vertex) =>
      point.forEach((coordinate, axis) => bytes.writeFloatLE(coordinate, 96 + vertex * 12 + axis * 4)));
    const file = path.join(root, 'part.stl');
    await writeFile(file, bytes);
    const handle = await open(file);
    try {
      expect((await renderStlPreview(handle, bytes.length)).toString()).toContain('<polygon');
      expect(await readStlTriangles(handle, bytes.length)).toHaveLength(1);
      await expect(renderStlPreview(handle, 33 * 1024 * 1024)).rejects.toThrow('too large');
    } finally {
      await handle.close();
    }
    await writeFile(file, Buffer.from('not an STL'));
    const invalid = await open(file);
    try {
      await expect(renderStlPreview(invalid, 10)).rejects.toThrow();
    } finally {
      await invalid.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
