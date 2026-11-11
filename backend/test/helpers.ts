import type { FastifyInstance } from 'fastify';

/**
 * Browsers always send Origin on POST/PATCH/DELETE, and the API now requires it for cookie-authenticated writes.
 * Tests that act as the web app get the allowed origin by default; a test can still pass its own Origin header.
 */
export function actAsBrowser(app: FastifyInstance, origin: string) {
  const inject = app.inject.bind(app) as (opts: any) => any;
  (app as any).inject = (opts: any) =>
    inject(typeof opts === 'string' ? { url: opts, headers: { origin } } : { ...opts, headers: { origin, ...(opts.headers ?? {}) } });
}
