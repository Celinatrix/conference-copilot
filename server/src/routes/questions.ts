import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { AttemptLimiter, requireUser } from '../auth.js';
import { getConferenceAccess } from '../access.js';
import { MAX_QUEUED_ANSWERS, toQuestionDto } from '../ai/service.js';

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'Không tìm thấy.' });

const NewQuestion = z
  .object({
    segmentId: z.string().uuid().optional(),
    text: z.string().trim().min(3).max(2000).optional(),
  })
  .refine((v) => v.segmentId || v.text, 'Cần segmentId hoặc text');

export function questionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, questions } = ctx;
  const perUser = new AttemptLimiter(ctx.config.aiRateLimits.questionsPerMinute, 60_000);
  app.addHook('preHandler', requireUser);

  /** Shared gate for every request that would start a paid answer. Returns true when the reply was sent. */
  const refuse = async (reply: FastifyReply, userId: string, workspaceId: string, conferenceId: string): Promise<boolean> => {
    if (!questions.configured) {
      await reply.code(503).send({ error: 'not_configured', message: 'Chưa cấu hình ANTHROPIC_API_KEY.' });
      return true;
    }
    if (!perUser.allow(userId)) {
      await reply.code(429).send({ error: 'rate_limited', message: 'Bạn yêu cầu gợi ý quá nhanh. Thử lại sau một phút.' });
      return true;
    }
    if (questions.queueLength(conferenceId) >= MAX_QUEUED_ANSWERS) {
      await reply.code(429).send({ error: 'queue_full', message: 'Đang có nhiều câu hỏi chờ soạn trả lời. Thử lại sau ít phút.' });
      return true;
    }
    const verdict = await questions.guard.check(workspaceId, conferenceId);
    if (!verdict.ok) {
      await reply.code(429).send({ error: verdict.code, message: verdict.message });
      return true;
    }
    return false;
  };

  app.get('/api/conferences/:id/questions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    const rows = await db.query(`SELECT * FROM questions WHERE conference_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]);
    const spent = await questions.spentOnAnswers(id);
    return { questions: rows.map(toQuestionDto), spentUsd: spent, autoBudgetUsd: ctx.config.answers.autoBudgetUsd };
  });

  // Any viewer may ask for a suggestion: it is shared with everyone following the conference.
  app.post('/api/conferences/:id/questions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = NewQuestion.parse(req.body);
    const access = await getConferenceAccess(db, id, req.user!.id);
    if (!access) return notFound(reply);
    if (await refuse(reply, req.user!.id, access.conference.workspace_id, id)) return reply;
    let text = body.text ?? '';
    let textVi: string | null = null;
    let language: string | null = null;
    if (body.segmentId) {
      const [seg] = await db.query<{ text_original: string; text_vi: string | null; language: string | null }>(
        'SELECT text_original, text_vi, language FROM segments WHERE id = $1 AND conference_id = $2',
        [body.segmentId, id],
      );
      if (!seg) return notFound(reply);
      text = seg.text_original;
      textVi = seg.text_vi;
      language = seg.language;
    }
    const question = await questions.createManual(access.conference, text, body.segmentId ?? null, textVi, language);
    // The answer streams to every viewer over the live WebSocket; the request returns at once.
    void questions.answer(question.id, access.conference);
    return reply.code(202).send({ question });
  });

  app.post('/api/questions/:id/answer', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound(reply);
    const [q] = await db.query<{ conference_id: string; status: string }>('SELECT conference_id, status FROM questions WHERE id = $1', [id]);
    if (!q) return notFound(reply);
    const access = await getConferenceAccess(db, q.conference_id, req.user!.id);
    if (!access) return notFound(reply);
    if (q.status === 'answering') return reply.code(409).send({ error: 'busy', message: 'Đang soạn câu trả lời.' });
    if (await refuse(reply, req.user!.id, access.conference.workspace_id, q.conference_id)) return reply;
    void questions.answer(id, access.conference);
    return reply.code(202).send({ ok: true });
  });
}
