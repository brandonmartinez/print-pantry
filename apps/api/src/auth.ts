import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { createPool } from '@print-pantry/db';

const scrypt = promisify(scryptCallback);
const cookieName = 'pantry_session';
const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;
const loginWindowMs = 5 * 60 * 1000;
const dummyPasswordHash = 'scrypt$9ca703e5f83d84dbb8f03d85ed2a9967$c420a9cda08680492fe28590083c99620db4dd437dbffae543da4ac6e4eeaddd';

type Pool = ReturnType<typeof createPool>;
export type User = { id: string; username: string; role: 'operator' | 'requester' };
type Account = User & { password_hash: string };

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error('Password must be at least 12 characters and no more than 1024 bytes');
  }
  const salt = randomBytes(16).toString('hex');
  const digest = await scrypt(password, Buffer.from(salt, 'hex'), 32) as Buffer;
  return `scrypt$${salt}$${digest.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' ||
    !/^[0-9a-f]{32}$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2]) ||
    Buffer.byteLength(password) > 1024) return false;
  const actual = await scrypt(password, Buffer.from(parts[1], 'hex'), 32) as Buffer;
  return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}

function readSessionCookie(request: FastifyRequest): string | null {
  const cookies = request.headers.cookie?.split(';').map((entry) => entry.trim()) ?? [];
  const found = cookies.filter((entry) => entry.startsWith(`${cookieName}=`));
  if (found.length !== 1) return null;
  const token = found[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function sessionCookie(token: string, secure: boolean): string {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeMs / 1000}${secure ? '; Secure' : ''}`;
}

export function createAuth(server: FastifyInstance, pool: Pool, secureCookie: boolean) {
  const loggedIn = new WeakMap<FastifyRequest, User>();
  const loginAttempts = new Map<string, { count: number; expiresAt: number }>();

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = readSessionCookie(request);
    if (!token) {
      await reply.code(401).send({ error: 'Sign in to continue' });
      return;
    }
    const result = await pool.query<User>(
      `SELECT u.id, u.username, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash(token)],
    );
    const user = result.rows[0];
    if (!user) {
      await reply.code(401).send({ error: 'Session expired; sign in again' });
      return;
    }
    loggedIn.set(request, user);
  }

  function currentUser(request: FastifyRequest): User {
    const user = loggedIn.get(request);
    if (!user) throw new Error('Authenticated user missing');
    return user;
  }

  async function operatorOnly(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await authenticate(request, reply);
    if (!reply.sent && currentUser(request).role !== 'operator') {
      await reply.code(403).send({ error: 'Operator access required' });
    }
  }

  server.post<{ Body: { username: string; password: string } }>('/auth/login', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['username', 'password'],
        properties: { username: { type: 'string', minLength: 3, maxLength: 32 }, password: { type: 'string', minLength: 1, maxLength: 1024 } },
      },
    },
  }, async (request, reply) => {
    const now = Date.now();
    for (const [address, attempt] of loginAttempts) {
      if (attempt.expiresAt <= now) loginAttempts.delete(address);
    }
    const address = request.ip;
    const attempt = loginAttempts.get(address);
    if (attempt && attempt.count >= 10) {
      reply.header('Retry-After', Math.ceil((attempt.expiresAt - now) / 1000));
      return reply.code(429).send({ error: 'Too many sign-in attempts; try again later' });
    }
    loginAttempts.set(address, {
      count: (attempt?.count ?? 0) + 1, expiresAt: attempt?.expiresAt ?? now + loginWindowMs,
    });
    const username = request.body.username.trim().toLowerCase();
    const result = await pool.query<Account>(
      'SELECT id, username, role, password_hash FROM users WHERE username = $1', [username],
    );
    const account = result.rows[0];
    const valid = await verifyPassword(request.body.password, account?.password_hash ?? dummyPasswordHash);
    if (!account || !valid) {
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    loginAttempts.delete(address);

    const token = randomBytes(32).toString('base64url');
    await pool.query(
      'INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)',
      [randomUUID(), tokenHash(token), account.id, new Date(Date.now() + sessionLifetimeMs)],
    );
    reply.header('Set-Cookie', sessionCookie(token, secureCookie));
    return { user: { id: account.id, username: account.username, role: account.role } };
  });

  server.get('/auth/me', { preHandler: authenticate }, async (request) => ({ user: currentUser(request) }));
  server.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const token = readSessionCookie(request);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
    reply.header('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`);
    return reply.code(204).send();
  });

  return { authenticate, operatorOnly, currentUser };
}
