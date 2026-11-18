-- Questions heard unclearly wait for the listener to confirm (or correct) the text before an answer is drafted,
-- and can be dismissed. Additive: existing rows keep their status; the new column defaults to NULL.
ALTER TABLE questions DROP CONSTRAINT questions_status_check;
ALTER TABLE questions ADD CONSTRAINT questions_status_check
  CHECK (status IN ('detected', 'answering', 'answered', 'error', 'awaiting_click', 'awaiting_confirm', 'dismissed'));
ALTER TABLE questions ADD COLUMN unclear_reason text;
