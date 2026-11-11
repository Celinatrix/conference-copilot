import type { AppContext } from '../app.js';
import { audit, type ConferenceRow } from '../access.js';
import { computeFlags } from '../ai/trust.js';
import { toSegmentDto } from '../live/room.js';
import type { SegmentDto } from '../live/protocol.js';
import { segmentsRepo } from '../repos/segments.js';

/** Business rules for changing a transcript after it was recorded. Callers have already checked canManage. */

export type SegmentEdit = { text_original?: string; text_vi?: string; is_important?: boolean };

export async function editSegment(ctx: AppContext, conference: ConferenceRow, segmentId: string, userId: string, patch: SegmentEdit): Promise<SegmentDto> {
  const { db } = ctx;
  const textEdited = patch.text_original !== undefined || patch.text_vi !== undefined;
  let segment = toSegmentDto(await segmentsRepo.applyEdit(db, segmentId, patch));
  if (textEdited) {
    // A human correction replaces the machine's doubt: drop low-confidence, re-check numbers and terms.
    const flags = computeFlags({
      original: segment.text_original,
      vi: segment.translation_status === 'skipped' ? null : segment.text_vi,
      confidence: null,
      glossary: conference.glossary,
      lowConfidenceThreshold: ctx.config.lowConfidenceThreshold,
    });
    segment = toSegmentDto(await segmentsRepo.setFlags(db, segmentId, flags));
  }
  ctx.live.broadcast(conference.id, { type: 'segment.updated', segment });
  if (textEdited) {
    await audit(db, { workspaceId: conference.workspace_id, userId, action: 'segment.edit', targetType: 'segment', targetId: segmentId });
  }
  return segment;
}

export type RetranslateResult = { ok: true; segment: SegmentDto } | { ok: false; segment: SegmentDto; message: string };

/** Translates one segment again with the three segments before it as context. Budget checks are the caller's. */
export async function retranslateSegment(ctx: AppContext, conference: ConferenceRow, row: Record<string, unknown>): Promise<RetranslateResult> {
  const { db } = ctx;
  const segment = toSegmentDto(row);
  const context = await segmentsRepo.contextBefore(db, conference.id, segment.seq, 3);
  await segmentsRepo.markPending(db, segment.id);
  const vi = await ctx.live.translateSegment(
    segment,
    conference,
    context.map((c) => ({ original: c.text_original, vi: c.text_vi })),
    null,
  );
  const updated = toSegmentDto(await segmentsRepo.get(db, segment.id));
  return vi === null ? { ok: false, segment: updated, message: updated.translation_error ?? 'Dịch lại thất bại.' } : { ok: true, segment: updated };
}
