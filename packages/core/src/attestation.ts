/**
 * Attestation & verification (docs/protocol.md §8, design §7.3): a public,
 * device-signed, explicit edge — "I verified this key" — always separate from
 * follows. TOFU everywhere: nothing here gates any capability; attestation
 * changes displayed confidence only.
 */
import { sha256 } from "@noble/hashes/sha256";
import { b64url, utf8 } from "./encoding.js";
import { verifySignature, type RunaRecord } from "./records.js";

export const ATTESTATION_METHODS = ["qr", "safety-number", "domain-proof"] as const;
export type AttestationMethod = (typeof ATTESTATION_METHODS)[number];

export interface AttestationRecord extends RunaRecord {
  type: "attestation";
  subject: string; // account id whose key was verified
  subject_root_pub: string; // must equal subject byte-for-byte (§8.1)
  method: AttestationMethod;
}

export interface AttestationRevokeRecord extends RunaRecord {
  type: "attestation-revoke";
  subject: string;
}

export interface DomainClaimRecord extends RunaRecord {
  type: "domain-claim";
  domain: string; // lowercase registrable hostname, no scheme/port/path (§8.4)
}

function assertAccountId(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  let bytes: Uint8Array;
  try {
    bytes = b64url.decode(value);
  } catch {
    throw new Error(`${field} is not valid base64url`);
  }
  if (bytes.length !== 32) throw new Error(`${field} must decode to 32 bytes`);
}

export function verifyAttestation(rec: AttestationRecord): void {
  if (rec.type !== "attestation") throw new Error("not an attestation");
  assertAccountId(rec.subject, "subject");
  if (rec.subject_root_pub !== rec.subject) {
    throw new Error("subject_root_pub must equal subject");
  }
  if (!ATTESTATION_METHODS.includes(rec.method as AttestationMethod)) {
    throw new Error(`unknown attestation method: ${rec.method}`);
  }
  if (rec.author === rec.subject) throw new Error("self-attestation is not allowed");
  verifySignature(rec);
}

export function verifyAttestationRevoke(rec: AttestationRevokeRecord): void {
  if (rec.type !== "attestation-revoke") throw new Error("not an attestation-revoke");
  assertAccountId(rec.subject, "subject");
  verifySignature(rec);
}

// Two or more labels of [a-z0-9-], no leading/trailing hyphen, ≤63 chars each.
const DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function verifyDomainClaim(rec: DomainClaimRecord): void {
  if (rec.type !== "domain-claim") throw new Error("not a domain-claim");
  if (typeof rec.domain !== "string" || !DOMAIN_RE.test(rec.domain)) {
    throw new Error("domain must be a lowercase registrable hostname");
  }
  verifySignature(rec);
}

/**
 * Latest-wins reduction per (author, subject), as follow/unfollow: an
 * attestation is active unless the same author later revoked it. A revoke
 * with created_at equal to the attestation's wins the tie (as device
 * revocation does in certs.ts). Records are assumed already verified; this
 * is pure state reduction. Returns one active attestation per author (the
 * newest), most recent first, author id as tiebreaker.
 */
export function activeAttestations(
  subject: string,
  attestations: AttestationRecord[],
  revokes: AttestationRevokeRecord[] = [],
): AttestationRecord[] {
  const newestByAuthor = new Map<string, AttestationRecord>();
  for (const a of attestations) {
    if (a.subject !== subject) continue;
    const prev = newestByAuthor.get(a.author);
    if (!prev || a.created_at > prev.created_at) newestByAuthor.set(a.author, a);
  }
  const out: AttestationRecord[] = [];
  for (const a of newestByAuthor.values()) {
    const revoked = revokes.some(
      (r) => r.subject === subject && r.author === a.author && r.created_at >= a.created_at,
    );
    if (!revoked) out.push(a);
  }
  out.sort((x, y) =>
    x.created_at === y.created_at
      ? x.author < y.author
        ? -1
        : 1
      : x.created_at > y.created_at
        ? -1
        : 1,
  );
  return out;
}

/** Fingerprint (§2): SHA-256 of the root pubkey bytes (decoded account id). */
export function fingerprint(accountId: string): Uint8Array {
  const pub = b64url.decode(accountId);
  if (pub.length !== 32) throw new Error("account id must decode to 32 bytes");
  return sha256(pub);
}

/** Display form of a fingerprint: lowercase hex in 8 groups of 8. */
export function renderFingerprint(fp: Uint8Array): string {
  const hex = Array.from(fp, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{8}/g)!.join(" ");
}

/**
 * Pairwise safety number (§8.2): symmetric 60-digit comparison string for two
 * account ids, 12 zero-padded 5-digit groups joined by single spaces.
 */
export function safetyNumber(idA: string, idB: string): string {
  const pair = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
  const h0 = sha256(utf8(`runa/v1/safety-number:0:${pair}`));
  const h1 = sha256(utf8(`runa/v1/safety-number:1:${pair}`));
  const bytes = new Uint8Array(64);
  bytes.set(h0, 0);
  bytes.set(h1, 32);
  const groups: string[] = [];
  for (let k = 0; k < 12; k++) {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 256 + (bytes[5 * k + i] ?? 0);
    groups.push(String(value % 100000).padStart(5, "0"));
  }
  return groups.join(" ");
}
