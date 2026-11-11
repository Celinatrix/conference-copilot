-- Supports incremental transcript sync (`GET .../segments?since=`) after a reconnect.
-- Additive only: no existing data or column changes.
CREATE INDEX IF NOT EXISTS segments_conference_updated_idx ON segments (conference_id, updated_at);
