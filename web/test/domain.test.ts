/**
 * Domain proof matching (src/verify/domain.ts, protocol §8.4): given an
 * already-fetched well-known document, find a byte-identical claim, verify
 * it, and confirm author/domain match. Pure — no network in this file; the
 * one fetch call lives in fetchAndCheckDomainProof, exercised here with an
 * injected fetch stub.
 */
import { describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { buildDeviceCert, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";
import { buildDomainClaim } from "../src/crypto/attestation.js";
import { checkDomainProof, fetchAndCheckDomainProof } from "../src/verify/domain.js";

const root = rootFromSeed(hexToBytes("11".repeat(32)));
const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const cert = buildDeviceCert(root, device, "t", "2026-08-20T12:00:00Z");
const other = rootFromSeed(hexToBytes("44".repeat(32)));
const AT = "2026-08-20T13:00:00Z";

describe("checkDomainProof", () => {
  it("verifies a matching, correctly-signed claim served for the right domain", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const doc = { v: 1, claims: [claim] };
    const result = checkDomainProof(doc, claim, root.account, "example.com", [cert], []);
    expect(result).toEqual({ ok: true, claim });
  });

  it("fails when the well-known document has no matching claim (record id differs)", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const different = buildDomainClaim(root.account, device, "example.com", "2026-08-20T14:00:00Z");
    const doc = { v: 1, claims: [different] };
    const result = checkDomainProof(doc, claim, root.account, "example.com", [cert], []);
    expect(result.ok).toBe(false);
  });

  it("fails when the claim's author does not match the profile being viewed", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const doc = { v: 1, claims: [claim] };
    const result = checkDomainProof(doc, claim, other.account, "example.com", [cert], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/author/);
  });

  it("fails when the claim's domain does not match the host it was fetched from", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const doc = { v: 1, claims: [claim] };
    const result = checkDomainProof(doc, claim, root.account, "not-example.com", [cert], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/domain/);
  });

  it("fails cleanly when the document is malformed (no claims array)", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const result = checkDomainProof({ v: 1 }, claim, root.account, "example.com", [cert], []);
    expect(result.ok).toBe(false);
  });

  it("fails cleanly when the document is not an object", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const result = checkDomainProof(null, claim, root.account, "example.com", [cert], []);
    expect(result.ok).toBe(false);
  });

  it("fails when the matching claim's device is unbound (no cert for it)", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const doc = { v: 1, claims: [claim] };
    const result = checkDomainProof(doc, claim, root.account, "example.com", [], []);
    expect(result.ok).toBe(false);
  });

  it("picks the matching claim out of several unrelated ones", () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const decoy1 = buildDomainClaim(root.account, device, "other.com", AT);
    const decoy2 = buildDomainClaim(other.account, device, "example.com", AT);
    const doc = { v: 1, claims: [decoy1, decoy2, claim] };
    const result = checkDomainProof(doc, claim, root.account, "example.com", [cert], []);
    expect(result).toEqual({ ok: true, claim });
  });
});

describe("fetchAndCheckDomainProof", () => {
  it("fetches the well-known URL for the claim's domain and verifies it", async () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const fetchStub = vi.fn(async (url: string) => {
      expect(url).toBe("https://example.com/.well-known/runa.json");
      return { ok: true, json: async () => ({ v: 1, claims: [claim] }) } as Response;
    });
    const result = await fetchAndCheckDomainProof(claim, root.account, [cert], [], fetchStub as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, claim });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it("renders a neutral failure on a non-2xx response", async () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const fetchStub = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    const result = await fetchAndCheckDomainProof(claim, root.account, [cert], [], fetchStub as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });

  it("renders a neutral failure when the fetch throws (unreachable or CORS-blocked)", async () => {
    const claim = buildDomainClaim(root.account, device, "example.com", AT);
    const fetchStub = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await fetchAndCheckDomainProof(claim, root.account, [cert], [], fetchStub as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });
});
