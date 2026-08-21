# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Runa** — a privacy-respecting social network where reach (not posting) is the rationed resource, trust is computed subjectively from each viewer's position in the follow graph, and private content is protected by client-side cryptography. The server is a dumb, honest-but-curious mailbox.

**Current state: implementation in progress.** `docs/poc-plan.md` is the shared work ledger between sessions — its checkboxes are the source of truth for what's done; work proceeds phase by phase, checking off tasks as they land.

## Reading order for a new session

1. `docs/poc-plan.md` — what to do next (checkboxes = current state).
2. `docs/architecture.md` — system shape, repo layout, and the **non-negotiable invariants** list.
3. `docs/protocol.md` — wire formats; consult before writing any record/envelope/API code.
4. `design-doc.md` — the normative design; cite it, don't re-derive it. `docs/threat-model.md` and `docs/trust-and-reach.md` fill in security and math detail.

## Commands

Run `npm install` once at the repo root (npm workspaces). Then, from the root:

- `make dev` — API server (`:8080`) + web dev server (Vite, proxies `/api`); `make simlab` — simulator dev server.
- `make test` — Go (`go test ./...` in `server/`) + Vitest across all TS workspaces.
- `make lint` — `go vet` + `tsc --noEmit` per workspace.
- `make vectors-test` — just the cross-implementation protocol-vector tests.
- Single Go test: `cd server && go test ./internal/api/ -run TestMeta`. Single TS test file: `npm run test -w packages/core -- --run <file-or-pattern>` (any workspace).
- Server binary: `cd server && go build ./cmd/runad`; flags `-addr`, `-db`, `-instance-name` (env: `RUNAD_ADDR`, `RUNAD_DB`, `RUNAD_INSTANCE_NAME`).
- Regenerate protocol vectors after a format/constant change: `npm run gen:vectors -w packages/core` (and `-w web` for the recovery-kit vector); then `make vectors-test`.

## Architecture (big picture)

Two deployable components plus a simulator, one trust boundary:

- `server/` — Go (stdlib `net/http`, SQLite via `modernc.org/sqlite`). Stores signed records and ciphertext, verifies signatures/cert-chains on ingest (hygiene, not authority), serves graph slices, computes *candidate* feed rankings, self-describes via `GET /api/v1/meta` (versions + running constants).
- `packages/core` — framework-free TS protocol core: records/canonicalization, trust math, budget math, published constants (ADR-0006).
- `web/` — TypeScript + React + Vite, imports core. Holds all keys (IndexedDB, treated as disposable), does all signing/encryption/decryption, **recomputes trust locally and re-ranks** — nothing renders as trusted unless the client's own math agrees. Instance-agnostic: API base URL is config.
- `simlab/` — simulator (design §16) importing the *same* `packages/core` math: synthetic populations, live constant sliders, reach charts; browser UI + headless CLI; scenario JSON checked into `simlab/scenarios/`. Dev/governance tool, never deployed. It must never fork or reimplement the core math — its whole value is exercising the shipping code.

The network is self-hostable (design §15): the primary instance gets **no privilege in code** — no hardcoded URLs, no blessed keys. v1 instances are independent networks; federation is deferred, don't foreclose it casually.

Two things are deliberately implemented twice (Go in `server/internal`, TS in `packages/core`): record canonicalization/verification and the trust/budget computation. That duplication is the audit mechanism — do not "deduplicate" it. Shared JSON test vectors in `docs/protocol/vectors/` keep both sides honest; the build order inside every phase is **vectors → core libs → server → client**.

Key formats: identity = Ed25519 root key (account ID = base64url of the pubkey) signing per-device certs; all stored data = JCS-canonical-JSON records with detached Ed25519 signatures, versioned (`v`/`alg`) from day one; tier-2 DMs = stateless hybrid X25519+HKDF+XChaCha20-Poly1305 envelopes per recipient *device*. Published constants live in exactly `server/internal/trust/constants.go`, `packages/core/src/constants.ts`, and the table in `docs/trust-and-reach.md` — a shared vector asserts they agree.

## Hard rules

- **Invariants in `docs/architecture.md` §"Non-negotiable invariants" override convenience.** If a task seems to require violating one (e.g., server touching a decryption key, trust from behavioral signals, purchasable reach), stop and surface the conflict instead of implementing.
- The four living docs (`threat-model.md`, `protocol.md`, `trust-and-reach.md`, `governance.md`) change via reviewed PRs like code. Never implement a wire format the spec doesn't define — extend `docs/protocol.md` in the same change, with vectors. No floating-point fields in signed records (ADR-0005).
- Client crypto uses the `@noble`/`@scure` family only (ADR-0004); server crypto uses Go stdlib + `golang.org/x/crypto`. Don't introduce other crypto dependencies without an ADR.
- Any change to reach algorithms or crypto updates the matching plain-language doc in `docs/explainers/` in the same change. Any change to a published constant cites a checked-in simlab scenario (`simlab/scenarios/`). simlab must be seeded-deterministic — no `Math.random`, no `Date.now` in simulation paths.
