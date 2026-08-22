/**
 * Tier-3 web-scoped posts (docs/protocol.md §5, M5). The author's client
 * enumerates a concrete recipient set locally, generates a random 32-byte
 * epoch key `K_e`, distributes it once to each recipient *device* using
 * exactly the §4 wrap mechanism (with domain-separated, epoch-bound HKDF
 * info), and encrypts posts under `K_e`. Snapshot semantics (§5.5, design
 * §7.2): the readable set is frozen at distribution time.
 *
 * Mirrors envelope.ts in style and mechanism (wrap steps, headerAad
 * convention, injectable `random`, signRecord usage) — the two share the
 * same hybrid primitive, just applied to a different fan-out shape.
 */
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { b64url, utf8 } from "./encoding.js";
import { canonicalize } from "./jcs.js";
import { signRecord, recordId, type RunaRecord } from "./records.js";
import { DM_ALG, type DmRecipientEntry, type SealRecipient } from "./envelope.js";
import { trustMap, type GraphView, type TrustConstants } from "./trust.js";
import { CONSTANTS } from "./constants.js";

/** HKDF info prefix (§5.3): "runa/v1/epoch-wrap:" + <epoch id> — binds each wrap to one epoch. */
const EPOCH_WRAP_INFO_PREFIX = "runa/v1/epoch-wrap:";

/** v1 scope sources an epoch record may declare (§5.1). "roster" is reserved. */
export type ScopeSource = "follows" | "web";

export interface EpochScope {
  source: ScopeSource;
}

export interface EpochRecord extends RunaRecord {
  type: "epoch";
  scope: EpochScope;
  prev?: string; // record id of the epoch this one supersedes (rotation chain)
}

export interface EpochKeyRecord extends RunaRecord {
  type: "epoch-key";
  alg: typeof DM_ALG;
  epoch: string; // epoch record id
  to: string; // recipient account id
  recipients: DmRecipientEntry[]; // same wrap-entry shape as the §4 envelope
}

export interface ScopedPostRecord extends RunaRecord {
  type: "scoped-post";
  alg: typeof DM_ALG;
  epoch: string; // epoch record id
  nonce: string; // b64url 24 bytes
  ciphertext: string;
}

export interface ScopedPostPlaintext {
  body: string;
}

