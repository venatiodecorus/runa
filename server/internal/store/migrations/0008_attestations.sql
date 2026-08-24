-- 0008: attestations (Phase 6 / M6, docs/protocol.md §8, design §7.3).
-- Attestation and attestation-revoke records materialize here exactly as
-- follow/unfollow does in 0003: latest created_at wins per (attester,
-- subject). Unlike follow's subject, an attestation's subject MUST be a
-- known account on this instance (enforced at ingest, protocol §6), so the
-- foreign key is safe to declare. `method` is denormalized from the record
-- so GET /accounts/{id}/attestations can be served from a join against
-- records without parsing every body. Attestations are public by design
-- (§8) — no visibility filtering applies here, unlike follows/mutes.
--
-- Tie-break (§8.1, asymmetric with follow/unfollow): a revoke with
-- created_at >= the attestation's supersedes it. The application layer
-- (server/internal/api/graph.go, applyAttestationRecord) enforces this in
-- both directions — an attestation record is not materialized if a
-- same-author revoke of the same subject already has created_at >= its
-- own, and a revoke deletes any stored row with created_at <= its own.

CREATE TABLE attestations (
	attester TEXT NOT NULL REFERENCES accounts(id),
	subject TEXT NOT NULL REFERENCES accounts(id),
	method TEXT NOT NULL,         -- "qr" | "safety-number" | "domain-proof"
	record_id TEXT NOT NULL REFERENCES records(id),
	created_at TEXT NOT NULL,     -- from the winning attestation record
	PRIMARY KEY (attester, subject)
);
CREATE INDEX idx_attestations_subject ON attestations(subject, created_at);
