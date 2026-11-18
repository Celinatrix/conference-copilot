import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../app.js';
import { requireUser } from '../auth.js';
import { getConferenceAccess } from '../access.js';

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found', message: 'Không tìm thấy.' });

/** Starts the speech worker if needed, waiting a little so the first status check reports the real state. */
async function warmUp(ctx: AppContext) {
  await Promise.race([ctx.audio.tts.start().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
  return ctx.audio.tts.status;
}

export function listenRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireUser);

  app.get('/api/tts/status', async () => ({ status: await warmUp(ctx) }));

  // Live MP3 of the Vietnamese translation, for phones that keep playing media with the screen locked.
  app.get('/api/conferences/:id/listen.mp3', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(ctx.db, id, req.user!.id);
    if (!access) return notFound(reply);
    const status = await warmUp(ctx);
    if (status.state !== 'ready') {
      return reply.code(503).send({ error: 'tts_unavailable', message: 'message' in status ? status.message : 'Bộ đọc giọng nói chưa sẵn sàng.' });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    ctx.audio.listen(id, reply.raw);
  });

  // Lets the listener check the voice and volume before the session starts.
  app.post('/api/conferences/:id/listen/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await getConferenceAccess(ctx.db, id, req.user!.id);
    if (!access) return notFound(reply);
    if (!ctx.audio.listenerCount(id)) return reply.code(409).send({ error: 'not_listening', message: 'Chưa có thiết bị nào đang nghe luồng âm thanh.' });
    void ctx.audio.say(id, 'Đã kết nối. Bản dịch tiếng Việt sẽ được đọc tại đây.');
    return { ok: true };
  });
}
