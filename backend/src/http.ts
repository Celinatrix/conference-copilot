import type { FastifyReply } from 'fastify';

/** Shape check for a UUID path parameter, so a malformed id never reaches a query (it would raise a 500). */
export const isUuid = (value: string): boolean => /^[0-9a-f-]{36}$/i.test(value);

/** Timestamps from PGlite/pg arrive as Date; API payloads carry ISO strings. */
export const toIso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

/** Same as toIso, but keeps a NULL column as null instead of the string "null". */
export const toIsoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : toIso(value));

export const notFound = (reply: FastifyReply, message = 'Không tìm thấy.') => reply.code(404).send({ error: 'not_found', message });

export const forbidden = (reply: FastifyReply, message = 'Bạn không có quyền thực hiện thao tác này.') =>
  reply.code(403).send({ error: 'forbidden', message });
