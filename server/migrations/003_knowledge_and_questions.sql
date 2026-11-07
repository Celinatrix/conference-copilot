-- Knowledge base per conference, detected questions with suggested answers, and trust flags on segments.
-- Additive only: new tables and new columns with defaults; existing rows keep working unchanged.

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id uuid NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  uploaded_by   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('pdf', 'docx', 'pptx', 'xlsx', 'csv')),
  size_bytes    integer NOT NULL,
  status        text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
  error         text,
  unit_count    integer NOT NULL DEFAULT 0,  -- pages, slides or sheets
  char_count    integer NOT NULL DEFAULT 0,
  warning       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_conference_idx ON documents(conference_id, created_at);

CREATE TABLE document_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  conference_id uuid NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  ordinal       integer NOT NULL,
  locator       text NOT NULL,              -- human-readable source position: "trang 3", "slide 5", "sheet Revenue, dòng 2–41"
  content       text NOT NULL,
  -- 'simple' keeps Vietnamese and English words as-is; good enough for keyword retrieval across both.
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (document_id, ordinal)
);
CREATE INDEX document_chunks_conference_idx ON document_chunks(conference_id);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin(tsv);

CREATE TABLE questions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_id   uuid NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
  segment_id      uuid REFERENCES segments(id) ON DELETE SET NULL,
  source          text NOT NULL CHECK (source IN ('auto', 'manual')),
  text_original   text NOT NULL,
  text_vi         text,
  language        text,
  status          text NOT NULL DEFAULT 'detected'
                  CHECK (status IN ('detected', 'answering', 'answered', 'error', 'awaiting_click')),
  error           text,
  answer          jsonb,                     -- { analysis_vi, options:[{mode, vi, en, citations:[…]}], missing, follow_ups, grounded }
  answer_model    text,
  answer_cost_usd double precision,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_conference_idx ON questions(conference_id, created_at DESC);

ALTER TABLE segments ADD COLUMN flags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE conferences ADD COLUMN response_modes jsonb NOT NULL DEFAULT '["professional","concise","strategic"]'::jsonb;
