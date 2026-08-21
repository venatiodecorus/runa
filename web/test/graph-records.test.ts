/**
 * Graph record builders (protocol §3.1): device-signed follow/unfollow/
 * mute/unmute with a `subject` account id — shape, sign, verify, tamper.
 */
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { nowTimestamp, verifyAuthoredRecord, verifySignature } from "@runa/core";
import { buildDeviceCert, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";
import {
  buildFollow,
  buildGraphRecord,
  buildMute,
  buildUnfollow,
  buildUnmute,
} from "../src/crypto/graph.js";

const root = rootFromSeed(hexToBytes("11".repeat(32)));
const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const cert = buildDeviceCert(root, device, "t", "2026-08-20T12:00:00Z");
const subject = rootFromSeed(hexToBytes("44".repeat(32))).account;
const AT = "2026-08-20T13:00:00Z";

describe("graph record builders", () => {
  it.each([
    ["follow", buildFollow] as const,
    ["unfollow", buildUnfollow] as const,
    ["mute", buildMute] as const,
    ["unmute", buildUnmute] as const,
  ])("%s: device-signed record with subject that fully verifies", (type, build) => {
    const rec = build(root.account, device, subject, AT);
    expect(rec).toMatchObject({
      v: 1,
      type,
      author: root.account,
      device: device.deviceId,
      created_at: AT,
      subject,
    });
    expect(typeof rec.sig).toBe("string");
    // Own signature + cert-chain binding to the author's root.
    expect(() => verifyAuthoredRecord(rec, [cert], [])).not.toThrow();
  });

  it("a tampered subject breaks the signature", () => {
    const rec = buildFollow(root.account, device, subject, AT);
    const other = rootFromSeed(hexToBytes("55".repeat(32))).account;
    expect(() => verifySignature({ ...rec, subject: other })).toThrow(/signature/);
  });

  it("rejects a subject that is not a 32-byte b64url account id", () => {
    expect(() => buildFollow(root.account, device, "not-an-account-id!", AT)).toThrow(/base64url/);
    expect(() => buildFollow(root.account, device, "aGVsbG8", AT)).toThrow(/32 bytes/);
  });

  it("defaults created_at to now", () => {
    const rec = buildGraphRecord("mute", root.account, device, subject);
    expect(rec.created_at.slice(0, 10)).toBe(nowTimestamp().slice(0, 10));
  });
});
