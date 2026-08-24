-- 0007: reply indexing for `post` records (docs/protocol.md §3.1, §5.1 notes
-- that replies to tier-3 scoped posts are unsupported). reply_to is a
-- denormalized copy of the record body's `reply_to` field, kept only for
-- `post` records, so the thread views (GET /records/{id}/replies) don't
-- need to scan and parse every post body.

ALTER TABLE records ADD COLUMN reply_to TEXT;
CREATE INDEX idx_records_reply_to ON records(reply_to, created_at);

-- Backfill any post records ingested before this migration existed.
UPDATE records SET reply_to = json_extract(body, '$.reply_to')
WHERE type = 'post' AND json_extract(body, '$.reply_to') IS NOT NULL;
