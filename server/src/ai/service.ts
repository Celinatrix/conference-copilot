import type { Db } from '../db.js';
import type { AppConfig } from '../config.js';
import type { ConferenceRow } from '../access.js';
import type { ServerEvent, SegmentDto } from '../live/protocol.js';
import { recordUsage, tokenCost } from '../usage.js';
import { selectContext } from '../kb/retrieve.js';
import { looksLikeQuestion, type QuestionDetector } from './questions.js';
import { RESPONSE_MODE_KEYS, type Responder, type ResponseMode, type StructuredAnswer } from './responder.js';
import { CostGuard } from './budget.js';

export interface QuestionDto {
  id: string;
  conference_id: string;
  segment_id: string | null;
  source: 'auto' | 'manual';
  text_original: string;
  text_vi: string | null;
  language: string | null;
  status: 'detected' | 'answering' | 'answered' | 'error' | 'awaiting_click';
  error: string | null;
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

export interface QuestionDeps {
  db: Db;
  config: AppConfig;
  detector: QuestionDetector;
  responder: Responder;
  broadcast: (conferenceId: string, event: ServerEvent) => void;
  log: { warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

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
    return this.deps.responder.configured;
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

  /** Called after each segment is translated. Cheap filter first; the classifier only sees likely questions. */
  async onSegmentTranslated(segment: SegmentDto, vi: string | null, conference: ConferenceRow, previous: string[]) {
    const { detector, db, config } = this.deps;
    if (!detector.configured || !looksLikeQuestion(segment.text_original)) return;
    try {
      if (!(await this.guard.check(conference.workspace_id, conference.id)).ok) return;
      const { detection, inputTokens, outputTokens } = await detector.detect({ current: segment.text_original, currentVi: vi, previous: previous.slice(-2) });
      await recordUsage(db, {
        workspaceId: conference.workspace_id,
        conferenceId: conference.id,
        provider: `detect:${detector.model}`,
        kind: 'llm',
        units: inputTokens + outputTokens,
        unit: 'token',
        costUsd: tokenCost(inputTokens, outputTokens, config.anthropic.inputUsdPerMTok, config.anthropic.outputUsdPerMTok),
      });
      if (!detection.is_question || !detection.worth_answering) return;

      const budget = config.answers.autoBudgetUsd;
      const overBudget = budget > 0 && (await this.spentOnAnswers(conference.id)) >= budget;
      const [row] = await db.query(
        `INSERT INTO questions (conference_id, segment_id, source, text_original, text_vi, language, status)
         VALUES ($1, $2, 'auto', $3, $4, $5, $6) RETURNING *`,
        [conference.id, segment.id, detection.question || segment.text_original, detection.question_vi || vi, segment.language, overBudget ? 'awaiting_click' : 'detected'],
      );
      const question = toQuestionDto(row);
      this.emit(question);
      if (!overBudget) await this.answer(question.id, conference, detection.keywords);
    } catch (err) {
      this.deps.log.warn({ err, segmentId: segment.id }, 'question detection failed');
    }
  }

  async createManual(conference: ConferenceRow, text: string, segmentId: string | null, textVi: string | null, language: string | null): Promise<QuestionDto> {
    const [row] = await this.deps.db.query(
      `INSERT INTO questions (conference_id, segment_id, source, text_original, text_vi, language, status)
       VALUES ($1, $2, 'manual', $3, $4, $5, 'detected') RETURNING *`,
      [conference.id, segmentId, text, textVi, language],
    );
    const question = toQuestionDto(row);
    this.emit(question);
    return question;
  }

  /**
   * Drafts (or re-drafts) the answer, queued behind any answer already running for this conference.
   * Manual requests may exceed the auto-suggest budget but never the hard cost caps.
   */
  answer(questionId: string, conference: ConferenceRow, extraKeywords: string[] = []): Promise<QuestionDto> {
    const id = conference.id;
    this.queued.set(id, this.queueLength(id) + 1);
    const run = (this.chains.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.answerNow(questionId, conference, extraKeywords))
      .finally(() => {
        this.queued.set(id, Math.max(0, this.queueLength(id) - 1));
        if (this.chains.get(id) === run) this.chains.delete(id);
      });
    this.chains.set(id, run);
    return run;
  }

  private async answerNow(questionId: string, conference: ConferenceRow, extraKeywords: string[]): Promise<QuestionDto> {
    const { db, responder, config } = this.deps;
    const update = async (sql: string, params: unknown[]) => {
      const [row] = await db.query(`UPDATE questions SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`, [questionId, ...params]);
      const q = toQuestionDto(row);
      this.emit(q);
      return q;
    };
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
      const a = config.answers;
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
