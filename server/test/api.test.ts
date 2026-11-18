import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { Translator, type TranslationRequest } from '../src/live/translator.js';
import type { SttHandlers, SttProvider, SttStream } from '../src/live/stt.js';
import { QuestionDetector } from '../src/ai/questions.js';
import { Responder } from '../src/ai/responder.js';
import { makeDocx } from './fixtures.js';
import { actAsBrowser } from './helpers.js';

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

class FakeDetector extends QuestionDetector {
  constructor() {
    super(null, 'fake-detector');
  }
  override get configured() {
    return true;
  }
  override async detect(input: { current: string; currentVi: string | null; previous: string[] }) {
    return {
      detection: {
        is_question: true,
        worth_answering: true,
        question: input.current,
        question_vi: `VI: ${input.current}`,
        keywords: ['IBNR'],
        // "[garbled]" in the transcript stands in for a question the model judges unclear.
        is_clear: !input.current.includes('[garbled]'),
        unclear_reason: input.current.includes('[garbled]') ? 'Câu hỏi bị cắt giữa chừng.' : '',
        // "[other team]" stands in for a question addressed to someone other than the listener's team.
        for_presenting_team: !input.current.includes('[other team]'),
      },
      inputTokens: 10,
      outputTokens: 10,
    };
  }
}

/** Answers from whatever context it is given, citing the first chunk, at a fixed $0.30 per answer. */
class FakeResponder extends Responder {
  constructor(model: string) {
    super(null, model);
  }
  override get configured() {
    return true;
  }
  override async generate(input: Parameters<Responder['generate']>[0], onDelta: (t: string) => void) {
    onDelta('[[ANALYSIS]]\n');
    const first = input.chunks[0];
    return {
      answer: {
        analysis_vi: 'Họ hỏi lý do.',
        options: input.modes.map((mode) => ({
          mode,
          vi: 'Theo tài liệu…',
          en: 'According to the documents…',
          citations: first ? [{ chunk_id: first.id, document_id: first.document_id, filename: first.filename, locator: first.locator, quote: first.content.slice(0, 20) }] : [],
        })),
        missing: '',
        follow_ups: [],
      },
      usage: { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
    };
  }
}

function multipartFile(filename: string, content: Buffer) {
  const boundary = `----cc${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return {
    payload: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const ORIGIN = 'http://localhost:3000';
let db: Db;
let app: FastifyInstance;
let config: ReturnType<typeof loadConfig>;
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
  const defaults = loadConfig();
  // Functional tests: open signup so each test user gets an isolated workspace (invite flow is in security.test.ts).
  // Both answer tiers priced alike here so the budget arithmetic below stays at $0.30 per answer.
  const { model: _m, ...qualityPrices } = defaults.answers;
  // Auto-drafting for the older tests; the confirm-first flow switches requireConfirm on for its own test.
  const answers = { ...defaults.answers, autoBudgetUsd: 0.5, requireConfirm: false, fast: { ...defaults.answers.fast, ...qualityPrices, model: 'fake-fast' } };
  config = loadConfig({ allowedOrigins: [ORIGIN], port: 0, allowSignup: true, registerPerHour: 1000, answers });
  await migrate(db, config.migrationsDir);
  ({ app } = await buildApp(db, config, {
    logger: false,
    stt,
    translator,
    detector: new FakeDetector(),
    responder: new FakeResponder('fake-quality'),
    fastResponder: new FakeResponder('fake-fast'),
  }));
  actAsBrowser(app, ORIGIN);
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
    expect(segs[0]).toMatchObject({ text_vi: 'VI: Hello everyone', translation_status: 'done' });
    // Timestamps are on the session clock: offset by when the first audio arrived, duration preserved.
    expect(segs[0].end_ms - segs[0].start_ms).toBe(1200);
    expect(segs[0].start_ms).toBeGreaterThanOrEqual(0);
    expect(segs[0].start_ms).toBeLessThan(3000);

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

  it('grounds auto-suggested answers in uploaded documents and switches to click-to-answer past the budget', async () => {
    const cookie = await register('kb@example.com');
    const id = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'Reserving forum' } })).json().conference.id;

    const upload = multipartFile('notes.docx', await makeDocx(['IBNR tăng 8% do bão mùa hè.', 'Chain ladder dùng cho tam giác bồi thường.']));
    const up = await app.inject({ method: 'POST', url: `/api/conferences/${id}/documents`, headers: { cookie, ...upload.headers }, payload: upload.payload });
    expect(up.statusCode).toBe(201);
    expect(up.json().document).toMatchObject({ filename: 'notes.docx', kind: 'docx', status: 'ready' });
    const bad = multipartFile('photo.png', Buffer.from('x'));
    expect((await app.inject({ method: 'POST', url: `/api/conferences/${id}/documents`, headers: { cookie, ...bad.headers }, payload: bad.payload })).statusCode).toBe(400);

    const { ticket } = (await app.inject({ method: 'POST', url: `/api/conferences/${id}/ws-ticket`, headers: { cookie } })).json();
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`, { origin: ORIGIN });
    await nextEvent(ws, 'state');
    ws.send(JSON.stringify({ type: 'start', audioSource: 'microphone', consent: true }));
    await nextEvent(ws, 'state', (e) => e.status === 'live');

