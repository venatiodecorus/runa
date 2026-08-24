/**
 * Key continuity pins (docs/protocol.md §8.3): a pin is the sorted list of
 * certified, unrevoked device ids last seen for a contact — taken at
 * attestation time or the last tier-2 send. A later device set that gained
 * ids not in the pin is the "new device" signal the DM composer warns
 * about. NEVER blocks sending (TOFU, architecture invariant 6) — the
 * warning is click-through information; a successful send (or a confirmed
 * "trust their new devices") always re-pins.
 *
 * Framework-free: diff logic is pure and unit-testable without IndexedDB;
 * the kv-backed load/save wrappers are thin and isolated at the bottom,
 * keyed per contact (`pin:v1:<account>`) as the dm/requests.ts pattern does.
 */
import type { DeviceCert, DeviceRevoke } from "@runa/core";
import { kvGet, kvSet } from "../store/db.js";

/** Sorted, deduplicated device ids — sorted so comparisons are order-independent. */
export type Pin = string[];

/** Certified, unrevoked device ids for one account (protocol §3 cert-binding rules). */
export function currentDeviceIds(certs: DeviceCert[], revocations: DeviceRevoke[]): Pin {
  const revoked = new Set(revocations.map((r) => r.device_sign_pub));
  const ids = new Set(certs.map((c) => c.device_sign_pub).filter((id) => !revoked.has(id)));
  return [...ids].sort();
}

export interface PinDiff {
  /** No pin exists yet for this contact — first conversation, TOFU: pin
   *  silently on first send, never warn. */
  firstContact: boolean;
  /** Device ids present now that were absent from the stored pin. */
  newDevices: string[];
}

/** Pure diff: the contact's current device set vs. the stored pin (`undefined` = none yet). */
export function diffPin(current: Pin, stored: Pin | undefined): PinDiff {
  if (stored === undefined) return { firstContact: true, newDevices: [] };
  const storedSet = new Set(stored);
  return { firstContact: false, newDevices: current.filter((id) => !storedSet.has(id)) };
}

// --- kv storage ---------------------------------------------------------------

const KEY_PREFIX = "pin:v1:";

export async function loadPin(contact: string): Promise<Pin | undefined> {
  return kvGet<Pin>(KEY_PREFIX + contact);
}

export async function savePin(contact: string, pin: Pin): Promise<void> {
  await kvSet(KEY_PREFIX + contact, pin);
}

/** Convenience: pin a contact directly from a fetched cert bundle (re-pin on
 *  send, on "trust new devices", or after publishing an attestation of them). */
export async function repinFromCerts(
  contact: string,
  certs: DeviceCert[],
  revocations: DeviceRevoke[],
): Promise<void> {
  await savePin(contact, currentDeviceIds(certs, revocations));
}
