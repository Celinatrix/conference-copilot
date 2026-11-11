/**
 * Reproducible security probes against an in-memory instance (PGlite in RAM, AI providers replaced by doubles,
 * so nothing leaves the machine and no real data is touched). Each line prints PASS / FAIL / INFO with evidence.
 *
 *   npx tsx scripts/security-probe.ts
 */
import WebSocket from 'ws';
import JSZip from 'jszip';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { Translator, type TranslationRequest } from '../src/live/translator.js';
import { QuestionDetector } from '../src/ai/questions.js';
import { Responder } from '../src/ai/responder.js';
import type { SttHandlers, SttProvider, SttStream } from '../src/live/stt.js';
import { hashPassword } from '../src/auth.js';

const ORIGIN = 'http://localhost:3000';
const results: { status: 'PASS' | 'FAIL' | 'INFO'; id: string; detail: string }[] = [];
const report = (status: 'PASS' | 'FAIL' | 'INFO', id: string, detail: string) => {
  results.push({ status, id, detail });
  console.log(`[${status}] ${id}: ${detail}`);
};
const check = (ok: boolean, id: string, detail: string) => report(ok ? 'PASS' : 'FAIL', id, detail);

class NullStt implements SttProvider {
  readonly name = 'null';
  readonly configured = true;
  open(_o: { language: string }, h: SttHandlers): SttStream {
    h.onStatus('open');
    return { provider: 'null', send() {}, keepAlive() {}, finish: async () => {}, close() {}, audioSecondsSent: () => 0 };
  }
}
class EchoTranslator extends Translator {
  constructor() { super(null, 'probe'); }
  override get configured() { return true; }
  override async translate(r: TranslationRequest) { return { text: r.text, inputTokens: 1, outputTokens: 1 }; }
}
let answerCalls = 0;
class CountingResponder extends Responder {
  constructor() { super(null, 'probe'); }
  override get configured() { return true; }
  override async generate() {
    answerCalls++;
    return { answer: { analysis_vi: '', options: [], missing: '', follow_ups: [] }, usage: { input: 50_000, output: 5_000, cacheRead: 0, cacheWrite: 0 } };
  }
}
class NoDetector extends QuestionDetector {
  constructor() { super(null, 'probe'); }
}

function multipart(filename: string, content: Buffer) {
  const b = `----probe${Math.random().toString(16).slice(2)}`;
  return {
    payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${b}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  };
}

