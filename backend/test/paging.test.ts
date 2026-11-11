import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { actAsBrowser } from './helpers.js';

/** API versioning and paging (audit ARC-08). */

const ORIGIN = 'http://localhost:3000';
let db: Db;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  db = await openPglite(null);
  const config = loadConfig({ allowedOrigins: [ORIGIN], allowSignup: true, registerPerHour: 1000 });
  await migrate(db, config.migrationsDir);
  ({ app } = await buildApp(db, config, { logger: false }));
  actAsBrowser(app, ORIGIN);
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'pager@example.com', name: 'Pager', password: 'a-long-password' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('versioned API', () => {
  it('serves every route under /api/v1 as well as /api', async () => {
    expect((await app.inject({ url: '/api/v1/health' })).json()).toEqual({ ok: true });
    const v1 = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(v1.statusCode).toBe(200);
    expect(v1.json().user.email).toBe('pager@example.com');
    expect((await app.inject({ url: '/api/v1/conferences' })).statusCode).toBe(401);
  });
});

describe('paging', () => {
  it('pages the conference list with limit/offset and nextOffset', async () => {
    for (const name of ['A', 'B', 'C']) {
      expect((await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name } })).statusCode).toBe(201);
    }
    const first = (await app.inject({ url: '/api/conferences?limit=2', headers: { cookie } })).json();
    expect(first.conferences).toHaveLength(2);
    expect(first.nextOffset).toBe(2);
    const second = (await app.inject({ url: `/api/conferences?limit=2&offset=${first.nextOffset}`, headers: { cookie } })).json();
    expect(second.conferences).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    const names = [...first.conferences, ...second.conferences].map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['A', 'B', 'C']);
  });

  it('pages a transcript by seq with nextAfterSeq until null', async () => {
    const conf = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'Long talk' } })).json().conference;
    const [session] = await db.query<{ id: string }>(
      `INSERT INTO live_sessions (conference_id, started_by, audio_source, stt_provider, consent_confirmed_at)
       VALUES ($1, $2, 'test', 'test', now()) RETURNING id`,
      [conf.id, conf.created_by],
    );
    for (let seq = 1; seq <= 5; seq++) {
      await db.query(
        `INSERT INTO segments (conference_id, session_id, seq, start_ms, end_ms, text_original) VALUES ($1, $2, $3, $4, $5, $6)`,
        [conf.id, session.id, seq, seq * 1000, seq * 1000 + 900, `line ${seq}`],
      );
    }
    const seen: number[] = [];
    let after = 0;
    for (let page = 0; page < 5; page++) {
      const r = (await app.inject({ url: `/api/conferences/${conf.id}/segments?limit=2&afterSeq=${after}`, headers: { cookie } })).json();
      seen.push(...r.segments.map((s: { seq: number }) => s.seq));
      if (r.nextAfterSeq === null) break;
      after = r.nextAfterSeq;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    // Without paging parameters the whole (short) transcript still comes back in one response.
    const all = (await app.inject({ url: `/api/conferences/${conf.id}/segments`, headers: { cookie } })).json();
    expect(all.segments).toHaveLength(5);
    expect(all.nextAfterSeq).toBeNull();
  });

  it('rejects page sizes outside the allowed range', async () => {
    expect((await app.inject({ url: '/api/conferences?limit=0', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/conferences?limit=5000', headers: { cookie } })).statusCode).toBe(400);
  });
});
