-- 0003: graph (Phase 2). Follow and mute edges materialized from signed
-- follow/unfollow/mute/unmute records on ingest (latest created_at wins).
-- Subjects are account ids that need not exist on this instance; unknown
-- subjects simply contribute nothing. Mutes are private to their muter and
-- never served to anyone else (docs/protocol.md §6).

CREATE TABLE follows (
	follower TEXT NOT NULL REFERENCES accounts(id),
	subject TEXT NOT NULL,        -- account id; may be off-instance
	record_id TEXT NOT NULL REFERENCES records(id),
	created_at TEXT NOT NULL,     -- from the winning follow record
	PRIMARY KEY (follower, subject)
);
CREATE INDEX idx_follows_subject ON follows(subject);

CREATE TABLE mutes (
	muter TEXT NOT NULL REFERENCES accounts(id),
	subject TEXT NOT NULL,
	record_id TEXT NOT NULL REFERENCES records(id),
	created_at TEXT NOT NULL,
	PRIMARY KEY (muter, subject)
);
