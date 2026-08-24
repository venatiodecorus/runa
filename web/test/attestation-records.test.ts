/**
 * Attestation & domain-claim record builders (protocol §8): device-signed
 * shape, sign, verify — mirrors the graph-records.test.ts pattern.
 */
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { nowTimestamp, verifyAttestation, verifyAttestationRevoke, verifyAuthoredRecord, verifyDomainClaim } from "@runa/core";
import { buildDeviceCert, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";
import { buildAttestation, buildAttestationRevoke, buildDomainClaim } from "../src/crypto/attestation.js";

const root = rootFromSeed(hexToBytes("11".repeat(32)));
const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const cert = buildDeviceCert(root, device, "t", "2026-08-20T12:00:00Z");
const subject = rootFromSeed(hexToBytes("44".repeat(32))).account;
const AT = "2026-08-20T13:00:00Z";

describe("buildAttestation", () => {
  it("builds a device-signed attestation with subject_root_pub == subject", () => {
    const rec = buildAttestation(root.account, device, subject, "safety-number", AT);
    expect(rec).toMatchObject({
      v: 1,
      type: "attestation",
      author: root.account,
      device: device.deviceId,
      created_at: AT,
      subject,
      subject_root_pub: subject,
      method: "safety-number",
    });
    expect(() => verifyAttestation(rec)).not.toThrow();
    expect(() => verifyAuthoredRecord(rec, [cert], [])).not.toThrow();
  });

  it("defaults created_at to now", () => {
    const rec = buildAttestation(root.account, device, subject, "qr");
    expect(rec.created_at.slice(0, 10)).toBe(nowTimestamp().slice(0, 10));
  });
});

describe("buildAttestationRevoke", () => {
  it("builds a device-signed revoke that verifies", () => {
    const rec = buildAttestationRevoke(root.account, device, subject, AT);
    expect(rec).toMatchObject({
      v: 1,
      type: "attestation-revoke",
      author: root.account,
      device: device.deviceId,
      subject,
    });
    expect(() => verifyAttestationRevoke(rec)).not.toThrow();
    expect(() => verifyAuthoredRecord(rec, [cert], [])).not.toThrow();
  });
});

describe("buildDomainClaim", () => {
  it("builds a device-signed domain-claim that verifies", () => {
    const rec = buildDomainClaim(root.account, device, "example.com", AT);
    expect(rec).toMatchObject({
      v: 1,
      type: "domain-claim",
      author: root.account,
      device: device.deviceId,
      domain: "example.com",
    });
    expect(() => verifyDomainClaim(rec)).not.toThrow();
    expect(() => verifyAuthoredRecord(rec, [cert], [])).not.toThrow();
  });

  it("rejects an invalid hostname shape at verify time", () => {
    const rec = buildDomainClaim(root.account, device, "Not A Domain", AT);
    expect(() => verifyDomainClaim(rec)).toThrow();
  });
});
