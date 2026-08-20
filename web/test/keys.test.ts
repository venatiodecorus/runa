import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import {
  b64url,
  utf8,
  nowTimestamp,
  signRecord,
  verifyDeviceCert,
  verifyDeviceRevoke,
  verifyAuthoredRecord,
} from "@runa/core";
import {
  AUTH_CONTEXT,
  buildDeviceCert,
  buildDeviceRevoke,
  deviceFromSeeds,
  generateDeviceKeys,
  generateRootSeed,
  rootFromSeed,
  signAuthChallenge,
} from "../src/crypto/keys.js";

const SEED = hexToBytes("11".repeat(32));

describe("root key", () => {
  it("derives deterministically from a seed", () => {
    const a = rootFromSeed(SEED);
    const b = rootFromSeed(hexToBytes("11".repeat(32)));
    expect(a.account).toBe(b.account);
    expect(a.account).toHaveLength(43); // b64url of 32 bytes, no padding
    expect(b64url.decode(a.account)).toEqual(a.publicKey);
  });

  it("rejects seeds that are not 32 bytes", () => {
    expect(() => rootFromSeed(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it("generates 32-byte random seeds", () => {
    const s1 = generateRootSeed();
    const s2 = generateRootSeed();
    expect(s1).toHaveLength(32);
    expect(b64url.encode(s1)).not.toBe(b64url.encode(s2));
  });
});

describe("device keys", () => {
  it("derives deterministically from seeds and ids are b64url pubkeys", () => {
    const d1 = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
    const d2 = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
    expect(d1.deviceId).toBe(d2.deviceId);
    expect(d1.kexPubB64).toBe(d2.kexPubB64);
    expect(d1.deviceId).toHaveLength(43);
    expect(b64url.decode(d1.kexPubB64)).toHaveLength(32);
  });

  it("generates distinct random devices", () => {
    expect(generateDeviceKeys().deviceId).not.toBe(generateDeviceKeys().deviceId);
  });
});

describe("device-cert / device-revoke", () => {
  const root = rootFromSeed(SEED);
  const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));

  it("builds a root-signed cert that verifies", () => {
    const cert = buildDeviceCert(root, device, "test device", "2026-08-20T12:00:00Z");
    expect(cert.device).toBeUndefined(); // root-signed: no device field
    expect(cert.device_sign_pub).toBe(device.deviceId);
    expect(cert.device_kex_pub).toBe(device.kexPubB64);
    expect(cert.name).toBe("test device");
    expect(() => verifyDeviceCert(cert, root.account)).not.toThrow();
  });

  it("omits name when not given", () => {
    const cert = buildDeviceCert(root, device, undefined, "2026-08-20T12:00:00Z");
    expect("name" in cert).toBe(false);
  });

  it("certifies a device that can then author verifiable records", () => {
    const cert = buildDeviceCert(root, device, undefined, "2026-08-20T12:00:00Z");
    const post = signRecord(
      {
        v: 1,
        type: "post",
        author: root.account,
        device: device.deviceId,
        created_at: "2026-08-20T13:00:00Z",
        body: "hello",
      },
      device.signSeed,
    );
    expect(() => verifyAuthoredRecord(post, [cert], [])).not.toThrow();
  });

  it("revocation verifies and invalidates later records", () => {
    const cert = buildDeviceCert(root, device, undefined, "2026-08-20T12:00:00Z");
    const revoke = buildDeviceRevoke(root, device.deviceId, "2026-08-20T14:00:00Z");
    expect(() => verifyDeviceRevoke(revoke, root.account)).not.toThrow();
    const late = signRecord(
      {
        v: 1,
        type: "post",
        author: root.account,
        device: device.deviceId,
        created_at: "2026-08-20T15:00:00Z",
        body: "too late",
      },
      device.signSeed,
    );
    expect(() => verifyAuthoredRecord(late, [cert], [revoke])).toThrow(/revoked/);
  });

  it("uses the current time by default", () => {
    const cert = buildDeviceCert(root, device);
    expect(cert.created_at.slice(0, 10)).toBe(nowTimestamp().slice(0, 10));
  });
});

describe("auth challenge signing", () => {
  it("signs utf8('runa-auth-v1:' + challenge) with the device key", () => {
    const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
    const challenge = b64url.encode(hexToBytes("aa".repeat(32)));
    const sig = signAuthChallenge(device.signSeed, challenge);
    expect(
      ed25519.verify(b64url.decode(sig), utf8(AUTH_CONTEXT + challenge), device.signPub),
    ).toBe(true);
    // and NOT over the bare challenge
    expect(ed25519.verify(b64url.decode(sig), utf8(challenge), device.signPub)).toBe(false);
  });
});
