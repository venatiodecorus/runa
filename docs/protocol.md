# Protocol Specification

**Status:** v0.1 (PoC-normative for M1–M3; §§ marked *outline* are direction, not yet normative).
**Bar (design §9):** a third party can build an independent client from this document. Until test vectors exist, that bar is unmet — writing vectors is part of each implementing milestone.
**Versioning rule:** every record and envelope carries `v` (integer) and, for envelopes, `alg`. Implementations MUST reject unknown `v`/`alg` rather than guess. Changes to this file follow the same review process as code.

## 1. Primitives (v1)

| Purpose | Algorithm | Notes |
|---|---|---|
| Signatures | Ed25519 | root and device signing keys |
| Key agreement | X25519 | device kex keys, ephemeral senders |
| KDF (key agreement) | HKDF-SHA-256 | context strings below |
| AEAD | XChaCha20-Poly1305 | 24-byte nonce, random |
| Hash / fingerprints | SHA-256 | |
| Password KDF | Argon2id | recovery-kit passphrase backup; params in §7 |
| Mnemonics | BIP39, English wordlist | 32-byte root seed → 24 words |
| Encoding (binary-in-JSON) | base64url, no padding | RFC 4648 §5 |
| Canonicalization | JCS (RFC 8785) | UTF-8, sorted keys, no insignificant whitespace |

## 2. Identity & naming

- **Root key:** Ed25519 keypair, generated client-side from a 32-byte seed (the seed is what the recovery kit encodes). Signs *only* device certificates and device revocations. Never signs content.
- **Account ID:** `base64url(root_public_key)` — 43 chars. The pubkey *is* the identity; there is no server-assigned ID. Display names/handles are non-unique profile metadata (a signed `profile` record), never identifiers. Identity is therefore **instance-independent** (design §15): the same root key can enroll on any instance; v1 instances are otherwise independent networks (no federation).
- **Fingerprint (for UI / QR / safety numbers):** SHA-256 of the root public key, rendered per client convention (e.g., grouped hex or numeric safety-number form). Not used on the wire.
- **Device keys:** per device/browser-profile, self-generated: one Ed25519 signing keypair + one X25519 kex keypair. **Device ID:** `base64url(device_signing_public_key)`. Devices do all operational work: sign records, receive wrapped keys.

## 3. Signed records

All server-stored user data is a **record**: a JSON object signed by a device key (device certs and revocations are signed by the root instead).

```jsonc
{
  "v": 1,
  "type": "<record type>",
  "author": "<account id>",            // root pubkey, base64url
  "device": "<device id>",             // signing device pubkey; ABSENT on root-signed records
  "created_at": "<RFC 3339 UTC, e.g. 2026-08-20T12:00:00Z>",
  // ...type-specific fields...
  "sig": "<base64url Ed25519 signature>"
}
```

**Signing:** remove `sig`, canonicalize the remainder with JCS, sign those bytes. **Record ID:** `base64url(SHA-256(canonical bytes including sig))` — content-addressed, computed, never chosen.

**Verification (client and server MUST both implement):** signature valid for the stated key; if device-signed, a valid device cert chains the device to `author`'s root and no revocation for that device predates trust in the record. Server verifies on ingest as hygiene; clients verify everything they render — the client is the authority.

### 3.1 Record types (v1)

| `type` | Signer | Server visibility | Fields beyond common |
|---|---|---|---|
| `device-cert` | root | public | `device_sign_pub`, `device_kex_pub`, `name` (user label, optional) |
| `device-revoke` | root | public | `device_sign_pub` |
| `profile` | device | public | `display_name`, `bio` (both optional) |
| `post` | device | public (tier 1) | `body` (UTF-8 text, PoC), `reply_to` (record ID, optional) |
| `follow` | device | follower-visible (§6) | `subject` (account id) |
| `unfollow` | device | follower-visible | `subject` |
| `mute` / `unmute` | device | **private to author** — stored server-side (server sees the graph regardless, design §8) but never served to any other user | `subject` |
| `dm` | device | ciphertext only | envelope of §4 as the record body |
| `attestation` | device | public *(outline — M6)* | `subject`, `subject_root_pub`, `method` |

Later-milestone types (`report`, `invite`, epoch records) are reserved; do not improvise formats — extend this spec first.

## 4. Tier-2 envelope v1 (stateless hybrid)

Chosen over double ratchet for v1 because browser storage loss is routine and breaks ratchet sessions (design §7.1). `alg` and `v` fields make double ratchet a versioned, per-conversation, opportunistic upgrade later.

