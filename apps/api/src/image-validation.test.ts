import { expect, it } from 'vitest';
import { validatedImageType } from './image-validation.js';

it('checks bounded image content rather than trusting its extension', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9ZlHkAAAAASUVORK5CYII=',
    'base64',
  );
  expect(validatedImageType(png)).toBe('image/png');
  expect(validatedImageType(Buffer.from('not a PNG'))).toBeNull();
  expect(validatedImageType(png.subarray(0, 24))).toBeNull();
  expect(validatedImageType(Buffer.concat([png, Buffer.from('extra')]))).toBeNull();
});
