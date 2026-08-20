# ADR-0003: TypeScript + React + Vite for the web client

**Status:** accepted · 2026-08-20

## Context

All clients are web clients (design §2.3). The client carries the real complexity: key custody, crypto, trust recomputation, IndexedDB persistence. It must be auditable (open-source reference client is part of the verifiability chain) and, eventually, buildable reproducibly.

## Decision

TypeScript (strict), React 18+, Vite. React chosen over Svelte/Solid for ecosystem depth and agent familiarity — the framework is not where this project's risk lives. State kept deliberately light (React context + hooks; add Zustand only if pain appears). `idb` for IndexedDB. Crypto and record logic live in framework-free modules (`src/crypto/`, `src/records/`, `src/trust/`) with zero React imports so they are unit-testable in Node (Vitest) against the shared protocol vectors.

## Consequences

- PWA/service-worker pinning and reproducible builds (threat model A2) come at M9; Vite supports both paths.
- The framework-free core keeps a future non-React or third-party client honest about what the "protocol client" actually is.
