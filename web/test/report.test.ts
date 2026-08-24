/**
 * `report` record builder (docs/protocol.md §9.1): device-signed shape,
 * validated with @runa/core's validateReport before it's returned — mirrors
 * the attestation-records.test.ts / graph-records.test.ts pattern. `submitReport`
 * (the POST /records round trip) is exercised implicitly via buildReport,
 * which is the pure part it delegates to; no fetch mocking needed here since
 * this suite only checks what gets built and validated before the wire.
 */
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { REPORT_COMMENT_MAX, nowTimestamp, verifyAuthoredRecord, verifyReport } from "@runa/core";
import { buildDeviceCert, deviceFromSeeds, rootFromSeed } from "../src/crypto/keys.js";
import { buildReport } from "../src/moderation/report.js";

const root = rootFromSeed(hexToBytes("11".repeat(32)));
const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const cert = buildDeviceCert(root, device, "t", "2026-08-20T12:00:00Z");
const subject = rootFromSeed(hexToBytes("44".repeat(32))).account;
const AT = "2026-08-20T13:00:00Z";

describe("buildReport", () => {
  it("builds a device-signed report with a valid record shape", () => {
    const rec = buildReport(root.account, device, { subject, reason: "spam" }, AT);
    expect(rec).toMatchObject({
      v: 1,
      type: "report",
      author: root.account,
      device: device.deviceId,
      created_at: AT,
      subject,
      reason: "spam",
    });
    expect(rec.record).toBeUndefined();
    expect(rec.comment).toBeUndefined();
    expect(rec.plaintext).toBeUndefined();
    expect(typeof rec.sig).toBe("string");
    expect(() => verifyReport(rec)).not.toThrow();
    expect(() => verifyAuthoredRecord(rec, [cert], [])).not.toThrow();
  });

  it("defaults created_at to now", () => {
    const rec = buildReport(root.account, device, { subject, reason: "other" });
    expect(rec.created_at.slice(0, 10)).toBe(nowTimestamp().slice(0, 10));
  });

  it("includes an optional record id and trims a comment", () => {
    const recordId = "R".repeat(43);
    const rec = buildReport(
      root.account,
      device,
      { subject, record: recordId, reason: "harassment", comment: "  spammy  " },
      AT,
    );
    expect(rec.record).toBe(recordId);
    expect(rec.comment).toBe("spammy");
  });

  it("drops a blank/whitespace-only comment entirely", () => {
    const rec = buildReport(root.account, device, { subject, reason: "spam", comment: "   " }, AT);
    expect(rec.comment).toBeUndefined();
  });

  it("rejects a comment over REPORT_COMMENT_MAX chars", () => {
    const tooLong = "x".repeat(REPORT_COMMENT_MAX + 1);
    expect(() => buildReport(root.account, device, { subject, reason: "spam", comment: tooLong }, AT)).toThrow(
      /comment/,
    );
  });

  it("accepts a comment at exactly REPORT_COMMENT_MAX chars", () => {
    const atCap = "x".repeat(REPORT_COMMENT_MAX);
    const rec = buildReport(root.account, device, { subject, reason: "spam", comment: atCap }, AT);
    expect(rec.comment).toHaveLength(REPORT_COMMENT_MAX);
  });

  it("rejects an unknown reason", () => {
    expect(() =>
      buildReport(root.account, device, { subject, reason: "made-up" as never }, AT),
    ).toThrow(/reason/);
  });

  it("rejects a self-report", () => {
    expect(() => buildReport(root.account, device, { subject: root.account, reason: "spam" }, AT)).toThrow(
      /self-report/,
    );
  });

  it("rejects plaintext without a record id (protocol §9.2)", () => {
    expect(() =>
      buildReport(root.account, device, { subject, reason: "spam", plaintext: "the message body" }, AT),
    ).toThrow(/plaintext requires a record id/);
  });

  it("carries plaintext through when a record id is set", () => {
    const recordId = "R".repeat(43);
    const rec = buildReport(
      root.account,
      device,
      { subject, record: recordId, reason: "harassment", plaintext: "the message body" },
      AT,
    );
    expect(rec.plaintext).toBe("the message body");
    expect(() => verifyReport(rec)).not.toThrow();
  });

  it("a tampered subject breaks the signature", () => {
    const rec = buildReport(root.account, device, { subject, reason: "spam" }, AT);
    expect(() => verifyReport({ ...rec, subject: rootFromSeed(hexToBytes("55".repeat(32))).account })).toThrow();
  });
});
