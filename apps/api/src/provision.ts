import { randomUUID } from 'node:crypto';
import { createPool } from '@print-pantry/db';
import { hashPassword } from './auth.js';

async function promptPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('Account provisioning requires an interactive terminal; passwords are never accepted as command arguments');
  }
  process.stdout.write('New password (minimum 12 characters): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const bytes: number[] = [];
  try {
    for await (const chunk of process.stdin) {
      for (const byte of chunk as Buffer) {
        if (byte === 3) throw new Error('Canceled');
        if (byte === 13 || byte === 10) {
          process.stdout.write('\n');
          return Buffer.from(bytes).toString('utf8');
        }
        if (byte === 127) {
          while (bytes.length && (bytes.pop()! & 0xc0) === 0x80) { /* remove UTF-8 code point */ }
        } else {
          if (byte < 32) throw new Error('Control characters are not allowed in passwords');
          if (bytes.length >= 1024) throw new Error('Password exceeds 1024 bytes');
          bytes.push(byte);
        }
      }
    }
    throw new Error('Password input closed');
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

const [usernameInput, role] = process.argv.slice(2);
const username = usernameInput?.toLowerCase();
if (!username || !/^[a-z][a-z0-9._-]{2,31}$/.test(username) ||
    (role !== 'operator' && role !== 'requester')) {
  throw new Error('Usage: npm run account:create -w @print-pantry/api -- <username> <operator|requester>');
}
const pool = createPool(process.env.DATABASE_URL ?? '');
try {
  const passwordHash = await hashPassword(await promptPassword());
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('print_pantry_account_provision'))");
    const existing = await connection.query('SELECT id FROM users LIMIT 1');
    if (!existing.rows.length && role !== 'operator') throw new Error('The first account must be an operator');
    await connection.query(
      'INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      [randomUUID(), username, passwordHash, role],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  process.stdout.write(`Created ${role} account ${username}.\n`);
} finally {
  await pool.end();
}
