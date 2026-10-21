import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export class AiError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function encryptAiSecret(secret: string, key: Buffer, providerId: string): string {
  if (key.length !== 32) throw new AiError('AI credential encryption is not configured', 503);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(providerId));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptAiSecret(value: string, key: Buffer, providerId: string): string {
  try {
    const [version, nonce, tag, encrypted, extra] = value.split('.');
    if (version !== 'v1' || extra !== undefined || key.length !== 32) throw new Error('Invalid encrypted credential');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(providerId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new AiError('Saved AI credentials cannot be decrypted. Restore the encryption key or replace the credentials in AI settings.', 503); }
}

export async function loadAiEncryptionKey(path?: string, create = false): Promise<Buffer | undefined> {
  if (!path) return undefined;
  if (create) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new AiError('AI encryption key file could not be created', 503); }
  }
  try {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== 32 || (info.mode & 0o077) !== 0) throw new Error('Invalid key file');
      return await handle.readFile();
    } finally { await handle.close(); }
  } catch { throw new AiError('AI encryption key file must be a private regular file containing exactly 32 bytes', 503); }
}