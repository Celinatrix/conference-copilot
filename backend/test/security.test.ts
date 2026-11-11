import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { Translator, type TranslationRequest } from '../src/live/translator.js';
import { QuestionDetector } from '../src/ai/questions.js';
import { Responder } from '../src/ai/responder.js';
import { UnsafeUploadError, checkSignature, inspectZip } from '../src/kb/safety.js';
import { ParseLimitError, parseInWorker } from '../src/kb/run-parse.js';
import type { SttHandlers, SttProvider, SttStream } from '../src/live/stt.js';
import { makeDocx, makePdf } from './fixtures.js';
import { actAsBrowser } from './helpers.js';

/** Regression tests for the security audit findings H1 (upload bombs) and H2 (AI cost abuse). */

async function bombDocx(xmlBytes: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>${'A'.repeat(xmlBytes)}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

describe('upload safety checks (H1, L4)', () => {
  it('requires the real file signature', async () => {
    expect(() => checkSignature(Buffer.from('#!/bin/sh\nrm -rf /'), 'pdf')).toThrow(UnsafeUploadError);
    expect(() => checkSignature(Buffer.from('%PDF-1.7 ...'), 'pdf')).not.toThrow();
    expect(() => checkSignature(Buffer.from('%PDF-1.7'), 'docx')).toThrow(/DOCX/);
    const docx = await makeDocx(['ok']);
    expect(() => checkSignature(docx, 'docx')).not.toThrow();
    expect(() => checkSignature(Buffer.from([0x61, 0x00, 0x62]), 'csv')).toThrow(/nhị phân/);
    expect(() => checkSignature(Buffer.from([0xff, 0xfe, 0x41]), 'csv')).toThrow(/UTF-8/);
    expect(() => checkSignature(Buffer.from('a,b\nđồng,1\n'), 'csv')).not.toThrow();
  });

  it('refuses decompression bombs from the ZIP directory alone', async () => {
    const normal = await makeDocx(['normal paragraph']);
    expect(() => inspectZip(normal)).not.toThrow();
    const bomb = await bombDocx(40 * 1024 * 1024);
    expect(() => inspectZip(bomb)).toThrow(expect.objectContaining({ code: 'zip_bomb' }));
    // Many small entries adding up past the total limit.
    const zip = new JSZip();
    for (let i = 0; i < 12; i++) zip.file(`part${i}.xml`, 'x'.repeat(5 * 1024 * 1024));
    const wide = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    expect(() => inspectZip(wide)).toThrow(/50 MB/);
    const crowded = new JSZip();
    for (let i = 0; i < 2100; i++) crowded.file(`f${i}.txt`, '');
    const crowdedZip = await crowded.generateAsync({ type: 'nodebuffer' });
    expect(() => inspectZip(crowdedZip)).toThrow(/quá nhiều/);
    expect(() => inspectZip(Buffer.from('PK\u0003\u0004 not really a zip'))).toThrow(/hỏng/);
  });

  it('enforces the parse deadline in the worker', async () => {
    await expect(parseInWorker(await makePdf(['hello']), 'a.pdf', { timeoutMs: 1, maxMemoryMb: 256 })).rejects.toBeInstanceOf(ParseLimitError);
    const ok = await parseInWorker(Buffer.from('a,b\n1,2\n'), 'a.csv');
    expect(ok.units[0].text).toBe('a | b\n1 | 2');
  });
});

class NullStt implements SttProvider {
  readonly name = 'null';
  readonly configured = true;
  open(_o: { language: string }, h: SttHandlers): SttStream {
    h.onStatus('open');
    return { provider: 'null', send() {}, keepAlive() {}, finish: async () => {}, close() {}, audioSecondsSent: () => 0 };
  }
}
class EchoTranslator extends Translator {
  constructor() { super(null, 'sec'); }
  override get configured() { return true; }
  override async translate(r: TranslationRequest) { return { text: r.text, inputTokens: 1, outputTokens: 1 }; }
}
let answers = 0;
class CountingResponder extends Responder {
  constructor() { super(null, 'sec'); }
  override get configured() { return true; }
  override async generate() {
    answers++;
    return { answer: { analysis_vi: '', options: [], missing: '', follow_ups: [] }, usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } };
  }
}

const ORIGIN = 'http://localhost:3000';
let db: Db;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  db = await openPglite(null);
  const config = loadConfig({
    allowedOrigins: [ORIGIN],
    allowSignup: true,
    registerPerHour: 1000,
    costCaps: { conferenceUsd: 2, workspaceDailyUsd: 50 },
    aiRateLimits: { questionsPerMinute: 3, retranslatePerMinute: 2 },
  });
  await migrate(db, config.migrationsDir);
  ({ app } = await buildApp(db, config, { logger: false, stt: new NullStt(), translator: new EchoTranslator(), detector: new QuestionDetector(null, 'x'), responder: new CountingResponder() }));
  actAsBrowser(app, ORIGIN);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

async function setup(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, name: email, password: 'correct-horse-battery' } });
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const conf = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'sec' } })).json().conference;
  return { cookie, conf };
}