Encryption of plaintext `P` from sender device `S` to recipient *devices* `D1..Dn` (recipient device list read from their signed, unrevoked device certs — both participants' devices are recipients, so the sender's other devices can read the conversation):

1. Generate random 32-byte content key `K`; random 24-byte nonce `N`.
2. `ciphertext = XChaCha20-Poly1305(key=K, nonce=N, plaintext=P, aad=canonical header)` where the header is the envelope minus `recipients`, `ciphertext`, `sig`.
3. For each recipient device `Di` (kex pub `Ri`): generate ephemeral X25519 pair `(e_i, E_i)`; `ss = X25519(e_i, Ri)`; `wrap_key = HKDF-SHA256(ikm=ss, salt=E_i ∥ Ri, info="runa/v1/dm-wrap")`; `wrapped = XChaCha20-Poly1305(key=wrap_key, nonce=random, plaintext=K)`.
4. Envelope (as the body of a `dm` record, signed by the sender's device key like any record):

```jsonc
{
  "v": 1, "type": "dm", "alg": "x25519-hkdf-sha256+xchacha20poly1305",
  "author": "...", "device": "...", "created_at": "...",
  "to": "<recipient account id>",          // routing hint for the mailbox; server needs it anyway (threat model: metadata conceded)
  "nonce": "<b64url N>",
  "recipients": [ { "device": "<Di id>", "eph_pub": "<b64url E_i>", "wrap_nonce": "...", "wrapped_key": "..." } ],
  "ciphertext": "<b64url>",
  "sig": "..."
}
```

Decryption: find own device in `recipients`, unwrap `K`, verify AEAD (the AAD binds the header, so a tampered `to`/`author` makes decryption fail; decryption failures are rendered as hard errors, never as content). Signature verification is REQUIRED before rendering; encryption without a valid signature is spoofable ciphertext.

Plaintext `P` is itself a small JSON: `{"body": "...", "conversation": "<sorted account ids joined by ':'>"}` — binding the conversation inside the AEAD prevents cross-conversation replay of ciphertext.

## 5. Tier-3 web-scoped posts *(outline — M5)*

Per design §7.1(3): sender's client enumerates the concrete recipient set locally ("My follows" = hop 1, "My web" = hop 2 above threshold), generates a random epoch key, distributes it once per recipient device over the tier-2 channel, and posts reference `epoch_id`. Rotate on membership change + max age 30 days. Snapshot semantics per design §7.2. Formats to be specified before M5 begins.

## 6. Server API (v1, PoC surface)

Base path `/api/v1`. JSON. Errors: `{"error": {"code": "<machine code>", "message": "..."}}`.
Auth: signup is open (`POST /accounts` with root pubkey + first device cert). Session auth for subsequent calls = signed challenge: `GET /auth/challenge` → client signs it with a certified device key → short-lived token. No passwords anywhere.

**v1 request/response shapes (PoC-normative):**

- `POST /accounts` body `{"root_pub": "<account id>", "device_cert": <device-cert record>}` → `201 {"account": "<id>"}`. Cert must be root-signed by `root_pub`.
- `GET /accounts/{id}` → `{"account", "profile": <latest profile record or null>, "device_certs": [...], "device_revocations": [...], "follower_count"}`.
- `POST /records` body = one signed record → `201 {"id": "<record id>"}`. Phase-1 accepted types: `post`, `profile`, `device-cert`, `device-revoke` (device adds/revocations flow through here). Unknown types → `400 unknown_type`. Verification failure → `400 invalid_record` / `403 revoked_device`.
- `GET /accounts/{id}/records?type=post&limit=50&before=<created_at>` → `{"records": [...], "next_before": "<created_at or null>"}`, reverse-chronological.
- `GET /auth/challenge` → `{"challenge": "<b64url 32 bytes>", "expires_at"}`. `POST /auth/session` body `{"account", "device", "challenge", "sig"}` where `sig` = Ed25519 over `utf8("runa-auth-v1:" + challenge)` by a certified, unrevoked device → `{"token", "expires_at"}`. Subsequent authenticated calls send `Authorization: Bearer <token>`.
- `GET /accounts/{id}/follows` (auth) → `{"follows": [<follow records>]}` — the current outbound follow list as signed records (an `unfollow` removes the pair's earlier `follow`; latest `created_at` wins). Visibility (design §8): allowed iff the requester **is a follower of `{id}`**, `{id}` is the requester, or `{id}` has opted up to public via a profile record field `"follows_public": true`; otherwise `403 not_visible`.
- `GET /graph/2hop` (auth) → `{"follows": {"<viewer>": [...], "<followee>": [...]}, "mutes": [...]}` — the viewer's entitled slice: their own follow list, the follow list of each account they follow (entitled: following makes them a follower), and their own private mutes. This is exactly the `GraphView` input to the published client-side trust computation.
- `GET /feed` (auth) → `{"items": [{"record": <post>, "author": "<id>", "candidate_trust": <float>}], "authors": {"<id>": {"device_certs": [...], "device_revocations": [...]}}}` — candidate ranking by the server's mirror of the published math (viewer's mutes applied; standing 1.0 pre-M7), most recent + highest trust first. `candidate_trust` is a *proposal*: clients recompute from `/graph/2hop` + `/meta` constants and re-rank before display; nothing renders as trusted unless the client's own computation agrees. (Floats appear only in responses, never in signed records.)
- `follow`/`unfollow`/`mute`/`unmute` records flow through `POST /records` like everything else; the server materializes graph edges from them on ingest. Mutes are never served to anyone but their author.
- `dm` records (the §4 envelope) also flow through `POST /records`: the server verifies signature + cert chain on the *envelope*, treats `ciphertext`/`recipients` as opaque, and requires `to` to be a valid account id. Reads (auth): `GET /dm/with/{id}` → `{"records": [<dm records where (author=viewer ∧ to=id) ∨ (author=id ∧ to=viewer)>], "next_before"}` chronological (oldest→newest within the page), `limit`/`before` as for records. `GET /dm/inbox` → `{"conversations": [{"with": "<account id>", "last": <dm record>, "request": <bool>}]}` sorted by last activity; `request` is true iff the *viewer* has no trust path to the counterparty **and** the viewer has never sent into the conversation (the Phase-3 tray is classification only; token spend arrives with M4).
- `POST /backup` (auth) body `{"blob": <passphrase-backup object, §7>}` → `204`; one blob per account, overwrite allowed. `GET /backup/{account}` → `{"blob"}` or `404`. **PoC caveat:** backup fetch is deliberately unauthenticated — the recovering user has no device to sign with; the blob is Argon2id-encrypted client-side, and account IDs are public. This widens the brute-force exposure from "the operator" to "anyone" and is flagged in the threat model; revisit before production (e.g., rate limits, proof-of-possession of the word list).

| Endpoint | Purpose |
|---|---|
| `GET /meta` | instance self-description: `{name, software_version, protocol_version, constants: {…}}` — unauthenticated; clients compute trust with these values and badge deviations from reference defaults (design §15) |
| `POST /accounts` | create account: root pubkey + initial `device-cert` |
| `GET /accounts/{id}` | profile, device certs/revocations, follower **count** |
| `POST /records` | submit any signed record; server verifies before storing |
| `GET /accounts/{id}/records?type=post&…` | an account's public records (paginated) |
| `GET /accounts/{id}/follows` | outbound follow list — requester must be a follower of `{id}` or `{id}` has opted up to public (design §8) |
| `GET /feed` | candidate-ranked feed for the authenticated account (server *proposes*) |
| `GET /graph/2hop` | the authenticated viewer's entitled slice: own follows' follow lists — the input to client-side trust computation |
| `GET /dm/inbox`, `GET /dm/with/{id}` | ciphertext mailbox |

The graph-visibility rules of design §8 are enforced here and only here matter server-side: outbound follows are follower-visible (opt-up to public), inbound lists are count-only to others, mutes are never served to anyone but their author.

## 7. Recovery kit (M1)

Presented once at signup (export-at-birth), re-exportable anytime:

- **Key file:** JSON `{"v":1,"kind":"runa-root-key","account":"<id>","seed":"<b64url 32 bytes>","created_at":"..."}`, downloaded — never sent to the server.
- **Word list:** BIP39 24-word encoding of the same seed.
- **Passphrase backup (optional, design §2.4):** blob = XChaCha20-Poly1305 over the key-file JSON, key = Argon2id(passphrase, salt=random 16B, m=64 MiB, t=3, p=1); `{v, salt, params, nonce, ciphertext}` may be stored server-side (`POST /backup`). Server stores it blind. UI must state the brute-force-target caveat for high-value accounts.
- Import of any of the three forms → root in memory → sign a fresh device cert → session live. Target: re-enrollment ≈ 30 seconds.

## 8. Test vectors

`docs/protocol/vectors/*.json` (created per milestone): JCS canonicalization cases, signed records (valid + tampered), a full tier-2 envelope with all private keys given, recovery-kit seed↔words. Both the Go and TypeScript test suites consume the same files. A vector-less format change is an unreviewable format change — reject in review.
