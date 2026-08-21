/**
 * Recipient-set enumeration for tier-2 DMs (docs/protocol.md §4): the seal
 * targets are ALL certified, unrevoked devices of BOTH participants — the
 * sender's other devices are recipients too, so the whole conversation stays
 * readable across the sender's own devices.
 *
 * Pure functions over AccountInfo-shaped inputs — no fetch, no React — so the
 * exclusion rules are directly testable.
 */
import {
  b64url,
  verifyDeviceCert,
  verifyDeviceRevoke,
  type DeviceCert,
  type DeviceRevoke,
  type SealRecipient,
} from "@runa/core";

/** The slice of GET /accounts/{id} the recipient computation needs. */
export interface DmParty {
  account: string;
  device_certs: DeviceCert[];
  device_revocations: DeviceRevoke[];
}

/**
 * One participant's sealable devices: every device with a valid root-signed
 * cert and NO valid revocation. A revoked device is excluded outright — we
 * are sealing a NEW message, so any revocation (whenever issued) disqualifies
 * the device. Certs that fail verification are skipped: we never encrypt to a
 * key the account's root did not sign for.
 */
export function partyDevices(party: DmParty): SealRecipient[] {
  const revoked = new Set<string>();
  for (const rev of party.device_revocations) {
    try {
      verifyDeviceRevoke(rev, party.account);
      revoked.add(rev.device_sign_pub);
    } catch {
      // invalid revocation record: ignore it (it revokes nothing)
    }
  }
  const out: SealRecipient[] = [];
  const seen = new Set<string>();
  for (const cert of party.device_certs) {
    if (seen.has(cert.device_sign_pub) || revoked.has(cert.device_sign_pub)) continue;
    try {
      verifyDeviceCert(cert, party.account);
    } catch {
      continue; // unverifiable cert — never a seal target
    }
    seen.add(cert.device_sign_pub);
    out.push({ device: cert.device_sign_pub, kexPub: b64url.decode(cert.device_kex_pub) });
  }
  return out;
}

/**
 * Full seal target list for a DM from `sender` to `recipient`.
 *
 * `senderCert` (the session's own device-cert) is merged into the sender's
 * cert list in case the server's view lags the just-enrolled device; it goes
 * through the same verify/revocation filter as everything else.
 *
 * Throws if the recipient has zero certified, unrevoked devices — a message
 * nobody could ever read must not be sent.
 */
export function dmRecipientSet(
  sender: DmParty,
  recipient: DmParty,
  senderCert?: DeviceCert,
): SealRecipient[] {
  const senderParty: DmParty =
    senderCert !== undefined &&
    !sender.device_certs.some((c) => c.device_sign_pub === senderCert.device_sign_pub)
      ? { ...sender, device_certs: [...sender.device_certs, senderCert] }
      : sender;

  const recipientDevices = partyDevices(recipient);
  if (recipientDevices.length === 0) {
    throw new Error(
      "recipient has no certified, unrevoked devices — refusing to send an unreadable message",
    );
  }

  const out: SealRecipient[] = [];
  const seen = new Set<string>();
  for (const r of [...partyDevices(senderParty), ...recipientDevices]) {
    if (seen.has(r.device)) continue; // self-DM: same account on both sides
    seen.add(r.device);
    out.push(r);
  }
  return out;
}
