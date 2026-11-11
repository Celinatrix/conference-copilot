import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { AuthUser } from '../auth.js';
import { audit, type ConferenceRow } from '../access.js';
import { recordUsage, tokenCost } from '../usage.js';
import type { SttProvider, SttResult, SttStream } from './stt.js';
import { SentenceAssembler, type AssembledSegment } from './assembler.js';
import { AudioTimeline } from './timeline.js';
import { computeFlags } from '../ai/trust.js';
import type { QuestionService } from '../ai/service.js';
import type { Translator } from './translator.js';
import type { ClientMessage, RoomStatus, SegmentDto, ServerEvent } from './protocol.js';
import { toIso } from '../http.js';

const HOST_GRACE_MS = 90_000;
const CONTEXT_SEGMENTS = 3;
const SLOW_CLIENT_BYTES = 1_000_000;
/** Translations in flight per room. Display order is by seq, so finishing out of order is harmless. */
export const TRANSLATION_CONCURRENCY = 3;

export interface LiveClient {
  id: string;
  user: AuthUser;
  canManage: boolean;
  send(event: ServerEvent): void;
  bufferedAmount(): number;
}

export function toSegmentDto(row: any): SegmentDto {
  return {
    ...row,
    confidence: row.confidence === null ? null : Number(row.confidence),
    flags: Array.isArray(row.flags) ? row.flags : [],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export interface LiveDeps {
  db: Db;
  config: AppConfig;
  stt: SttProvider;
  translator: Translator;
  /** Question detection + suggested answers; absent in setups without it. */
  questions?: QuestionService;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

class LiveRoom {
  readonly clients = new Set<LiveClient>();
  private host: LiveClient | null = null;
  private hostUserId: string | null = null;
  private status: RoomStatus = 'idle';
  private session: { id: string; startedAt: Date } | null = null;
  private stt: SttStream | null = null;
  private sttStatus = 'idle';
  private sttDetail: string | null = null;
  private partial: { text: string; language: string | null; speaker: string | null } | null = null;
  private nextSeq = 1;
  private conference: ConferenceRow | null = null;
  /** Recent segments for translation context; `vi` fills in when that segment's translation finishes. */
  private context: { original: string; vi: string | null }[] = [];
  private translateQueue: { segment: SegmentDto; receivedAt: number }[] = [];
  private translationsInFlight = 0;
  private assembler: SentenceAssembler | null = null;
  private timeline: AudioTimeline | null = null;
  /** Segment inserts run one after another so seq numbers and DB order always match. */
  private writeChain: Promise<void> = Promise.resolve();
  private hostGrace: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private sttSecondsRecorded = 0;
  private busy = false;

  constructor(
    readonly conferenceId: string,
    private deps: LiveDeps,
    private manager: LiveManager,
  ) {}

  get idle() {
    return this.status === 'idle' && this.clients.size === 0;
  }

  attach(client: LiveClient) {
    this.clients.add(client);
    this.sendState(client);
    if (this.partial) client.send({ type: 'partial', ...this.partial });
    this.broadcastState();
  }

  detach(client: LiveClient) {
    this.clients.delete(client);
    if (client === this.host) {
      this.host = null;
      if (this.status === 'live' || this.status === 'paused') {
        this.hostGrace = setTimeout(() => this.onHostLost(), HOST_GRACE_MS);
      }
    }
    this.broadcastState();
    this.manager.cleanup(this);
  }

  async handleControl(client: LiveClient, msg: ClientMessage) {
    switch (msg.type) {
      case 'ping':
        return client.send({ type: 'pong', t: msg.t });
      case 'start':
        return this.start(client, msg.audioSource);
      case 'reclaim':
        return this.reclaim(client);
      case 'pause':
      case 'resume':
        if (client !== this.host) return this.error(client, 'not_host', 'Chỉ thiết bị đang thu âm mới điều khiển được phiên.');
        return this.setPaused(msg.type === 'pause');
      case 'stop':
        if (client !== this.host && !client.canManage) return this.error(client, 'forbidden', 'Bạn không có quyền dừng phiên.');
        return this.end('stopped');
    }
  }

  handleAudio(client: LiveClient, chunk: Buffer) {
    if (client !== this.host || this.status !== 'live' || !this.stt) return;
    this.timeline?.mark(chunk.length);
    this.stt.send(chunk);
  }

  private error(client: LiveClient, code: string, message: string) {
    client.send({ type: 'error', code, message });
  }

  private async start(client: LiveClient, audioSource: string) {
    if (!client.canManage) return this.error(client, 'forbidden', 'Bạn không có quyền bắt đầu thu âm cho hội nghị này.');
    if (this.status === 'live' || this.status === 'paused') {
      if (this.hostUserId === client.user.id) return this.reclaim(client);
      return this.error(client, 'host_busy', 'Một thiết bị khác đang thu âm cho hội nghị này.');
    }
    if (this.busy || this.status === 'ending') return;
    if (!this.deps.stt.configured) {
      return this.error(client, 'stt_not_configured', 'Chưa cấu hình DEEPGRAM_API_KEY trong file backend/.env.');
    }
    this.busy = true;
    const { db } = this.deps;
    try {
      const [conf] = await db.query<ConferenceRow>('SELECT * FROM conferences WHERE id = $1', [this.conferenceId]);
      if (!conf) return this.error(client, 'not_found', 'Hội nghị không tồn tại.');
      // A new session is new spending: refuse it past the hard caps. A running session is never cut off.
      const verdict = await this.deps.questions?.guard.check(conf.workspace_id, conf.id);
      if (verdict && !verdict.ok) return this.error(client, 'budget_exceeded', verdict.message);
      this.conference = conf;
      const [session] = await db.query<{ id: string; started_at: Date }>(
        `INSERT INTO live_sessions (conference_id, started_by, audio_source, stt_provider, consent_confirmed_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING id, started_at`,
        [this.conferenceId, client.user.id, audioSource, this.deps.stt.name],
      );
      const [{ max }] = await db.query<{ max: number | null }>('SELECT MAX(seq) AS max FROM segments WHERE conference_id = $1', [this.conferenceId]);
      this.nextSeq = (max ?? 0) + 1;
      const recent = await db.query<{ text_original: string; text_vi: string | null }>(
        'SELECT text_original, text_vi FROM segments WHERE conference_id = $1 ORDER BY seq DESC LIMIT $2',
        [this.conferenceId, CONTEXT_SEGMENTS],
      );
      this.context = recent.reverse().map((r) => ({ original: r.text_original, vi: r.text_vi }));
      this.session = { id: session.id, startedAt: new Date(session.started_at) };
      this.host = client;
      this.hostUserId = client.user.id;
      this.sttSecondsRecorded = 0;
      this.status = 'live';
      this.assembler = new SentenceAssembler((segment) => this.queueWrite(segment));
      this.timeline = new AudioTimeline(this.session.startedAt.getTime());
      this.stt = this.deps.stt.open(
        { language: conf.input_language || 'multi' },
        {
          onResult: (r) => this.onSttResult(r),
          onUtteranceEnd: () => {
            this.assembler?.utteranceEnd();
            this.clearPartial();
          },
          onStatus: (status, detail) => {
            this.sttStatus = status;
            this.sttDetail = detail ?? null;
            if (status === 'failed') {
              this.deps.log.error({ conferenceId: this.conferenceId, detail }, 'STT failed');
              this.broadcast({ type: 'error', code: 'stt_failed', message: `Không kết nối được Deepgram. ${detail ?? ''}`.trim() });
              void this.end('stt_failed');
            }
            this.broadcastState();
          },
        },
      );
      this.usageTimer = setInterval(() => void this.flushSttUsage(), 60_000);
      await db.query(`UPDATE conferences SET status = 'live', updated_at = now() WHERE id = $1`, [this.conferenceId]);
      await audit(db, {
        workspaceId: conf.workspace_id,
        userId: client.user.id,
        action: 'live_session.start',
        targetType: 'conference',
        targetId: this.conferenceId,
        meta: { sessionId: session.id, audioSource, consent: true },
      });
      this.broadcastState();
    } catch (err) {
      this.deps.log.error({ err }, 'start failed');
      this.error(client, 'start_failed', 'Không bắt đầu được phiên. Xem log server.');
    } finally {
      this.busy = false;
    }
  }

  private reclaim(client: LiveClient) {
    if (!this.session || client.user.id !== this.hostUserId) return;
    if (this.host && this.host !== client) return this.error(client, 'host_busy', 'Một thiết bị khác đang thu âm.');
    this.host = client;
    if (this.hostGrace) clearTimeout(this.hostGrace);
    this.hostGrace = null;
    this.broadcastState();
  }

  private async setPaused(paused: boolean) {
    if (paused && this.status !== 'live') return;
    if (!paused && this.status !== 'paused') return;
    this.status = paused ? 'paused' : 'live';
    if (paused) {
      // Speech was cut by the pause: release what was heard so it is stored and translated now.
      this.assembler?.flush();
      this.clearPartial();
    }
    await this.deps.db.query('UPDATE conferences SET status = $2, updated_at = now() WHERE id = $1', [this.conferenceId, this.status]);
    this.broadcastState();
  }

  private async onHostLost() {
    this.hostGrace = null;
    if (this.status === 'live') {
      this.deps.log.warn({ conferenceId: this.conferenceId }, 'host did not reconnect; pausing');
      await this.setPaused(true);
    }
  }

  private async end(reason: string) {
    if (!this.session || this.status === 'ending' || this.status === 'idle') return;
    this.status = 'ending';
    this.broadcastState();
    if (this.hostGrace) clearTimeout(this.hostGrace);
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.hostGrace = this.usageTimer = null;
    try {
      await this.stt?.finish();
    } catch (err) {
      this.deps.log.warn({ err }, 'stt finish failed');
    }
    // Release the sentence still being assembled and wait for it to be stored before closing the session.
    this.assembler?.flush();
    this.assembler?.dispose();
    this.assembler = null;
    await this.writeChain;
    await this.flushSttUsage();
    this.clearPartial();
    const { db } = this.deps;
    await db.query('UPDATE live_sessions SET ended_at = now(), end_reason = $2 WHERE id = $1', [this.session.id, reason]);
    await db.query(`UPDATE conferences SET status = 'ended', updated_at = now() WHERE id = $1`, [this.conferenceId]);
    if (this.conference) {
      await audit(db, {
        workspaceId: this.conference.workspace_id,
        userId: this.hostUserId,
        action: 'live_session.end',
        targetType: 'conference',
        targetId: this.conferenceId,
        meta: { sessionId: this.session.id, reason },
      });
    }
    this.stt = null;
    this.session = null;
    this.host = null;
    this.hostUserId = null;
    this.sttStatus = 'idle';
    this.status = 'idle';
    this.broadcastState();
    this.manager.cleanup(this);
  }

  private async flushSttUsage() {
    if (!this.stt || !this.conference) return;
    const total = this.stt.audioSecondsSent();
    const delta = total - this.sttSecondsRecorded;
    if (delta <= 0) return;
    this.sttSecondsRecorded = total;
    await recordUsage(this.deps.db, {
      workspaceId: this.conference.workspace_id,
      conferenceId: this.conferenceId,
      provider: this.stt.provider,
      kind: 'stt',
      units: delta / 60,
      unit: 'minute',
      costUsd: (delta / 60) * this.deps.config.deepgram.usdPerMinute,
    }).catch((err) => this.deps.log.warn({ err }, 'usage record failed'));
  }

  private clearPartial() {
    if (!this.partial) return;
    this.partial = null;
    this.broadcast({ type: 'partial.clear' });
  }

  private onSttResult(r: SttResult) {
    if (!this.session || !this.assembler) return;
    if (r.isFinal) this.assembler.push(r);
    // Viewers see the whole sentence growing: confirmed-but-unreleased text plus the current interim guess.
    const interim = r.isFinal ? '' : r.text;
    const text = [this.assembler.pendingText, interim].filter(Boolean).join(' ');
    if (!text) return this.clearPartial();
    this.partial = {
      text,
      language: r.language ?? this.assembler.pendingLanguage,
      speaker: this.assembler.pendingSpeaker ?? r.speaker,
    };
    this.broadcast({ type: 'partial', ...this.partial }, true);
  }

  private queueWrite(segment: AssembledSegment) {
    const session = this.session;
    if (!session) return;
    this.writeChain = this.writeChain
      .then(() => this.persistSegment(segment, session.id))
      .catch((err) => this.deps.log.error({ err }, 'persist segment failed'));
  }

  private async persistSegment(s: AssembledSegment, sessionId: string) {
    const seq = this.nextSeq++;
    const language = s.language ?? (this.conference?.input_language !== 'multi' ? this.conference?.input_language ?? null : null);
    const [row] = await this.deps.db.query(
      `INSERT INTO segments (conference_id, session_id, seq, start_ms, end_ms, speaker, language, confidence, text_original)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        this.conferenceId,
        sessionId,
        seq,
        // Session clock, not audio clock: silence gating and pauses make the two drift apart.
        this.timeline ? this.timeline.toSessionMs(s.startSec) : Math.round(s.startSec * 1000),
        this.timeline ? this.timeline.toSessionMs(s.endSec) : Math.round(s.endSec * 1000),
        s.speaker,
        language,
        s.confidence,
        s.text,
      ],
    );
    const segment = toSegmentDto(row);
    // The live line now continues from whatever has not been released yet.
    const rest = this.assembler?.pendingText ?? '';
    if (rest && this.partial) this.partial = { ...this.partial, text: rest };
    else this.partial = null;
    this.broadcast({ type: 'segment', segment });
    this.broadcast(this.partial ? { type: 'partial', ...this.partial } : { type: 'partial.clear' });
    this.translateQueue.push({ segment, receivedAt: Date.now() });
    this.pumpTranslations();
  }

  /** Runs up to TRANSLATION_CONCURRENCY translations at once so a fast speaker does not build a growing backlog. */
  private pumpTranslations() {
    const conference = this.conference;
    if (!conference) return;
    while (this.translationsInFlight < TRANSLATION_CONCURRENCY && this.translateQueue.length) {
      const { segment, receivedAt } = this.translateQueue.shift()!;
      // Context = the originals just before this segment; their translations are included once available.
      const context = this.context.slice(-CONTEXT_SEGMENTS).map((c) => ({ ...c }));
      const entry = { original: segment.text_original, vi: null as string | null };
      this.context.push(entry);
      if (this.context.length > CONTEXT_SEGMENTS * 2) this.context.shift();
      this.translationsInFlight++;
      this.manager
        .translateSegment(segment, conference, context, receivedAt)
        .then((vi) => {
          entry.vi = vi;
          // Fire-and-forget: question detection must never hold up the translation queue.
          void this.deps.questions?.onSegmentTranslated(segment, vi, conference, context.map((c) => c.original));
        })
        .catch((err) => this.deps.log.error({ err, segmentId: segment.id }, 'translation pipeline failed'))
        .finally(() => {
          this.translationsInFlight--;
          this.pumpTranslations();
        });
    }
  }

  broadcast(event: ServerEvent, droppable = false) {
    for (const c of this.clients) {
      if (droppable && c.bufferedAmount() > SLOW_CLIENT_BYTES) continue;
      c.send(event);
    }
  }

  private stateFor(client: LiveClient): ServerEvent {
    return {
      type: 'state',
      status: this.status,
      sessionId: this.session?.id ?? null,
      startedAt: this.session?.startedAt.toISOString() ?? null,
      hostConnected: this.host !== null,
      hostUserId: this.hostUserId,
      youAreHost: client === this.host,
      sttStatus: this.sttStatus,
      sttDetail: this.sttDetail,
      viewers: this.clients.size,
    };
  }

  private sendState(client: LiveClient) {
    client.send(this.stateFor(client));
  }

  private broadcastState() {
    for (const c of this.clients) this.sendState(c);
  }
}

export class LiveManager {
  private rooms = new Map<string, LiveRoom>();

  constructor(private deps: LiveDeps) {}

  /** Wired after construction because the question service broadcasts through this manager. */
  attachQuestions(questions: QuestionService) {
    this.deps.questions = questions;
  }

  room(conferenceId: string): LiveRoom {
    let room = this.rooms.get(conferenceId);
    if (!room) {
      room = new LiveRoom(conferenceId, this.deps, this);
      this.rooms.set(conferenceId, room);
    }
    return room;
  }

  cleanup(room: LiveRoom) {
    if (room.idle) this.rooms.delete(room.conferenceId);
  }

  broadcast(conferenceId: string, event: ServerEvent) {
    this.rooms.get(conferenceId)?.broadcast(event);
  }

  /** Sessions cannot survive a process restart; close them so the UI does not show a phantom live session. */
  async recoverAfterRestart() {
    const { db } = this.deps;
    await db.query(`UPDATE live_sessions SET ended_at = now(), end_reason = 'server_restart' WHERE ended_at IS NULL`);
    await db.query(`UPDATE conferences SET status = 'ended', updated_at = now() WHERE status IN ('live', 'paused')`);
    await db.query(
      `UPDATE segments SET translation_status = 'error', translation_error = 'Server khởi động lại trước khi dịch xong' WHERE translation_status = 'pending'`,
    );
  }

  /** Translates one segment, persists the result, streams deltas to viewers. Returns the Vietnamese text (or null on failure). */
  async translateSegment(
    segment: SegmentDto,
    conference: ConferenceRow,
    context: { original: string; vi: string | null }[],
    receivedAt: number | null,
  ): Promise<string | null> {
    const { db, translator, config, log } = this.deps;
    const conferenceId = segment.conference_id;

    const finish = async (status: 'done' | 'skipped', text: string) => {
      const flags = computeFlags({
        original: segment.text_original,
        vi: status === 'skipped' ? null : text,
        confidence: segment.confidence,
        glossary: conference.glossary,
        lowConfidenceThreshold: config.lowConfidenceThreshold,
      });
      const [row] = await db.query(
        `UPDATE segments SET text_vi = $2, translation_status = $3, translation_error = NULL, flags = $4::jsonb, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [segment.id, text, status, JSON.stringify(flags)],
      );
      if (!row) return text;
      this.broadcast(conferenceId, {
        type: 'translation.done',
        segmentId: segment.id,
        text_vi: text,
        latencyMs: receivedAt === null ? null : Date.now() - receivedAt,
        flags,
      });
      return text;
    };

    if (segment.language && segment.language.toLowerCase().startsWith('vi')) {
      return finish('skipped', segment.text_original);
    }

    try {
      const result = await translator.translate(
        {
          text: segment.text_original,
          language: segment.language,
          conferenceName: conference.name,
          glossary: conference.glossary,
          context,
        },
        (delta) => this.broadcast(conferenceId, { type: 'translation.delta', segmentId: segment.id, delta }),
      );
      await recordUsage(db, {
        workspaceId: conference.workspace_id,
        conferenceId,
        provider: `anthropic:${translator.model}`,
        kind: 'translation',
        units: result.inputTokens + result.outputTokens,
        unit: 'token',
        costUsd: tokenCost(result.inputTokens, result.outputTokens, config.anthropic.inputUsdPerMTok, config.anthropic.outputUsdPerMTok),
      });
      return await finish('done', result.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi dịch không xác định';
      log.warn({ err, segmentId: segment.id }, 'translation failed');
      await db.query(
        `UPDATE segments SET translation_status = 'error', translation_error = $2, updated_at = now() WHERE id = $1`,
        [segment.id, message.slice(0, 500)],
      );
      this.broadcast(conferenceId, { type: 'translation.error', segmentId: segment.id, message });
      return null;
    }
  }
}