function upload(confId: string, cookie: string, filename: string, content: Buffer) {
  const b = `----sec${Math.random().toString(16).slice(2)}`;
  return app.inject({
    method: 'POST',
    url: `/api/conferences/${confId}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${b}` },
    payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`), content, Buffer.from(`\r\n--${b}--\r\n`)]),
  });
}

describe('upload endpoint (H1)', () => {
  it('rejects a decompression bomb before parsing and stores nothing', async () => {
    const { cookie, conf } = await setup('bomb@sec.test');
    const rss0 = process.memoryUsage().rss;
    const res = await upload(conf.id, cookie, 'bomb.docx', await bombDocx(60 * 1024 * 1024));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('zip_bomb');
    expect(process.memoryUsage().rss - rss0).toBeLessThan(150 * 1024 * 1024);
    const [{ n }] = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents WHERE conference_id = $1`, [conf.id]);
    expect(n).toBe(0);
  });

  it('rejects a file whose content does not match its extension', async () => {
    const { cookie, conf } = await setup('fake@sec.test');
    const res = await upload(conf.id, cookie, 'report.pdf', Buffer.from('#!/bin/sh\n'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('bad_signature');
  });

  it('caps the text extracted from one document', async () => {
    const { cookie, conf } = await setup('long@sec.test');
    const csv = `a,b\n${'x'.repeat(100)},1\n`.repeat(1).concat(Array.from({ length: 22_000 }, (_, i) => `${'y'.repeat(95)},${i}`).join('\n'));
    const res = await upload(conf.id, cookie, 'huge.csv', Buffer.from(csv));
    expect(res.statusCode).toBe(201);
    expect(res.json().document).toMatchObject({ status: 'error' });
    expect(res.json().document.error).toMatch(/quá dài/);
    const [{ chunks }] = await db.query<{ chunks: number }>(`SELECT COUNT(*)::int AS chunks FROM document_chunks WHERE conference_id = $1`, [conf.id]);
    expect(chunks).toBe(0);
  });
});

describe('AI cost controls (H2)', () => {
  it('rate-limits manual answer requests per user', async () => {
    const { cookie, conf } = await setup('spam@sec.test');
    answers = 0;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({ method: 'POST', url: `/api/conferences/${conf.id}/questions`, headers: { cookie }, payload: { text: `Question ${i}?` } })).statusCode);
    }
    expect(codes).toEqual([202, 202, 202, 429, 429, 429]);
    await new Promise((r) => setTimeout(r, 100));
    expect(answers).toBe(3);
  });

  it('stops every paid path once the conference hard cap is reached', async () => {
    const { cookie, conf } = await setup('cap@sec.test');
    await db.query(
      `INSERT INTO usage_events (workspace_id, conference_id, provider, kind, units, unit, cost_usd) VALUES ($1, $2, 'test', 'llm', 1, 'token', 2.5)`,
      [conf.workspace_id, conf.id],
    );
    const q = await app.inject({ method: 'POST', url: `/api/conferences/${conf.id}/questions`, headers: { cookie }, payload: { text: 'Anything?' } });
    expect(q.statusCode).toBe(429);
    expect(q.json().error).toBe('conference_cap');

    const [u] = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'cap@sec.test'`);
    const [s] = await db.query<{ id: string }>(`INSERT INTO live_sessions (conference_id, started_by, audio_source, stt_provider, consent_confirmed_at) VALUES ($1, $2, 'x', 'x', now()) RETURNING id`, [conf.id, u.id]);
    const [seg] = await db.query<{ id: string }>(`INSERT INTO segments (conference_id, session_id, seq, start_ms, end_ms, text_original) VALUES ($1, $2, 1, 0, 0, 'hi') RETURNING id`, [conf.id, s.id]);
    const rt = await app.inject({ method: 'POST', url: `/api/segments/${seg.id}/retranslate`, headers: { cookie } });
    expect(rt.statusCode).toBe(429);

    const { ticket } = (await app.inject({ method: 'POST', url: `/api/conferences/${conf.id}/ws-ticket`, headers: { cookie } })).json();
    const ws = new WebSocket(`ws://${base}/ws?ticket=${ticket}`, { origin: ORIGIN });
    await new Promise((r) => ws.once('message', r));
    const err = new Promise<{ code: string }>((resolve) => ws.on('message', (d) => { const e = JSON.parse(d.toString()); if (e.type === 'error') resolve(e); }));
    ws.send(JSON.stringify({ type: 'start', audioSource: 'mic', consent: true }));
    expect((await err).code).toBe('budget_exceeded');
    ws.close();
  });

  it('rate-limits retranslation per user', async () => {
    const { cookie, conf } = await setup('rt@sec.test');
    const [u] = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'rt@sec.test'`);
    const [s] = await db.query<{ id: string }>(`INSERT INTO live_sessions (conference_id, started_by, audio_source, stt_provider, consent_confirmed_at) VALUES ($1, $2, 'x', 'x', now()) RETURNING id`, [conf.id, u.id]);
    const [seg] = await db.query<{ id: string }>(`INSERT INTO segments (conference_id, session_id, seq, start_ms, end_ms, text_original) VALUES ($1, $2, 1, 0, 0, 'hello') RETURNING id`, [conf.id, s.id]);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'POST', url: `/api/segments/${seg.id}/retranslate`, headers: { cookie } })).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
  });
});
