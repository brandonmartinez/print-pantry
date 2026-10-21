import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { decryptAiSecret, encryptAiSecret, loadAiEncryptionKey } from './ai-secrets.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('encrypts credentials with authenticated provider identity and never includes plaintext', () => {
  const key = randomBytes(32);
  const ciphertext = encryptAiSecret('synthetic-provider-credential', key, 'provider-one');
  expect(ciphertext).not.toContain('synthetic-provider-credential');
  expect(decryptAiSecret(ciphertext, key, 'provider-one')).toBe('synthetic-provider-credential');
  expect(() => decryptAiSecret(ciphertext, key, 'provider-two')).toThrow('cannot be decrypted');
  expect(() => decryptAiSecret(ciphertext, randomBytes(32), 'provider-one')).toThrow('cannot be decrypted');
  expect(() => decryptAiSecret(ciphertext.replace('v1.', 'v2.'), key, 'provider-one')).toThrow('cannot be decrypted');
});

it('creates a private persistent development key without replacing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pantry-ai-key-')); roots.push(root);
  const path = join(root, 'private/key');
  const first = await loadAiEncryptionKey(path, true);
  expect(first?.length).toBe(32);
  expect(await loadAiEncryptionKey(path, true)).toEqual(first);
  expect(await loadAiEncryptionKey()).toBeUndefined();
});

it('rejects unprotected key files and invalid sizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pantry-ai-key-')); roots.push(root);
  const path = join(root, 'key');
  await writeFile(path, randomBytes(32), { mode: 0o644 });
  await expect(loadAiEncryptionKey(path)).rejects.toThrow('private regular file');
  await chmod(path, 0o600);
  await writeFile(path, 'short');
  await expect(loadAiEncryptionKey(path)).rejects.toThrow('32 bytes');
});