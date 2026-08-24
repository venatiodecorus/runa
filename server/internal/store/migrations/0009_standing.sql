-- 0009: standing & reports (Phase 7 / M7, docs/protocol.md §9,
-- docs/trust-and-reach.md §4). Three tables, one per rung of the ladder:
--
--   reports      — the automated rung's inputs. Materialized from verified
--                  `report` records on ingest; the signed body stays in
--                  records and is served ONLY to the operator review queue
--                  (§9.1: a report never appears in any listing, feed, or
--                  count served to users, including the subject).
--                  `dismissed` is the adjudicated-false flag: dismissed
--                  reports are excluded from mass forever (§9.4), which is
--                  why they are flagged rather than deleted — the row is
--                  also the record of what was adjudicated.
--   standing     — the human rung's state: `p_adj` with the timestamp it
--                  was set (decay is computed lazily at read time from
--                  standing_half_life_days, so nothing needs re-writing as
--                  time passes) and the cold-outreach `frozen_until`.
--                  p_auto is deliberately NOT stored: it is a pure function
--                  of the window's reports plus the graph, recomputed at
--                  read time so reports age out on their own (§9.3).
--   review_queue — the human rung's worklist: one entry per opened review,
--                  resolved in place (resolved_at + decision + note) rather
--                  than deleted, so an account's adjudication history stays
--                  auditable and a resolved entry can suppress an immediate
--                  re-open on the same reports.
--
-- Floats (`p_adj`) live only here and in API responses, never in signed
-- records (ADR-0005).

CREATE TABLE reports (
	record_id TEXT PRIMARY KEY REFERENCES records(id),
	reporter TEXT NOT NULL REFERENCES accounts(id),
	subject TEXT NOT NULL REFERENCES accounts(id),
	reported_record TEXT NULL REFERENCES records(id),  -- the specific record complained about, §9.1
	reason TEXT NOT NULL,                              -- "spam" | "harassment" | "illegal" | "other"
	created_at TEXT NOT NULL,                          -- from the report record
	dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reports_subject ON reports(subject, created_at);
CREATE INDEX idx_reports_reporter ON reports(reporter);

CREATE TABLE standing (
	account TEXT PRIMARY KEY REFERENCES accounts(id),
	p_adj REAL NOT NULL DEFAULT 0,
	p_adj_updated_at TEXT,       -- RFC 3339 UTC; the decay clock's origin
	frozen_until TEXT NULL       -- RFC 3339 UTC; NULL = never frozen
);

CREATE TABLE review_queue (
	id INTEGER PRIMARY KEY,
	account TEXT NOT NULL REFERENCES accounts(id),
	opened_at TEXT NOT NULL,
	resolved_at TEXT NULL,
	decision TEXT NULL,          -- "dismiss" | "uphold" | "freeze" | "none"
	note TEXT NULL
);
CREATE INDEX idx_review_queue_account ON review_queue(account);
