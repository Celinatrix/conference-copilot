/**
 * Server-side load check: how long a confirmed segment and its translation take to reach every viewer,
 * and what an 8-hour transcript costs to load. External APIs are replaced by in-process doubles, so the
 * numbers isolate our own pipeline (DB write + fan-out); real Deepgram/Claude latency comes on top.
 *
 *   npx tsx scripts/bench-fanout.ts
 */
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { migrate, openPglite } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { Translator, type TranslationRequest } from '../src/live/translator.js';
import type { SttHandlers, SttProvider, SttStream } from '../src/live/stt.js';

class ScriptedStt implements SttProvider {
  readonly name = 'scripted';
  readonly configured = true;
  handlers: SttHandlers | null = null;
  open(_o: { language: string }, handlers: SttHandlers): SttStream {
    this.handlers = handlers;
    handlers.onStatus('open');
    return { provider: this.name, send() {}, keepAlive() {}, finish: async () => {}, close() {}, audioSecondsSent: () => 0 };
  }
}

class InstantTranslator extends Translator {
  constructor() {
    super(null, 'bench');
  }
  override get configured() {
    return true;
  }
  override async translate(req: TranslationRequest, onDelta: (d: string) => void) {
    for (const word of req.text.split(' ')) onDelta(word + ' ');
    return { text: req.text, inputTokens: 1, outputTokens: 1 };
  }
}

const ORIGIN = 'http://localhost:3000';
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const SENTENCE = 'Our loss reserve estimate for the property portfolio increased by twelve percent this quarter';

async function main() {
  const db = await openPglite(null);
  const config = loadConfig({ allowedOrigins: [ORIGIN] });
  await migrate(db, config.migrationsDir);
  const stt = new ScriptedStt();
  const { app } = await buildApp(db, config, { logger: false, stt, translator: new InstantTranslator() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'bench@copilot.test', name: 'Bench', password: 'bench-password-123' } });
  const cookie = String(reg.headers['set-cookie']).split(';')[0];

  console.log('viewers | segments | segment→all viewers p50/p95 (ms) | translation done→all p50/p95 (ms) | rss MB');
  for (const viewers of [1, 5, 10, 20]) {
    const conf = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: `bench ${viewers}` } })).json().conference;
    const sockets: WebSocket[] = [];
    const segArrivals = new Map<number, number[]>();
    const doneArrivals = new Map<string, number[]>();
    const segIdBySeq = new Map<string, number>();
    for (let i = 0; i < viewers; i++) {
      const { ticket } = (await app.inject({ method: 'POST', url: `/api/conferences/${conf.id}/ws-ticket`, headers: { cookie } })).json();
      const ws = new WebSocket(`ws://${base}/ws?ticket=${ticket}`, { origin: ORIGIN });
      await new Promise((r) => ws.once('open', r));
      ws.on('message', (raw) => {
        const e = JSON.parse(raw.toString());
        const now = performance.now();
        if (e.type === 'segment') {
          segIdBySeq.set(e.segment.id, e.segment.seq);
          segArrivals.get(e.segment.seq)?.push(now);
        } else if (e.type === 'translation.done') doneArrivals.get(e.segmentId)?.push(now) ?? doneArrivals.set(e.segmentId, [now]);
      });
      sockets.push(ws);
    }
    const host = sockets[0];
    host.send(JSON.stringify({ type: 'start', audioSource: 'bench', consent: true }));
    await new Promise((r) => setTimeout(r, 200));

    const N = 200;
    const sentAt = new Map<number, number>();
    for (let seq = 1; seq <= N; seq++) {
      segArrivals.set(seq, []);
      sentAt.set(seq, performance.now());
      stt.handlers!.onResult({ isFinal: true, speechFinal: true, text: `${SENTENCE} (${seq})`, language: 'en', speaker: 'Speaker 1', startSec: seq, endSec: seq + 1, confidence: 0.9 });
      // A fast speaker produces a confirmed segment every ~1.5 s; 25 ms here stresses the pipeline 60x harder.
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 1500));

    const segLat: number[] = [];
    for (const [seq, arr] of segArrivals) if (arr.length === viewers) segLat.push(Math.max(...arr) - sentAt.get(seq)!);
    const doneLat: number[] = [];
    for (const [id, arr] of doneArrivals) {
      const seq = segIdBySeq.get(id);
      if (seq && arr.length === viewers) doneLat.push(Math.max(...arr) - sentAt.get(seq)!);
    }
    const rss = (process.memoryUsage().rss / 1e6).toFixed(0);
    console.log(
      `${String(viewers).padStart(7)} | ${String(segLat.length).padStart(8)} | ${pct(segLat, 50).toFixed(1)} / ${pct(segLat, 95).toFixed(1)} | ${pct(doneLat, 50).toFixed(1)} / ${pct(doneLat, 95).toFixed(1)} | ${rss}`,
    );
    host.send(JSON.stringify({ type: 'stop' }));
    await new Promise((r) => setTimeout(r, 300));
    for (const s of sockets) s.close();
  }

  // 8-hour transcript: ~1 confirmed segment every 3 s → ~9,600 segments.
  const conf = (await app.inject({ method: 'POST', url: '/api/conferences', headers: { cookie }, payload: { name: 'eight hours' } })).json().conference;
  const [session] = await db.query<{ id: string }>(
    `INSERT INTO live_sessions (conference_id, started_by, audio_source, stt_provider, consent_confirmed_at)
     SELECT $1, id, 'bench', 'bench', now() FROM users LIMIT 1 RETURNING id`,
    [conf.id],
  );
  const t0 = performance.now();
  await db.query(
    `INSERT INTO segments (conference_id, session_id, seq, start_ms, end_ms, speaker, language, text_original, text_vi, translation_status)
     SELECT $1, $2, g, g * 3000, g * 3000 + 2500, 'Speaker 1', 'en', $3 || ' ' || g, 'Bản dịch tiếng Việt mẫu cho đoạn ' || g, 'done'
     FROM generate_series(1, 9600) g`,
    [conf.id, session.id, SENTENCE],
  );
  const insertMs = performance.now() - t0;
  const t1 = performance.now();
  const res = await app.inject({ url: `/api/conferences/${conf.id}/segments`, headers: { cookie } });
  const loadMs = performance.now() - t1;
  const t2 = performance.now();
  await app.inject({ url: `/api/conferences/${conf.id}/segments?q=${encodeURIComponent('đoạn 9599')}`, headers: { cookie } });
  const searchMs = performance.now() - t2;
  console.log(
    `\n8h transcript: 9600 segments inserted in ${insertMs.toFixed(0)} ms; full load ${loadMs.toFixed(0)} ms, ${(res.body.length / 1e6).toFixed(1)} MB JSON; ILIKE search ${searchMs.toFixed(0)} ms`,
  );

  await app.close();
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
