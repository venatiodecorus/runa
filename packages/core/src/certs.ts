/**
 * Device certificates & revocations (docs/protocol.md §§2–3): root signs
 * exactly these; devices do everything else. A device-signed record is
 * trustworthy only if (a) its own signature verifies and (b) the device is
 * bound to the author's root by a valid, unrevoked cert.
 */
import { verifySignature, type RunaRecord } from "./records.js";

export interface DeviceCert extends RunaRecord {
  type: "device-cert";
  device_sign_pub: string;
  device_kex_pub: string;
  name?: string;
}

export interface DeviceRevoke extends RunaRecord {
  type: "device-revoke";
  device_sign_pub: string;
}

export function verifyDeviceCert(cert: DeviceCert, expectedAuthor?: string): void {
  if (cert.type !== "device-cert") throw new Error("not a device-cert");
  if (typeof cert.device_sign_pub !== "string" || typeof cert.device_kex_pub !== "string") {
    throw new Error("device-cert missing device keys");
  }
  if (expectedAuthor !== undefined && cert.author !== expectedAuthor) {
    throw new Error("device-cert author mismatch");
  }
  verifySignature(cert);
}

export function verifyDeviceRevoke(rev: DeviceRevoke, expectedAuthor?: string): void {
  if (rev.type !== "device-revoke") throw new Error("not a device-revoke");
  if (typeof rev.device_sign_pub !== "string") throw new Error("device-revoke missing device key");
  if (expectedAuthor !== undefined && rev.author !== expectedAuthor) {
    throw new Error("device-revoke author mismatch");
  }
  verifySignature(rev);
}

/**
 * Verify that a device-signed record's device is bound to its author:
 * a valid cert for record.device signed by record.author exists, and no
 * revocation of that device predates the record (created_at <= record's).
 * RFC 3339 UTC strings at fixed precision compare correctly as strings.
 */
export function verifyDeviceBinding(
  record: RunaRecord,
  certs: DeviceCert[],
  revocations: DeviceRevoke[] = [],
): void {
  if (record.device === undefined) throw new Error("record has no device field");
  const cert = certs.find(
    (c) => c.device_sign_pub === record.device && c.author === record.author,
  );
  if (!cert) throw new Error("no device-cert binds this device to the author");
  verifyDeviceCert(cert, record.author);
  for (const rev of revocations) {
    if (rev.device_sign_pub !== record.device || rev.author !== record.author) continue;
    verifyDeviceRevoke(rev, record.author);
    if (rev.created_at <= record.created_at) {
      throw new Error("device was revoked before this record");
    }
  }
}

/** Full verification of a device-signed record: own signature + binding. */
export function verifyAuthoredRecord(
  record: RunaRecord,
  certs: DeviceCert[],
  revocations: DeviceRevoke[] = [],
): void {
  verifySignature(record);
  verifyDeviceBinding(record, certs, revocations);
}
