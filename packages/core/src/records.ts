/**
 * Signed records (docs/protocol.md §3): JCS-canonical JSON with detached
 * base64url Ed25519 signatures. Root-signed records (device-cert,
 * device-revoke) carry no `device` field; everything else is device-signed.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { b64url, utf8 } from "./encoding.js";
import { canonicalize, assertNoFloats } from "./jcs.js";

export const PROTOCOL_V = 1;

export interface RunaRecord {
  v: number;
  type: string;
  author: string; // account id = b64url(root pubkey)
  device?: string; // b64url(device signing pubkey); absent on root-signed records
  created_at: string; // RFC 3339 UTC, second precision, Z suffix
  sig?: string;
  [field: string]: unknown;
}

/** Record types signed directly by the root key. */
export const ROOT_SIGNED_TYPES = new Set(["device-cert", "device-revoke"]);

const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function nowTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Canonical signing bytes: the record minus `sig`, JCS-canonicalized. */
export function signingBytes(record: RunaRecord): Uint8Array {
  const { sig: _sig, ...rest } = record;
  assertNoFloats(rest);
  return utf8(canonicalize(rest));
}

export function signRecord(record: Omit<RunaRecord, "sig">, privateKey: Uint8Array): RunaRecord {
  const sig = ed25519.sign(signingBytes(record as RunaRecord), privateKey);
  return { ...record, sig: b64url.encode(sig) } as RunaRecord;
}

/** Structural validation of the common fields. Throws with a reason. */
export function validateShape(record: RunaRecord): void {
  if (record.v !== PROTOCOL_V) throw new Error(`unknown record version: ${record.v}`);
  if (typeof record.type !== "string" || record.type.length === 0) throw new Error("missing type");
  decodeKey(record.author, "author");
  const rootSigned = ROOT_SIGNED_TYPES.has(record.type);
  if (rootSigned && record.device !== undefined) {
    throw new Error(`${record.type} must be root-signed (no device field)`);
  }
  if (!rootSigned) decodeKey(record.device as string, "device");
  if (typeof record.created_at !== "string" || !CREATED_AT_RE.test(record.created_at)) {
    throw new Error("created_at must be RFC 3339 UTC with Z suffix, second precision");
  }
  if (typeof record.sig !== "string") throw new Error("missing sig");
  assertNoFloats(record);
}

function decodeKey(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  let bytes: Uint8Array;
  try {
    bytes = b64url.decode(value);
  } catch {
    throw new Error(`${field} is not valid base64url`);
  }
  if (bytes.length !== 32) throw new Error(`${field} must decode to 32 bytes`);
  return bytes;
}

/**
 * Verify the record's own signature (shape + Ed25519). Root-signed records
 * verify against `author`; device-signed records verify against `device` —
 * whether that device is certified by the author's root is a separate step
 * (verifyDeviceBinding in certs.ts), and both are required before trusting
 * a device-signed record.
 */
export function verifySignature(record: RunaRecord): void {
  validateShape(record);
  const signerKey = ROOT_SIGNED_TYPES.has(record.type)
    ? decodeKey(record.author, "author")
    : decodeKey(record.device, "device");
  const ok = ed25519.verify(b64url.decode(record.sig!), signingBytes(record), signerKey);
  if (!ok) throw new Error("signature verification failed");
}

/** Content-addressed record ID: b64url(SHA-256(canonical bytes incl. sig)). */
export function recordId(record: RunaRecord): string {
  assertNoFloats(record);
  return b64url.encode(sha256(utf8(canonicalize(record))));
}
