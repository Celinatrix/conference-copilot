import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { ConferenceRow } from '../access.js';
import type { ServerEvent, SegmentDto } from '../live/protocol.js';
import { recordUsage, tokenCost } from '../usage.js';
import { selectContext } from '../kb/retrieve.js';
import { looksLikeFeedback, looksLikeQuestion, type QuestionDetector } from './questions.js';
import {
  ANSWER_MODEL_CHOICES,
  RESPONSE_MODE_KEYS,
  type AnswerModelChoice,
  type Responder,
  type ResponseMode,
  type StructuredAnswer,
} from './responder.js';
import { CostGuard } from './budget.js';

export interface QuestionDto {
  id: string;
  conference_id: string;
  segment_id: string | null;
  source: 'auto' | 'manual';
  /** 'comment' = a judge's remark on the presentation (status 'noted'): listed, never answered. */
  kind: 'question' | 'comment';
  text_original: string;
  text_vi: string | null;
  language: string | null;
  status: 'detected' | 'answering' | 'answered' | 'error' | 'awaiting_click' | 'awaiting_confirm' | 'dismissed' | 'noted';
  error: string | null;
  /** Why the listener is asked to confirm the question (status 'awaiting_confirm'). */
  unclear_reason: string | null;
  /** "Câu N" in the conference, in the order questions were asked. */
  seq: number;
  answer: StructuredAnswer | null;
  answer_model: string | null;
  answer_cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
export const toQuestionDto = (row: any): QuestionDto => ({
  ...row,
  answer_cost_usd: row.answer_cost_usd === null ? null : Number(row.answer_cost_usd),
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

export function normalizeModes(value: unknown): ResponseMode[] {
  const modes = Array.isArray(value) ? value.filter((m): m is ResponseMode => RESPONSE_MODE_KEYS.includes(m as ResponseMode)) : [];
  return modes.length ? modes.slice(0, 3) : ['professional', 'concise', 'strategic'];
}

/** 'fast' = cheap first draft; 'quality' = the stronger model, on request. */
export type AnswerTier = 'fast' | 'quality';

export interface QuestionDeps {
  db: Db;
  config: AppConfig;
  detector: QuestionDetector;
  /** The responder for a model id (first drafts use the conference's choice, "draft more carefully" ANSWER_MODEL). */
  responderFor: (model: string) => Responder;
  broadcast: (conferenceId: string, event: ServerEvent) => void;
  /** Speaks a short notice into the conference's audio stream (locked-screen listeners); optional. */
  announce?: (conferenceId: string, text: string) => void;
  log: { warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

/** "Câu N": the next number in the conference ($1). Removed questions keep theirs, so numbers never shift. */
const NEXT_QUESTION_SEQ = `(SELECT COALESCE(MAX(seq), 0) + 1 FROM questions WHERE conference_id = $1 AND kind = 'question')`;
/** "Nhận xét N": remarks are numbered separately, so they never leave gaps in the question numbers. */
const NEXT_COMMENT_SEQ = `(SELECT COALESCE(MAX(seq), 0) + 1 FROM questions WHERE conference_id = $1 AND kind = 'comment')`;

/** Answers waiting per conference beyond which new manual requests are refused. */
export const MAX_QUEUED_ANSWERS = 5;

/** Detects questions in the live transcript and drafts grounded answers, within the per-conference budget. */
export class QuestionService {
  readonly guard: CostGuard;
  /** One answer at a time per conference: bursts queue up instead of running (and billing) in parallel. */
  private chains = new Map<string, Promise<unknown>>();
  private queued = new Map<string, number>();

  constructor(private deps: QuestionDeps) {
    this.guard = new CostGuard(deps.db, deps.config);
  }

  get configured() {
    return this.deps.responderFor(this.deps.config.answers.fast.model).configured;
  }

  queueLength(conferenceId: string): number {
    return this.queued.get(conferenceId) ?? 0;
  }

  private emit(q: QuestionDto) {
    this.deps.broadcast(q.conference_id, { type: 'question', question: q });
  }

  async spentOnAnswers(conferenceId: string): Promise<number> {
    const [{ spent }] = await this.deps.db.query<{ spent: number | null }>(
      `SELECT SUM(cost_usd)::double precision AS spent FROM usage_events WHERE conference_id = $1 AND provider LIKE 'answer:%'`,
      [conferenceId],
    );
    return Number(spent ?? 0);
  }

  /**
   * Called after each segment is translated. Cheap filter first; the classifier only sees likely questions and likely
   * remarks. It sorts the line into a question to the team (popup, answer on request), a remark on the presentation
   * (listed as "Nhận xét", never answered), both (split into one of each), or neither.
   */
  async onSegmentTranslated(segment: SegmentDto, vi: string | null, conference: ConferenceRow, previous: string[]) {
    const { detector, db, config } = this.deps;
    if (!detector.configured) return;
    if (!looksLikeQuestion(segment.text_original) && !looksLikeFeedback(segment.text_original) && !(vi && looksLikeFeedback(vi))) return;
    try {
      if (!(await this.guard.check(conference.workspace_id, conference.id)).ok) return;
      const { detection, inputTokens, outputTokens } = await detector.detect({ current: segment.text_original, currentVi: vi, previous: previous.slice(-4) });
      await recordUsage(db, {
        workspaceId: conference.workspace_id,
        conferenceId: conference.id,
        provider: `detect:${detector.model}`,
        kind: 'llm',
        units: inputTokens + outputTokens,
        unit: 'token',
        costUsd: tokenCost(inputTokens, outputTokens, config.anthropic.inputUsdPerMTok, config.anthropic.outputUsdPerMTok),
      });
      // Only lines put to the listener's team (by judges / organizers / audience) are surfaced.
      if (!detection.for_presenting_team) return;
      const hasComment = detection.kind === 'comment' || detection.kind === 'comment_with_question';
      if (hasComment) await this.saveComment(conference, segment, detection.comment || segment.text_original, detection.comment_vi || vi);
      const hasQuestion = detection.kind === 'question' || detection.kind === 'comment_with_question';
      if (!hasQuestion || !detection.is_question || !detection.worth_answering || !detection.question.trim()) return;

      // A question heard badly is confirmed by the listener first: an answer to the wrong question is worse than none.
      const lowConfidence = segment.confidence !== null && segment.confidence < config.lowConfidenceThreshold;
      const reasons = [
        lowConfidence ? `Nhận dạng giọng nói không chắc chắn (độ tin cậy ${Math.round(segment.confidence! * 100)}%).` : '',
        detection.is_clear ? '' : detection.unclear_reason.trim() || 'Câu hỏi chưa rõ ràng.',
      ].filter(Boolean);
      const unclear = reasons.length > 0;
      const budget = config.answers.autoBudgetUsd;
      const overBudget = !unclear && budget > 0 && (await this.spentOnAnswers(conference.id)) >= budget;
      // By default every question waits for the listener's "Trả lời" (draft) or "Skip" before anything is drafted:
      // nothing is spent on questions they will not answer. ANSWER_REQUIRE_CONFIRM=false restores auto-drafting.
      const status = unclear ? 'awaiting_confirm' : config.answers.requireConfirm || overBudget ? 'awaiting_click' : 'detected';
      const [row] = await db.query(
        `INSERT INTO questions (conference_id, segment_id, source, text_original, text_vi, language, status, unclear_reason, seq)
         VALUES ($1, $2, 'auto', $3, $4, $5, $6, $7, ${NEXT_QUESTION_SEQ}) RETURNING *`,
        [
          conference.id,
          segment.id,
          detection.question,
          detection.question_vi || (hasComment ? null : vi),
          segment.language,
          status,
          unclear ? reasons.join(' ') : null,
        ],
      );
      const question = toQuestionDto(row);
      await this.dropSupersededFragments(conference.id, question);
      this.emit(question);
      if (status === 'detected') await this.answer(question.id, conference, detection.keywords);
    } catch (err) {
      this.deps.log.warn({ err, segmentId: segment.id }, 'question detection failed');
    }
  }

  /** A judge's remark on the presentation: listed as "Nhận xét N" (own numbering), no popup, no answer, no cost beyond detection. */
  private async saveComment(conference: ConferenceRow, segment: SegmentDto, text: string, textVi: string | null) {
    const [row] = await this.deps.db.query(
      `INSERT INTO questions (conference_id, segment_id, source, kind, text_original, text_vi, language, status, seq)
       VALUES ($1, $2, 'auto', 'comment', $3, $4, $5, 'noted', ${NEXT_COMMENT_SEQ}) RETURNING *`,
      [conference.id, segment.id, text, textVi, segment.language],
    );
    this.emit(toQuestionDto(row));
  }

  async createManual(conference: ConferenceRow, text: string, segmentId: string | null, textVi: string | null, language: string | null): Promise<QuestionDto> {
    const [row] = await this.deps.db.query(
      `INSERT INTO questions (conference_id, segment_id, source, text_original, text_vi, language, status, seq)
       VALUES ($1, $2, 'manual', $3, $4, $5, 'detected', ${NEXT_QUESTION_SEQ}) RETURNING *`,
      [conference.id, segmentId, text, textVi, language],
    );
    const question = toQuestionDto(row);
    this.emit(question);
    return question;
  }

  /**
   * A speaker who pauses mid-question produces two detections: the fragment ("What happens to your value of new
   * business") and, a moment later, the full question. Undecided fragments from the last 30 s that the new question
   * contains are dismissed, so the listener gets one prompt per question.
   */
  private async dropSupersededFragments(conferenceId: string, question: QuestionDto) {
    const norm = (s: string) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const full = norm(question.text_original);
    if (!full) return;
    const recent = await this.deps.db.query(
      `SELECT * FROM questions WHERE conference_id = $1 AND id <> $2 AND status IN ('awaiting_click', 'awaiting_confirm')
         AND created_at > now() - interval '30 seconds'`,
      [conferenceId, question.id],
    );
    for (const old of recent) {
      // Only an unfinished question counts as a fragment: one flagged unclear, or not ending with a question mark.
      // A complete question is never dropped, even when a later (wrongly merged) detection repeats its text.
      const unfinished = old.status === 'awaiting_confirm' || !/[?？]\s*["')\]]?\s*$/u.test(String(old.text_original));
      if (!unfinished) continue;
      // Compare the unfinished tail: a detection can wrongly glue an earlier complete question in front of the
      // fragment ("…claims data? What happens to your value of new business if"); its tail is what continues.
      const parts = String(old.text_original).split(/[?？.!。]/u).map((p) => p.trim()).filter(Boolean);
      const fragment = norm(parts.at(-1) ?? '');
      if (!fragment || fragment.length >= full.length || !full.includes(fragment)) continue;
      const q = await this.dismiss(old.id);
      if (q) this.deps.log.warn({ questionId: old.id }, 'dismissed a question fragment superseded by the full question');
    }
  }

  /** Prices from .env for the two configured models, list prices for the other selectable ones. */
  private priceFor(model: string) {
    const { answers } = this.deps.config;
    if (model === answers.fast.model) return answers.fast;
    if (model === answers.model) return answers;
    return ANSWER_MODEL_CHOICES[model as AnswerModelChoice] ?? answers;
  }

  /** Replaces the question text with the listener's correction before drafting; the stale translation is dropped. */
  async correctText(questionId: string, text: string): Promise<void> {
    const [row] = await this.deps.db.query(
      `UPDATE questions SET text_original = $2, text_vi = NULL, unclear_reason = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [questionId, text],
    );
    if (row) this.emit(toQuestionDto(row));
  }

  async dismiss(questionId: string): Promise<QuestionDto | null> {
    const [row] = await this.deps.db.query(`UPDATE questions SET status = 'dismissed', updated_at = now() WHERE id = $1 RETURNING *`, [questionId]);
    if (!row) return null;
    const q = toQuestionDto(row);
    this.emit(q);
    return q;
  }

  /**
   * Drafts (or re-drafts) the answer, queued behind any answer already running for this conference.
   * Manual requests may exceed the auto-suggest budget but never the hard cost caps.
   */
  answer(questionId: string, conference: ConferenceRow, extraKeywords: string[] = [], tier: AnswerTier = 'fast'): Promise<QuestionDto> {
    const id = conference.id;
    this.queued.set(id, this.queueLength(id) + 1);
    const run = (this.chains.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.answerNow(questionId, conference, extraKeywords, tier))
      .finally(() => {
        this.queued.set(id, Math.max(0, this.queueLength(id) - 1));
        if (this.chains.get(id) === run) this.chains.delete(id);
      });
    this.chains.set(id, run);
    return run;
  }

  private async answerNow(questionId: string, conference: ConferenceRow, extraKeywords: string[], tier: AnswerTier): Promise<QuestionDto> {
    const { db, config } = this.deps;
    // Read the choice at drafting time: a live room holds the conference row from when the session started.
    const [choice] = await db.query<{ answer_model: string | null }>('SELECT answer_model FROM conferences WHERE id = $1', [conference.id]);
    const model = tier === 'quality' ? config.answers.model : choice?.answer_model ?? config.answers.fast.model;
    const responder = this.deps.responderFor(model);
    // A question the listener removed (X) while it was queued or being drafted stays removed: no update revives it.
    const update = async (sql: string, params: unknown[]) => {
      const [row] = await db.query(`UPDATE questions SET ${sql}, updated_at = now() WHERE id = $1 AND status <> 'dismissed' RETURNING *`, [questionId, ...params]);
      if (!row) {
        const [current] = await db.query(`SELECT * FROM questions WHERE id = $1`, [questionId]);
        return toQuestionDto(current);
      }
      const q = toQuestionDto(row);
      this.emit(q);
      return q;
    };
    const [existing] = await db.query<{ status: string }>(`SELECT status FROM questions WHERE id = $1`, [questionId]);
    if (existing?.status === 'dismissed') return update('status = status', []);
    const verdict = await this.guard.check(conference.workspace_id, conference.id);
    if (!verdict.ok) return update(`status = 'error', error = $2`, [verdict.message]);
    const question = await update(`status = 'answering', error = NULL`, []);
    try {
      const recent = await db.query<{ text_original: string; text_vi: string | null }>(
        `SELECT text_original, text_vi FROM segments WHERE conference_id = $1 ORDER BY seq DESC LIMIT 6`,
        [conference.id],
      );
      const { chunks, mode } = await selectContext(db, conference.id, [question.text_original, question.text_vi ?? '', ...extraKeywords]);
      const [{ docs }] = await db.query<{ docs: number }>(`SELECT COUNT(*)::int AS docs FROM documents WHERE conference_id = $1 AND status = 'ready'`, [conference.id]);
      const modes = normalizeModes((conference as ConferenceRow & { response_modes?: unknown }).response_modes);
      const result = await responder.generate(
        {
          question: question.text_original,
          questionVi: question.text_vi,
          recentTranscript: recent.reverse().map((r) => r.text_vi ?? r.text_original),
          modes,
          conferenceName: conference.name,
          chunks,
        },
        (delta) => this.deps.broadcast(conference.id, { type: 'answer.delta', questionId, delta }),
      );
      const a = this.priceFor(model);
      const u = result.usage;
      const cost = (u.input * a.inputUsdPerMTok + u.output * a.outputUsdPerMTok + u.cacheRead * a.cacheReadUsdPerMTok + u.cacheWrite * a.cacheWriteUsdPerMTok) / 1_000_000;
      await recordUsage(db, {
        workspaceId: conference.workspace_id,
        conferenceId: conference.id,
        provider: `answer:${responder.model}`,
        kind: 'llm',
        units: u.input + u.output + u.cacheRead + u.cacheWrite,
        unit: 'token',
        costUsd: cost,
      });
      const answer: StructuredAnswer = { ...result.answer, context: mode === 'none' ? (docs ? 'no_match' : 'none') : mode };
      return await update(`status = 'answered', answer = $2::jsonb, answer_model = $3, answer_cost_usd = $4`, [JSON.stringify(answer), responder.model, cost]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định';
      this.deps.log.warn({ err, questionId }, 'answer failed');
      return await update(`status = 'error', error = $2`, [message.slice(0, 500)]);
    }
  }
}
