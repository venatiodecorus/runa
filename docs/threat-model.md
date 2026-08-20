# Threat Model

**Status:** v0.1 — expanded from design §10. This is the foundation document every other doc cites. Changes go through code review like protocol changes.

## Assets

1. **Tier-2/3 content plaintext** — private messages and web-scoped posts.
2. **Private keys** — identity root keys and device keys.
3. **User attention** — the rationed resource; spam is an attack on it.
4. **Graph integrity** — trust edges reflect deliberate user acts, unforgeable.
5. **Content authenticity** — what you read is what the author signed.

Explicitly **not** protected assets in v1 (stated non-goals): metadata privacy from the server (no sealed sender), hiding the social graph from the server, anonymity. The network protects content and rations attention; it does not hide who talks to whom from its own operator.

## Adversaries & analysis

### A1. Honest-but-curious server (the 95% case)

**Sees:** full follow graph, all metadata (timing, sizes, device lists, epoch distribution fan-out), all public (tier-1) content, invite provenance.
**Cannot:** read tier-2/3 content (client-side encryption, server never holds keys); forge content, follows, or attestations (everything is signed; server verifies but is never a trust root).
This adversary covers mass surveillance and data-breach scenarios: a full database dump yields ciphertext, public content, and the graph — no private content, no keys.

**Instances (design §15):** the network is self-hostable; each instance's operator is the A1/A2 adversary *for that instance's users*. Self-hosting distributes operator power across many smaller operators — it does not eliminate it, and choosing an instance is choosing which operator to stand in this threat model. An operator who quietly alters trust constants is caught by `/meta` disclosure plus client-side recomputation; one who alters the invariants is running a detectable fork.

### A2. Active / malicious / compelled server

- **Can:** deny service; selectively drop or withhold messages, records, and attestations; serve manipulated *orderings*. Signed content makes tampering detectable, not censorship. Client-side re-ranking (design §3.3) makes ranking manipulation detectable because the algorithm is published.
- **Key substitution at first contact:** feasible. Mitigations: TOFU means the attack must hit the *first* exchange; key-change-without-re-attestation alarms; the attestation web; any later out-of-band safety-number check exposes it retroactively.
- **Malicious web code delivery (the big honest caveat):** the client is re-delivered JS on every load. A server willing to serve targeted malicious code to a specific user defeats E2E for that user. Mitigations (M9, post-PoC): reproducible builds + published hashes; PWA service-worker version pinning; client served as static assets on mirrorable infra decoupled from the API server; optional verifier extension. Honest summary: *E2E protects against a passive server always, and an active-but-code-honest server; targeted malicious code delivery defeats it, mitigated by build transparency and mirrors.*

### A3. Sybil attacker (unlimited free keypairs)

Cannot acquire inbound honest-graph trust. Trust rings carry weight only internally to the ring; the hop-2 cap plus per-path damping means one bridge into the honest graph yields one damped path, not amplification. Reach budgets scale with earned inbound trust (log-scaled, standing-weighted), so minted accounts hold minimum budgets. Signup PoW prices bulk creation; signup clustering and behavioral fingerprints are loud in legitimate metadata. Honest arithmetic (design §5.3): open signup means total cold-outreach volume scales linearly with account creation — the defense makes spam expensive *per unit of attention actually reached*, not impossible.

### A4. Brigade (real accounts, coordinated reports)

Report weighting discounts graph-correlated reporter clusters (a brigade is a tight cluster by definition); diversity beats volume. Adjudicated-false reports burn reporter standing. Trust-weighting means a brigade's mutes shape *their own* neighborhoods most. Residual risk: a genuinely graph-diverse mass campaign still moves standing — the human-review rung is the backstop, and standing decays (no permanent marks).

### A5. Recipient betrayal

Any tier-2/3 recipient can leak plaintext. Unsolvable (the screenshot problem) — stated, not hidden. Report-with-plaintext-forwarding is the legitimate, envelope-proven form: the reporter proves they were a real recipient; the server gains no decryption capability.

### A6. Client-device compromise

Malware or physical access to an unlocked browser yields that device's keys and locally cached plaintext. Root compromise = identity compromise. Mitigations: device keys are per-device and revocable by root (a lost device is a non-event); root is used only to sign device certs so it can live cold (exported at birth, optionally hardware-backed). Browser storage is treated as disposable, which bounds what a stolen cache is worth.

## Known accepted limitations (design §14)

Filter bubbles by construction (explore mode is the designated mitigation); full metadata + graph visible to server; epoch granularity as the forward-secrecy dial; tier-2 v1 lacks per-message forward secrecy (versioned upgrade path to double ratchet specified); a centralized server can censor even though it can't read or forge; behavioral enforcement is metadata-only for tiers 2–3 *by construction* (no content signals available); attestation is a public act; failed recovery is a new account, on purpose.

## PoC-specific notes

The PoC (see [`poc-plan.md`](poc-plan.md)) runs without: signup PoW, reach budgets (unless the stretch phase lands), standing/reports, reproducible-build transparency. During PoC these are absent, not broken — the PoC threat model is A1 plus content-authenticity only. Do not demo the PoC as spam-resistant.
