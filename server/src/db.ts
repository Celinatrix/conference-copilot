import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  kind: 'pglite' | 'postgres';
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable & { exec(sql: string): Promise<void> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Embedded Postgres (WASM) for local runs and tests. `dir = null` keeps everything in memory. */
export async function openPglite(dir: string | null): Promise<Db> {
  if (dir) await mkdir(dir, { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params) {
      const res = await db.query(sql, params as any[]);
      return res.rows as any[];
    },
    async exec(sql) {
      await db.exec(sql);
    },
    transaction(fn) {
      return db.transaction(async (tx) =>
        fn({
          query: async (sql, params) => (await tx.query(sql, params as any[])).rows as any[],
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      );
    },
    close: () => db.close(),
  };
}

export async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query('SELECT 1');
  return {
    kind: 'postgres',
    async query(sql, params) {
      const res = await pool.query(sql, params as any[]);
      return res.rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          query: async (sql, params) => (await client.query(sql, params as any[])).rows,
          exec: async (sql) => {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function migrate(db: Db, migrationsDir: string): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
