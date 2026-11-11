import type { Queryable } from '../db.js';
import type { ConferenceRow } from '../access.js';

/** SQL for conferences and their live sessions. No HTTP, no permission rules: callers check access first. */

/** Conferences a user may see: their own, plus every 'workspace' conference in workspaces they belong to. */
const VISIBLE = `c.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
                 AND (c.created_by = $1 OR c.visibility = 'workspace')`;

export type ConferenceListRow = ConferenceRow & { segment_count: number };

export interface ConferenceInsert {
  workspaceId: string;
  createdBy: string;
  name: string;
  startsAt: string | null;
  location: string;
  speakers: string;
  inputLanguage: string;
  glossary: string;
  visibility: 'private' | 'workspace';
}

/** Columns a PATCH may change; JSON columns are cast explicitly. */
const UPDATABLE = new Set(['name', 'starts_at', 'location', 'speakers', 'input_language', 'glossary', 'visibility', 'response_modes']);
const JSON_COLUMNS = new Set(['response_modes']);

export const conferencesRepo = {
  async dashboard(db: Queryable, userId: string) {
    const recent = await db.query<ConferenceListRow>(
      `SELECT c.*, (SELECT COUNT(*)::int FROM segments s WHERE s.conference_id = c.id) AS segment_count
       FROM conferences c WHERE ${VISIBLE} ORDER BY c.updated_at DESC LIMIT 6`,
      [userId],
    );
    const active = await db.query<ConferenceRow>(
      `SELECT c.* FROM conferences c WHERE ${VISIBLE} AND c.status IN ('live', 'paused') ORDER BY c.updated_at DESC`,
      [userId],
    );
    const [stats] = await db.query<{ conferences: number; segments: number; minutes: number; cost: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM conferences c WHERE ${VISIBLE}) AS conferences,
         (SELECT COUNT(*)::int FROM segments s JOIN conferences c ON c.id = s.conference_id WHERE ${VISIBLE}) AS segments,
         (SELECT COALESCE(SUM(u.units), 0)::double precision FROM usage_events u JOIN conferences c ON c.id = u.conference_id WHERE ${VISIBLE} AND u.kind = 'stt') AS minutes,
         (SELECT COALESCE(SUM(u.cost_usd), 0)::double precision FROM usage_events u JOIN conferences c ON c.id = u.conference_id WHERE ${VISIBLE}) AS cost`,
      [userId],
    );
    return { recent, active, stats };
  },

  /**
   * One page of the conferences a user can see, newest first. `offset` paging is fine here: a workspace holds at
   * most a few hundred conferences. Fetches one extra row to tell whether another page exists.
   */
  async listVisible(db: Queryable, userId: string, opts: { q: string | null; limit: number; offset: number }) {
    const rows = await db.query<ConferenceListRow>(
      `SELECT c.*, (SELECT COUNT(*)::int FROM segments s WHERE s.conference_id = c.id) AS segment_count
       FROM conferences c
       WHERE ${VISIBLE}
         AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.location ILIKE '%' || $2 || '%')
       ORDER BY COALESCE(c.starts_at, c.created_at) DESC, c.id
       LIMIT $3 OFFSET $4`,
      [userId, opts.q, opts.limit + 1, opts.offset],
    );
    const hasMore = rows.length > opts.limit;
    return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
  },

  async insert(db: Queryable, c: ConferenceInsert): Promise<ConferenceRow> {
    const [row] = await db.query<ConferenceRow>(
      `INSERT INTO conferences (workspace_id, created_by, name, starts_at, location, speakers, input_language, glossary, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [c.workspaceId, c.createdBy, c.name, c.startsAt, c.location, c.speakers, c.inputLanguage, c.glossary, c.visibility],
    );
    return row;
  },

  /** Updates the given columns (already validated) and returns the new row. */
  async update(db: Queryable, id: string, fields: [string, unknown][]): Promise<ConferenceRow> {
    for (const [k] of fields) if (!UPDATABLE.has(k)) throw new Error(`Column ${k} is not updatable`);
    const sets = fields.map(([k], i) => `${k} = $${i + 2}${JSON_COLUMNS.has(k) ? '::jsonb' : ''}`).join(', ');
    const [row] = await db.query<ConferenceRow>(`UPDATE conferences SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`, [
      id,
      ...fields.map(([k, v]) => (JSON_COLUMNS.has(k) ? JSON.stringify(v) : v)),
    ]);
    return row;
  },

  async remove(db: Queryable, id: string) {
    await db.query('DELETE FROM conferences WHERE id = $1', [id]);
  },

  sessions(db: Queryable, conferenceId: string) {
    return db.query('SELECT id, started_at, ended_at, end_reason, audio_source FROM live_sessions WHERE conference_id = $1 ORDER BY started_at', [
      conferenceId,
    ]);
  },
};
