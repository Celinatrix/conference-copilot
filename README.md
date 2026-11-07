# Conference AI Copilot

Real-time multilingual conference interpretation into Vietnamese.

**Status: Phase 1, realtime core.** Working: sign-in, conference management, live audio capture → streaming
speech-to-text (Deepgram) → streaming Vietnamese translation (Claude), auto-saved transcript, edit and
search, important markers, Markdown/TXT export, cost tracking, 3-column live UI with a large-text mode,
and many viewers following one session live.
Not built yet (next phases): Knowledge Base/RAG, AI suggested answers, question detection, AI summary
reports, team invitations, PDF/DOCX export.

## Requirements

- Node.js 20+ (tested on 26)
- A Deepgram API key and an Anthropic API key
- Chrome or Edge (recommended). Microphone capture needs `localhost` or HTTPS.

No Docker or Postgres install is needed for local runs: the server uses **PGlite** (real Postgres
compiled to WASM) and stores data in `./data/pglite`. Set `DATABASE_URL` to switch to a real PostgreSQL.
The same migrations run on both.

## Run locally

```bash
npm install
cp .env.example .env        # then fill DEEPGRAM_API_KEY and ANTHROPIC_API_KEY
npm run dev:server          # API + WebSocket on http://127.0.0.1:4000
npm run dev:web             # UI on http://localhost:3000  (second terminal)
```

Open http://localhost:3000 and create an account. The first account owns the workspace; after that, signup is
closed and teammates join through invite links (Settings → Thành viên & lời mời; single use, expiring, member or
admin). Then create a conference, click **Start Listening**, choose an audio source and confirm the recording notice.

Both dev servers listen on `127.0.0.1` only, so nobody else on a shared Wi-Fi can reach them. Security probes:
`npx tsx scripts/security-probe.ts` in `server/` (in-memory instance, no external calls).

Tests: `npm test` (server unit + API/WebSocket integration tests against in-memory PGlite).
Typecheck: `npm run typecheck`.

### Measuring quality and performance

- `npm run bench:live -w server -- talk.wav --ref talk.txt --glossary terms.txt --language multi` plays a
  recording through the **real** Deepgram + Claude pipeline in real time. It reports latency (speech end → segment,
  → first Vietnamese word, → full translation), word error rate, and glossary term recall, and writes a rating sheet to
  `data/bench/`. This spends API credit roughly equal to the recording length. Convert audio first:
  `ffmpeg -i talk.mp3 -ar 16000 -ac 1 -c:a pcm_s16le talk.wav`.
- `npm run bench:fanout -w server` measures our own server overhead with 1/5/10/20 viewers, plus load and search
  times for an 8-hour transcript. External APIs are replaced by instant doubles.

## Architecture

```
Browser (host)  mic / USB interface / system audio
  └─ AudioWorklet → 16 kHz PCM16, 100 ms frames ──binary WS──┐
                                                             ▼
Fastify server ── LiveRoom (one per conference) ── Deepgram streaming (interim + final, language, speaker)
                    │  partial → broadcast only
                    │  final   → segments table → Claude Haiku streaming translation → broadcast deltas
                    └─ fan-out to every viewer's WebSocket
Next.js UI  ── /api/* proxied to the server (first-party session cookie)
```

- **One audio stream per conference**, however many people watch, so AI cost scales with conference hours, not viewers.
- **Partial vs. confirmed**: interim recognition is shown in italics and never stored. Final recognition chunks
  are joined into whole sentences (`server/src/live/assembler.ts`: cut on end-of-utterance, sentence punctuation,
  speaker change, 12 s or 60 words). Each sentence is persisted immediately and then translated, up to 3 at a time,
  with the preceding segments and the conference glossary as context.
- **Resilience**: the browser queues up to 2 minutes of audio while the network is down and replays it after
  reconnecting. The server buffers 30 s while Deepgram reconnects (with timestamp offsets) and gives a lost host
  90 s to come back before pausing. Sessions left open by a server restart are closed cleanly on boot.
  A failed translation can be retried per segment.
- **Security**: scrypt password hashing, hashed session tokens in httpOnly SameSite cookies, an Origin check on
  mutating requests and on the WebSocket, single-use 60 s WebSocket tickets, per-conference privacy
  (`private` = creator only, even for workspace owners), an audit log, a login rate limit, and API keys only on the server.

### Code map

| Path | What |
|---|---|
| `server/migrations/` | SQL migrations (run automatically on start, or `npm run migrate -w server`) |
| `server/src/live/deepgram.ts` | Deepgram streaming adapter: reconnect, buffering, keep-alive, message parser |
| `server/src/live/translator.ts` | Claude streaming translator and prompt |
| `server/src/live/room.ts` | Live session orchestration, persistence, fan-out |
| `server/src/routes/` | REST API |
| `web/public/pcm-worklet.js` | Resampling to 16 kHz PCM16 on the audio thread |
| `web/lib/live.ts` | WebSocket client with reconnect and audio queue |
| `web/app/(app)/conferences/[id]/page.tsx` | Live 3-column interface |

### REST API (summary)

| Method | Path | |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | session cookie |
| GET | `/api/auth/me` | current user + workspace |
| GET | `/api/dashboard` | recent / active conferences, totals |
| GET/POST | `/api/conferences` | list (`?q=`) / create |
| GET/PATCH/DELETE | `/api/conferences/:id` | detail with sessions / update / permanent delete |
| GET | `/api/conferences/:id/segments?q=&important=1` | transcript, search |
| PATCH | `/api/segments/:id` | edit original/translation, mark important |
| POST | `/api/segments/:id/retranslate` | translate again |
| GET | `/api/conferences/:id/export?format=md\|txt&view=both\|original\|vi` | download |
| GET | `/api/conferences/:id/usage` | cost breakdown |
| POST | `/api/conferences/:id/ws-ticket` | ticket for `ws://host:4000/ws?ticket=` |

WebSocket: the client sends JSON `start` / `pause` / `resume` / `stop` / `reclaim` plus binary audio frames;
the server sends `state`, `partial`, `segment`, `translation.delta|done|error`, `segment.updated`, `error`.

## Known limits (honest list)

- **Language support depends on the Deepgram model.** `nova-3` with `language=multi` auto-detects and handles
  code-switching only for the languages Deepgram supports in multilingual mode. For other languages, set the
  conference input language explicitly; if Deepgram rejects the combination, the UI shows Deepgram's error and
  you can change `DEEPGRAM_MODEL`. Check Deepgram's current language table before an important event.
- Translation runs on **confirmed sentences** only (no translation of interim text), to avoid flicker and wasted
  tokens. End-to-end latency is typically the speaker pause (~0.3–1 s) plus Claude's streaming time; it depends on
  network and audio quality and is not guaranteed.
- Speaker labels come from streaming diarization ("Speaker 1/2…") and can be wrong when people talk over each other.
- System-audio capture works on Chrome/Edge (Windows: whole screen or tab; macOS: tab only). Not on Safari, Firefox or mobile.
- Live rooms live in one server process. Running several API instances requires Redis pub/sub (planned for the production phase).
- Costs shown are estimates from the unit prices in `.env`; check the providers' billing dashboards for the real numbers.