/** Header = the record minus recipients/ciphertext/sig; canonical bytes are the AAD (§4, §5.4). */
function headerAad(record: Record<string, unknown>): Uint8Array {
  const { recipients: _r, ciphertext: _c, sig: _s, ...header } = record;
  return utf8(canonicalize(header));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Build + sign an `epoch` record (§5.2). Device-signed, like posts. The
 * epoch ID is the record's own content-addressed record id (§3) — callers
 * use the returned `epochId` for `epoch-key`/`scoped-post` records and never
 * invent or store a separate identifier.
 */
export function makeEpoch(opts: {
  source: ScopeSource;
  prev?: string;
  author: string;
  device: string;
  deviceSignSeed: Uint8Array;
  createdAt: string;
}): { record: EpochRecord; epochId: string } {
  const unsigned: Record<string, unknown> = {
    v: 1,
    type: "epoch",
    author: opts.author,
    device: opts.device,
    created_at: opts.createdAt,
    scope: { source: opts.source },
  };
  if (opts.prev !== undefined) unsigned.prev = opts.prev;
  const record = signRecord(unsigned as Omit<RunaRecord, "sig">, opts.deviceSignSeed) as EpochRecord;
  return { record, epochId: recordId(record) };
}

/**
 * Wrap the 32-byte epoch key `K_e` to every certified device of one
 * recipient account, producing one `epoch-key` record (§5.3). The author
 * calls this once per member, including a self-grant `to: author` so their
 * other devices can read their own posts. Same hybrid mechanism as
 * `sealDm`'s step 3, with the HKDF info bound to this specific epoch —
 * `"runa/v1/epoch-wrap:" + epochId`, NOT the dm info string — so a wrap
 * cannot be replayed under a different epoch.
 */
export function sealEpochKey(opts: {
  epochId: string;
  epochKey: Uint8Array; // 32 bytes, the same K_e for every member of this epoch
  to: string; // recipient account id
  author: string;
  device: string; // sender (epoch admitter) device id
  deviceSignSeed: Uint8Array;
  createdAt: string;
  recipients: SealRecipient[]; // ALL certified, unrevoked devices of `to`
  random?: (n: number) => Uint8Array; // injectable for deterministic vectors
}): EpochKeyRecord {
  const random = opts.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const wrapInfo = EPOCH_WRAP_INFO_PREFIX + opts.epochId;
  const unsigned: Record<string, unknown> = {
    v: 1,
    type: "epoch-key",
    alg: DM_ALG,
    author: opts.author,
    device: opts.device,
    created_at: opts.createdAt,
    epoch: opts.epochId,
    to: opts.to,
  };

  const recipients: DmRecipientEntry[] = opts.recipients.map((r) => {
    const ephPriv = random(32);
    const ephPub = x25519.getPublicKey(ephPriv);
    const shared = x25519.getSharedSecret(ephPriv, r.kexPub);
    const wrapKey = hkdf(sha256, shared, concat(ephPub, r.kexPub), wrapInfo, 32);
    const wrapNonce = random(24);
    const wrapped = xchacha20poly1305(wrapKey, wrapNonce).encrypt(opts.epochKey);
    return {
      device: r.device,
      eph_pub: b64url.encode(ephPub),
      wrap_nonce: b64url.encode(wrapNonce),
      wrapped_key: b64url.encode(wrapped),
    };
  });

  return signRecord({ ...unsigned, recipients } as Omit<RunaRecord, "sig">, opts.deviceSignSeed) as EpochKeyRecord;
}

/**
 * Unwrap `K_e` as one recipient device. Callers MUST have verified the
 * record signature + cert chain first (verifyAuthoredRecord) — this
 * function trusts none of that. The HKDF info is derived from the record's
 * OWN `epoch` field, so a record whose `epoch` has been swapped to a
 * different epoch id fails to unwrap (the wrap key at seal time was derived
 * from the true epoch id, not the swapped one) — this is the cryptographic
 * binding §5.3 describes, not just a field to cross-check. Throws on any
 * failure (wrong device, wrong epoch, tampered ciphertext).
 */
export function openEpochKey(record: EpochKeyRecord, device: { deviceId: string; kexSeed: Uint8Array }): Uint8Array {
  if (record.v !== 1 || record.alg !== DM_ALG) throw new Error(`unsupported epoch-key alg: v${record.v} ${record.alg}`);
  const entry = record.recipients.find((r) => r.device === device.deviceId);
  if (!entry) throw new Error("this device is not a recipient");
  const ephPub = b64url.decode(entry.eph_pub);
  const shared = x25519.getSharedSecret(device.kexSeed, ephPub);
  const kexPub = x25519.getPublicKey(device.kexSeed);
  const wrapKey = hkdf(sha256, shared, concat(ephPub, kexPub), EPOCH_WRAP_INFO_PREFIX + record.epoch, 32);
  const epochKey = xchacha20poly1305(wrapKey, b64url.decode(entry.wrap_nonce)).decrypt(b64url.decode(entry.wrapped_key));
  if (epochKey.length !== 32) throw new Error("unwrapped epoch key is not 32 bytes");
  return epochKey;
}

/**
 * Encrypt a scoped post under the epoch key (§5.4). AEAD key = `K_e`,
 * random 24-byte nonce, AAD = the record minus `ciphertext`/`sig` (there is
 * no `recipients` field on a scoped-post; `headerAad` stripping a
 * nonexistent key is harmless, so the same helper as the wrap step works
 * unchanged). Plaintext is `{"body": "<string>"}`.
 */
export function sealScopedPost(opts: {
  body: string;
  epochId: string;
  epochKey: Uint8Array; // 32 bytes
  author: string;
  device: string;
  deviceSignSeed: Uint8Array;
  createdAt: string;
  random?: (n: number) => Uint8Array;
}): ScopedPostRecord {
  const random = opts.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const nonce = random(24);
  const unsigned: Record<string, unknown> = {
    v: 1,
    type: "scoped-post",
    alg: DM_ALG,
    author: opts.author,
    device: opts.device,
    created_at: opts.createdAt,
    epoch: opts.epochId,
    nonce: b64url.encode(nonce),
  };
  const plaintext: ScopedPostPlaintext = { body: opts.body };
  const ciphertext = xchacha20poly1305(opts.epochKey, nonce, headerAad(unsigned)).encrypt(
    utf8(JSON.stringify(plaintext)),
  );
  return signRecord(
    { ...unsigned, ciphertext: b64url.encode(ciphertext) } as Omit<RunaRecord, "sig">,
    opts.deviceSignSeed,
  ) as ScopedPostRecord;
}

/**
 * Decrypt a scoped post given its epoch key. Callers MUST have verified the
 * record signature + cert chain first (verifyAuthoredRecord) — encryption
 * without a valid signature is spoofable ciphertext, exactly as for `dm`.
 * The AAD binds author/epoch/timestamp, so ciphertext transplanted onto
 * another author or epoch fails to decrypt. Throws on any failure,
 * including a structurally malformed plaintext.
 */
export function openScopedPost(record: ScopedPostRecord, epochKey: Uint8Array): ScopedPostPlaintext {
  if (record.v !== 1 || record.alg !== DM_ALG) throw new Error(`unsupported scoped-post alg: v${record.v} ${record.alg}`);
  const plainBytes = xchacha20poly1305(epochKey, b64url.decode(record.nonce), headerAad(record)).decrypt(
    b64url.decode(record.ciphertext),
  );
  const plaintext = JSON.parse(new TextDecoder().decode(plainBytes)) as ScopedPostPlaintext;
  if (typeof plaintext.body !== "string") throw new Error("malformed scoped-post plaintext");
  return plaintext;
}

/**
 * Concrete scope enumeration (§5.1), client authority — the server never
 * validates that a fan-out matches the named scope. `follows` is the
 * author's hop-1 follow list MINUS any account the author currently mutes
 * (design §7.1: a mute is a membership-removal event — a muted-but-followed
 * account gets no scoped posts, in either scope; `view.mutes` is the same
 * mute source `trustMap` reads, so both scopes agree on who's muted). `web`
 * is every account within the hop cap whose trust from the author's vantage
 * clears `feed_surface_threshold`, computed via the published `trustMap`
 * (never reimplemented here) — which already excludes muted accounts and
 * prunes propagation through them. Pre-M7 standing is uniformly 1.0, so
 * subjective trust and effective trust coincide; once standing varies,
 * callers passing a `graph`/`constants` pair with standing baked in stay
 * compatible, but that plumbing is out of scope for M5.
 * Returns account ids sorted ascending, excluding the author (the author is
 * always added as a member via their own epoch-key self-grant, never via
 * scope). Throws on any source other than the v1 non-reserved values
 * (`"roster"` and future sources are reserved — §5.1).
 */
export function enumerateScope(
  view: GraphView,
  author: string,
  source: string,
  constants: TrustConstants = CONSTANTS,
): string[] {
  if (source === "follows") {
    const muted = new Set(view.mutes ?? []);
    const set = new Set(view.follows[author] ?? []);
    set.delete(author);
    for (const m of muted) set.delete(m);
    return [...set].sort();
  }
  if (source === "web") {
    const map = trustMap(author, view, constants);
    return Object.entries(map)
      .filter(([id, trust]) => id !== author && trust >= constants.feed_surface_threshold)
      .map(([id]) => id)
      .sort();
  }
  throw new Error(`unknown or reserved scope source: ${source}`);
}

/**
 * Rotation predicate (§5.5, normative, client-driven): the client MUST
 * mint a new epoch before sealing a post if the concrete scope set has
 * changed since the epoch's last distribution, or the epoch has aged past
 * `epoch_max_age_days`. `nowIso` is a parameter, never `Date.now()`
 * (determinism rule) — callers supply the client's current time.
 */
export function needsRotation(opts: {
  createdAt: string; // the epoch record's created_at
  currentMembers: readonly string[]; // freshly recomputed concrete scope set (+ author)
  frozenMembers: readonly string[]; // the epoch's actual fan-out membership
  nowIso: string;
  constants?: { epoch_max_age_days: number };
}): boolean {
  const constants = opts.constants ?? CONSTANTS;
  const current = new Set(opts.currentMembers);
  const frozen = new Set(opts.frozenMembers);
  const setsDiffer =
    current.size !== frozen.size || [...current].some((m) => !frozen.has(m));
  const ageMs = Date.parse(opts.nowIso) - Date.parse(opts.createdAt);
  if (!Number.isFinite(ageMs)) throw new Error("createdAt/nowIso must be valid RFC 3339 timestamps");
  const maxAgeMs = constants.epoch_max_age_days * 24 * 60 * 60 * 1000;
  return setsDiffer || ageMs > maxAgeMs;
}
