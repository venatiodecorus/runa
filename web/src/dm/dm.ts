/**
 * Tier-2 DM send/open flows (docs/protocol.md §4). All envelope crypto lives
 * in @runa/core (sealDm/openDm) — this module only enumerates recipients,
 * enforces the verify-BEFORE-decrypt order, and maps failures to UI-safe
 * results. Framework-free: no React imports.
 */
import {
  conversationId,
  nowTimestamp,
  openDm,
  sealDm,
  verifyAuthoredRecord,
  type DeviceCert,
  type DeviceRevoke,
  type DmRecord,
} from "@runa/core";
import { getAccount, postRecord } from "../api/client.js";
import { dmRecipientSet } from "./recipients.js";

/** Structural slice of ui/session.ts's Session that DMs need. */
export interface DmSession {
  root: { account: string };
  device: { deviceId: string; signSeed: Uint8Array; kexSeed: Uint8Array };
  cert: DeviceCert;
}

/** Per-account key material for verification (shape of GET /accounts/{id}). */
export interface AuthorKeys {
  device_certs: DeviceCert[];
  device_revocations: DeviceRevoke[];
}

/**
 * Seal `body` to every certified, unrevoked device of BOTH participants and
 * post it. Refuses (throws) when the recipient has zero sealable devices.
 * Returns the posted record so the UI can render it optimistically.
 */
export async function sendDm(
  session: DmSession,
  recipientAccount: string,
  body: string,
): Promise<DmRecord> {
  const [senderInfo, recipientInfo] = await Promise.all([
    getAccount(session.root.account),
    getAccount(recipientAccount),
  ]);
  const recipients = dmRecipientSet(senderInfo, recipientInfo, session.cert);
  const record = sealDm({
    body,
    participants: [session.root.account, recipientAccount],
    to: recipientAccount,
    author: session.root.account,
    device: session.device.deviceId,
    deviceSignSeed: session.device.signSeed,
    createdAt: nowTimestamp(),
    recipients,
  });
  await postRecord(record);
  return record;
}

export type OpenDmResult =
  | { ok: true; body: string; conversation: string }
  | {
      ok: false;
      /**
       * "not-recipient": the envelope was not sealed to this device — benign
       * (typically a message from before this device enrolled).
       * "verification-failed": signature/cert-chain/AEAD/conversation-binding
       * failure — render as tampered, NEVER as content.
       */
      reason: "not-recipient" | "verification-failed";
      detail: string;
    };

/**
 * Verify-then-decrypt one dm record as the viewing session's device.
 * Order is protocol-mandated (§4): signature + cert chain FIRST (encryption
 * without a valid signature is spoofable ciphertext), then AEAD open, then
 * the conversation binding inside the plaintext (anti cross-conversation
 * replay). Every failure returns {ok:false}; callers must render failures as
 * placeholders and never fall back to showing content.
 */
export function openDmRecord(
  record: DmRecord,
  certsByAccount: Record<string, AuthorKeys>,
  session: { root: { account: string }; device: { deviceId: string; kexSeed: Uint8Array } },
): OpenDmResult {
  const fail = (reason: "not-recipient" | "verification-failed", detail: string): OpenDmResult => ({
    ok: false,
    reason,
    detail,
  });

  // 1. Author signature + device-cert chain, against the AUTHOR's keys.
  const author = certsByAccount[record.author];
  try {
    verifyAuthoredRecord(record, author?.device_certs ?? [], author?.device_revocations ?? []);
  } catch (e) {
    return fail("verification-failed", e instanceof Error ? e.message : String(e));
  }

  // 2. The record must involve the viewer at all.
  const viewer = session.root.account;
  const counterparty = record.author === viewer ? record.to : record.author;
  if (record.author !== viewer && record.to !== viewer) {
    return fail("verification-failed", "record is neither from nor to this account");
  }

  // 3. Sealed to this device? (Distinct, benign failure mode.)
  if (!Array.isArray(record.recipients) || !record.recipients.some((r) => r?.device === session.device.deviceId)) {
    return fail("not-recipient", "not sealed to this device (sent before it was enrolled?)");
  }

  // 4. Unwrap + AEAD open (AAD binds the header; tampering fails here or in 1).
  let plaintext;
  try {
    plaintext = openDm(record, session.device);
  } catch (e) {
    return fail("verification-failed", e instanceof Error ? e.message : String(e));
  }

  // 5. Conversation binding: plaintext must name exactly this pair.
  if (plaintext.conversation !== conversationId([viewer, counterparty])) {
    return fail("verification-failed", "conversation binding mismatch (cross-conversation replay?)");
  }

  return { ok: true, body: plaintext.body, conversation: plaintext.conversation };
}
