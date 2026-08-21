-- 0005: Cold-outreach token buckets (Phase 4, trust-and-reach §3). One row
-- per sender; refill is lazy (applied on access, once per elapsed UTC day),
-- so only the balance and the date it was last brought current are stored.
-- The daily budget itself is never stored — it is recomputed from live
-- inbound trust at every refill. tokens is REAL: budgets are floats in
-- responses (never in signed records), and spends subtract whole tokens.

CREATE TABLE buckets (
	account TEXT PRIMARY KEY REFERENCES accounts(id),
	tokens REAL NOT NULL,
	last_refill TEXT NOT NULL     -- UTC calendar date, YYYY-MM-DD
);
