import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/auth.js';
import { WORKSPACE_SEATS } from '../src/routes/workspace.js';
import { actAsBrowser } from './helpers.js';

/** Data-integrity guarantees that used to rely on "count, then write" outside any lock (audit ARC-09). */

const ORIGIN = 'http://localhost:3000';
let db: Db;
let app: FastifyInstance;

const register = (email: string, invite?: string) =>
  app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, name: email.split('@')[0], password: 'a-long-password', invite } });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];

beforeAll(async () => {
  db = await openPglite(null);
  // Closed signup, as in production: only the first account and invite holders may register.
  const config = loadConfig({ allowedOrigins: [ORIGIN], allowSignup: false, registerPerHour: 1000 });
  await migrate(db, config.migrationsDir);
  ({ app } = await buildApp(db, config, { logger: false }));
  actAsBrowser(app, ORIGIN);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('data integrity', () => {
  it('lets only one of two simultaneous first registrations become the owner', async () => {
    const results = await Promise.all([register('first-a@example.com'), register('first-b@example.com')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    const [{ owners }] = await db.query<{ owners: number }>(`SELECT COUNT(*)::int AS owners FROM workspace_members WHERE role = 'owner'`);
    expect(owners).toBe(1);
  });

  // PGlite runs every query on one connection, so this cannot reproduce the race itself (that needs a pooled
  // PostgreSQL); it checks that the locked count-and-insert still stops exactly at the seat limit.
  it('stops issuing invitations exactly at the seat limit when several are requested at once', async () => {
    const [owner] = await db.query<{ user_id: string; workspace_id: string }>(`SELECT user_id, workspace_id FROM workspace_members WHERE role = 'owner'`);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: (await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [owner.user_id]))[0].email, password: 'a-long-password' },
    });
    const cookie = cookieOf(login);
    // The owner holds one seat; fill all but one of the rest with pending invitations.
    for (let i = 0; i < WORKSPACE_SEATS - 2; i++) {
      await db.query(
        `INSERT INTO invitations (workspace_id, token_hash, role, created_by, expires_at) VALUES ($1, $2, 'member', $3, now() + interval '1 day')`,
        [owner.workspace_id, sha256(`seed-${i}`), owner.user_id],
      );
    }
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => app.inject({ method: 'POST', url: '/api/workspace/invites', headers: { cookie }, payload: {} })),
    );
    const codes = attempts.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409]);
    const [{ seats }] = await db.query<{ seats: number }>(
      `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1)::int
            + (SELECT COUNT(*) FROM invitations WHERE workspace_id = $1 AND used_at IS NULL AND revoked_at IS NULL)::int AS seats`,
      [owner.workspace_id],
    );
    expect(seats).toBe(WORKSPACE_SEATS);
  });

  it('refuses to delete a user whose conference, transcript or documents others may rely on', async () => {
    const [owner] = await db.query<{ user_id: string; email: string }>(
      `SELECT m.user_id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.role = 'owner'`,
    );
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: 'a-long-password' } });
    const created = await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: cookieOf(login) }, payload: { name: 'Shared', visibility: 'workspace' } });
    expect(created.statusCode).toBe(201);

    await expect(db.query('DELETE FROM users WHERE id = $1', [owner.user_id])).rejects.toThrow(/foreign key/i);
    const [{ n }] = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM conferences WHERE id = $1', [created.json().conference.id]);
    expect(n).toBe(1);
  });
});
