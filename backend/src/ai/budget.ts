import type { Queryable } from '../db.js';
import type { AppConfig } from '../config.js';

export type BudgetVerdict = { ok: true } | { ok: false; code: 'conference_cap' | 'workspace_cap'; message: string };

/**
 * Hard spending caps, checked before every optional paid AI call and before a live session starts.
 * A session already running keeps translating past the cap (cutting a speaker off mid-talk is worse than a
 * small overrun), but answers, detection and retranslation stop.
 */
export class CostGuard {
  constructor(
    private db: Queryable,
    private config: AppConfig,
  ) {}

  async check(workspaceId: string, conferenceId: string | null): Promise<BudgetVerdict> {
    const { conferenceUsd, workspaceDailyUsd } = this.config.costCaps;
    const [row] = await this.db.query<{ conf: number; day: number }>(
      `SELECT
         COALESCE((SELECT SUM(cost_usd) FROM usage_events WHERE conference_id = $2), 0)::double precision AS conf,
         COALESCE((SELECT SUM(cost_usd) FROM usage_events WHERE workspace_id = $1 AND created_at > now() - interval '24 hours'), 0)::double precision AS day`,
      [workspaceId, conferenceId],
    );
    if (conferenceId && conferenceUsd > 0 && Number(row.conf) >= conferenceUsd) {
      return { ok: false, code: 'conference_cap', message: `Hội nghị này đã dùng hết trần chi phí AI ($${conferenceUsd}). Tăng AI_CONFERENCE_CAP_USD trong backend/.env nếu cần.` };
    }
    if (workspaceDailyUsd > 0 && Number(row.day) >= workspaceDailyUsd) {
      return { ok: false, code: 'workspace_cap', message: `Workspace đã dùng hết trần chi phí AI trong 24 giờ ($${workspaceDailyUsd}). Tăng AI_WORKSPACE_DAILY_CAP_USD nếu cần.` };
    }
    return { ok: true };
  }
}
