import type { Queryable } from './db.js';

export interface UsageEntry {
  workspaceId: string;
  conferenceId: string | null;
  provider: string;
  kind: 'stt' | 'translation' | 'llm' | 'storage';
  units: number;
  unit: string;
  costUsd: number;
}

export async function recordUsage(db: Queryable, e: UsageEntry) {
  if (e.units <= 0) return;
  await db.query(
    `INSERT INTO usage_events (workspace_id, conference_id, provider, kind, units, unit, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.workspaceId, e.conferenceId, e.provider, e.kind, e.units, e.unit, e.costUsd],
  );
}

export const tokenCost = (inputTokens: number, outputTokens: number, inPerM: number, outPerM: number) =>
  (inputTokens * inPerM + outputTokens * outPerM) / 1_000_000;

export async function conferenceUsage(db: Queryable, conferenceId: string) {
  const rows = await db.query<{ kind: string; provider: string; unit: string; units: number; cost_usd: number }>(
    `SELECT kind, provider, unit, SUM(units)::double precision AS units, SUM(cost_usd)::double precision AS cost_usd
     FROM usage_events WHERE conference_id = $1 GROUP BY kind, provider, unit ORDER BY kind`,
    [conferenceId],
  );
  const total = rows.reduce((s, r) => s + Number(r.cost_usd), 0);
  return { items: rows.map((r) => ({ ...r, units: Number(r.units), cost_usd: Number(r.cost_usd) })), totalUsd: total };
}
