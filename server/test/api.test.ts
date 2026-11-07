import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { Translator, type TranslationRequest } from '../src/live/translator.js';
import type { SttHandlers, SttProvider, SttStream } from '../src/live/stt.js';

/** Test double: lets the test push recognition results as if they came from the provider. */
class ScriptedStt implements SttProvider {
  readonly name = 'scripted';
  readonly configured = true;
  handlers: SttHandlers | null = null;
  bytes = 0;
  open(_opts: { language: string }, handlers: SttHandlers): SttStream {
    this.handlers = handlers;
    handlers.onStatus('open');
    return {
      provider: this.name,
      send: (chunk) => (this.bytes += chunk.length),
      keepAlive: () => {},
      finish: async () => {},
      close: () => {},
      audioSecondsSent: () => this.bytes / 32000,
    };
  }
}

class EchoTranslator extends Translator {
  delayMs = 0;
  maxConcurrent = 0;
  private active = 0;
  constructor() {
    super(null, 'test-model');
  }
  override get configured() {
    return true;
  }
  override async translate(req: TranslationRequest, onDelta: (d: string) => void) {
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.active--;
    onDelta('VI: ');
    onDelta(req.text);
    return { text: `VI: ${req.text}`, inputTokens: 100, outputTokens: 20 };
  }
}

const ORIGIN = 'http://localhost:3000';
let db: Db;
let app: FastifyInstance;
let baseUrl: string;
const stt = new ScriptedStt();
const translator = new EchoTranslator();

function cookieOf(res: { headers: Record<string, unknown> }) {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(';')[0];
}

async function register(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, name: email.split('@')[0], password: 'a-long-password' } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

function nextEvent(ws: WebSocket, type: string, predicate: (e: any) => boolean = () => true): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 3000);
    const onMsg = (data: WebSocket.RawData) => {
      const e = JSON.parse(data.toString());
      if (e.type === type && predicate(e)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(e);
      }
    };
    ws.on('message', onMsg);
  });
}

