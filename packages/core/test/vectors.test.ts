/**
 * Consumes the shared protocol vectors in docs/protocol/vectors/ — the same
 * files the Go suite reads. This is the TS side of the cross-implementation
 * contract (protocol §9).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSTANTS } from "../src/constants.js";
import { subjectiveTrust } from "../src/trust.js";
import { dailyBudget, isColdInitiation } from "../src/budgets.js";
import { canonicalize } from "../src/jcs.js";
import { verifySignature, type RunaRecord } from "../src/records.js";
import { verifyAuthoredRecord, verifyDeviceBinding, type DeviceCert, type DeviceRevoke } from "../src/certs.js";
import {
  verifyAttestation,
  verifyAttestationRevoke,
  verifyDomainClaim,
  activeAttestations,
  safetyNumber,
  fingerprint,
  type AttestationRecord,
  type AttestationRevokeRecord,
  type DomainClaimRecord,
} from "../src/attestation.js";
import { bytesToHex } from "@noble/hashes/utils";

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/protocol/vectors");
const load = (name: string) => JSON.parse(readFileSync(join(VECTORS, name), "utf8"));

describe("vectors: jcs-01", () => {
  const { cases } = load("jcs-01.json");
  for (const c of cases) {
    it(c.name, () => {
      expect(canonicalize(c.input)).toBe(c.canonical);
    });
  }
});

describe("vectors: records-01", () => {
  const data = load("records-01.json");
  const certs = data.certs as DeviceCert[];
  const revocations = data.revocations as DeviceRevoke[];
  for (const c of data.cases) {
    it(c.name, () => {
      const record = c.record as RunaRecord;
      const verify = () =>
        c.check === "chain" ? verifyAuthoredRecord(record, certs, revocations) : verifySignature(record);
      if (c.valid) {
        expect(verify).not.toThrow();
      } else {
        expect(verify).toThrow();
      }
    });
  }
});

describe("vectors: trust-graph-01", () => {
  const { cases } = load("trust-graph-01.json");
  for (const c of cases) {
    it(c.name, () => {
      expect(subjectiveTrust(c.viewer, c.author, c.graph)).toBeCloseTo(c.trust, 9);
    });
  }
});

describe("vectors: budgets-01", () => {
  const { cases } = load("budgets-01.json");
  for (const c of cases) {
    it(c.name, () => {
      expect(dailyBudget(c.base, c.inbound_trust, c.k, c.standing)).toBeCloseTo(c.budget, 9);
    });
  }
});

describe("vectors: cold-01", () => {
  const { cases } = load("cold-01.json");
  for (const c of cases) {
    it(c.name, () => {
      expect(isColdInitiation(c.recipient, c.sender, c.graph)).toBe(c.cold);
    });
  }
});

describe("vectors: attest-01", () => {
  const data = load("attest-01.json");
  const certs = data.certs as DeviceCert[];
  const verifyByType = (record: RunaRecord) => {
    if (record.type === "attestation") verifyAttestation(record as AttestationRecord);
    else if (record.type === "attestation-revoke") verifyAttestationRevoke(record as AttestationRevokeRecord);
    else if (record.type === "domain-claim") verifyDomainClaim(record as DomainClaimRecord);
    else throw new Error(`unexpected type ${record.type}`);
    verifyDeviceBinding(record, certs);
  };
  for (const c of data.cases) {
    it(c.name, () => {
      if (c.valid) expect(() => verifyByType(c.record)).not.toThrow();
      else expect(() => verifyByType(c.record)).toThrow();
    });
  }
  it("reduction: revoke supersedes, latest-wins", () => {
    const r = data.reduction;
    expect(
      activeAttestations(r.subject, r.attestations, r.revokes).map((a: AttestationRecord) => a.author),
    ).toEqual(r.active_authors);
    expect(
      activeAttestations(r.subject, r.attestations).map((a: AttestationRecord) => a.author),
    ).toEqual(r.without_revokes_active_authors);
  });
});

describe("vectors: safety-number-01", () => {
  const data = load("safety-number-01.json");
  for (const c of data.cases) {
    it(c.name, () => {
      expect(safetyNumber(c.id_a, c.id_b)).toBe(c.safety_number);
    });
  }
  for (const f of data.fingerprints) {
    it(`fingerprint ${f.account_id.slice(0, 8)}…`, () => {
      expect(bytesToHex(fingerprint(f.account_id))).toBe(f.sha256_hex);
    });
  }
});

describe("vectors: constants-01", () => {
  it("reference constants agree with @runa/core", () => {
    expect(load("constants-01.json").constants).toEqual(CONSTANTS);
  });
});
