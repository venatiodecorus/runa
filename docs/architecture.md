# Architecture

**Status:** v0.1 — proof-of-concept architecture. The normative product/design source is [`design-doc.md`](../design-doc.md); this document maps it onto concrete technology.

## System shape

Two deployable components plus one dev/governance tool, one repo:

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  web/  (TypeScript, React)   │  HTTPS │  server/  (Go)               │
│                              │◄──────►│                              │
│  • key generation & custody  │  JSON  │  • dumb, honest-but-curious  │
│  • all signing               │        │    mailbox & record store    │
│  • all encryption/decryption │        │  • signature verification    │
│  • trust re-computation      │        │  • graph store & 2-hop fetch │
│  • feed re-ranking           │        │  • candidate feed ranking    │
│  • IndexedDB device storage  │        │  • (later) budgets, standing │
└──────────────────────────────┘        └──────────────────────────────┘
                                                    │
                                              SQLite (PoC)
```

The trust boundary is absolute and is the whole point of the project:

- **The client is the security perimeter.** Private keys never leave the browser except as user-initiated, client-side-encrypted export blobs. All tier-2/3 plaintext exists only client-side.
- **The server stores signed records and ciphertext.** It verifies signatures and device-cert chains on ingest (defense in depth, not a trust root), computes *candidate* feed rankings, and serves graph slices. It can withhold and reorder; it can never read tier-2/3 content or forge records.
- **Server proposes, client verifies** (design §3.3): the server returns candidate-ranked feeds; the client recomputes `effective_trust` locally and nothing renders as trusted unless the client's own math agrees.

The third component, **`simlab/`** (design §16), is not deployed: a simulator that imports the same `packages/core` trust/budget math the client ships, runs it over synthetic populations, and charts how constant changes move reach. It is the mechanism by which constants get tuned and attack scenarios get red-teamed; scenario files are checked in and cited in constant-change PRs.

## Deployment model: instances (design §15)

One codebase, many instances. The project runs the **primary instance**; anyone can stand up their own from the same source, and **no code path may privilege the primary** (no hardcoded URLs, no blessed keys — enforced in review). An instance is one `runad` + one database + a web build pointed at it; instances are independent networks in v1 (identity keys are portable, graph/content/standing are per-instance; federation deferred — see [`self-hosting.md`](self-hosting.md)). Every instance self-describes via `GET /api/v1/meta`, publishing its versions and running constants; clients compute with instance-published constants and badge deviations from the reference defaults.

## Technology choices

Rationale for each lives in [`docs/decisions/`](decisions/). Summary:

| Layer | Choice | ADR |
|---|---|---|
| Backend language | Go (stdlib `net/http`, Go ≥1.23) | [ADR-0001](decisions/adr-0001-go-backend.md) |
| Server storage | SQLite via `modernc.org/sqlite` (CGO-free); store interface kept Postgres-portable | [ADR-0002](decisions/adr-0002-sqlite-storage.md) |
| Web client | TypeScript + React + Vite | [ADR-0003](decisions/adr-0003-web-stack.md) |
| Client crypto | `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, `@scure/bip39`, `@scure/base`, `hash-wasm` (Argon2id) | [ADR-0004](decisions/adr-0004-crypto-libraries.md) |
| Signed-record wire format | JCS canonical JSON (RFC 8785), Ed25519 detached signatures, versioned records | [ADR-0005](decisions/adr-0005-record-format.md) |

## Repository layout (target)

