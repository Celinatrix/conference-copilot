-- The cost guard sums a workspace's spend over the last 24 hours before every paid AI call
-- (src/ai/budget.ts). Without this index that query scans the whole usage_events table.
-- Additive only: no existing data or column changes.
CREATE INDEX IF NOT EXISTS usage_events_workspace_created_idx ON usage_events (workspace_id, created_at);
