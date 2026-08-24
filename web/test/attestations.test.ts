/**
 * Attestation verify+reduce glue (src/verify/attestations.ts): every
 * candidate is re-verified against its own authors bundle before counting —
 * the server's list is a candidate set, never an authority (protocol §8.3).
 * The kv-backed cache wrappers are one-line IndexedDB calls, exercised in
 * the browser; `nextAttestedCache` is the pure reconciliation they share.
 */
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { buildDeviceCert, buildDeviceRevoke, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";
import { buildAttestation } from "../src/crypto/attestation.js";
import type { AttestationAuthorBundle } from "../src/verify/attestations.js";
import { findOwn, nextAttestedCache, verifyAndReduceAttestations } from "../src/verify/attestations.js";

const viewer = rootFromSeed(hexToBytes("11".repeat(32)));
const viewerDevice = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const viewerCert = buildDeviceCert(viewer, viewerDevice, "t", "2026-08-20T12:00:00Z");

const other = rootFromSeed(hexToBytes("55".repeat(32)));
const otherDevice = deviceFromSeeds(hexToBytes("66".repeat(32)), hexToBytes("77".repeat(32)));
const otherCert = buildDeviceCert(other, otherDevice, "t", "2026-08-20T12:00:00Z");

const subject = rootFromSeed(hexToBytes("44".repeat(32))).account;
const AT = "2026-08-20T13:00:00Z";

function authorsBundle(...certs: ReturnType<typeof buildDeviceCert>[]): Record<string, AttestationAuthorBundle> {
  const bundle: AttestationAuthorBundle = { device_certs: certs, device_revocations: [] };
  const out: Record<string, AttestationAuthorBundle> = {};
  for (const c of certs) out[c.author] = bundle;
  return out;
}

describe("verifyAndReduceAttestations", () => {
  it("keeps a valid attestation that verifies against its author's bundle", () => {
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    const active = verifyAndReduceAttestations(subject, [rec], authorsBundle(viewerCert));
    expect(active).toHaveLength(1);
    expect(active[0]!.author).toBe(viewer.account);
  });

  it("discards a record whose signature was tampered", () => {
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    const tampered = { ...rec, method: "domain-proof" as const };
    const active = verifyAndReduceAttestations(subject, [tampered], authorsBundle(viewerCert));
    expect(active).toHaveLength(0);
  });

  it("discards a record with no device-cert binding it to its claimed author", () => {
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    // Authors bundle only knows about `other`'s cert — viewer's device is unbound.
    const active = verifyAndReduceAttestations(subject, [rec], authorsBundle(otherCert));
    expect(active).toHaveLength(0);
  });

  it("discards a record whose device was revoked before it was signed", () => {
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    const revoke = buildDeviceRevoke(viewer, viewerDevice.deviceId, "2026-08-20T12:30:00Z"); // before AT
    const bundle: AttestationAuthorBundle = { device_certs: [viewerCert], device_revocations: [revoke] };
    const active = verifyAndReduceAttestations(subject, [rec], { [viewer.account]: bundle });
    expect(active).toHaveLength(0);
  });

  it("ignores non-attestation record types mixed into the candidate list", () => {
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    const notAnAttestation = { ...rec, type: "post" };
    const active = verifyAndReduceAttestations(subject, [notAnAttestation], authorsBundle(viewerCert));
    expect(active).toHaveLength(0);
  });

  it("reduces multiple authors' attestations to the active latest-wins set", () => {
    const a = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", "2026-08-20T13:00:00Z");
    const b = buildAttestation(other.account, otherDevice, subject, "qr", "2026-08-20T14:00:00Z");
    const active = verifyAndReduceAttestations(subject, [a, b], authorsBundle(viewerCert, otherCert));
    expect(active.map((x) => x.author).sort()).toEqual([other.account, viewer.account].sort());
  });
});

describe("findOwn", () => {
  it("finds the viewer's own attestation among the active set", () => {
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    expect(findOwn(viewer.account, [rec])?.author).toBe(viewer.account);
  });

  it("returns null when the viewer has not attested", () => {
    const rec = buildAttestation(other.account, otherDevice, subject, "safety-number", AT);
    expect(findOwn(viewer.account, [rec])).toBeNull();
  });
});

describe("nextAttestedCache", () => {
  it("adds the subject when the viewer has an active attestation of it", () => {
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    const next = nextAttestedCache({}, viewer.account, subject, [rec]);
    expect(next).toEqual({ [subject]: AT });
  });

  it("removes the subject when the viewer no longer has an active attestation", () => {
    const cache = { [subject]: AT, other: "2026-01-01T00:00:00Z" };
    const next = nextAttestedCache(cache, viewer.account, subject, []);
    expect(next).toEqual({ other: "2026-01-01T00:00:00Z" });
  });

  it("returns the SAME object when nothing changes (no redundant write)", () => {
    const cache = { [subject]: AT };
    const rec = buildAttestation(viewer.account, viewerDevice, subject, "safety-number", AT);
    const next = nextAttestedCache(cache, viewer.account, subject, [rec]);
    expect(next).toBe(cache);
  });

  it("is unaffected by another account's attestation of the same subject", () => {
    const rec = buildAttestation(other.account, otherDevice, subject, "safety-number", AT);
    const next = nextAttestedCache({}, viewer.account, subject, [rec]);
    expect(next).toEqual({});
  });
});