    const ask = (text: string, at: number) =>
      stt.handlers!.onResult({ isFinal: true, speechFinal: true, text, language: 'en', speaker: 'Speaker 2', startSec: at, endSec: at + 2, confidence: 0.9 });

    const answered1 = nextEvent(ws, 'question', (e) => e.question.status === 'answered');
    ask('What drove the IBNR increase this year?', 0);
    const q1 = (await answered1).question;
    // Auto-detected questions get the cheap first-draft model.
    expect(q1).toMatchObject({ source: 'auto', text_vi: 'VI: What drove the IBNR increase this year?', answer_model: 'fake-fast' });
    expect(q1.answer.context).toBe('all');
    expect(q1.answer.options.map((o: { mode: string }) => o.mode)).toEqual(['professional', 'concise', 'strategic']);
    expect(q1.answer.options[0].citations[0]).toMatchObject({ filename: 'notes.docx', locator: 'phần 1' });

    const answered2 = nextEvent(ws, 'question', (e) => e.question.status === 'answered');
    ask('How do you validate the chain ladder results?', 3);
    await answered2;

    // $0.60 spent ≥ $0.50 budget: the next question waits for a click instead of spending more.
    const waiting = nextEvent(ws, 'question', (e) => e.question.status === 'awaiting_click');
    ask('Could you share the tail factor assumptions?', 6);
    const q3 = (await waiting).question;

    const manual = nextEvent(ws, 'question', (e) => e.question.id === q3.id && e.question.status === 'answered');
    expect((await app.inject({ method: 'POST', url: `/api/questions/${q3.id}/answer`, headers: { cookie } })).statusCode).toBe(202);
    await manual;

    const list = (await app.inject({ url: `/api/conferences/${id}/questions`, headers: { cookie } })).json();
    expect(list.questions).toHaveLength(3);
    expect(list.spentUsd).toBeCloseTo(0.9, 5);

    expect((await app.inject({ method: 'PATCH', url: `/api/conferences/${id}`, headers: { cookie }, payload: { response_modes: ['academic', 'technical'] } })).json().conference.response_modes).toEqual(['academic', 'technical']);
    expect((await app.inject({ method: 'PATCH', url: `/api/conferences/${id}`, headers: { cookie }, payload: { response_modes: ['academic', 'technical', 'concise', 'strategic'] } })).statusCode).toBe(400);