async function main() {
  const db = await openPglite(null);
  const config = loadConfig({ allowedOrigins: [ORIGIN] });
  await migrate(db, config.migrationsDir);
  const { app } = await buildApp(db, config, { logger: false, stt: new NullStt(), translator: new EchoTranslator(), detector: new NoDetector(), responder: new CountingResponder() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;

  // Act as the browser app: every request carries the allowed Origin unless a probe sets its own.
  const rawInject = app.inject.bind(app) as (o: any) => any;
  (app as any).inject = (o: any) => rawInject({ ...o, headers: { origin: ORIGIN, ...(o.headers ?? {}) } });

  const login = async (email: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'correct-horse-battery' } });
    return { cookie: String(r.headers['set-cookie']).split(';')[0], raw: String(r.headers['set-cookie']), user: r.json().user };
  };
  // Signup is closed by default: the first account bootstraps; other tenants are created directly in the DB
  // (as separate workspaces) so cross-tenant probes still have a second tenant to attack.
  const register = async (email: string) => {
    const [{ users }] = await db.query<{ users: number }>('SELECT COUNT(*)::int AS users FROM users');
    if (users === 0) {
      await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, name: email, password: 'correct-horse-battery' } });
    } else {
      const [u] = await db.query<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1, $1, $2) RETURNING id`, [email, await hashPassword('correct-horse-battery')]);
      const [w] = await db.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`ws ${email}`]);
      await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w.id, u.id]);
    }
    return login(email);
  };
  const A = await register('alice@probe.test');
  const B = await register('bob@probe.test');

  // ---- Fixture data owned by A ----
  const confA = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: A.cookie }, payload: { name: 'A private board meeting' } })).json().conference;
  const [userA] = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'alice@probe.test'`);
  const [sess] = await db.query<{ id: string }>(`INSERT INTO live_sessions (conference_id, started_by, audio_source, stt_provider, consent_confirmed_at) VALUES ($1, $2, 'x', 'x', now()) RETURNING id`, [confA.id, userA.id]);
  const [segA] = await db.query<{ id: string }>(`INSERT INTO segments (conference_id, session_id, seq, start_ms, end_ms, text_original, text_vi) VALUES ($1, $2, 1, 0, 0, 'Secret merger with ACME', 'Bí mật sáp nhập') RETURNING id`, [confA.id, sess.id]);
  const csv = multipart('plan.csv', Buffer.from('item,value\nacquisition price,42000000\n'));
  const docA = (await app.inject({ method: 'POST', url: `/api/conferences/${confA.id}/documents`, headers: { cookie: A.cookie, ...csv.headers }, payload: csv.payload })).json().document;
  const [qA] = await db.query<{ id: string }>(`INSERT INTO questions (conference_id, source, text_original, status) VALUES ($1, 'manual', 'q', 'answered') RETURNING id`, [confA.id]);

  // ---- 06 Server authentication: every non-public route without a session ----
  const protectedRoutes: [string, string][] = [
    ['GET', '/api/auth/me'], ['GET', '/api/dashboard'], ['GET', '/api/conferences'], ['POST', '/api/conferences'],
    ['GET', `/api/conferences/${confA.id}`], ['PATCH', `/api/conferences/${confA.id}`], ['DELETE', `/api/conferences/${confA.id}`],
    ['GET', `/api/conferences/${confA.id}/segments`], ['PATCH', `/api/segments/${segA.id}`], ['POST', `/api/segments/${segA.id}/retranslate`],
    ['GET', `/api/conferences/${confA.id}/export`], ['GET', `/api/conferences/${confA.id}/usage`], ['POST', `/api/conferences/${confA.id}/ws-ticket`],
    ['GET', `/api/conferences/${confA.id}/documents`], ['POST', `/api/conferences/${confA.id}/documents`], ['DELETE', `/api/documents/${docA.id}`],
    ['GET', `/api/conferences/${confA.id}/questions`], ['POST', `/api/conferences/${confA.id}/questions`], ['POST', `/api/questions/${qA.id}/answer`],
  ];
  const leaks: string[] = [];
  for (const [method, url] of protectedRoutes) {
    const r = await app.inject({ method: method as 'GET', url, payload: method === 'GET' || method === 'DELETE' ? undefined : {} });
    if (r.statusCode !== 401) leaks.push(`${method} ${url} → ${r.statusCode}`);
  }
  check(leaks.length === 0, 'AUTH-01 unauthenticated access', leaks.length ? leaks.join(', ') : `${protectedRoutes.length} protected routes all return 401`);
  const status = await app.inject({ url: '/api/system/status' });
  check(status.statusCode === 401, 'AUTH-02 status endpoint requires login', `GET /api/system/status without login → ${status.statusCode}`);
  const noOrigin = await rawInject({ method: 'POST', url: '/api/conferences', headers: { cookie: A.cookie }, payload: { name: 'csrf' } });
  check(noOrigin.statusCode === 403, 'CSRF-01 cookie write without Origin', `POST with session cookie and no Origin → ${noOrigin.statusCode}`);

  // ---- 08 Record-level authorization (IDOR/BOLA): B against A's objects ----
  const idor: [string, string, unknown?][] = [
    ['GET', `/api/conferences/${confA.id}`], ['PATCH', `/api/conferences/${confA.id}`, { name: 'pwned' }], ['DELETE', `/api/conferences/${confA.id}`],
    ['GET', `/api/conferences/${confA.id}/segments`], ['GET', `/api/conferences/${confA.id}/segments?q=Secret`], ['PATCH', `/api/segments/${segA.id}`, { text_vi: 'pwned' }],
    ['POST', `/api/segments/${segA.id}/retranslate`], ['GET', `/api/conferences/${confA.id}/export?format=md`], ['GET', `/api/conferences/${confA.id}/usage`],
    ['POST', `/api/conferences/${confA.id}/ws-ticket`], ['GET', `/api/conferences/${confA.id}/documents`], ['DELETE', `/api/documents/${docA.id}`],
    ['GET', `/api/conferences/${confA.id}/questions`], ['POST', `/api/conferences/${confA.id}/questions`, { text: 'What is the price?' }],
    ['POST', `/api/conferences/${confA.id}/questions`, { segmentId: segA.id }], ['POST', `/api/questions/${qA.id}/answer`],
  ];
  const breaches: string[] = [];
  for (const [method, url, payload] of idor) {
    const r = await app.inject({ method: method as 'GET', url, headers: { cookie: B.cookie }, payload: payload as object | undefined });
    if (r.statusCode < 400 || r.body.includes('Secret') || r.body.includes('42000000')) breaches.push(`${method} ${url} → ${r.statusCode}`);
  }
  check(breaches.length === 0, 'IDOR-01 cross-tenant object access', breaches.length ? breaches.join(', ') : `${idor.length} requests by another tenant all denied (403/404), no data in bodies`);
  const confBpre = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: B.cookie }, payload: { name: 'B conf' } })).json().conference;
  const crossSeg = await app.inject({ method: 'POST', url: `/api/conferences/${confBpre.id}/questions`, headers: { cookie: B.cookie }, payload: { segmentId: segA.id } });
  check(crossSeg.statusCode === 404, 'IDOR-02 foreign segment via own conference', `B asks a question about A's segment through B's conference → ${crossSeg.statusCode}`);
  const listB = (await app.inject({ url: '/api/conferences', headers: { cookie: B.cookie } })).json().conferences;
  check(!listB.some((c: { id: string }) => c.id === confA.id), 'IDOR-03 listing isolation', `B's conference list has ${listB.length} item(s), none of A's`);

  // ---- 09 Mass assignment ----
  const [wsA] = await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM workspace_members WHERE user_id = $1`, [userA.id]);
  await app.inject({ method: 'PATCH', url: `/api/conferences/${confBpre.id}`, headers: { cookie: B.cookie }, payload: { workspace_id: wsA.workspace_id, created_by: userA.id, status: 'live', id: confA.id, name: 'renamed' } });
  const [after] = await db.query<{ workspace_id: string; created_by: string; status: string; name: string }>(`SELECT workspace_id, created_by, status, name FROM conferences WHERE id = $1`, [confBpre.id]);
  check(after.workspace_id !== wsA.workspace_id && after.created_by !== userA.id && after.status === 'draft' && after.name === 'renamed', 'MASS-01 conference PATCH', `protected fields ignored (status=${after.status}), allowed field name updated`);
  // Invite into A's workspace as member, then try to self-promote and jump to B's workspace while registering.
  const [wsB] = await db.query<{ workspace_id: string }>(`SELECT m.workspace_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'bob@probe.test'`);
  const inv = (await app.inject({ method: 'POST', url: '/api/workspace/invites', headers: { cookie: A.cookie }, payload: { role: 'member' } })).json();
  const invToken = new URL(inv.path, ORIGIN).searchParams.get('invite');
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'mallory@probe.test', name: 'M', password: 'correct-horse-battery', invite: invToken, role: 'owner', workspace_id: wsB.workspace_id } });
  const memberships = await db.query<{ workspace_id: string; role: string }>(`SELECT m.workspace_id, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'mallory@probe.test'`);
  check(
    reg.statusCode === 200 && memberships.length === 1 && memberships[0].workspace_id === wsA.workspace_id && memberships[0].role === 'member',
    'MASS-02 register with role/workspace_id',
    `invited as member: ended in ${memberships.map((m) => `${m.workspace_id === wsA.workspace_id ? 'A' : 'other'}:${m.role}`).join(',')}`,
  );
  await app.inject({ method: 'PATCH', url: `/api/segments/${segA.id}`, headers: { cookie: A.cookie }, payload: { conference_id: confBpre.id, seq: 999, is_important: true } });
  const [segAfter] = await db.query<{ conference_id: string; seq: number }>(`SELECT conference_id, seq FROM segments WHERE id = $1`, [segA.id]);
  check(segAfter.conference_id === confA.id && segAfter.seq === 1, 'MASS-03 segment PATCH', 'conference_id and seq cannot be changed through the API');

  // ---- 14 SQL injection ----
  const payloads = [`' OR '1'='1`, `%' OR 1=1 --`, `'; DROP TABLE users; --`, `\\'); SELECT pg_sleep(2); --`];
  let sqlOk = true;
  for (const p of payloads) {
    const t0 = Date.now();
    const r1 = await app.inject({ url: `/api/conferences?q=${encodeURIComponent(p)}`, headers: { cookie: B.cookie } });
    const r2 = await app.inject({ url: `/api/conferences/${confA.id}/segments?q=${encodeURIComponent(p)}`, headers: { cookie: A.cookie } });
    if (r1.statusCode !== 200 || r1.json().conferences.length !== 0 || r2.statusCode !== 200 || r2.json().segments.length !== 0 || Date.now() - t0 > 1500) sqlOk = false;
  }
  const [{ users }] = await db.query<{ users: number }>(`SELECT COUNT(*)::int AS users FROM users`);
  // 3 users exist at this point: alice, bob, mallory.
  check(sqlOk && users === 3, 'SQLI-01 search parameters', `${payloads.length} payloads on 2 search endpoints: no extra rows, no delay, users table intact (${users})`);
  const sinceInj = await app.inject({ url: `/api/conferences/${confA.id}/segments?since=${encodeURIComponent("2020-01-01' OR 1=1--")}`, headers: { cookie: A.cookie } });
  check(sinceInj.statusCode === 400, 'SQLI-02 since parameter', `malformed timestamp rejected by schema → ${sinceInj.statusCode}`);

  // ---- 07/15 Input validation and stored content ----
  const xss = '<img src=x onerror=alert(1)>';
  const xr = await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: B.cookie }, payload: { name: xss, input_language: 'en; DROP' } });
  check(xr.statusCode === 400, 'INPUT-01 schema validation', `invalid input_language rejected → ${xr.statusCode}`);
  const xs = await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: B.cookie }, payload: { name: xss } });
  const exp = await app.inject({ url: `/api/conferences/${xs.json().conference.id}/export?format=md`, headers: { cookie: B.cookie } });
  report('INFO', 'XSS-01 stored markup', `name stored verbatim (${xs.statusCode}); React escapes it on render (no dangerouslySetInnerHTML in web/). Markdown export contains raw "<img onerror>": ${exp.body.includes('onerror')} – risky only if opened in a viewer that renders HTML`);
  check(String(exp.headers['content-type']).startsWith('text/markdown') && String(exp.headers['content-disposition']).startsWith('attachment'), 'XSS-02 export served as download', `${exp.headers['content-type']}, ${exp.headers['content-disposition']}`);

  // ---- 16 File upload ----
  const up = (name: string, buf: Buffer, cookie = A.cookie) => {
    const m = multipart(name, buf);
    return app.inject({ method: 'POST', url: `/api/conferences/${confA.id}/documents`, headers: { cookie, ...m.headers }, payload: m.payload });
  };
  check((await up('evil.exe', Buffer.from('MZ'))).statusCode === 400, 'UPLOAD-01 extension allowlist', '.exe rejected');
  const fakePdf = await up('report.pdf', Buffer.from('#!/bin/sh\nrm -rf /\n'));
  check(fakePdf.statusCode === 422, 'UPLOAD-02 content not matching extension', `shell script named .pdf → HTTP ${fakePdf.statusCode} ${fakePdf.json().error ?? fakePdf.json().document?.status} (refused before any parser runs)`);
  const trav = await up('../../../../windows/win.ini.csv', Buffer.from('a,b\n1,2\n'));
  report('INFO', 'UPLOAD-03 path traversal filename', `accepted as metadata "${trav.json().document?.filename}"; originals are never written to disk, so no path is built from it`);
  const big = await up('big.csv', Buffer.alloc(26 * 1024 * 1024, 0x61));
  check(big.statusCode === 413, 'UPLOAD-04 size limit', `26 MB upload → ${big.statusCode}`);
  // Decompression bomb: a 60 MB XML that compresses to well under 1 MB.
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${'A'.repeat(60 * 1024 * 1024)}</w:t></w:r></w:p></w:body></w:document>`);
  const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const bombRes = await up('bomb.docx', bomb);
  const rssPeak = process.memoryUsage().rss;
  const [bombDoc] = await db.query<{ char_count: number; status: string }>(`SELECT char_count, status FROM documents WHERE filename = 'bomb.docx'`);
  check(bombRes.statusCode !== 201 || bombDoc?.status === 'error', 'UPLOAD-05 decompression bomb', `${(bomb.length / 1024).toFixed(0)} KB docx expanding to 60 MB → HTTP ${bombRes.statusCode} ${bombRes.json().error ?? ''}, document row: ${bombDoc ? `${bombDoc.status}, ${bombDoc.char_count} chars` : 'none'}, ${Date.now() - t0} ms, RSS +${((rssPeak - rss0) / 1e6).toFixed(0)} MB`);

  // ---- 10/11/12 Cookies, passwords, enumeration, rate limits ----
  check(/HttpOnly/i.test(A.raw) && /SameSite=Lax/i.test(A.raw), 'COOKIE-01 flags', A.raw.replace(/cc_session=[^;]+/, 'cc_session=<redacted>'));
  report(/Secure/i.test(A.raw) ? 'PASS' : 'INFO', 'COOKIE-02 Secure flag', /Secure/i.test(A.raw) ? 'Secure set' : 'Secure NOT set (COOKIE_SECURE=false by default; must be true behind HTTPS)');
  const tmp = await register('logout@probe.test');
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: tmp.cookie } });
  check((await app.inject({ url: '/api/auth/me', headers: { cookie: tmp.cookie } })).statusCode === 401, 'COOKIE-03 logout invalidates server session', 'old cookie → 401 after logout');
  const [hash] = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE email = 'alice@probe.test'`);
  report('INFO', 'PWD-01 hashing', `stored as ${hash.password_hash.split('$').slice(0, 4).join('$')}$… (scrypt; OWASP minimum for scrypt is N=2^17, current N=2^14)`);
  const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'alice@probe.test', name: 'x', password: 'correct-horse-battery' } });
  check(dup.statusCode !== 409, 'ENUM-01 registration reveals existing emails', `register existing email → ${dup.statusCode} ${dup.json().error}`);
  const time = async (email: string) => {
    const ts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s = performance.now();
      await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': `198.51.100.${i}` }, payload: { email, password: `nope-${i}` } });
      ts.push(performance.now() - s);
    }
    return ts.sort((a, b) => a - b)[2];
  };
  const known = await time('bob@probe.test');
  const unknown = await time('nobody@probe.test');
  check(known / Math.max(unknown, 0.1) < 3, 'ENUM-02 login timing', `median login time: existing email ${known.toFixed(1)} ms vs unknown ${unknown.toFixed(1)} ms`);
  let regOk = 0;
  for (let i = 0; i < 30; i++) if ((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `bot${i}@probe.test`, name: 'bot', password: 'correct-horse-battery' } })).statusCode === 200) regOk++;
  check(regOk < 30, 'BOT-01 registration rate limit', `${regOk}/30 automated registrations from one client accepted`);
  let confOk = 0;
  for (let i = 0; i < 50; i++) if ((await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: B.cookie }, payload: { name: `spam ${i}` } })).statusCode === 201) confOk++;
  check(confOk < 50, 'BOT-02 resource creation rate limit', `${confOk}/50 conferences created in a burst`);

  // ---- A. AI cost abuse ----
  answerCalls = 0;
  for (let i = 0; i < 25; i++) await app.inject({ method: 'POST', url: `/api/conferences/${confBpre.id}/questions`, headers: { cookie: B.cookie }, payload: { text: `Spam question number ${i}?` } });
  await new Promise((r) => setTimeout(r, 300));
  const [{ spent }] = await db.query<{ spent: number }>(`SELECT COALESCE(SUM(cost_usd),0)::double precision AS spent FROM usage_events WHERE conference_id = $1 AND provider LIKE 'answer:%'`, [confBpre.id]);
  check(answerCalls < 25, 'AI-01 manual answer requests bounded per user', `${answerCalls}/25 paid answer generations started by one user in a burst (simulated cost $${spent.toFixed(2)}; per-user limit ${config.aiRateLimits.questionsPerMinute}/min, hard cap $${config.costCaps.conferenceUsd}/conference)`);
  let retr = 0;
  for (let i = 0; i < 20; i++) if ((await app.inject({ method: 'POST', url: `/api/segments/${segA.id}/retranslate`, headers: { cookie: A.cookie } })).statusCode === 200) retr++;
  check(retr < 20, 'AI-02 retranslate rate limit', `${retr}/20 paid retranslations accepted in a burst`);

  // ---- D. WebSocket ----
  const ticket = async (cookie: string, conf: string) => (await app.inject({ method: 'POST', url: `/api/conferences/${conf}/ws-ticket`, headers: { cookie } })).json().ticket as string;
  const closeCode = (url: string, origin = ORIGIN) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { origin });
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => {});
    });
  check((await closeCode(`ws://${base}/ws`)) === 4401, 'WS-01 no ticket', 'closed 4401');
  const t1 = await ticket(A.cookie, confA.id);
  check((await closeCode(`ws://${base}/ws?ticket=${t1}`, 'https://evil.example')) === 4403, 'WS-02 foreign Origin', 'closed 4403');
  const t2 = await ticket(A.cookie, confA.id);
  const first = new WebSocket(`ws://${base}/ws?ticket=${t2}`, { origin: ORIGIN });
  await new Promise((r) => first.once('message', r));
  check((await closeCode(`ws://${base}/ws?ticket=${t2}`)) === 4401, 'WS-03 ticket replay', 'second use of the same ticket closed 4401');
  const big64 = await new Promise<number>((resolve) => {
    first.on('close', (c) => resolve(c));
    first.send(Buffer.alloc(70 * 1024));
  });
  // The server drops the connection on an oversized frame; the client sees 1009 or, when the socket is cut, 1006.
  check(big64 === 1009 || big64 === 1006, 'WS-04 message size limit', `70 KB frame (limit 64 KB) → connection closed with ${big64}`);
  const sockets: WebSocket[] = [];
  let opened = 0;
  for (let i = 0; i < 40; i++) {
    const s = new WebSocket(`ws://${base}/ws?ticket=${await ticket(B.cookie, confBpre.id)}`, { origin: ORIGIN });
    sockets.push(s);
    await new Promise<void>((r) => { s.once('message', () => { opened++; r(); }); s.once('close', () => r()); });
  }
  check(opened < 40, 'WS-05 connections per user', `${opened}/40 simultaneous sockets accepted for one user`);
  const flood = sockets[0];
  let pongs = 0;
  flood.on('message', (d) => { if (JSON.parse(d.toString()).type === 'pong') pongs++; });
  for (let i = 0; i < 2000; i++) flood.send(JSON.stringify({ type: 'ping', t: i }));
  await new Promise((r) => setTimeout(r, 800));
  check(pongs < 2000, 'WS-06 message rate limit', `${pongs}/2000 control messages processed within 0.8 s`);
  const live = sockets[1];
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: B.cookie } });
  await new Promise((r) => setTimeout(r, 200));
  check(live.readyState !== WebSocket.OPEN, 'WS-07 socket after logout', `socket opened before logout is ${live.readyState === WebSocket.OPEN ? 'still OPEN' : 'closed'}`);
  for (const s of sockets) s.close();

  // ---- 17 Data minimization ----
  const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: A.cookie } })).json();
  const conf = (await app.inject({ url: `/api/conferences/${confA.id}`, headers: { cookie: A.cookie } })).body;
  const docs = (await app.inject({ url: `/api/conferences/${confA.id}/documents`, headers: { cookie: A.cookie } })).body;
  const leaky = [JSON.stringify(me), conf, docs].some((b) => /password_hash|token_hash|ANTHROPIC|DEEPGRAM_API/.test(b));
  check(!leaky, 'DATA-01 secrets in responses', `me keys: ${Object.keys(me.user).join(',')}; no password/token hashes or keys in sampled responses`);
  const err = await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie: A.cookie, 'content-type': 'application/json' }, payload: '{"name":' });
  check(!/at\s+\S+\.(ts|js):\d+/.test(err.body), 'DATA-02 error details', `malformed JSON → ${err.statusCode} ${err.body.slice(0, 120)}`);

  // ---- G. Deletion ----
  await app.inject({ method: 'DELETE', url: `/api/conferences/${confA.id}`, headers: { cookie: A.cookie } });
  const [left] = await db.query<{ s: number; d: number; c: number; q: number; a: number }>(
    `SELECT (SELECT COUNT(*)::int FROM segments WHERE conference_id = $1::uuid) s, (SELECT COUNT(*)::int FROM documents WHERE conference_id = $1::uuid) d,
            (SELECT COUNT(*)::int FROM document_chunks WHERE conference_id = $1::uuid) c, (SELECT COUNT(*)::int FROM questions WHERE conference_id = $1::uuid) q,
            (SELECT COUNT(*)::int FROM audit_logs WHERE target_id = $1::text) a`,
    [confA.id],
  );
  check(left.s + left.d + left.c + left.q === 0, 'PRIV-01 conference deletion cascades', `remaining: segments ${left.s}, documents ${left.d}, chunks ${left.c}, questions ${left.q}; audit entries kept: ${left.a}`);

  const by = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\nSummary: ${by('PASS')} PASS, ${by('FAIL')} FAIL, ${by('INFO')} INFO`);
  await app.close();
  await db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
