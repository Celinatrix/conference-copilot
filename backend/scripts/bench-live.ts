/**
 * Real-API quality check: plays a recording through Deepgram + the sentence assembler + Claude exactly as a live
 * session would (real-time pacing), then reports latency, word error rate and glossary term recall.
 *
 *   npx tsx scripts/bench-live.ts talk.wav [--ref talk.txt] [--glossary terms.txt] [--language multi|en|ja...]
 *
 * The WAV must be 16 kHz mono 16-bit PCM:  ffmpeg -i talk.mp3 -ar 16000 -ac 1 -c:a pcm_s16le talk.wav
 * Results (JSON + a Markdown sheet for rating translations 1–5) are written to data/bench/.
 * This spends real API credit: about the length of the recording in Deepgram minutes plus a few cents of Claude.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { DeepgramProvider } from '../src/live/deepgram.js';
import { Translator } from '../src/live/translator.js';
import { SentenceAssembler, type AssembledSegment } from '../src/live/assembler.js';
import { BYTES_PER_SECOND } from '../src/live/stt.js';
import { percentile, readPcm16Wav, termRecall, wordErrorRate } from '../src/quality.js';
import { tokenCost } from '../src/usage.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

interface Row extends AssembledSegment {
  readyAt: number; // ms since audio start
  speechEndAt: number;
  firstTokenAt: number | null;
  doneAt: number | null;
  vi: string | null;
  error: string | null;
}

async function main() {
  const wavPath = process.argv[2];
  if (!wavPath || wavPath.startsWith('--')) {
    console.error('Usage: npx tsx scripts/bench-live.ts <file.wav> [--ref ref.txt] [--glossary terms.txt] [--language multi]');
    process.exit(2);
  }
  const config = loadConfig();
  const missing = [!config.deepgram.apiKey && 'DEEPGRAM_API_KEY', !config.anthropic.apiKey && 'ANTHROPIC_API_KEY'].filter(Boolean);
  if (missing.length) {
    console.error(`Missing ${missing.join(' and ')} in .env. This benchmark calls the real APIs.`);
    process.exit(2);
  }

  const audio = readPcm16Wav(await readFile(wavPath));
  const reference = arg('ref') ? await readFile(arg('ref')!, 'utf8') : null;
  const glossary = arg('glossary') ? await readFile(arg('glossary')!, 'utf8') : '';
  const language = arg('language') ?? 'multi';
  const durationSec = audio.length / BYTES_PER_SECOND;
  console.log(`Streaming ${basename(wavPath)} (${durationSec.toFixed(1)} s, language=${language}) in real time…`);

  const translator = new Translator(config.anthropic.apiKey, config.anthropic.translationModel);
  const rows: Row[] = [];
  const pending: Promise<void>[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let t0 = 0;
  const now = () => performance.now() - t0;

  const translate = (row: Row, context: { original: string; vi: string | null }[]) =>
    translator
      .translate({ text: row.text, language: row.language, conferenceName: 'Benchmark', glossary, context }, () => {
        row.firstTokenAt ??= now();
      })
      .then((r) => {
        row.vi = r.text;
        row.doneAt = now();
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
      })
      .catch((err) => {
        row.error = err instanceof Error ? err.message : String(err);
      });

  const assembler = new SentenceAssembler((s) => {
    const row: Row = { ...s, readyAt: now(), speechEndAt: s.endSec * 1000, firstTokenAt: null, doneAt: null, vi: null, error: null };
    const context = rows.slice(-3).map((r) => ({ original: r.text, vi: r.vi }));
    rows.push(row);
    process.stdout.write(`  [${s.startSec.toFixed(1)}s] ${s.text}\n`);
    pending.push(translate(row, context));
  });

  let failed: string | null = null;
  const stream = new DeepgramProvider(config.deepgram.apiKey, config.deepgram.model).open(
    { language },
    {
      onResult: (r) => r.isFinal && assembler.push(r),
      onUtteranceEnd: () => assembler.utteranceEnd(),
      onStatus: (status, detail) => {
        if (status === 'failed') failed = detail ?? 'Deepgram connection failed';
        else if (status === 'reconnecting') console.warn(`  Deepgram reconnecting${detail ? `: ${detail}` : ''}`);
      },
    },
  );

  const chunkBytes = BYTES_PER_SECOND / 10;
  t0 = performance.now();
  for (let off = 0, i = 0; off < audio.length && !failed; off += chunkBytes, i++) {
    stream.send(audio.subarray(off, off + chunkBytes));
    const wait = (i + 1) * 100 - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  if (failed) {
    console.error(`Stopped: ${failed}`);
    stream.close();
    process.exit(1);
  }
  await stream.finish();
  assembler.flush();
  await Promise.all(pending);

  const sttLatency = rows.map((r) => r.readyAt - r.speechEndAt);
  const firstToken = rows.filter((r) => r.firstTokenAt !== null).map((r) => r.firstTokenAt! - r.readyAt);
  const endToEnd = rows.filter((r) => r.doneAt !== null).map((r) => r.doneAt! - r.speechEndAt);
  const transcript = rows.map((r) => r.text).join(' ');
  const wer = reference ? wordErrorRate(reference, transcript) : null;
  const terms = glossary ? termRecall(glossary, transcript) : null;
  const sttUsd = (durationSec / 60) * config.deepgram.usdPerMinute;
  const llmUsd = tokenCost(inputTokens, outputTokens, config.anthropic.inputUsdPerMTok, config.anthropic.outputUsdPerMTok);
  const fmt = (v: number | null) => (v === null ? '—' : `${(v / 1000).toFixed(2)} s`);

  const summary = {
    file: basename(wavPath),
    language,
    sttModel: config.deepgram.model,
    translationModel: config.anthropic.translationModel,
    audioSeconds: Number(durationSec.toFixed(1)),
    segments: rows.length,
    translationErrors: rows.filter((r) => r.error).length,
    shortSegments: rows.filter((r) => r.text.split(/\s+/).length < 4).length,
    latencyMs: {
      speechEndToSegment: { p50: percentile(sttLatency, 50), p95: percentile(sttLatency, 95) },
      segmentToFirstToken: { p50: percentile(firstToken, 50), p95: percentile(firstToken, 95) },
      speechEndToTranslation: { p50: percentile(endToEnd, 50), p95: percentile(endToEnd, 95) },
    },
    wer: wer && Number(wer.wer.toFixed(4)),
    termRecall: terms && { found: terms.found.length, total: terms.found.length + terms.missed.length, missed: terms.missed },
    estimatedCostUsd: Number((sttUsd + llmUsd).toFixed(4)),
  };

  console.log('\n— Result —');
  console.log(`Segments: ${rows.length} (${summary.shortSegments} under 4 words, ${summary.translationErrors} translation errors)`);
  console.log(`Speech end → segment ready   p50 ${fmt(summary.latencyMs.speechEndToSegment.p50)}  p95 ${fmt(summary.latencyMs.speechEndToSegment.p95)}`);
  console.log(`Segment → first Vietnamese   p50 ${fmt(summary.latencyMs.segmentToFirstToken.p50)}  p95 ${fmt(summary.latencyMs.segmentToFirstToken.p95)}`);
  console.log(`Speech end → full translation p50 ${fmt(summary.latencyMs.speechEndToTranslation.p50)}  p95 ${fmt(summary.latencyMs.speechEndToTranslation.p95)}`);
  if (wer) console.log(`Word error rate: ${(wer.wer * 100).toFixed(1)}% (${wer.errors}/${wer.refWords} words)`);
  if (terms) console.log(`Glossary terms heard: ${terms.found.length}/${terms.found.length + terms.missed.length}${terms.missed.length ? ` (missed: ${terms.missed.join(', ')})` : ''}`);
  console.log(`Estimated cost: $${summary.estimatedCostUsd}`);

  const outDir = resolve(config.migrationsDir, '..', 'data', 'bench');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stem = `${basename(wavPath, '.wav')}-${stamp}`;
  await writeFile(resolve(outDir, `${stem}.json`), JSON.stringify({ summary, rows }, null, 2));
  const sheet = [
    `# ${summary.file} – translation rating sheet`,
    '',
    'Rate each line 1–5 (5 = a professional interpreter would say the same). Note wrong numbers or terms.',
    '',
    '| # | Time | Original | Vietnamese | Score |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r, i) => `| ${i + 1} | ${r.startSec.toFixed(1)}s | ${r.text.replace(/\|/g, '/')} | ${(r.vi ?? `ERROR: ${r.error}`).replace(/\|/g, '/')} | |`),
  ].join('\n');
  await writeFile(resolve(outDir, `${stem}.md`), sheet);
  console.log(`\nSaved data/bench/${stem}.json and .md`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
