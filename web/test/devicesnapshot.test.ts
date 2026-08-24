/**
 * Device snapshot (dev/test-only working-set export): roundtrip and the
 * self-consistency checks — a corrupted or mixed-up snapshot must never
 * silently yield a working set that contradicts itself.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { utf8 } from "@runa/core";
import {
  buildDeviceSnapshot,
  looksLikeDeviceSnapshot,
  parseDeviceSnapshot,
} from "../src/crypto/devicesnapshot.js";
import { buildDeviceCert, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";

const seed = (label: string) => sha256(utf8(`devicesnapshot-test:${label}`));
const root = rootFromSeed(seed("root"));
const device = deviceFromSeeds(seed("sign"), seed("kex"));
const cert = buildDeviceCert(root, device, "snapshot-test", "2026-08-24T12:00:00Z");
const snapshot = buildDeviceSnapshot(root, device, cert, "2026-08-24T12:00:00Z");
const json = JSON.stringify(snapshot);

describe("device snapshot", () => {
  it("roundtrips to the same working set", () => {
    const parsed = parseDeviceSnapshot(json);
    expect(parsed.root.account).toBe(root.account);
    expect(parsed.device.deviceId).toBe(device.deviceId);
    expect(parsed.device.kexPubB64).toBe(device.kexPubB64);
    expect(parsed.cert).toEqual(cert);
  });

  it("sniffs snapshot vs key file", () => {
    expect(looksLikeDeviceSnapshot(json)).toBe(true);
    expect(looksLikeDeviceSnapshot('{"v":1,"kind":"runa-root-key"}')).toBe(false);
    expect(looksLikeDeviceSnapshot("not json")).toBe(false);
  });

  it("rejects account/root-seed mismatch", () => {
    const other = rootFromSeed(seed("other-root"));
    expect(() =>
      parseDeviceSnapshot(JSON.stringify({ ...snapshot, account: other.account })),
    ).toThrow(/does not match its root seed/);
  });

  it("rejects a cert that certifies different device keys", () => {
    const otherDevice = deviceFromSeeds(seed("other-sign"), seed("other-kex"));
    const otherCert = buildDeviceCert(root, otherDevice, "other", "2026-08-24T12:00:00Z");
    expect(() =>
      parseDeviceSnapshot(JSON.stringify({ ...snapshot, cert: otherCert })),
    ).toThrow(/does not certify/);
  });

  it("rejects a cert signed by a different root", () => {
    const otherRoot = rootFromSeed(seed("other-root"));
    const foreignCert = buildDeviceCert(otherRoot, device, "foreign", "2026-08-24T12:00:00Z");
    expect(() =>
      parseDeviceSnapshot(JSON.stringify({ ...snapshot, cert: foreignCert })),
    ).toThrow();
  });

  it("rejects tampered seeds and wrong kinds", () => {
    expect(() =>
      parseDeviceSnapshot(JSON.stringify({ ...snapshot, device_kex_seed: "AAAA" })),
    ).toThrow(/32 bytes/);
    expect(() => parseDeviceSnapshot(JSON.stringify({ ...snapshot, kind: "runa-root-key" }))).toThrow(
      /not a runa device snapshot/,
    );
  });
});
