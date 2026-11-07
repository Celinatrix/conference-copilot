-- Invite-only membership. Additive: a new table; no existing rows change.
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,          -- sha256 of the link token; the raw token is shown once
  role         text NOT NULL CHECK (role IN ('admin', 'member')),
  email        text,                           -- optional: only this address may use the invite
  created_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_workspace_idx ON invitations(workspace_id, created_at DESC);
