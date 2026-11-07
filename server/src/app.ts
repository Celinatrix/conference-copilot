import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { SESSION_COOKIE, WsTicketStore, userFromToken } from './auth.js';
import { getConferenceAccess } from './access.js';
import { authRoutes } from './routes/auth.js';
import { conferenceRoutes } from './routes/conferences.js';
import { LiveManager, type LiveClient } from './live/room.js';
import { ClientMessage, type ServerEvent } from './live/protocol.js';
import { DeepgramProvider } from './live/deepgram.js';
import { Translator } from './live/translator.js';
import type { SttProvider } from './live/stt.js';

export interface AppContext {
  db: Db;
  config: AppConfig;
  live: LiveManager;
  tickets: WsTicketStore;
  stt: SttProvider;
  translator: Translator;
}

const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

export async function buildApp(
  db: Db,
  config: AppConfig,
  opts: { logger?: boolean; stt?: SttProvider; translator?: Translator } = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 256 * 1024,
    trustProxy: config.trustProxy,
  });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: MAX_AUDIO_FRAME_BYTES } });

  const stt = opts.stt ?? new DeepgramProvider(config.deepgram.apiKey, config.deepgram.model);
  const translator = opts.translator ?? new Translator(config.anthropic.apiKey, config.anthropic.translationModel);
  const live = new LiveManager({ db, config, stt, translator, log: app.log });
  const ctx: AppContext = { db, config, live, tickets: new WsTicketStore(), stt, translator };

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    // CSRF guard: state-changing requests must come from an allowed browser origin (or a non-browser client without Origin).
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin && !config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: 'bad_origin', message: 'Origin không được phép.' });
    }
    req.user = await userFromToken(db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation', message: err.issues.map((i) => i.message).join('; '), issues: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: 'server_error', message: status >= 500 ? 'Lỗi máy chủ.' : (err as Error).message });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/system/status', async () => ({
    database: db.kind,
    stt: { provider: stt.name, configured: stt.configured, model: config.deepgram.model },
    translation: { provider: 'anthropic', configured: translator.configured, model: translator.model },
  }));

  await app.register(async (scope) => authRoutes(scope, ctx));
  await app.register(async (scope) => conferenceRoutes(scope, ctx));

  app.get('/ws', { websocket: true }, async (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      socket.close(4403, 'bad origin');
      return;
    }
    const redeemed = ctx.tickets.redeem((req.query as { ticket?: string }).ticket);
    if (!redeemed) {
      socket.close(4401, 'invalid ticket');
      return;
    }
    const access = await getConferenceAccess(db, redeemed.conferenceId, redeemed.user.id);
    if (!access) {
      socket.close(4403, 'forbidden');
      return;
    }

    const client: LiveClient = {
      id: randomUUID(),
      user: redeemed.user,
      canManage: access.canManage,
      send: (event: ServerEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      },
      bufferedAmount: () => socket.bufferedAmount,
    };
    const room = live.room(redeemed.conferenceId);
    room.attach(client);

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        room.handleAudio(client, buf);
        return;
      }
      let parsed: ClientMessage;
      try {
        parsed = ClientMessage.parse(JSON.parse(data.toString()));
      } catch {
        client.send({ type: 'error', code: 'bad_message', message: 'Thông điệp không hợp lệ.' });
        return;
      }
      void room.handleControl(client, parsed).catch((err) => req.log.error({ err }, 'control failed'));
    });
    socket.on('close', () => room.detach(client));
  });

  return { app, ctx };
}
