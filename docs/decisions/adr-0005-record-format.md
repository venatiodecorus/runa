# ADR-0005: JCS canonical JSON for signed records

**Status:** accepted · 2026-08-20

## Context

Every record is signed and must verify identically in Go and TypeScript, and be third-party-implementable (protocol bar, design §9). Candidates: canonical JSON (JCS, RFC 8785), deterministic CBOR, protobuf.

## Decision

JCS canonical JSON with detached base64url Ed25519 signatures. Rationale: human-readable records are load-bearing for a transparency-first protocol (users and auditors can read what they signed); JCS is a small, precisely specified standard with implementations in both languages (`gowebpki/jcs` for Go; a small vetted JS implementation or a ~100-line in-repo one covered by vectors); debugging signed-bytes mismatches in JSON is vastly cheaper than in binary formats during the PoC.

## Consequences

- JSON number canonicalization is the classic JCS footgun — protocol v1 sidesteps it by convention: **no floating-point fields in signed records** (timestamps are RFC 3339 strings, counts are integers). Enforced by vectors.
- Larger payloads than CBOR; irrelevant at PoC scale. Envelope `v`/`alg` fields leave room to introduce a binary format as a versioned change if size ever matters (e.g., epoch fan-out at M5+).
