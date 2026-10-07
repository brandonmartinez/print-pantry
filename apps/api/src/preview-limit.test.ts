import { expect, it } from 'vitest';
import { createPreviewLimiter, PreviewBusyError } from './preview-limit.js';

it('limits active preview work and bounds queued requests', async () => {
  const limited = createPreviewLimiter(2, 1);
  const release: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const work = () => limited(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => release.push(resolve));
    active--;
  });
  const first = work();
  const second = work();
  const third = work();
  await expect(work()).rejects.toThrow(PreviewBusyError);
  expect(peak).toBe(2);
  release.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(peak).toBe(2);
  release.shift()!();
  release.shift()!();
  await Promise.all([first, second, third]);
});
