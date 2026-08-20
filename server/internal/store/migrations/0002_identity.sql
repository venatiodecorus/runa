-- 0002: identity & custody (Phase 1). Accounts are root pubkeys; records are
-- content-addressed canonical JSON; devices materialize cert/revocation state
-- so ingest-time chain checks are a lookup, not a records scan.

CREATE TABLE accounts (
	id TEXT PRIMARY KEY,          -- account id = b64url(root pubkey)
	created_at TEXT NOT NULL      -- RFC 3339 UTC
);

CREATE TABLE records (
	id TEXT PRIMARY KEY,          -- b64url(SHA-256(canonical bytes incl. sig))
	account TEXT NOT NULL REFERENCES accounts(id),
	device TEXT,                  -- NULL on root-signed records
	type TEXT NOT NULL,
	created_at TEXT NOT NULL,     -- from the record; fixed-precision, string-sortable
	body TEXT NOT NULL            -- stored canonical JSON, served verbatim
);
CREATE INDEX idx_records_account_type_created ON records(account, type, created_at);
CREATE INDEX idx_records_account_created ON records(account, created_at);

CREATE TABLE devices (
	account TEXT NOT NULL REFERENCES accounts(id),
	device_sign_pub TEXT NOT NULL,
	device_kex_pub TEXT NOT NULL,
	cert_record_id TEXT NOT NULL REFERENCES records(id),
	revoked_at TEXT,              -- created_at of the earliest device-revoke, NULL if unrevoked
	PRIMARY KEY (account, device_sign_pub)
);

CREATE TABLE sessions (
	token TEXT PRIMARY KEY,
	account TEXT NOT NULL REFERENCES accounts(id),
	device TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE TABLE backups (
	account TEXT PRIMARY KEY REFERENCES accounts(id),
	blob TEXT NOT NULL,           -- client-side-encrypted passphrase backup, stored blind
	updated_at TEXT NOT NULL
);
