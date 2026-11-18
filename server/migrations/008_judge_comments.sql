-- Judges' remarks on the presentation ("Nhận xét") are kept apart from questions put to the team: they are listed
-- with their own numbering, never pop up and are never answered. Additive: existing rows stay questions.
ALTER TABLE questions ADD COLUMN kind text NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'comment'));
ALTER TABLE questions DROP CONSTRAINT questions_status_check;
ALTER TABLE questions ADD CONSTRAINT questions_status_check
  CHECK (status IN ('detected', 'answering', 'answered', 'error', 'awaiting_click', 'awaiting_confirm', 'dismissed', 'noted'));
