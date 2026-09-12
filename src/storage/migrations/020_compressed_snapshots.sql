-- Raw payloads are the deepest evidence layer and the whole of the database's growth: 778 MB of
-- 1.17 GB after four days, and 190 MB more every day. They are text, and text compresses about
-- five times, so the bytes are kept exactly — gzipped instead of plain.
--
-- The hash is what makes an unchanged poll cheap to recognise. Until now an unchanged payload was
-- detected by comparing the whole previous document, which meant reading 21 MB back out of the
-- database on every poll of a large page.
--
-- `expired_at` marks a payload whose body has been released after its retention window. The row
-- stays: source, time, hash and original size are a receipt that the evidence existed and what it
-- weighed, and the event's own before and after state is untouched either way.
ALTER TABLE snapshots ADD COLUMN body BLOB;
ALTER TABLE snapshots ADD COLUMN hash TEXT NOT NULL DEFAULT '';
ALTER TABLE snapshots ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE snapshots ADD COLUMN expired_at TEXT;

CREATE INDEX snapshots_source_hash ON snapshots(source, hash);
CREATE INDEX snapshots_collected ON snapshots(collected_at);
