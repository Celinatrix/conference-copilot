-- Core schema: identity, workspaces, conferences, live sessions, transcript, usage, audit.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Session tokens are stored hashed (sha256); the raw token only lives in the httpOnly cookie.
CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE conferences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  starts_at      timestamptz,
  location       text NOT NULL DEFAULT '',
  speakers       text NOT NULL DEFAULT '',
  -- 'multi' = automatic language detection; otherwise a BCP-47 code such as 'en' or 'ja'.
  input_language text NOT NULL DEFAULT 'multi',
  glossary       text NOT NULL DEFAULT '',
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'ended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conferences_workspace_idx ON conferences(workspace_id, created_at DESC);

CREATE TABLE live_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id        uuid NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  started_by           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audio_source         text NOT NULL,
  stt_provider         text NOT NULL,
  consent_confirmed_at timestamptz NOT NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  end_reason           text
);
CREATE INDEX live_sessions_conference_idx ON live_sessions(conference_id);

CREATE TABLE segments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id      uuid NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  session_id         uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  seq                integer NOT NULL,
  start_ms           integer NOT NULL,
  end_ms             integer NOT NULL,
  speaker            text,
  language           text,
  confidence         double precision,
  text_original      text NOT NULL,
  text_vi            text,
  translation_status text NOT NULL DEFAULT 'pending' CHECK (translation_status IN ('pending', 'done', 'error', 'skipped')),
  translation_error  text,
  is_important       boolean NOT NULL DEFAULT false,
  edited             boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conference_id, seq)
);

CREATE TABLE usage_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conference_id uuid REFERENCES conferences(id) ON DELETE SET NULL,
  provider      text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('stt', 'translation', 'llm', 'storage')),
  units         double precision NOT NULL,
  unit          text NOT NULL,
  cost_usd      double precision NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_conference_idx ON usage_events(conference_id);

CREATE TABLE audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,
  user_id      uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_workspace_idx ON audit_logs(workspace_id, created_at DESC);
