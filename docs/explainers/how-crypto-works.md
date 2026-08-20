# How Runa's cryptography works

*Plain-language explainer. The precise formats live in [`protocol.md`](../protocol.md); if this page and the spec disagree, the spec wins and this page has a bug. Updated in the same change as any cryptographic change.*

## Your account is a key, not a row in our database

Signing up generates a cryptographic keypair **on your device**. No email, no phone number, no password. The public half is your identity; the private half never leaves your device except when *you* export it. The server can't reset it, reassign it, or log in as you — it doesn't have it. Your identity isn't even instance-specific: the same key is yours on any Runa server.

Two kinds of keys, because browsers lose things:

- Your **root key** is your identity. It's shown to you at signup as a recovery kit — a downloadable file and a 24-word phrase — and its only job is to bless and revoke device keys. Keep it somewhere safe; ideally it lives *outside* the browser entirely.
- **Device keys** do the daily work: one set per browser/device, blessed by a certificate signed with your root. They sign your posts and receive your encrypted messages. If a browser clears its storage or a laptop is lost, you revoke that device's key with your root and enroll a new one in about thirty seconds. **Losing a device is a non-event; losing your root key without a recovery kit means the account is gone** — genuinely gone, because there's no back door for us is the same fact as there's no back door for anyone.

Recovery options are yours to configure and change later: a passphrase-encrypted backup stored (unreadably) on the server, splitting your key among trusted contacts so any 3-of-5 can help you recover, or explicitly none.

## Everything is signed; private things are encrypted

**Every piece of content is signed** by a device key. The server checks signatures but is never trusted for them — your client re-verifies everything it shows you. The server cannot forge a post, a follow, or an attestation from you; if it tampers with content, clients detect it.

Content comes in three privacy tiers:

1. **Public posts** — signed plaintext. The server (and everyone) can read them; nobody can alter them.
2. **Direct messages** — end-to-end encrypted. Your client fetches the recipient's device certificates, encrypts a fresh random key to *each of their devices* (and your own other devices), and encrypts the message with it. The server stores and delivers ciphertext it cannot read. Version fields are built into every envelope, so stronger schemes (like double-ratchet forward secrecy) can roll out later without breaking anything.
3. **Web-scoped posts** — encrypted to your followers (or your 2-hop web) *as it exists at the moment you post*. People you trust later can see your future posts, not your past ones — like a conversation someone joins midway. Removing someone stops all future sharing but can't unsend the past.

Verification is separate from following, on purpose. Following someone means "show me their posts" — it says nothing about keys. **Attestation** is a distinct, deliberate act: scanning a fingerprint QR in person, comparing safety numbers over another channel, or checking a proof posted on a domain the person controls. Encryption works without any of this (trust-on-first-use, like Signal); attestation raises displayed confidence and arms the one loud alarm that matters: *"this person's key changed and nobody who verified them before has re-verified."* Verification never gates capability — it informs it.

## What the server can and cannot do — honestly

**Can:** see the follow graph, message timing and sizes, and all public content; refuse service; withhold messages. It's a mailbox: it knows who writes to whom, and it can lose mail, but it cannot open the private envelopes.

**Cannot:** read DMs or scoped posts, forge anything, or quietly swap your keys after first contact without tripping alarms.

**The honest caveat:** the client is a web app, re-delivered as code on every load. A malicious server willing to serve poisoned code *to you specifically* could defeat the encryption for you. Mitigations are on the roadmap (reproducible builds with published hashes, version pinning, mirrors that decouple the code you run from the server you talk to) — but we state the limit rather than pretend it away. Likewise unsolvable and stated plainly: anyone you send a message to can leak it. Encryption protects the pipe, not the people you choose.

Every format, algorithm, and constant is specified publicly to the standard of "a stranger could build a compatible client from the docs" — and the [test vectors](../protocol/vectors/README.md) mean they can prove their client is compatible. That is the audit mechanism: not "trust us," but "check us."
