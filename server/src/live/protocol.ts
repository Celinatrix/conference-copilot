import { z } from 'zod';

/** Control messages from browser to server. Audio travels as binary frames (16 kHz PCM16 mono). */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), audioSource: z.string().max(120), consent: z.literal(true) }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('reclaim') }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type RoomStatus = 'idle' | 'live' | 'paused' | 'ending';

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

export type ServerEvent =
  | {
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
  | { type: 'partial'; text: string; language: string | null; speaker: string | null }
  | { type: 'partial.clear' }
  | { type: 'segment'; segment: SegmentDto }
  | { type: 'segment.updated'; segment: SegmentDto }
  | { type: 'translation.delta'; segmentId: string; delta: string }
  | { type: 'translation.done'; segmentId: string; text_vi: string; latencyMs: number | null; flags: string[] }
  | { type: 'question'; question: import('../ai/service.js').QuestionDto }
  | { type: 'answer.delta'; questionId: string; delta: string }
  | { type: 'translation.error'; segmentId: string; message: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number };
