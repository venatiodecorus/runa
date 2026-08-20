# ADR-0004: Client crypto libraries

**Status:** accepted · 2026-08-20

## Context

The browser client needs Ed25519, X25519, XChaCha20-Poly1305, HKDF, SHA-256, Argon2id, BIP39. WebCrypto now ships Ed25519/X25519 in current browsers but has no XChaCha20-Poly1305 or Argon2id, offers no non-extractable story compatible with our export-at-birth custody model, and mixing WebCrypto + JS libraries splits every primitive across two APIs.

## Decision

Pure-JS/WASM audited libraries, one family: `@noble/curves` (ed25519, x25519), `@noble/ciphers` (xchacha20poly1305), `@noble/hashes` (sha256, hkdf), `@scure/bip39` + `@scure/base` (word lists, base64url), `hash-wasm` (Argon2id — noble has no Argon2id and it must be fast enough for m=64 MiB). noble/scure are minimal-dependency, audited, and readable — which matters for a client whose auditability is a design pillar.

## Consequences

- Keys are extractable JS values; custody safety comes from the design (disposable device keys, cold root), not from non-extractability. WebAuthn PRF root-wrapping (design §2.3) is a later, additive convenience tier — verify PRF browser coverage at implementation time (design §13).
- Same primitives exist server-side in Go's x/crypto, so test vectors are cheap to satisfy on both ends.
- Constant-time guarantees in JS are best-effort; acceptable for PoC, note in the threat model if it survives to production review.
