-- 0004: DMs (Phase 3). A dm record's envelope is opaque ciphertext; this
-- table materializes on ingest only the routing metadata the server needs
-- anyway (threat model: metadata conceded, docs/protocol.md §4) for the two
-- read paths: pair lookups (GET /dm/with/{id}, either direction) and
-- counterparty scans (GET /dm/inbox). Bodies stay in records, served
-- verbatim; recipient is the envelope's `to`, always a local account.

CREATE TABLE dms (
	record_id TEXT PRIMARY KEY REFERENCES records(id),
	author TEXT NOT NULL REFERENCES accounts(id),
	recipient TEXT NOT NULL REFERENCES accounts(id),
	created_at TEXT NOT NULL      -- from the record; string-sortable
);
CREATE INDEX idx_dms_author_recipient_created ON dms(author, recipient, created_at);
CREATE INDEX idx_dms_recipient_created ON dms(recipient, created_at);
