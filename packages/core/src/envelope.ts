/**
 * Tier-2 envelope v1 (docs/protocol.md §4): stateless hybrid encryption to
 * every recipient *device*. Chosen over double ratchet for v1 because browser
 * storage loss is routine (design §7.1); `v`/`alg` make ratchet a versioned
 * upgrade later.
 *
 * The envelope is a `dm` record, signed by the sender's device key like any
 * record. Signature verification (verifyAuthoredRecord) is REQUIRED before
 * rendering — encryption without it is spoofable ciphertext. The AEAD binds
 * the envelope header as AAD, and the plaintext carries the conversation id,
 * preventing cross-conversation replay.
 */
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { b64url, utf8 } from "./encoding.js";
import { canonicalize } from "./jcs.js";
import { signRecord, type RunaRecord } from "./records.js";

export const DM_ALG = "x25519-hkdf-sha256+xchacha20poly1305";
const WRAP_INFO = "runa/v1/dm-wrap";

export interface DmRecipientEntry {
  device: string; // recipient device id (signing pubkey b64url) — lookup key
  eph_pub: string;
  wrap_nonce: string;
  wrapped_key: string;
}

export interface DmRecord extends RunaRecord {
  type: "dm";
  alg: typeof DM_ALG;
  to: string;
  nonce: string;
  recipients: DmRecipientEntry[];
  ciphertext: string;
}

export interface DmPlaintext {
  body: string;
  /** Sorted participant account ids joined by ":" — replay binding. */
  conversation: string;
}

export interface SealRecipient {
  /** Recipient device id (device_sign_pub from their cert) — routing key. */
  device: string;
  /** That device's X25519 kex pubkey (device_kex_pub from their cert). */
  kexPub: Uint8Array;
}

export function conversationId(participants: string[]): string {
  return [...participants].sort().join(":");
}

/** Header = the envelope minus recipients/ciphertext/sig; its canonical bytes are the AAD. */
function headerAad(record: Record<string, unknown>): Uint8Array {
  const { recipients: _r, ciphertext: _c, sig: _s, ...header } = record;
  return utf8(canonicalize(header));
}

export function sealDm(opts: {
  body: string;
  participants: string[]; // account ids incl. sender's
  to: string; // recipient account id (mailbox routing)
  author: string;
  device: string; // sender device id
  deviceSignSeed: Uint8Array;
  createdAt: string;
  recipients: SealRecipient[]; // ALL devices of BOTH participants (protocol §4)
  random?: (n: number) => Uint8Array; // injectable for deterministic vectors
}): DmRecord {
  const random = opts.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const contentKey = random(32);
  const nonce = random(24);
  const unsigned: Record<string, unknown> = {
    v: 1,
    type: "dm",
    alg: DM_ALG,
    author: opts.author,
    device: opts.device,
    created_at: opts.createdAt,
    to: opts.to,
    nonce: b64url.encode(nonce),
  };
  const plaintext: DmPlaintext = { body: opts.body, conversation: conversationId(opts.participants) };
  const ciphertext = xchacha20poly1305(contentKey, nonce, headerAad(unsigned)).encrypt(
    utf8(JSON.stringify(plaintext)),
  );

  const recipients: DmRecipientEntry[] = opts.recipients.map((r) => {
    const ephPriv = random(32);
    const ephPub = x25519.getPublicKey(ephPriv);
    const shared = x25519.getSharedSecret(ephPriv, r.kexPub);
    const wrapKey = hkdf(sha256, shared, concat(ephPub, r.kexPub), WRAP_INFO, 32);
    const wrapNonce = random(24);
    const wrapped = xchacha20poly1305(wrapKey, wrapNonce).encrypt(contentKey);
    return {
      device: r.device,
      eph_pub: b64url.encode(ephPub),
      wrap_nonce: b64url.encode(wrapNonce),
      wrapped_key: b64url.encode(wrapped),
    };
  });

  return signRecord(
    { ...unsigned, recipients, ciphertext: b64url.encode(ciphertext) } as Omit<RunaRecord, "sig">,
    opts.deviceSignSeed,
  ) as DmRecord;
}

/**
 * Decrypt an envelope as one recipient device. Callers MUST have verified the
 * record signature + cert chain first (verifyAuthoredRecord) and MUST check
 * `conversation` matches the participants they believe they're talking to.
 * Any failure throws — decryption failures render as hard errors, never as
 * content.
 */
export function openDm(record: DmRecord, device: { deviceId: string; kexSeed: Uint8Array }): DmPlaintext {
  if (record.v !== 1 || record.alg !== DM_ALG) throw new Error(`unsupported envelope: v${record.v} ${record.alg}`);
  const entry = record.recipients.find((r) => r.device === device.deviceId);
  if (!entry) throw new Error("this device is not a recipient");
  const ephPub = b64url.decode(entry.eph_pub);
  const shared = x25519.getSharedSecret(device.kexSeed, ephPub);
  const kexPub = x25519.getPublicKey(device.kexSeed);
  const wrapKey = hkdf(sha256, shared, concat(ephPub, kexPub), WRAP_INFO, 32);
  const contentKey = xchacha20poly1305(wrapKey, b64url.decode(entry.wrap_nonce)).decrypt(
    b64url.decode(entry.wrapped_key),
  );
  const plainBytes = xchacha20poly1305(contentKey, b64url.decode(record.nonce), headerAad(record)).decrypt(
    b64url.decode(record.ciphertext),
  );
  const plaintext = JSON.parse(new TextDecoder().decode(plainBytes)) as DmPlaintext;
  if (typeof plaintext.body !== "string" || typeof plaintext.conversation !== "string") {
    throw new Error("malformed dm plaintext");
  }
  return plaintext;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
