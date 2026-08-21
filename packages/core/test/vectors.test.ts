/**
 * Consumes the shared protocol vectors in docs/protocol/vectors/ — the same
 * files the Go suite reads. This is the TS side of the cross-implementation
 * contract (protocol §8).
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
import { verifyAuthoredRecord, type DeviceCert, type DeviceRevoke } from "../src/certs.js";

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

describe("vectors: constants-01", () => {
  it("reference constants agree with @runa/core", () => {
    expect(load("constants-01.json").constants).toEqual(CONSTANTS);
  });
});
