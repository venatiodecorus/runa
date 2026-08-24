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
3. **Web-scoped posts** — private posts to "My follows" or "My web," encrypted to that audience *as it exists at the moment you post*. Details and honest caveats below.

Verification is separate from following, on purpose. Following someone means "show me their posts" — it says nothing about keys. Verifying keys is its own act, described next.

## Verifying that a key belongs to a person

Encryption works from the very first message with no setup — your client just uses the keys the server hands it (trust-on-first-use, like Signal). That's the right default, and it leaves exactly one gap: the *first* time you ever contact someone, a malicious server could in principle hand you the wrong key. Attestation is how you close that gap when it matters.

**Attestation** is a distinct, deliberate statement — "I checked, out-of-band, that this key belongs to the person I think it does" — made one of three ways:

- **Safety numbers.** Open someone's profile and your client shows a 60-digit number computed from your key and theirs together. Their client shows *the same number* to them. Read it to each other on a call, in person, over any channel you already trust; if the digits match, the keys are real, and one tap publishes your attestation. (If a server had substituted a key on either side, the numbers would not match — this check exposes it retroactively, which is exactly why a server thinking about it shouldn't.)
- **QR fingerprint scan** in person — the same check, camera instead of voice.
- **Domain proofs.** Someone who controls a website can claim it and put a small signed file at a standard location on that site. *Your* client fetches the file and checks the signature itself — the server is never asked to vouch. It's the only method that scales to verifying strangers and institutions.

Attestations are **public by design** — a verifiability claim you hide is worthless, so be aware that *"who verified whom"* is visible to everyone, including the server. They're also signed like everything else: the server can withhold them, but can never forge one from you.

What attestation buys you is *displayed confidence* and one loud alarm. Accounts you've verified get a checkmark that your own client computed and nobody can fake. Profiles show how many people *you trust* have verified an account — your web's judgment, not a global score. And the alarm: your client quietly remembers which devices your contacts had when you last checked; if someone you verified suddenly sprouts a new device, you're told before your next private message — *"a new device appeared since you verified them; re-compare your safety numbers if you can."* It's a warning you can click through, never a wall: someone whose phone died deserves your message, not a lockout. Verification never gates capability — it informs it.

## Private posts to your followers or your web

A DM has one or two readers, so it gets its own key. A scoped post might go to hundreds of people, so it uses a different trick: a shared key for a whole batch of posts, not one key per post.

When you post privately for the first time (or whenever your audience changes — see rotation, below), your client generates a random **epoch key**. It looks at who currently qualifies for the audience you picked — your followers, or your wider web — and hands a copy of that key to each of their devices individually, locked so that only that specific device can open it (the same locking mechanism a DM uses). Every post in that batch is then encrypted once with that one shared key. Your readers' clients fetch the locked copy meant for their own device, unlock the epoch key, and use it to read every post in the batch.

The server's job doesn't change: it stores the locked keys and the encrypted posts, and it never holds a key that can open either. It doesn't see an epoch key in the clear, ever — not even briefly in transit.

**Snapshot, not subscription.** Your audience at the moment you post is exactly who can read it, permanently. As the design doc puts it: *"Private posts are shared with your web as it exists when you post. Trust you grant later starts from now — like a conversation someone joins midway."* Someone you follow later can see your future scoped posts, not your backlog. Someone you remove stops getting new ones, but nothing can reach into their device and un-show them what they already unlocked.

**Rotation.** Because the readable set is frozen at distribution time, your client periodically starts a fresh batch under a new key with a freshly recomputed reader list — whenever your qualifying audience actually changes, and at least every 30 days regardless, so a key isn't left standing indefinitely.

**Honestly:** the server can see *who received a copy* of each epoch key, even though it can't read the key or the posts themselves — that's audience metadata, not content, and it's conceded rather than hidden. Anyone who can read a post could always screenshot or repost it — encryption protects the pipe, not the person on the other end of it. And if you lose every device without a recovery kit, your root key comes back, but your old private posts don't: recovery restores your identity, not your history.

## What the server can and cannot do — honestly

**Can:** see the follow graph, message timing and sizes, and all public content; refuse service; withhold messages. It's a mailbox: it knows who writes to whom, and it can lose mail, but it cannot open the private envelopes.

**Cannot:** read DMs or scoped posts, forge anything, or quietly swap your keys after first contact without tripping alarms.

**The honest caveat:** the client is a web app, re-delivered as code on every load. A malicious server willing to serve poisoned code *to you specifically* could defeat the encryption for you. Mitigations are on the roadmap (reproducible builds with published hashes, version pinning, mirrors that decouple the code you run from the server you talk to) — but we state the limit rather than pretend it away. Likewise unsolvable and stated plainly: anyone you send a message to can leak it. Encryption protects the pipe, not the people you choose.

Every format, algorithm, and constant is specified publicly to the standard of "a stranger could build a compatible client from the docs" — and the [test vectors](../protocol/vectors/README.md) mean they can prove their client is compatible. That is the audit mechanism: not "trust us," but "check us."
