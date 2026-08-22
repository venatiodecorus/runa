-- 0006: Tier-3 scoped posts (Phase 5, docs/protocol.md §5). Epoch records,
-- key grants, and scoped posts are opaque to the server — it never holds a
-- decryption key (architecture invariant 3). These tables materialize on
-- ingest only the routing/authorization metadata the read paths need:
--
--   epochs        the epoch record's declared scope source and rotation
--                 chain; the epoch id IS the record id (§5.2).
--   epoch_members the FROZEN membership snapshot (§5.1): the author (added
--                 with the epoch) plus every account addressed by an
--                 accepted epoch-key record. Never recomputed from the
--                 graph — the fan-out is the snapshot.
--   epoch_keys    routing for GET /epochs/keys: which grants name this
--                 viewer as `to`. Bodies stay in records, served verbatim.
--   scoped_posts  post → epoch, so member-only delivery in /feed and
--                 /accounts/{id}/records is a join, not a body scan.

CREATE TABLE epochs (
	record_id TEXT PRIMARY KEY REFERENCES records(id),   -- the epoch id (§5.2)
	author TEXT NOT NULL REFERENCES accounts(id),
	scope_source TEXT NOT NULL,   -- "follows" | "web" (§5.1; reserved sources rejected on ingest)
	prev TEXT,                    -- superseded epoch id, NULL when none
	created_at TEXT NOT NULL      -- from the record; string-sortable
);
CREATE INDEX idx_epochs_author_created ON epochs(author, created_at);

CREATE TABLE epoch_members (
	epoch_id TEXT NOT NULL REFERENCES epochs(record_id),
	member TEXT NOT NULL REFERENCES accounts(id),
	PRIMARY KEY (epoch_id, member)
);
CREATE INDEX idx_epoch_members_member ON epoch_members(member);

CREATE TABLE epoch_keys (
	record_id TEXT PRIMARY KEY REFERENCES records(id),
	epoch_id TEXT NOT NULL REFERENCES epochs(record_id),
	recipient TEXT NOT NULL REFERENCES accounts(id),   -- the record's `to`
	created_at TEXT NOT NULL
);
CREATE INDEX idx_epoch_keys_recipient_created ON epoch_keys(recipient, created_at);

CREATE TABLE scoped_posts (
	record_id TEXT PRIMARY KEY REFERENCES records(id),
	epoch_id TEXT NOT NULL REFERENCES epochs(record_id),
	author TEXT NOT NULL REFERENCES accounts(id),
	created_at TEXT NOT NULL
);
CREATE INDEX idx_scoped_posts_author_created ON scoped_posts(author, created_at);
