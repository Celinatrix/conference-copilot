/**
 * The contract between backend and frontend. Both sides import these types, so a change here that one side
 * does not follow fails `npm run typecheck`. Types only: import with `import type`, nothing here runs.
 */

// ---------- Transcript ----------

export interface SegmentDto {
  id: string;
  conference_id: string;
  session_id: string;
  seq: number;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  language: string | null;
  confidence: number | null;
  text_original: string;
  text_vi: string | null;
  translation_status: 'pending' | 'done' | 'error' | 'skipped';
  translation_error: string | null;
  is_important: boolean;
  edited: boolean;
  /** Trust warnings: 'low_confidence', 'number:<digits>', 'term:<glossary term>'. */
  flags: string[];
  created_at: string;
  updated_at: string;
}

/** GET /api/v1/conferences/:id/segments. Keep passing `afterSeq=nextAfterSeq` until it is null. */
export interface SegmentPage {
  segments: SegmentDto[];
  /** Pass as `since` later to fetch only what changed after this request. */
  serverTime: string;
  nextAfterSeq: number | null;
}

/** GET /api/v1/conferences. Keep passing `offset=nextOffset` until it is null. */
export interface ConferencePage<C> {
  conferences: C[];
  nextOffset: number | null;
}

// ---------- Knowledge base ----------

export interface DocumentDto {
  id: string;
  conference_id: string;
  uploaded_by: string;
  filename: string;
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv';
  size_bytes: number;
  status: 'processing' | 'ready' | 'error';
  error: string | null;
  /** Pages, slides or sheets. */
  unit_count: number;
  char_count: number;
  warning: string | null;
  created_at: string;
}

// ---------- Suggested answers ----------

export type ResponseMode = 'professional' | 'concise' | 'strategic' | 'academic' | 'technical';

export interface AnswerCitation {
  chunk_id: string;
  document_id: string;
  filename: string;
  locator: string;
  quote: string;
}

export interface AnswerOption {
  mode: ResponseMode;
  vi: string;
  en: string;
  citations: AnswerCitation[];
}

export interface StructuredAnswer {
  analysis_vi: string;
  options: AnswerOption[];
  missing: string;
  follow_ups: string[];
  /** 'none' = no documents at all; 'no_match' = documents exist but nothing relevant was found. */
  context: 'all' | 'ranked' | 'none' | 'no_match';
}

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

// ---------- Live WebSocket protocol ----------

/** Control messages from browser to server. Audio travels as binary frames (16 kHz PCM16 mono). */
export type ClientMessage =
  | { type: 'start'; audioSource: string; consent: true }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'reclaim' }
  | { type: 'ping'; t: number };

export type RoomStatus = 'idle' | 'live' | 'paused' | 'ending';

export interface RoomState {
  type: 'state';
  status: RoomStatus;
  sessionId: string | null;
  startedAt: string | null;
  hostConnected: boolean;
  hostUserId: string | null;
  youAreHost: boolean;
  sttStatus: string;
  sttDetail: string | null;
  viewers: number;
}

/** Events from server to every viewer of a conference. */
export type ServerEvent =
  | RoomState
  | { type: 'partial'; text: string; language: string | null; speaker: string | null }
  | { type: 'partial.clear' }
  | { type: 'segment'; segment: SegmentDto }
  | { type: 'segment.updated'; segment: SegmentDto }
  | { type: 'translation.delta'; segmentId: string; delta: string }
  | { type: 'translation.done'; segmentId: string; text_vi: string; latencyMs: number | null; flags: string[] }
  | { type: 'translation.error'; segmentId: string; message: string }
  | { type: 'question'; question: QuestionDto }
  | { type: 'answer.delta'; questionId: string; delta: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number };
