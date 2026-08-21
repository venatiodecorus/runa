# Self-Hosting & Instances

**Status:** v0.1 — design §15 made operational. Design constraints apply from Phase 0; the operator guide itself is written at M9.

## Model

- An **instance** is one server (one `runad` + its database) plus its users' graph. The project runs the **primary instance**; anyone can run their own from the same source.
- **No primary-instance privilege in code.** No hardcoded URLs, no feature flags only the primary can enable, no blessed keys. The primary is the reference deployment, nothing more. This is enforceable in review: any PR that would make the primary special is rejected.
- **v1 instances are independent networks.** Identity keypairs are instance-independent (your root key is yours everywhere), but graph, content, standing, and budgets are per-instance. **Federation is deferred, not foreclosed** — before accepting any design that would make cross-instance trust paths, mailbox routing, or attestation propagation structurally expensive, raise it as a protocol discussion.

## Design constraints on the codebase (now, not at M9)

1. **Client is instance-agnostic:** API base URL is configuration; the web build must be deployable against any instance (and servable *by* `runad` itself as static assets, or separately per the code-delivery mitigations in the threat model).
2. **Instances self-describe:** `GET /api/v1/meta` (protocol §6) returns instance name, software + protocol versions, and the **running constants**. Clients compute trust with the instance-published constants and visibly badge deviations from the reference defaults in `trust-and-reach.md`. Transparency is a per-instance protocol expectation.
3. **Trivial ops floor:** one static Go binary + one SQLite file + one config (flags/env) must be a complete working instance. Anything beyond that (Postgres, object storage) stays optional.
4. **Modes are per-instance and disclosed.** Example: **imageboard mode** (design §17) — the instance disables profile customization (no names/bios/avatars; accounts render as their ids) via a config flag, published in `/meta` so any client renders accordingly. Modes never touch the trust math or the invariants.
5. **Constants are config, invariants are not.** Operators may tune published constants (their `/meta` discloses it). The invariants in `trust-and-reach.md` §5 (no purchasable reach, throttle-don't-silence, …) are code, not config — an operator who changes those is running a fork, and clients/users can tell because the algorithms are published.

## Operator responsibilities (expanded at M9 into a real guide)

Each operator is the honest-but-curious/active server of the [threat model](threat-model.md) for their users: they see the graph and metadata, hold ciphertext, and run the human-review rung of the enforcement ladder for their instance. Choosing an instance is choosing an operator to trust with exactly that much.

## Open items

- **License** — self-hosting makes this load-bearing (copyleft vs permissive changes what "anyone can run an instance" means in practice). Owner decision; needed before first public release, not before PoC code.
- Naming/trademark posture for third-party instances.
- Federation design discussion (post-PoC).
- M9 deliverables: operator guide, Docker image, backup/restore, upgrade/migration story.
