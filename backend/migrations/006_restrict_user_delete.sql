-- Deleting a user must never silently delete shared work. With ON DELETE CASCADE, removing one member wiped
-- every conference they created (shared ones included), every document they uploaded, and every live session
-- they started together with its transcript (segments cascade from live_sessions).
-- RESTRICT makes such a delete fail instead; a future "delete account" feature has to hand ownership over
-- (or delete the person's private conferences) explicitly first.
-- No data changes; only the delete rule of three foreign keys.

ALTER TABLE conferences DROP CONSTRAINT conferences_created_by_fkey;
ALTER TABLE conferences ADD CONSTRAINT conferences_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE documents DROP CONSTRAINT documents_uploaded_by_fkey;
ALTER TABLE documents ADD CONSTRAINT documents_uploaded_by_fkey
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE live_sessions DROP CONSTRAINT live_sessions_started_by_fkey;
ALTER TABLE live_sessions ADD CONSTRAINT live_sessions_started_by_fkey
  FOREIGN KEY (started_by) REFERENCES users(id) ON DELETE RESTRICT;
