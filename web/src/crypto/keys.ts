/**
 * Key generation & root-signed records (docs/protocol.md §2).
 *
 * - Root: Ed25519 keypair from a 32-byte seed; account id = b64url(pubkey).
 *   Signs ONLY device-certs and device-revokes, never content.
 * - Device: Ed25519 signing pair + X25519 kex pair, random seeds.
 *   Device id = b64url(device signing pubkey).
 *
 * Framework-free: no React, no DOM beyond WebCrypto's getRandomValues.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519";
import {
  b64url,
  utf8,
  nowTimestamp,
  signRecord,
  type DeviceCert,
  type DeviceRevoke,
} from "@runa/core";

export interface RootKey {
  /** 32-byte Ed25519 seed — the value the recovery kit encodes. */
  seed: Uint8Array;
  publicKey: Uint8Array;
  /** Account id = b64url(publicKey), 43 chars. */
  account: string;
}

export interface DeviceKeys {
  /** 32-byte Ed25519 signing seed (private). */
  signSeed: Uint8Array;
  /** 32-byte X25519 key-agreement seed (private). */
  kexSeed: Uint8Array;
  signPub: Uint8Array;
  kexPub: Uint8Array;
  /** Device id = b64url(signPub). */
  deviceId: string;
  /** b64url(kexPub). */
  kexPubB64: string;
}

export function generateRootSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function rootFromSeed(seed: Uint8Array): RootKey {
  if (seed.length !== 32) throw new Error("root seed must be 32 bytes");
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, account: b64url.encode(publicKey) };
}

export function deviceFromSeeds(signSeed: Uint8Array, kexSeed: Uint8Array): DeviceKeys {
  if (signSeed.length !== 32 || kexSeed.length !== 32) {
    throw new Error("device seeds must be 32 bytes");
  }
  const signPub = ed25519.getPublicKey(signSeed);
  const kexPub = x25519.getPublicKey(kexSeed);
  return {
    signSeed,
    kexSeed,
    signPub,
    kexPub,
    deviceId: b64url.encode(signPub),
    kexPubB64: b64url.encode(kexPub),
  };
}

export function generateDeviceKeys(): DeviceKeys {
  return deviceFromSeeds(
    crypto.getRandomValues(new Uint8Array(32)),
    crypto.getRandomValues(new Uint8Array(32)),
  );
}

/** Build + root-sign a device-cert record binding `device` to `root`. */
export function buildDeviceCert(
  root: RootKey,
  device: DeviceKeys,
  name?: string,
  createdAt: string = nowTimestamp(),
): DeviceCert {
  return signRecord(
    {
      v: 1,
      type: "device-cert",
      author: root.account,
      created_at: createdAt,
      device_sign_pub: device.deviceId,
      device_kex_pub: device.kexPubB64,
      ...(name !== undefined && name !== "" ? { name } : {}),
    },
    root.seed,
  ) as DeviceCert;
}

/** Build + root-sign a device-revoke record for a device signing pubkey. */
export function buildDeviceRevoke(
  root: RootKey,
  deviceSignPub: string,
  createdAt: string = nowTimestamp(),
): DeviceRevoke {
  return signRecord(
    {
      v: 1,
      type: "device-revoke",
      author: root.account,
      created_at: createdAt,
      device_sign_pub: deviceSignPub,
    },
    root.seed,
  ) as DeviceRevoke;
}

export const AUTH_CONTEXT = "runa-auth-v1:";

/**
 * Sign a server auth challenge with the device signing key
 * (protocol §6: Ed25519 over utf8("runa-auth-v1:" + challenge)).
 */
export function signAuthChallenge(deviceSignSeed: Uint8Array, challenge: string): string {
  return b64url.encode(ed25519.sign(utf8(AUTH_CONTEXT + challenge), deviceSignSeed));
}
