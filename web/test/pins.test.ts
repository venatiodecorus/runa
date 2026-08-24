/**
 * Key continuity pins (src/dm/pins.ts, protocol §8.3): device-set diff logic
 * that drives the DM composer's "new device" warning. The kv-backed
 * load/save wrappers are one-line IndexedDB calls, exercised in the
 * browser; `currentDeviceIds` and `diffPin` are the pure logic they share.
 */
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { buildDeviceCert, buildDeviceRevoke, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";
import { currentDeviceIds, diffPin } from "../src/dm/pins.js";

const root = rootFromSeed(hexToBytes("11".repeat(32)));
const d1 = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const d2 = deviceFromSeeds(hexToBytes("44".repeat(32)), hexToBytes("55".repeat(32)));
const d3 = deviceFromSeeds(hexToBytes("66".repeat(32)), hexToBytes("77".repeat(32)));
const cert1 = buildDeviceCert(root, d1, "one", "2026-08-20T12:00:00Z");
const cert2 = buildDeviceCert(root, d2, "two", "2026-08-20T12:05:00Z");
const cert3 = buildDeviceCert(root, d3, "three", "2026-08-20T12:10:00Z");

describe("currentDeviceIds", () => {
  it("returns certified device ids, sorted", () => {
    const ids = currentDeviceIds([cert2, cert1], []);
    expect(ids).toEqual([d1.deviceId, d2.deviceId].sort());
  });

  it("excludes a revoked device", () => {
    const revoke = buildDeviceRevoke(root, d2.deviceId, "2026-08-20T12:20:00Z");
    const ids = currentDeviceIds([cert1, cert2], [revoke]);
    expect(ids).toEqual([d1.deviceId]);
  });

  it("deduplicates repeated certs for the same device", () => {
    const ids = currentDeviceIds([cert1, cert1], []);
    expect(ids).toEqual([d1.deviceId]);
  });

  it("empty certs → empty pin", () => {
    expect(currentDeviceIds([], [])).toEqual([]);
  });
});

describe("diffPin", () => {
  it("first contact (no stored pin): TOFU — no warning, regardless of current devices", () => {
    const current = currentDeviceIds([cert1, cert2], []);
    const diff = diffPin(current, undefined);
    expect(diff).toEqual({ firstContact: true, newDevices: [] });
  });

  it("no new devices when the current set is a subset of the stored pin", () => {
    const stored = currentDeviceIds([cert1, cert2], []);
    const current = currentDeviceIds([cert1], []);
    const diff = diffPin(current, stored);
    expect(diff).toEqual({ firstContact: false, newDevices: [] });
  });

  it("no new devices when the current set exactly matches the stored pin", () => {
    const pin = currentDeviceIds([cert1, cert2], []);
    expect(diffPin(pin, pin)).toEqual({ firstContact: false, newDevices: [] });
  });

  it("flags a device present now but absent from the stored pin", () => {
    const stored = currentDeviceIds([cert1], []);
    const current = currentDeviceIds([cert1, cert2, cert3], []);
    const diff = diffPin(current, stored);
    expect(diff.firstContact).toBe(false);
    expect(diff.newDevices.sort()).toEqual([d2.deviceId, d3.deviceId].sort());
  });

  it("re-pinning (stored = current) clears the diff", () => {
    const before = currentDeviceIds([cert1], []);
    const after = currentDeviceIds([cert1, cert2], []);
    expect(diffPin(after, before).newDevices).toEqual([d2.deviceId]);
    // Confirming ("Got it — trust their new devices") re-pins to `after`.
    expect(diffPin(after, after).newDevices).toEqual([]);
  });
});
