# ADR-0002: SQLite for PoC storage

**Status:** accepted · 2026-08-20

## Context

PoC needs: records by author/type/time, graph edges with 2-hop reads, ciphertext mailbox. Single-node, small data, zero-ops preferred.

## Decision

SQLite via `modernc.org/sqlite` (pure Go, no cgo — keeps cross-compilation and sandbox builds trivial). WAL mode. Schema migrations as embedded, numbered SQL files applied at startup. All storage access behind a small `store` interface in `server/internal/store` written against `database/sql`, keeping a later Postgres implementation a new driver + migration dialect, not a rewrite.

## Consequences

- One writer at a time is fine at PoC scale; revisit at the point epoch-key fan-out (design §13) is being measured, not before.
- No ORM, no sqlc for now — hand-written queries; adopt sqlc only if the query surface grows past comfort.
