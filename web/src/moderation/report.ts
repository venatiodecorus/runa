/**
 * `report` record builder + submit (docs/protocol.md §9.1, M7). Mirrors the
 * crypto/graph.ts and crypto/attestation.ts pattern: build the record, device-
 * sign it, validate its shape with @runa/core BEFORE it ever reaches the
 * wire, then post through the shared /records path.
 *
 * `plaintext` (§9.2, encrypted-content forwarding) is the one place a
 * recipient's own decrypted copy of a dm/scoped-post leaves the device — the
 * UI layer (ui/Report.tsx) is responsible for the explicit consent gate
 * before it ever reaches this module; this module only enforces the
 * structural rule that plaintext never travels without a `record` naming
 * what it was decrypted from (server-contextual recipiency is enforced by
 * the instance, not here).
 *
 * Framework-free: no React imports.
 */
import {
  nowTimestamp,
  signRecord,
  validateReport,
  type ReportReason,
  type ReportRecord,
} from "@runa/core";
import { postRecord } from "../api/client.js";
import type { DeviceKeys } from "../crypto/keys.js";

type SigningDevice = Pick<DeviceKeys, "deviceId" | "signSeed">;

export interface ReportInput {
  /** Account being reported. */
  subject: string;
  /** The specific record complained about, optional. */
  record?: string;
  reason: ReportReason;
  /** UTF-8, ≤ REPORT_COMMENT_MAX chars (core enforces the cap). Blank/whitespace-only is dropped. */
  comment?: string;
  /**
   * Forwarded plaintext (§9.2) — only meaningful alongside `record` naming an
   * encrypted dm/scoped-post the reporter received. Never set this for a
   * public post's report.
   */
  plaintext?: string;
}

/** Build + device-sign a `report` record, validated before it's returned. */
export function buildReport(
  author: string,
  device: SigningDevice,
  input: ReportInput,
  createdAt: string = nowTimestamp(),
): ReportRecord {
  if (input.plaintext !== undefined && input.record === undefined) {
    throw new Error("plaintext requires a record id — it names what the plaintext was decrypted from (protocol §9.2)");
  }
  const comment = input.comment?.trim();
  const record = signRecord(
    {
      v: 1,
      type: "report",
      author,
      device: device.deviceId,
      created_at: createdAt,
      subject: input.subject,
      ...(input.record !== undefined ? { record: input.record } : {}),
      reason: input.reason,
      ...(comment ? { comment } : {}),
      ...(input.plaintext !== undefined ? { plaintext: input.plaintext } : {}),
    },
    device.signSeed,
  ) as ReportRecord;
  // Shape validation (unknown reason, self-report, over-long comment, malformed
  // ids) before it's ever posted — mirrors DomainsSection's verifyDomainClaim
  // call in ui/Profile.tsx. Recipiency/existence checks are server-contextual.
  validateReport(record);
  return record;
}

/** buildReport + POST /records — the round trip used by every report surface. */
export async function submitReport(
  author: string,
  device: SigningDevice,
  input: ReportInput,
  createdAt?: string,
): Promise<ReportRecord> {
  const record = buildReport(author, device, input, createdAt);
  await postRecord(record);
  return record;
}
