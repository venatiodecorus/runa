/**
 * Device snapshot: a DEV/TEST-ONLY export of a complete working set — root
 * seed, device seeds, and the device's cert — so a browser can act as an
 * EXISTING device instead of enrolling a new one. Importing one restores
 * access to tier-2/3 ciphertext addressed to that device, which normal
 * recovery deliberately does not (design §7.2: recovery restores identity,
 * not history).
 *
 * Not part of the protocol (nothing here touches the wire — protocol §7's
 * recovery kit carries the root only, by design): this is a client-local
 * convenience the seed script emits into the gitignored testKeys/ dir.
 * A snapshot contains PRIVATE key material including the root seed — never
 * produce one for a real account.
 *
 * Framework-free: no React, no DOM.
 */
import { b64url, verifyDeviceCert, type DeviceCert } from "@runa/core";
import { deviceFromSeeds, rootFromSeed, type DeviceKeys, type RootKey } from "./keys.js";

export interface DeviceSnapshot {
  v: 1;
  kind: "runa-device-snapshot";
  account: string;
  root_seed: string; // b64url 32 bytes
  device_sign_seed: string; // b64url 32 bytes
  device_kex_seed: string; // b64url 32 bytes
  cert: DeviceCert;
  created_at: string;
}

export interface ParsedSnapshot {
  root: RootKey;
  device: DeviceKeys;
  cert: DeviceCert;
}

export function buildDeviceSnapshot(
  root: RootKey,
  device: DeviceKeys,
  cert: DeviceCert,
  createdAt: string,
): DeviceSnapshot {
  return {
    v: 1,
    kind: "runa-device-snapshot",
    account: root.account,
    root_seed: b64url.encode(root.seed),
    device_sign_seed: b64url.encode(device.signSeed),
    device_kex_seed: b64url.encode(device.kexSeed),
    cert,
    created_at: createdAt,
  };
}

/** Cheap sniff so the recover flow can route a pasted/uploaded JSON file. */
export function looksLikeDeviceSnapshot(json: string): boolean {
  try {
    return (JSON.parse(json) as { kind?: unknown }).kind === "runa-device-snapshot";
  } catch {
    return false;
  }
}

function decodeSeed(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string") throw new Error(`snapshot missing ${field}`);
  let bytes: Uint8Array;
  try {
    bytes = b64url.decode(value);
  } catch {
    throw new Error(`${field} is not valid base64url`);
  }
  if (bytes.length !== 32) throw new Error(`${field} must be 32 bytes`);
  return bytes;
}

/**
 * Parse + validate a snapshot JSON string. Everything is recomputed and
 * cross-checked (as parseKeyFile does): the account id from the root seed,
 * the device id from the device seeds against the cert's device_sign_pub,
 * and the cert's root signature — a corrupted or mixed-up file must not
 * silently yield a working set that contradicts itself.
 */
export function parseDeviceSnapshot(json: string): ParsedSnapshot {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("not valid JSON");
  }
  const ds = obj as Partial<DeviceSnapshot>;
  if (ds.v !== 1) throw new Error(`unknown snapshot version: ${String(ds.v)}`);
  if (ds.kind !== "runa-device-snapshot") throw new Error("not a runa device snapshot");
  const root = rootFromSeed(decodeSeed(ds.root_seed, "root_seed"));
  if (typeof ds.account === "string" && ds.account !== root.account) {
    throw new Error("snapshot account does not match its root seed");
  }
  const device = deviceFromSeeds(
    decodeSeed(ds.device_sign_seed, "device_sign_seed"),
    decodeSeed(ds.device_kex_seed, "device_kex_seed"),
  );
  if (typeof ds.cert !== "object" || ds.cert === null) throw new Error("snapshot missing cert");
  const cert = ds.cert as DeviceCert;
  verifyDeviceCert(cert, root.account);
  if (cert.device_sign_pub !== device.deviceId) {
    throw new Error("snapshot cert does not certify the snapshot's device keys");
  }
  if (cert.device_kex_pub !== device.kexPubB64) {
    throw new Error("snapshot cert kex key does not match the snapshot's device keys");
  }
  return { root, device, cert };
}
