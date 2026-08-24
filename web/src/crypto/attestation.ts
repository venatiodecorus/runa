/**
 * Attestation & domain-claim records (docs/protocol.md §8): device-signed
 * `attestation` / `attestation-revoke` / `domain-claim`. Mirrors the
 * crypto/graph.ts pattern — build the record, sign with the current device,
 * post through the shared /records path.
 *
 * Framework-free: no React, no DOM.
 */
import {
  nowTimestamp,
  signRecord,
  type AttestationMethod,
  type AttestationRecord,
  type AttestationRevokeRecord,
  type DomainClaimRecord,
} from "@runa/core";
import type { DeviceKeys } from "./keys.js";

type SigningDevice = Pick<DeviceKeys, "deviceId" | "signSeed">;

/** Build + device-sign an `attestation` record (§8.1). `subject_root_pub` is
 *  required to equal `subject` byte-for-byte — the account id already *is*
 *  the base64url root pubkey, so it is simply repeated. */
export function buildAttestation(
  author: string,
  device: SigningDevice,
  subject: string,
  method: AttestationMethod,
  createdAt: string = nowTimestamp(),
): AttestationRecord {
  return signRecord(
    {
      v: 1,
      type: "attestation",
      author,
      device: device.deviceId,
      created_at: createdAt,
      subject,
      subject_root_pub: subject,
      method,
    },
    device.signSeed,
  ) as AttestationRecord;
}

/** Build + device-sign an `attestation-revoke` record withdrawing `subject`. */
export function buildAttestationRevoke(
  author: string,
  device: SigningDevice,
  subject: string,
  createdAt: string = nowTimestamp(),
): AttestationRevokeRecord {
  return signRecord(
    {
      v: 1,
      type: "attestation-revoke",
      author,
      device: device.deviceId,
      created_at: createdAt,
      subject,
    },
    device.signSeed,
  ) as AttestationRevokeRecord;
}

/** Build + device-sign a `domain-claim` record (§8.4). `domain` should
 *  already be normalized (lowercase, no scheme/port/path) by the caller. */
export function buildDomainClaim(
  author: string,
  device: SigningDevice,
  domain: string,
  createdAt: string = nowTimestamp(),
): DomainClaimRecord {
  return signRecord(
    {
      v: 1,
      type: "domain-claim",
      author,
      device: device.deviceId,
      created_at: createdAt,
      domain,
    },
    device.signSeed,
  ) as DomainClaimRecord;
}
