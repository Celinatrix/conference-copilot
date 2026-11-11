import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';

/** Security audit batch 2: invite-only signup (M1), Origin enforcement (M2), enumeration (L1), public status (L6). */

const ORIGIN = 'http://localhost:3000';
let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await openPglite(null);
  // Secure defaults: signup closed. Register limit lowered so the limiter is reachable in a test.
  const config = loadConfig({ allowedOrigins: [ORIGIN], allowSignup: false, registerPerHour: 8 });
  await migrate(db, config.migrationsDir);
  ({ app } = await buildApp(db, config, { logger: false }));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const post = (url: string, payload: object, cookie?: string, origin: string | null = ORIGIN) =>
  app.inject({ method: 'POST', url, payload, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const pw = 'correct-horse-battery';

describe('invite-only membership', () => {
  let owner = '';
  let memberInvitePath = '';

  it('lets the first account register and become owner, then closes signup without leaking emails', async () => {
    const first = await post('/api/auth/register', { email: 'owner@acc.test', name: 'Owner', password: pw });
    expect(first.statusCode).toBe(200);
    owner = cookieOf(first);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: owner } })).json().workspace.role).toBe('owner');

    const stranger = await post('/api/auth/register', { email: 'stranger@acc.test', name: 'S', password: pw });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error).toBe('signup_closed');
    // An existing address gets the same answer: closed signup does not reveal who has an account.
    const existing = await post('/api/auth/register', { email: 'owner@acc.test', name: 'X', password: pw });
    expect(existing.statusCode).toBe(403);
    expect(existing.json().error).toBe('signup_closed');
  });

  it('creates a single-use invite and joins the inviting workspace with the invited role only', async () => {
    const created = await post('/api/workspace/invites', { role: 'member', expiresInDays: 3 }, owner);
    expect(created.statusCode).toBe(201);
    memberInvitePath = created.json().path;
    const token = new URL(memberInvitePath, ORIGIN).searchParams.get('invite')!;
    const [{ token_hash }] = await db.query<{ token_hash: string }>('SELECT token_hash FROM invitations LIMIT 1');
    expect(token_hash).not.toBe(token);

    const info = await app.inject({ url: `/api/invites/${token}` });
    expect(info.json()).toMatchObject({ workspace: 'Workspace của Owner', role: 'member' });

    const joined = await post('/api/auth/register', { email: 'member@acc.test', name: 'Mem', password: pw, invite: token, role: 'owner' });
    expect(joined.statusCode).toBe(200);
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: cookieOf(joined) } })).json();
    expect(me.workspace).toMatchObject({ name: 'Workspace của Owner', role: 'member' });

    const reuse = await post('/api/auth/register', { email: 'second@acc.test', name: 'Two', password: pw, invite: token });
    expect(reuse.statusCode).toBe(403);
    expect(reuse.json().error).toBe('invalid_invite');
    expect((await app.inject({ url: `/api/invites/${token}` })).statusCode).toBe(404);

    // Members cannot invite; members see the roster.
    expect((await post('/api/workspace/invites', { role: 'member' }, cookieOf(joined))).statusCode).toBe(403);
    const roster = (await app.inject({ url: '/api/workspace/members', headers: { cookie: cookieOf(joined) } })).json();
    expect(roster.members.map((m: { email: string; role: string }) => `${m.email}:${m.role}`)).toEqual(['owner@acc.test:owner', 'member@acc.test:member']);
  });

  it('honours email-bound invites, revocation, and owner-only admin invites', async () => {
    const bound = (await post('/api/workspace/invites', { role: 'admin', email: 'boss@acc.test' }, owner)).json();
    const boundToken = new URL(bound.path, ORIGIN).searchParams.get('invite')!;
    const wrongEmail = await post('/api/auth/register', { email: 'other@acc.test', name: 'O', password: pw, invite: boundToken });
    expect(wrongEmail.statusCode).toBe(403);
    const admin = await post('/api/auth/register', { email: 'boss@acc.test', name: 'Boss', password: pw, invite: boundToken });
    expect(admin.statusCode).toBe(200);
    const adminCookie = cookieOf(admin);
    expect((await post('/api/workspace/invites', { role: 'admin' }, adminCookie)).statusCode).toBe(403);
    const fromAdmin = await post('/api/workspace/invites', { role: 'member' }, adminCookie);
    expect(fromAdmin.statusCode).toBe(201);

    const revokeToken = new URL(fromAdmin.json().path, ORIGIN).searchParams.get('invite')!;
    const del = await app.inject({ method: 'DELETE', url: `/api/workspace/invites/${fromAdmin.json().invite.id}`, headers: { cookie: owner, origin: ORIGIN } });
    expect(del.statusCode).toBe(200);
    expect((await post('/api/auth/register', { email: 'late@acc.test', name: 'L', password: pw, invite: revokeToken })).statusCode).toBe(403);
    const list = (await app.inject({ url: '/api/workspace/invites', headers: { cookie: owner } })).json();
    expect(list.invites).toHaveLength(0);
  });
});

describe('request hardening', () => {
  it('requires a valid Origin on cookie-authenticated writes', async () => {
    const login = await post('/api/auth/login', { email: 'owner@acc.test', password: pw });
    const cookie = cookieOf(login);
    expect((await post('/api/conferences', { name: 'no origin' }, cookie, null)).statusCode).toBe(403);
    expect((await post('/api/conferences', { name: 'evil origin' }, cookie, 'https://evil.example')).statusCode).toBe(403);
    expect((await post('/api/conferences', { name: 'browser' }, cookie)).statusCode).toBe(201);
  });

  it('keeps the system status behind login', async () => {
    expect((await app.inject({ url: '/api/system/status' })).statusCode).toBe(401);
  });

  it('answers unknown and known emails in similar time', async () => {
    const median = async (email: string) => {
      const ts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, 'x-forwarded-for': `192.0.2.${i}` }, payload: { email, password: `wrong-${i}` } });
        ts.push(performance.now() - t);
      }
      return ts.sort((a, b) => a - b)[2];
    };
    const known = await median('member@acc.test');
    const unknown = await median('ghost@acc.test');
    expect(unknown / known).toBeGreaterThan(0.5);
  });

  it('limits conference creation bursts', async () => {
    const cookie = cookieOf(await post('/api/auth/login', { email: 'boss@acc.test', password: pw }));
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await post('/api/conferences', { name: `burst ${i}` }, cookie)).statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(20);
    expect(codes.at(-1)).toBe(429);
  });

  it('limits registration attempts per IP', async () => {
    const codes: number[] = [];
    // A fresh client address, so earlier registrations in this file do not count.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: '203.0.113.50', headers: { origin: ORIGIN }, payload: { email: `x${i}@acc.test`, name: 'x', password: pw } });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([...Array(8).fill(403), 429, 429]);
  });
});
