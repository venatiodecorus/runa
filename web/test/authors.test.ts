/**
 * verifiedDisplayName (src/ui/authors.ts): a display name is non-unique
 * metadata and must never render unless its profile record verifies —
 * tampering, imageboard mode, and author mismatch must all yield null.
 */
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { signRecord } from "@runa/core";
import { buildDeviceCert, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";
import { verifiedDisplayName } from "../src/ui/authors.js";

const root = rootFromSeed(hexToBytes("11".repeat(32)));
const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const cert = buildDeviceCert(root, device, "t", "2026-08-20T12:00:00Z");
const AT = "2026-08-20T13:00:00Z";

function makeProfile(overrides: Record<string, unknown> = {}) {
  return signRecord(
    {
      v: 1,
      type: "profile",
      author: root.account,
      device: device.deviceId,
      created_at: AT,
      display_name: "Alice",
      ...overrides,
    },
    device.signSeed,
  );
}

describe("verifiedDisplayName", () => {
  it("returns the display name for a valid, verified profile", () => {
    const bundle = { device_certs: [cert], device_revocations: [], profile: makeProfile() };
    expect(verifiedDisplayName(root.account, bundle, false)).toBe("Alice");
  });

  it("returns null for a tampered profile (signature no longer verifies)", () => {
    const profile = makeProfile();
    const tampered = { ...profile, display_name: "Mallory" };
    const bundle = { device_certs: [cert], device_revocations: [], profile: tampered };
    expect(verifiedDisplayName(root.account, bundle, false)).toBeNull();
  });

  it("returns null in imageboard mode even for a valid profile", () => {
    const bundle = { device_certs: [cert], device_revocations: [], profile: makeProfile() };
    expect(verifiedDisplayName(root.account, bundle, true)).toBeNull();
  });

  it("returns null when the profile's author doesn't match the account", () => {
    const bundle = { device_certs: [cert], device_revocations: [], profile: makeProfile() };
    expect(verifiedDisplayName("some-other-account", bundle, false)).toBeNull();
  });

  it("returns null when there is no profile", () => {
    const bundle = { device_certs: [cert], device_revocations: [], profile: null };
    expect(verifiedDisplayName(root.account, bundle, false)).toBeNull();
  });

  it("returns null when display_name is missing or empty", () => {
    const missing = { ...makeProfile(), display_name: undefined };
    const empty = makeProfile({ display_name: "   " });
    expect(
      verifiedDisplayName(root.account, { device_certs: [cert], device_revocations: [], profile: missing }, false),
    ).toBeNull();
    expect(
      verifiedDisplayName(root.account, { device_certs: [cert], device_revocations: [], profile: empty }, false),
    ).toBeNull();
  });
});
