/**
 * Request-tray actions (design §5.2, Phase 4). "Accept" is just replying —
 * the server clears the request flag once the recipient sends into the
 * conversation. "Dismiss" is purely LOCAL: a flag in this browser's kv store
 * (store/db.ts), keyed by counterparty — the server never learns about it,
 * and a fresh device starts with an empty dismissed set (browser storage is
 * disposable by design). "Decline & report" (M7, ui/Messages.tsx +
 * moderation/report.ts) decrypts the request's message, gates forwarding it
 * behind explicit consent (protocol §9.2), submits a `report` record, then
 * calls dismissRequest below exactly like plain Dismiss — declining always
 * hides locally, reporting is the separate, optional, consent-gated act on
 * top of it.
 *
 * Framework-free: no React imports.
 */
import type { DmConversation } from "../api/client.js";
import { kvDelete, kvGet, kvSet } from "../store/db.js";

const KEY_PREFIX = "dm.request.dismissed:";

export async function dismissRequest(counterparty: string): Promise<void> {
  await kvSet(KEY_PREFIX + counterparty, true);
}

export async function restoreRequest(counterparty: string): Promise<void> {
  await kvDelete(KEY_PREFIX + counterparty);
}

/** Load the dismissed flags for the given counterparties (one kv key each). */
export async function loadDismissed(counterparties: string[]): Promise<Set<string>> {
  const flags = await Promise.all(counterparties.map((id) => kvGet<boolean>(KEY_PREFIX + id)));
  return new Set(counterparties.filter((_, i) => flags[i] === true));
}

export interface RequestPartition {
  /** Request conversations not locally dismissed, original order kept. */
  visible: DmConversation[];
  /** Locally dismissed request conversations, original order kept. */
  dismissed: DmConversation[];
}

/**
 * Pure split of request-conversations by the local dismissed set. Dismissal
 * only ever HIDES — it never touches non-request conversations, and a
 * dismissed counterparty whose conversation left the tray (they were
 * accepted or vanished) simply stops mattering.
 */
export function partitionRequests(
  requests: DmConversation[],
  dismissed: ReadonlySet<string>,
): RequestPartition {
  const visible: DmConversation[] = [];
  const hidden: DmConversation[] = [];
  for (const c of requests) (dismissed.has(c.with) ? hidden : visible).push(c);
  return { visible, dismissed: hidden };
}
