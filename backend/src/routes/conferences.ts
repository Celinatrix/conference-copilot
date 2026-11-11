import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { AttemptLimiter, requireUser } from '../auth.js';
import { audit, getConferenceAccess, primaryWorkspace, type ConferenceRow } from '../access.js';
import { formatTranscript } from '../export.js';
import { toSegmentDto } from '../live/room.js';
import { conferenceUsage } from '../usage.js';
import { RESPONSE_MODE_KEYS, type ResponseMode } from '../ai/responder.js';
import { forbidden, isUuid, notFound as notFoundReply } from '../http.js';
import { conferencesRepo } from '../repos/conferences.js';
import { segmentsRepo } from '../repos/segments.js';
import { editSegment, retranslateSegment } from '../services/transcript.js';

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
const ConferencePatch = ConferenceInput.partial().extend({
  response_modes: z
    .array(z.enum(RESPONSE_MODE_KEYS as [ResponseMode, ...ResponseMode[]]))
    .min(1, 'Chọn ít nhất 1 kiểu trả lời')
    .max(3, 'Tối đa 3 kiểu trả lời')
    .optional(),
});

const SegmentPatch = z
  .object({
    text_original: z.string().trim().min(1).max(5000).optional(),
    text_vi: z.string().trim().max(5000).optional(),
    is_important: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Không có thay đổi');

/** Paging limits: a page of the conference list, and of a transcript (an 8-hour talk is a few thousand segments). */
const CONFERENCE_PAGE = { default: 100, max: 200 };
const SEGMENT_PAGE = { default: 1000, max: 2000 };
const pageSize = (page: { default: number; max: number }) => z.coerce.number().int().min(1).max(page.max).default(page.default);

const notFound = (reply: FastifyReply) => notFoundReply(reply, 'Không tìm thấy hội nghị.');

/** Columns visible to API clients. */
function publicConference(c: ConferenceRow, access?: { canManage: boolean; canDelete: boolean }) {
  return { ...c, permissions: access ? { canManage: access.canManage, canDelete: access.canDelete } : undefined };
}

export function conferenceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const retranslateLimiter = new AttemptLimiter(ctx.config.aiRateLimits.retranslatePerMinute, 60_000);
  app.addHook('preHandler', requireUser);

  app.get('/api/dashboard', async (req) => conferencesRepo.dashboard(db, req.user!.id));

  app.get('/api/conferences', async (req) => {
    const q = z
      .object({ q: z.string().max(200).optional(), limit: pageSize(CONFERENCE_PAGE), offset: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);
    const page = await conferencesRepo.listVisible(db, req.user!.id, { q: q.q?.trim() || null, limit: q.limit, offset: q.offset });
    return { conferences: page.rows, nextOffset: page.hasMore ? q.offset + q.limit : null };
  });

  app.post('/api/conferences', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = ConferenceInput.parse(req.body);
    const ws = await primaryWorkspace(db, req.user!.id);
    if (!ws) return reply.code(400).send({ error: 'no_workspace', message: 'Tài khoản chưa thuộc workspace nào.' });
    const row = await conferencesRepo.insert(db, {
      workspaceId: ws.workspace_id,
      createdBy: req.user!.id,
      name: body.name,
      startsAt: body.starts_at ?? null,
      location: body.location,
      speakers: body.speakers,
      inputLanguage: body.input_language,
      glossary: body.glossary,
      visibility: body.visibility,
    });
    await audit(db, { workspaceId: ws.workspace_id, userId: req.user!.id, action: 'conference.create', targetType: 'conference', targetId: row.id });
    return reply.code(201).send({ conference: publicConference(row, { canManage: true, canDelete: true }) });
  });

  app.get('/api/conferences/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    return { conference: publicConference(access.conference, access), sessions: await conferencesRepo.sessions(db, id) };
  });

  app.patch('/api/conferences/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    if (!access.canManage) return forbidden(reply);
    const patch = ConferencePatch.parse(req.body);
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!fields.length) return { conference: publicConference(access.conference, access) };
    const row = await conferencesRepo.update(db, id, fields);
    await audit(db, {
      workspaceId: row.workspace_id,
      userId: req.user!.id,
      action: 'conference.update',
      targetType: 'conference',
      targetId: id,
      meta: { fields: fields.map(([k]) => k) },
    });
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
    await conferencesRepo.remove(db, id);
    await audit(db, {
      workspaceId: access.conference.workspace_id,
      userId: req.user!.id,
      action: 'conference.delete',
      targetType: 'conference',
      targetId: id,
      meta: { name: access.conference.name },
    });
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
        // Keyset paging: pass the previous response's nextAfterSeq until it comes back null.
        afterSeq: z.coerce.number().int().min(0).default(0),
        limit: pageSize(SEGMENT_PAGE),
      })
      .parse(req.query);
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    const serverTime = await segmentsRepo.syncCursor(db);
    const page = await segmentsRepo.list(db, id, {
      q: q.q?.trim() || null,
      importantOnly: q.important === '1',
      since: q.since ?? null,
      afterSeq: q.afterSeq,
      limit: q.limit,
    });
    const segments = page.rows.map(toSegmentDto);
    return { segments, serverTime, nextAfterSeq: page.hasMore ? (segments.at(-1)?.seq ?? null) : null };
  });

  /** Loads a segment and checks the caller may manage its conference. Sends the 404/403 itself and returns null then. */
  const segmentForManager = async (id: string, userId: string, reply: FastifyReply) => {
    const row = isUuid(id) ? await segmentsRepo.get(db, id) : null;
    const access = row ? await getConferenceAccess(db, row.conference_id, userId) : null;
    if (!row || !access) {
      await notFound(reply);
      return null;
    }
    if (!access.canManage) {
      await forbidden(reply);
      return null;
    }
    return { row, conference: access.conference };
  };

  app.patch('/api/segments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = SegmentPatch.parse(req.body);
    const found = await segmentForManager(id, req.user!.id, reply);
    if (!found) return reply;
    return { segment: await editSegment(ctx, found.conference, id, req.user!.id, patch) };
  });

  app.post('/api/segments/:id/retranslate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = await segmentForManager(id, req.user!.id, reply);
    if (!found) return reply;
    if (!retranslateLimiter.allow(req.user!.id)) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Bạn dịch lại quá nhanh. Thử lại sau một phút.' });
    }
    const verdict = await ctx.questions.guard.check(found.conference.workspace_id, found.conference.id);
    if (!verdict.ok) return reply.code(429).send({ error: verdict.code, message: verdict.message });
    const result = await retranslateSegment(ctx, found.conference, found.row);
    if (!result.ok) return reply.code(502).send({ error: 'translation_failed', message: result.message, segment: result.segment });
    return { segment: result.segment };
  });

  app.get('/api/conferences/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ format: z.enum(['md', 'txt']).default('md'), view: z.enum(['both', 'original', 'vi']).default('both') }).parse(req.query);
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    const rows = await segmentsRepo.all(db, id);
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
