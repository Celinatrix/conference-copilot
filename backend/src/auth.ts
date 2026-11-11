import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';

export const SESSION_COOKIE = 'cc_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token),
    userId,
    expiresAt.toISOString(),
  ]);
  return { token, expiresAt };
}

export async function userFromToken(db: Db, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const rows = await db.query<AuthUser>(
    `SELECT u.id, u.email, u.name FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Vui lòng đăng nhập.' });
  }
}

/** Short-lived single-use tickets let the browser open a WebSocket to the API origin without exposing the session cookie. */
export class WsTicketStore {
  private tickets = new Map<string, { user: AuthUser; conferenceId: string; expires: number }>();

  issue(user: AuthUser, conferenceId: string): string {
    this.sweep();
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { user, conferenceId, expires: Date.now() + 60_000 });
    return ticket;
  }

  redeem(ticket: string | undefined): { user: AuthUser; conferenceId: string } | null {
    if (!ticket) return null;
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.expires < Date.now()) return null;
    return { user: entry.user, conferenceId: entry.conferenceId };
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
  }
}

/** Fixed-window limiter for login attempts, keyed by IP + email. */
export class AttemptLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private max = 10, private windowMs = 15 * 60_000) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }
}
