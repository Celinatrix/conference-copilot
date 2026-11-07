import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import {
  AttemptLimiter,
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashPassword,
  requireUser,
  verifyPassword,
} from '../auth.js';
import { audit, primaryWorkspace } from '../access.js';

const Register = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(10, 'Mật khẩu cần ít nhất 10 ký tự').max(200),
});
const Login = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) });

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const perClient = new AttemptLimiter(10);
  // Caps guessing on one account even when the attacker rotates IP addresses.
  const perAccount = new AttemptLimiter(20);
  const cookieOpts = (expires: Date) => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.config.cookieSecure,
    expires,
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = Register.parse(req.body);
    const existing = await ctx.db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (existing.length) return reply.code(409).send({ error: 'email_taken', message: 'Email này đã được đăng ký.' });
    const passwordHash = await hashPassword(body.password);
    const user = await ctx.db.transaction(async (tx) => {
      const [u] = await tx.query<{ id: string; email: string; name: string }>(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
        [body.email, body.name, passwordHash],
      );
      const [w] = await tx.query<{ id: string }>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [`Workspace của ${body.name}`]);
      await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w.id, u.id]);
      await audit(tx, { workspaceId: w.id, userId: u.id, action: 'user.register' });
      return u;
    });
    const session = await createSession(ctx.db, user.id);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts(session.expiresAt));
    return { user };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = Login.parse(req.body);
    const clientOk = perClient.allow(`${req.ip}:${body.email}`);
    const accountOk = perAccount.allow(body.email);
    if (!clientOk || !accountOk) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Quá nhiều lần thử. Vui lòng đợi 15 phút.' });
    }
    const [row] = await ctx.db.query<{ id: string; email: string; name: string; password_hash: string }>(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [body.email],
    );
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Email hoặc mật khẩu không đúng.' });
    }
    const session = await createSession(ctx.db, row.id);
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts(session.expiresAt));
    await audit(ctx.db, { userId: row.id, action: 'user.login' });
    return { user: { id: row.id, email: row.email, name: row.name } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(ctx.db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => {
    const workspace = await primaryWorkspace(ctx.db, req.user!.id);
    return { user: req.user, workspace };
  });
}
