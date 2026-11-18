-- "Câu 1, Câu 2, …": a stable number per conference, in the order questions were asked. Kept when a question is
-- skipped or removed, so numbers never shift. Existing questions are numbered by creation time.
ALTER TABLE questions ADD COLUMN seq integer;
UPDATE questions q
SET seq = r.n
FROM (SELECT id, row_number() OVER (PARTITION BY conference_id ORDER BY created_at, id) AS n FROM questions) r
WHERE q.id = r.id;