    ws.send(JSON.stringify({ type: 'stop' }));
    await nextEvent(ws, 'state', (e) => e.status === 'idle');
    ws.close();
  });

  it('waits for "Trả lời" or "Skip" before drafting, and ignores questions for another team', async () => {
    config.answers.requireConfirm = true;
    try {
      const cookie = await register('decide@example.com');
      const id = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'Finals Q&A' } })).json().conference.id;
      const { ticket } = (await app.inject({ method: 'POST', url: `/api/conferences/${id}/ws-ticket`, headers: { cookie } })).json();
      const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`, { origin: ORIGIN });
      await nextEvent(ws, 'state');
      ws.send(JSON.stringify({ type: 'start', audioSource: 'microphone', consent: true }));
      await nextEvent(ws, 'state', (e) => e.status === 'live');
      const ask = (text: string, at: number) =>
        stt.handlers!.onResult({ isFinal: true, speechFinal: true, text, language: 'en', speaker: 'Judge', startSec: at, endSec: at + 2, confidence: 0.95 });

      // Pending: shown to the listener, nothing drafted (no cost) until they choose.
      const pending = nextEvent(ws, 'question', (e) => e.question.status === 'awaiting_click');
      ask('Why did you choose a 60% quota share?', 0);
      const q1 = (await pending).question;
      expect(q1.answer).toBeNull();
      expect(q1.seq).toBe(1);
      expect((await app.inject({ url: `/api/conferences/${id}/questions`, headers: { cookie } })).json().spentUsd).toBe(0);

      // "Trả lời" drafts it.
      const answered = nextEvent(ws, 'question', (e) => e.question.id === q1.id && e.question.status === 'answered');
      expect((await app.inject({ method: 'POST', url: `/api/questions/${q1.id}/answer`, headers: { cookie } })).statusCode).toBe(202);
      await answered;

      // A question for another team never reaches the listener; the next one for them does.
      const next = nextEvent(ws, 'question', () => true);
      ask('What is your view on that, [other team]?', 3);
      ask('How do you price the rider?', 6);
      // Numbers follow the order of asking; the ignored "[other team]" question takes none.
      expect((await next).question).toMatchObject({ text_original: 'How do you price the rider?', seq: 2 });

      // A pause mid-question: the fragment is detected first, then the full question. Only the full one stays.
      const fragment = nextEvent(ws, 'question', (e) => e.question.text_original === 'What happens to your value of new business');
      ask('What happens to your value of new business', 9);
      const frag = (await fragment).question;
      const fragmentDropped = nextEvent(ws, 'question', (e) => e.question.id === frag.id && e.question.status === 'dismissed');
      ask('What happens to your value of new business if first-year lapse is higher than expected?', 11);
      await fragmentDropped;
      const pendingNow = (await app.inject({ url: `/api/conferences/${id}/questions`, headers: { cookie } }))
        .json()
        .questions.filter((q: { status: string }) => q.status === 'awaiting_click')
        .map((q: { text_original: string }) => q.text_original);
      expect(pendingNow).toContain('What happens to your value of new business if first-year lapse is higher than expected?');
      expect(pendingNow).not.toContain('What happens to your value of new business');
      // A complete question (ends with "?") is never dropped, even if a later detection repeats its text.
      expect(pendingNow).toContain('How do you price the rider?');
      const repeat = nextEvent(ws, 'question', (e) => e.question.text_original.startsWith('How do you price the rider? And'));
      ask('How do you price the rider? And what about lapses?', 14);
      await repeat;
      const stillThere = (await app.inject({ url: `/api/conferences/${id}/questions`, headers: { cookie } }))
        .json()
        .questions.find((q: { text_original: string }) => q.text_original === 'How do you price the rider?');
      expect(stillThere.status).toBe('awaiting_click');

      // A complete question glued in front of an unfinished one: the next full question drops the glued fragment.
      const glued = nextEvent(ws, 'question', (e) => e.question.text_original.endsWith('cost of the gift hour'));
      ask('Why use the youngest child? And what is the cost of the gift hour', 17);
      const gluedQ = (await glued).question;
      const gluedDropped = nextEvent(ws, 'question', (e) => e.question.id === gluedQ.id && e.question.status === 'dismissed');
      ask('And what is the cost of the gift hour per family?', 19);
      await gluedDropped;

      ws.send(JSON.stringify({ type: 'stop' }));
      await nextEvent(ws, 'state', (e) => e.status === 'idle');
      ws.close();
    } finally {
      config.answers.requireConfirm = false;
    }
  });

  it('asks the listener to confirm unclear questions before drafting an answer', async () => {
    const cookie = await register('confirm@example.com');
    const id = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'Q&A' } })).json().conference.id;
    const { ticket } = (await app.inject({ method: 'POST', url: `/api/conferences/${id}/ws-ticket`, headers: { cookie } })).json();
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`, { origin: ORIGIN });
    await nextEvent(ws, 'state');
    ws.send(JSON.stringify({ type: 'start', audioSource: 'microphone', consent: true }));
    await nextEvent(ws, 'state', (e) => e.status === 'live');
    const ask = (text: string, at: number, confidence: number) =>
      stt.handlers!.onResult({ isFinal: true, speechFinal: true, text, language: 'en', speaker: 'Judge', startSec: at, endSec: at + 2, confidence });

    // Low recognition confidence: held for confirmation, nothing drafted or billed.
    const held = nextEvent(ws, 'question', (e) => e.question.status === 'awaiting_confirm');
    ask('Why did you choose a sixty percent quota share?', 0, 0.5);
    const q1 = (await held).question;
    expect(q1.unclear_reason).toContain('50%');
    expect(q1.answer).toBeNull();

    // Confirming with a corrected text drafts the answer for the corrected question.
    const answered = nextEvent(ws, 'question', (e) => e.question.id === q1.id && e.question.status === 'answered');
    const confirm = await app.inject({ method: 'POST', url: `/api/questions/${q1.id}/answer`, headers: { cookie }, payload: { text: 'Why did you choose a 60% quota share with Gen Re?' } });
    expect(confirm.statusCode).toBe(202);
    expect((await answered).question).toMatchObject({ text_original: 'Why did you choose a 60% quota share with Gen Re?', unclear_reason: null });

    // Clear audio but a question the detector judges unclear: also held; dismissing it removes it from play.
    const held2 = nextEvent(ws, 'question', (e) => e.question.status === 'awaiting_confirm');
    ask('What about the [garbled] reserve?', 3, 0.95);
    const q2 = (await held2).question;
    expect(q2.unclear_reason).toBe('Câu hỏi bị cắt giữa chừng.');
    const dismissed = await app.inject({ method: 'POST', url: `/api/questions/${q2.id}/dismiss`, headers: { cookie } });
    expect(dismissed.json().question.status).toBe('dismissed');

    // A clear, confident question still goes straight to an answer.
    const direct = nextEvent(ws, 'question', (e) => e.question.status === 'answered' && e.question.id !== q1.id);
    ask('How do you validate the TPD assumptions?', 6, 0.95);
    const q3 = (await direct).question;
    expect(q3).toMatchObject({ unclear_reason: null, answer_model: 'fake-fast' });

    // "Draft more carefully" re-answers with the stronger model.
    const upgraded = nextEvent(ws, 'question', (e) => e.question.id === q3.id && e.question.status === 'answered' && e.question.answer_model === 'fake-quality');
    expect((await app.inject({ method: 'POST', url: `/api/questions/${q3.id}/answer`, headers: { cookie }, payload: { quality: true } })).statusCode).toBe(202);
    await upgraded;

    // The conference's model choice applies to the next draft, even mid-session; unknown models are refused.
    const patchModel = (answer_model: unknown) => app.inject({ method: 'PATCH', url: `/api/conferences/${id}`, headers: { cookie }, payload: { answer_model } });
    expect((await patchModel('gpt-4o')).statusCode).toBe(400);
    expect((await patchModel('claude-sonnet-5-5')).json().conference.answer_model).toBe('claude-sonnet-5-5');
    // This conference is past its $0.50 auto budget by now, so the question waits for a click; the click drafts with the chosen model.
    const waiting = nextEvent(ws, 'question', (e) => e.question.status === 'awaiting_click');
    ask('Why only five rider age bands?', 9, 0.95);
    const q4 = (await waiting).question;
    const bySonnet = nextEvent(ws, 'question', (e) => e.question.id === q4.id && e.question.status === 'answered');
    await app.inject({ method: 'POST', url: `/api/questions/${q4.id}/answer`, headers: { cookie } });
    expect((await bySonnet).question.answer_model).toBe('fake-quality');
    expect((await patchModel(null)).json().conference.answer_model).toBeNull();

    // X on an answered question removes it, and re-drafting it later cannot bring it back.
    expect((await app.inject({ method: 'POST', url: `/api/questions/${q4.id}/dismiss`, headers: { cookie } })).json().question.status).toBe('dismissed');
    await app.inject({ method: 'POST', url: `/api/questions/${q4.id}/answer`, headers: { cookie } });
    await new Promise((r) => setTimeout(r, 200));
    const after = (await app.inject({ url: `/api/conferences/${id}/questions`, headers: { cookie } })).json().questions.find((x: { id: string }) => x.id === q4.id);
    expect(after.status).toBe('dismissed');

    ws.send(JSON.stringify({ type: 'stop' }));
    await nextEvent(ws, 'state', (e) => e.status === 'idle');
    ws.close();
  });

  it('refuses WebSocket connections without a valid ticket', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=forged`, { origin: ORIGIN });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
