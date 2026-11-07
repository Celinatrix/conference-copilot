import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireUser } from '../auth.js';
import { audit, getConferenceAccess, primaryWorkspace, type ConferenceRow } from '../access.js';
import { formatTranscript } from '../export.js';
import { toSegmentDto } from '../live/room.js';
import { conferenceUsage } from '../usage.js';

const LANGUAGE = z.string().regex(/^(multi|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/, 'Mã ngôn ngữ không hợp lệ');

const ConferenceInput = z.object({
  name: z.string().trim().min(1, 'Cần nhập tên hội nghị').max(200),
  starts_at: z.string().datetime({ offset: true }).nullable().optional(),
  location: z.string().trim().max(200).default(''),
  speakers: z.string().trim().max(2000).default(''),
  input_language: LANGUAGE.default('multi'),
  glossary: z.string().max(5000).default(''),
  visibility: z.enum(['private', 'workspace']).default('private'),
});
const ConferencePatch = ConferenceInput.partial();

const SegmentPatch = z
  .object({
    text_original: z.string().trim().min(1).max(5000).optional(),
    text_vi: z.string().trim().max(5000).optional(),
    is_important: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Không có thay đổi');

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'Không tìm thấy hội nghị.' });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden', message: 'Bạn không có quyền thực hiện thao tác này.' });

/** Columns visible to API clients. */
function publicConference(c: ConferenceRow, access?: { canManage: boolean; canDelete: boolean }) {
  return { ...c, permissions: access ? { canManage: access.canManage, canDelete: access.canDelete } : undefined };
}

export function conferenceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', requireUser);

  app.get('/api/dashboard', async (req) => {
    const userId = req.user!.id;
    const visible = `c.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
                     AND (c.created_by = $1 OR c.visibility = 'workspace')`;
    const recent = await db.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM segments s WHERE s.conference_id = c.id) AS segment_count
       FROM conferences c WHERE ${visible} ORDER BY c.updated_at DESC LIMIT 6`,
      [userId],
    );
    const active = await db.query(`SELECT c.* FROM conferences c WHERE ${visible} AND c.status IN ('live', 'paused') ORDER BY c.updated_at DESC`, [userId]);
    const [stats] = await db.query<{ conferences: number; segments: number; minutes: number; cost: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM conferences c WHERE ${visible}) AS conferences,
         (SELECT COUNT(*)::int FROM segments s JOIN conferences c ON c.id = s.conference_id WHERE ${visible}) AS segments,
         (SELECT COALESCE(SUM(u.units), 0)::double precision FROM usage_events u JOIN conferences c ON c.id = u.conference_id WHERE ${visible} AND u.kind = 'stt') AS minutes,
         (SELECT COALESCE(SUM(u.cost_usd), 0)::double precision FROM usage_events u JOIN conferences c ON c.id = u.conference_id WHERE ${visible}) AS cost`,
      [userId],
    );
    return { recent, active, stats };
  });

  app.get('/api/conferences', async (req) => {
    const q = z.object({ q: z.string().max(200).optional() }).parse(req.query);
    const rows = await db.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM segments s WHERE s.conference_id = c.id) AS segment_count
       FROM conferences c
       WHERE c.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
         AND (c.created_by = $1 OR c.visibility = 'workspace')
         AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.location ILIKE '%' || $2 || '%')
       ORDER BY COALESCE(c.starts_at, c.created_at) DESC`,
      [req.user!.id, q.q?.trim() || null],
    );
    return { conferences: rows };
  });

  app.post('/api/conferences', async (req, reply) => {
    const body = ConferenceInput.parse(req.body);
    const ws = await primaryWorkspace(db, req.user!.id);
    if (!ws) return reply.code(400).send({ error: 'no_workspace', message: 'Tài khoản chưa thuộc workspace nào.' });
    const [row] = await db.query<ConferenceRow>(
      `INSERT INTO conferences (workspace_id, created_by, name, starts_at, location, speakers, input_language, glossary, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [ws.workspace_id, req.user!.id, body.name, body.starts_at ?? null, body.location, body.speakers, body.input_language, body.glossary, body.visibility],
    );
    await audit(db, { workspaceId: ws.workspace_id, userId: req.user!.id, action: 'conference.create', targetType: 'conference', targetId: row.id });
    return reply.code(201).send({ conference: publicConference(row, { canManage: true, canDelete: true }) });
  });

  app.get('/api/conferences/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    const sessions = await db.query(
      'SELECT id, started_at, ended_at, end_reason, audio_source FROM live_sessions WHERE conference_id = $1 ORDER BY started_at',
      [id],
    );
    return { conference: publicConference(access.conference, access), sessions };
  });

  app.patch('/api/conferences/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    if (!access.canManage) return forbidden(reply);
    const patch = ConferencePatch.parse(req.body);
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!fields.length) return { conference: publicConference(access.conference, access) };
    const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const [row] = await db.query<ConferenceRow>(
      `UPDATE conferences SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...fields.map(([, v]) => v)],
    );
    await audit(db, { workspaceId: row.workspace_id, userId: req.user!.id, action: 'conference.update', targetType: 'conference', targetId: id, meta: { fields: fields.map(([k]) => k) } });
    return { conference: publicConference(row, access) };
  });

  app.delete('/api/conferences/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    if (!access.canDelete) return forbidden(reply);
    if (access.conference.status === 'live' || access.conference.status === 'paused') {
      return reply.code(409).send({ error: 'live', message: 'Hãy dừng phiên đang chạy trước khi xóa.' });
    }
    await db.query('DELETE FROM conferences WHERE id = $1', [id]);
    await audit(db, { workspaceId: access.conference.workspace_id, userId: req.user!.id, action: 'conference.delete', targetType: 'conference', targetId: id, meta: { name: access.conference.name } });
    return { ok: true };
  });

  app.get('/api/conferences/:id/segments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z
      .object({
        q: z.string().max(200).optional(),
        important: z.enum(['1', '0']).optional(),
        // Incremental sync: only segments created or changed after this server timestamp.
        since: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.query);
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    // Cursor for the next `since` call, 5 s behind so a row committed during this request is not skipped;
    // the overlap only re-sends rows the client merges by id.
    const [{ now }] = await db.query<{ now: Date | string }>(`SELECT now() - interval '5 seconds' AS now`);
    const rows = await db.query(
      `SELECT * FROM segments WHERE conference_id = $1
         AND ($2::text IS NULL OR text_original ILIKE '%' || $2 || '%' OR text_vi ILIKE '%' || $2 || '%')
         AND ($3::boolean IS NULL OR is_important = $3)
         AND ($4::timestamptz IS NULL OR updated_at > $4)
       ORDER BY seq`,
      [id, q.q?.trim() || null, q.important === '1' ? true : null, q.since ?? null],
    );
    return { segments: rows.map(toSegmentDto), serverTime: now instanceof Date ? now.toISOString() : String(now) };
  });

  app.patch('/api/segments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound(reply);
    const patch = SegmentPatch.parse(req.body);
    const [seg] = await db.query<{ conference_id: string }>('SELECT conference_id FROM segments WHERE id = $1', [id]);
    if (!seg) return notFound(reply);
    const access = await getConferenceAccess(db, seg.conference_id, req.user!.id);
    if (!access) return notFound(reply);
    if (!access.canManage) return forbidden(reply);
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
    const segment = toSegmentDto(row);
    ctx.live.broadcast(seg.conference_id, { type: 'segment.updated', segment });
    if (textEdited) {
      await audit(db, { workspaceId: access.conference.workspace_id, userId: req.user!.id, action: 'segment.edit', targetType: 'segment', targetId: id });
    }
    return { segment };
  });

  app.post('/api/segments/:id/retranslate', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound(reply);
    const [row] = await db.query('SELECT * FROM segments WHERE id = $1', [id]);
    if (!row) return notFound(reply);
    const access = await getConferenceAccess(db, row.conference_id, req.user!.id);
    if (!access) return notFound(reply);
    if (!access.canManage) return forbidden(reply);
    const context = await db.query<{ text_original: string; text_vi: string | null }>(
      'SELECT text_original, text_vi FROM segments WHERE conference_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 3',
      [row.conference_id, row.seq],
    );
    await db.query(`UPDATE segments SET translation_status = 'pending', translation_error = NULL WHERE id = $1`, [id]);
    const vi = await ctx.live.translateSegment(
      toSegmentDto(row),
      access.conference,
      context.reverse().map((c) => ({ original: c.text_original, vi: c.text_vi })),
      null,
    );
    const [updated] = await db.query('SELECT * FROM segments WHERE id = $1', [id]);
    if (vi === null) return reply.code(502).send({ error: 'translation_failed', message: updated.translation_error, segment: toSegmentDto(updated) });
    return { segment: toSegmentDto(updated) };
  });

  app.get('/api/conferences/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ format: z.enum(['md', 'txt']).default('md'), view: z.enum(['both', 'original', 'vi']).default('both') }).parse(req.query);
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    const rows = await db.query('SELECT * FROM segments WHERE conference_id = $1 ORDER BY seq', [id]);
    const body = formatTranscript(access.conference, rows.map(toSegmentDto), q.format, q.view);
    const safeName = access.conference.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80) || 'transcript';
    await audit(db, { workspaceId: access.conference.workspace_id, userId: req.user!.id, action: 'transcript.export', targetType: 'conference', targetId: id, meta: q });
    return reply
      .header('Content-Type', q.format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}.${q.format}`)}`)
      .send(body);
  });

  app.get('/api/conferences/:id/usage', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    return conferenceUsage(db, id);
  });

  app.post('/api/conferences/:id/ws-ticket', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    return { ticket: ctx.tickets.issue(req.user!, id) };
  });
}