```
runa/
├── design-doc.md          # normative design (handoff brief)
├── docs/                  # living documents — changed via same review process as code
│   ├── architecture.md    #   this file
│   ├── threat-model.md    #   design §9 doc 1
│   ├── protocol.md        #   design §9 doc 2 — envelope formats, key hierarchy
│   ├── trust-and-reach.md #   design §9 doc 3 — the math + constants table
│   ├── governance.md      #   design §9 doc 4
│   ├── poc-plan.md        # phased plan with task checklists — agents start here
│   ├── self-hosting.md    # instance model & operator constraints
│   ├── explainers/        # plain-language reach & crypto explainers (updated with algorithm changes)
│   └── decisions/         # ADRs
├── server/                # Go module: github.com/VenatioDecorus/runa/server
│   ├── cmd/runad/         #   server entrypoint
│   └── internal/
│       ├── api/           #   HTTP handlers (stdlib mux, /api/v1/...)
│       ├── store/         #   storage interface + SQLite impl + embedded migrations
│       ├── record/        #   record parsing, JCS canonicalization, sig/cert-chain verification
│       └── trust/         #   server-side candidate ranking (mirror of core math)
├── packages/
│   └── core/              # framework-free TS protocol core: records/canonicalization,
│                          #   trust math, budget math, published constants (ADR-0006)
├── web/                   # Vite + React + TypeScript client (imports packages/core)
│   └── src/
│       ├── crypto/        #   keys, envelopes, recovery kit (no React imports — pure, testable)
│       ├── store/         #   IndexedDB (device keys, working root copy, cache)
│       ├── api/           #   typed API client (instance base URL is config)
│       └── ui/            #   components, routes
├── simlab/                # simulator (imports packages/core): browser UI + headless CLI
│   ├── src/population/    #   graph generators & cohort models (seeded, deterministic)
│   └── scenarios/         #   checked-in scenario JSON — cited in constant-change PRs
└── Makefile               # dev/test/lint entrypoints for all of the above
```

Two places intentionally implement the same logic twice (`packages/core` in TS, `server/internal` in Go): record canonicalization/verification, and the trust/budget math. This duplication is **by design** — client-side re-verification is the audit mechanism (design §1.7, §3.3). Cross-implementation test vectors (shared JSON fixtures in `docs/protocol/vectors/`, consumed by both test suites) keep them honest, and simlab exercising `packages/core` means simulation results describe the code the client actually ships.

## Data flow examples

**Signup (M1):** client generates Ed25519 root → derives/creates first device keypair (Ed25519 sign + X25519 kex) → root signs device cert → recovery kit screen (key file + BIP39 word list, client-side only) → `POST /api/v1/accounts` with root pubkey + device cert. No email, no phone. Server stores; account exists.

**Tier-1 post:** client builds post record → canonicalizes → signs with device key → `POST /api/v1/records`. Server verifies sig + device-cert chain (cert signed by root, not revoked) → stores → appears in followers' candidate feeds.

**Feed read (M2):** client fetches candidate feed + its own follows' follow lists (the 2-hop slice it is entitled to) → recomputes `subjective_trust × standing` per author → re-ranks locally → renders. Server ranking is a hint, never an authority.

**Tier-2 DM (M3):** client fetches recipient's signed device certs → for each recipient device: seal a random content key via X25519-ECDH + HKDF + XChaCha20-Poly1305 → envelope (versioned) signed by sender device → server stores/routes ciphertext. Decryption only ever client-side.

## Non-negotiable invariants (enforced in code review)

From design §1; violations are protocol changes requiring explicit sign-off, never incidental:

1. No mechanism may purchase or PoW-mint reach (PoW gates suspicion/signup only).
2. Penalties throttle reach to strangers; they never sever chosen edges or delete content.
3. Server never holds a decryption key for tier-2/3 content, including via report flows.
4. Nothing renders as trusted unless the client's own computation agrees.
5. Trust inputs are deliberate acts only (follow, mute) — never behavioral signals, and never group co-membership once groups exist (design §18: groups are an audience primitive, not a trust primitive).
6. Verification/attestation never gates capability (TOFU everywhere).
7. All algorithms and signal types are public; the only unpublished values are operational friction thresholds, and that boundary is disclosed.
8. No primary-instance privilege in code; instances publish their running constants via `/meta` (design §15).
9. Published constants change only with a cited simlab scenario (design §16); explainer docs update in the same PR as any algorithm or crypto change.
