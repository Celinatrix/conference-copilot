import type { Queryable } from '../db.js';

/** SQL for transcript segments. Rows come back raw; turn them into API objects with toSegmentDto(). */

export interface SegmentFilter {
  /** Substring in the original or the Vietnamese text. */
  q: string | null;
  importantOnly: boolean;
  /** Only rows created or changed after this server timestamp (incremental sync). */
  since: string | null;
  /** Keyset paging by seq: rows with seq greater than this. */
  afterSeq: number;
  limit: number;
}

export const segmentsRepo = {
  /** One page in seq order, plus one extra row to tell whether another page exists. */
  async list(db: Queryable, conferenceId: string, f: SegmentFilter) {
    const rows = await db.query(
      `SELECT * FROM segments WHERE conference_id = $1
         AND ($2::text IS NULL OR text_original ILIKE '%' || $2 || '%' OR text_vi ILIKE '%' || $2 || '%')
         AND ($3::boolean IS NULL OR is_important = $3)
         AND ($4::timestamptz IS NULL OR updated_at > $4)
         AND seq > $5
       ORDER BY seq
       LIMIT $6`,
      [conferenceId, f.q, f.importantOnly ? true : null, f.since, f.afterSeq, f.limit + 1],
    );
    const hasMore = rows.length > f.limit;
    return { rows: hasMore ? rows.slice(0, f.limit) : rows, hasMore };
  },

  /** Cursor for the next `since` call, 5 s behind so a row committed during the request is not skipped. */
  async syncCursor(db: Queryable): Promise<string> {
    const [{ now }] = await db.query<{ now: Date | string }>(`SELECT now() - interval '5 seconds' AS now`);
    return now instanceof Date ? now.toISOString() : String(now);
  },

  async get(db: Queryable, id: string) {
    const [row] = await db.query('SELECT * FROM segments WHERE id = $1', [id]);
    return row ?? null;
  },

  /** Every segment of a conference in order (export). */
  all(db: Queryable, conferenceId: string) {
    return db.query('SELECT * FROM segments WHERE conference_id = $1 ORDER BY seq', [conferenceId]);
  },

  /** The few segments right before `seq`, oldest first: translation context. */
  async contextBefore(db: Queryable, conferenceId: string, seq: number, count: number) {
    const rows = await db.query<{ text_original: string; text_vi: string | null }>(
      'SELECT text_original, text_vi FROM segments WHERE conference_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3',
      [conferenceId, seq, count],
    );
    return rows.reverse();
  },

  /** Applies a human edit. A new Vietnamese text marks the translation done; any text change sets `edited`. */
  async applyEdit(db: Queryable, id: string, patch: { text_original?: string; text_vi?: string; is_important?: boolean }) {
    const textEdited = patch.text_original !== undefined || patch.text_vi !== undefined;
    const [row] = await db.query(
      `UPDATE segments SET
         text_original = COALESCE($2, text_original),
         text_vi = COALESCE($3, text_vi),
         translation_status = CASE WHEN $3::text IS NOT NULL THEN 'done' ELSE translation_status END,
         is_important = COALESCE($4, is_important),
         edited = edited OR $5,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, patch.text_original ?? null, patch.text_vi ?? null, patch.is_important ?? null, textEdited],
    );
    return row;
  },

  async setFlags(db: Queryable, id: string, flags: string[]) {
    const [row] = await db.query(`UPDATE segments SET flags = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`, [id, JSON.stringify(flags)]);
    return row;
  },

  async markPending(db: Queryable, id: string) {
    await db.query(`UPDATE segments SET translation_status = 'pending', translation_error = NULL, updated_at = now() WHERE id = $1`, [id]);
  },
};
