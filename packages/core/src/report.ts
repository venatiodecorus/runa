/**
 * Reports & standing, wire format (docs/protocol.md §9): a public-graph-
 * adjacent but server-**private** signed record — "I am reporting this
 * account/record" — device-signed, never metered, never served to any user
 * (§9.1). Its aggregate effect on an account's standing is the published math
 * in docs/trust-and-reach.md §4 (standing.ts), not anything computed here.
 */
import { verifySignature, type RunaRecord } from "./records.js";

export const REPORT_REASONS = ["spam", "harassment", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_COMMENT_MAX = 1000;

export interface ReportRecord extends RunaRecord {
  type: "report";
  subject: string; // account id being reported
  record?: string; // record id complained about, optional
  reason: ReportReason;
  comment?: string; // UTF-8 text, ≤ REPORT_COMMENT_MAX chars
  plaintext?: string; // forwarded plaintext, only with an encrypted `record` (§9.2)
}

function assertAccountId(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  // Account ids are 43-char base64url (b64url(32-byte Ed25519 pubkey)); a
  // length/charset check is the plausibility bar shared with attestation.ts's
  // assertAccountId — the actual "is this a known account" check is server-side.
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`${field} must be a plausible account id`);
  }
}

// Record ids are b64url(SHA-256(...)) — 43 chars, same shape as account ids
// and as recordId()'s output (records.ts). A plausibility check only: whether
// the referenced record actually exists on this instance is server-context.
const RECORD_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Type-specific shape validation for a `report` record (protocol §9.1):
 * subject looks like an account id, no self-report, reason is a known value,
 * comment (if present) respects the length cap, record (if present) looks
 * like a record id. Does NOT verify the signature (see verifyReport) and does
 * NOT check recipiency/existence/instance-membership — those rules (§9.2,
 * "subject must be a known account", "record must exist and be authored by
 * subject", "plaintext only with an encrypted dm/scoped-post record") are
 * server-contextual and live at the ingest layer, not in this pure function.
 */
export function validateReport(rec: ReportRecord): void {
  if (rec.type !== "report") throw new Error("not a report");
  assertAccountId(rec.subject, "subject");
  if (rec.author === rec.subject) throw new Error("self-report is not allowed");
  if (!REPORT_REASONS.includes(rec.reason as ReportReason)) {
    throw new Error(`unknown report reason: ${rec.reason}`);
  }
  if (rec.comment !== undefined) {
    if (typeof rec.comment !== "string") throw new Error("comment must be a string");
    if (rec.comment.length > REPORT_COMMENT_MAX) {
      throw new Error(`comment exceeds ${REPORT_COMMENT_MAX} chars`);
    }
  }
  if (rec.record !== undefined) {
    if (typeof rec.record !== "string" || !RECORD_ID_RE.test(rec.record)) {
      throw new Error("record must be a plausible record id");
    }
  }
  if (rec.plaintext !== undefined && typeof rec.plaintext !== "string") {
    throw new Error("plaintext must be a string");
  }
}

/** Signature verify + shape validation, mirroring verifyAttestation's convention. */
export function verifyReport(rec: ReportRecord): void {
  validateReport(rec);
  verifySignature(rec);
}
