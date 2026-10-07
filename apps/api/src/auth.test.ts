import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './auth.js';

describe('household passwords', () => {
  it('uses salted scrypt verification without storing plaintext', async () => {
    const first = await hashPassword('long unique household passphrase');
    const second = await hashPassword('long unique household passphrase');
    expect(first).not.toBe(second);
    expect(first).not.toContain('household');
    expect(await verifyPassword('long unique household passphrase', first)).toBe(true);
    expect(await verifyPassword('other household passphrase', first)).toBe(false);
    expect(await verifyPassword('long unique household passphrase', 'invalid')).toBe(false);
  });

  it('rejects unsafe bootstrap passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
    await expect(hashPassword('x'.repeat(1025))).rejects.toThrow();
  });
});