beforeAll(async () => {
  db = await openPglite(null);
  const config = loadConfig({ allowedOrigins: [ORIGIN], port: 0 });
  await migrate(db, config.migrationsDir);
  ({ app } = await buildApp(db, config, { logger: false, stt, translator }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  baseUrl = `127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('auth', () => {
  it('rejects anonymous access and wrong passwords', async () => {
    expect((await app.inject({ url: '/api/conferences' })).statusCode).toBe(401);
    await register('owner@example.com');
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'OWNER@example.com', password: 'a-long-password' } });
    expect(ok.statusCode).toBe(200);
  });

  it('limits password guessing on one account even when the client rotates X-Forwarded-For', async () => {
    await register('target@example.com');
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
        payload: { email: 'target@example.com', password: `wrong-guess-${i}` },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it('blocks state-changing requests from foreign origins', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('conferences and live pipeline', () => {
  it('isolates private conferences between users', async () => {
    const alice = await register('alice@example.com');
    const bob = await register('bob@example.com');
    const created = await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: alice }, payload: { name: 'Private summit' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().conference.id;
    expect((await app.inject({ url: `/api/conferences/${id}`, headers: { cookie: bob } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/conferences/${id}/ws-ticket`, headers: { cookie: bob } })).statusCode).toBe(404);
  });

  it('streams audio → final segment → Vietnamese translation, persists and exports it', async () => {
    const cookie = await register('host@example.com');
    const created = await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'Live test', glossary: 'GPU' } });
    const id = created.json().conference.id;
    const { ticket } = (await app.inject({ method: 'POST', url: `/api/conferences/${id}/ws-ticket`, headers: { cookie } })).json();

    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`, { origin: ORIGIN });
    await nextEvent(ws, 'state');

    ws.send(JSON.stringify({ type: 'start', audioSource: 'microphone', consent: true }));
    await nextEvent(ws, 'state', (e) => e.status === 'live' && e.youAreHost);

    ws.send(Buffer.alloc(3200));
    await new Promise((r) => setTimeout(r, 50));
    expect(stt.bytes).toBe(3200);

    const partial = nextEvent(ws, 'partial');
    stt.handlers!.onResult({ isFinal: false, speechFinal: false, text: 'Hello every', language: 'en', speaker: 'Speaker 1', startSec: 0, endSec: 1, confidence: 0.5 });
    expect((await partial).text).toBe('Hello every');

    const segment = nextEvent(ws, 'segment');
    const done = nextEvent(ws, 'translation.done');
    stt.handlers!.onResult({ isFinal: true, speechFinal: true, text: 'Hello everyone', language: 'en', speaker: 'Speaker 1', startSec: 0, endSec: 1.2, confidence: 0.95 });
    expect((await segment).segment).toMatchObject({ seq: 1, text_original: 'Hello everyone', translation_status: 'pending' });
    expect((await done).text_vi).toBe('VI: Hello everyone');

    ws.send(JSON.stringify({ type: 'stop' }));
    await nextEvent(ws, 'state', (e) => e.status === 'idle');
    ws.close();

    const segs = (await app.inject({ url: `/api/conferences/${id}/segments`, headers: { cookie } })).json().segments;
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ text_vi: 'VI: Hello everyone', translation_status: 'done', start_ms: 0, end_ms: 1200 });

    const conf = (await app.inject({ url: `/api/conferences/${id}`, headers: { cookie } })).json();
    expect(conf.conference.status).toBe('ended');
    expect(conf.sessions[0].end_reason).toBe('stopped');

    const exported = await app.inject({ url: `/api/conferences/${id}/export?format=md`, headers: { cookie } });
    expect(exported.body).toContain('VI: Hello everyone');

    const usage = (await app.inject({ url: `/api/conferences/${id}/usage`, headers: { cookie } })).json();
    expect(usage.items.map((i: { kind: string }) => i.kind).sort()).toEqual(['stt', 'translation']);
    expect(usage.totalUsd).toBeGreaterThan(0);

    const edited = await app.inject({ method: 'PATCH', url: `/api/segments/${segs[0].id}`, headers: { cookie }, payload: { text_vi: 'Xin chào mọi người', is_important: true } });
    expect(edited.json().segment).toMatchObject({ text_vi: 'Xin chào mọi người', is_important: true, edited: true });

    const search = (await app.inject({ url: `/api/conferences/${id}/segments?q=chào&important=1`, headers: { cookie } })).json();
    expect(search.segments).toHaveLength(1);
  });

  it('assembles a sentence from several finals and translates a fast speaker in parallel', async () => {
    const cookie = await register('fast@example.com');
    const id = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'Fast talker' } })).json().conference.id;
    const { ticket } = (await app.inject({ method: 'POST', url: `/api/conferences/${id}/ws-ticket`, headers: { cookie } })).json();
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`, { origin: ORIGIN });
    await nextEvent(ws, 'state');
    ws.send(JSON.stringify({ type: 'start', audioSource: 'microphone', consent: true }));
    await nextEvent(ws, 'state', (e) => e.status === 'live');

    // Two chunks of one sentence: the growing line is shown, but only one segment is stored.
    const grown = nextEvent(ws, 'partial', (e) => e.text === 'The combined ratio');
    stt.handlers!.onResult({ isFinal: true, speechFinal: false, text: 'The combined ratio', language: 'en', speaker: 'Speaker 1', startSec: 0, endSec: 1, confidence: 0.9 });
    await grown;
    const first = nextEvent(ws, 'segment');
    stt.handlers!.onResult({ isFinal: true, speechFinal: true, text: 'fell to 94 percent', language: 'en', speaker: 'Speaker 1', startSec: 1, endSec: 2, confidence: 0.9 });
    expect((await first).segment.text_original).toBe('The combined ratio fell to 94 percent');

    translator.delayMs = 300;
    translator.maxConcurrent = 0;
    const done: string[] = [];
    const allDone = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === 'translation.done' && e.text_vi.startsWith('VI: Point')) {
          done.push(e.text_vi);
          if (done.length === 6) resolve();
        }
      });
    });
    const t0 = Date.now();
    for (let i = 1; i <= 6; i++) {
      stt.handlers!.onResult({ isFinal: true, speechFinal: true, text: `Point ${i}`, language: 'en', speaker: 'Speaker 1', startSec: 2 + i, endSec: 3 + i, confidence: 0.9 });
    }
    await allDone;
    const elapsed = Date.now() - t0;
    translator.delayMs = 0;
    expect(translator.maxConcurrent).toBe(3);
    // Sequential would need 6 × 300 ms; three at a time needs two rounds.
    expect(elapsed).toBeLessThan(1300);

    const segs = (await app.inject({ url: `/api/conferences/${id}/segments`, headers: { cookie } })).json().segments;
    expect(segs.map((s: { seq: number }) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    ws.send(JSON.stringify({ type: 'stop' }));
    await nextEvent(ws, 'state', (e) => e.status === 'idle');
    ws.close();
  });

  it('returns only changed segments for incremental sync', async () => {
    const cookie = await register('sync@example.com');
    const id = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'Sync' } })).json().conference.id;
    const [session] = await db.query<{ id: string }>(
      `INSERT INTO live_sessions (conference_id, started_by, audio_source, stt_provider, consent_confirmed_at)
       SELECT $1, id, 'test', 'test', now() FROM users WHERE email = 'sync@example.com' RETURNING id`,
      [id],
    );
    await db.query(
      `INSERT INTO segments (conference_id, session_id, seq, start_ms, end_ms, text_original, updated_at)
       SELECT $1, $2, g, 0, 0, 'line ' || g, now() - interval '1 hour' FROM generate_series(1, 5) g`,
      [id, session.id],
    );
    const full = (await app.inject({ url: `/api/conferences/${id}/segments`, headers: { cookie } })).json();
    expect(full.segments).toHaveLength(5);
    await app.inject({ method: 'PATCH', url: `/api/segments/${full.segments[2].id}`, headers: { cookie }, payload: { is_important: true } });
    const delta = (await app.inject({ url: `/api/conferences/${id}/segments?since=${encodeURIComponent(full.serverTime)}`, headers: { cookie } })).json();
    expect(delta.segments.map((s: { seq: number }) => s.seq)).toEqual([3]);
  });

  it('refuses WebSocket connections without a valid ticket', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=forged`, { origin: ORIGIN });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
