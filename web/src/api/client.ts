/**
 * Typed API client (docs/protocol.md §6). The instance base URL is
 * configuration (design §15) — same-origin (dev proxy / runad-served static
 * build) unless VITE_API_BASE points elsewhere. The client must work against
 * any instance.
 *
 * Framework-free: no React imports. The session token lives in module memory
 * only — never in IndexedDB or localStorage.
 */
import type { DeviceCert, DeviceRevoke, DmRecord, RunaRecord } from "@runa/core";
import type { PassphraseBackup } from "../crypto/recoverykit.js";

export const API_BASE: string =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE) || "";

export interface InstanceMeta {
  name: string;
  software_version: string;
  protocol_version: string;
  constants: Record<string, number>;
}

export interface AccountInfo {
  account: string;
  profile: RunaRecord | null;
  device_certs: DeviceCert[];
  device_revocations: DeviceRevoke[];
  follower_count: number;
}

export interface RecordPage {
  records: RunaRecord[];
  next_before: string | null;
}

/**
 * GET /graph/2hop — the viewer's entitled slice (protocol §6): own follow
 * list, the follow list of each followed account, and own private mutes.
 * Plain id-lists (unlike /follows, which returns the signed records) —
 * exactly the GraphView input to the published trust computation.
 */
export interface Graph2Hop {
  follows: Record<string, string[]>;
  mutes: string[];
}

export interface FeedItem {
  record: RunaRecord;
  author: string;
  /** Server's proposal only — the client recomputes and re-ranks (§3.3). */
  candidate_trust: number;
}

export interface FeedAuthor {
  device_certs: DeviceCert[];
  device_revocations: DeviceRevoke[];
}

export interface FeedResponse {
  items: FeedItem[];
  authors: Record<string, FeedAuthor>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- session token (memory only) -------------------------------------------

let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function hasSession(): boolean {
  return sessionToken !== null;
}

async function request<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init?.auth && sessionToken !== null) {
    headers.set("Authorization", `Bearer ${sessionToken}`);
  }
  const resp = await fetch(`${API_BASE}/api/v1${path}`, { ...init, headers });
  if (!resp.ok) {
    let code = "unknown";
    let message = resp.statusText;
    try {
      const body = await resp.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch {
      // non-JSON error body; keep defaults
    }
    throw new ApiError(resp.status, code, message);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

// --- endpoints --------------------------------------------------------------

export function fetchMeta(): Promise<InstanceMeta> {
  return request<InstanceMeta>("/meta");
}

/** POST /accounts — open signup: root pubkey + root-signed first device cert. */
export function createAccount(rootPub: string, deviceCert: DeviceCert): Promise<{ account: string }> {
  return request("/accounts", {
    method: "POST",
    body: JSON.stringify({ root_pub: rootPub, device_cert: deviceCert }),
  });
}

export function getAccount(id: string): Promise<AccountInfo> {
  return request(`/accounts/${encodeURIComponent(id)}`);
}

/**
 * POST /records — one signed record. Attaches the bearer token when a session
 * exists; a root-signed device-cert posted during recovery (no certified
 * device yet, so no session) is self-authorizing via its root signature.
 */
export function postRecord(record: RunaRecord): Promise<{ id: string }> {
  return request("/records", { method: "POST", body: JSON.stringify(record), auth: true });
}

export function listRecords(
  id: string,
  opts: { type?: string; limit?: number; before?: string } = {},
): Promise<RecordPage> {
  const params = new URLSearchParams();
  if (opts.type !== undefined) params.set("type", opts.type);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before !== undefined) params.set("before", opts.before);
  const qs = params.toString();
  return request(`/accounts/${encodeURIComponent(id)}/records${qs ? `?${qs}` : ""}`);
}

// --- graph & feed (protocol §6) ---------------------------------------------

/**
 * GET /accounts/{id}/follows (auth) — the current outbound follow list as
 * signed follow RECORDS (latest created_at wins; unfollow removes the pair).
 * 403 not_visible unless the requester is a follower of {id}, is {id}, or
 * {id} has opted up to public via profile `follows_public` (design §8).
 */
export function getFollows(id: string): Promise<{ follows: RunaRecord[] }> {
  return request(`/accounts/${encodeURIComponent(id)}/follows`, { auth: true });
}

/** GET /graph/2hop (auth) — the viewer's entitled slice as plain id-lists. */
export function getGraph2Hop(): Promise<Graph2Hop> {
  return request("/graph/2hop", { auth: true });
}

/**
 * GET /feed (auth) — server-proposed candidate ranking plus each author's
 * certs/revocations so the client can verify every record before rendering.
 */
export function getFeed(): Promise<FeedResponse> {
  return request("/feed", { auth: true });
}

// --- DMs (protocol §4 envelope, §6 mailbox) ---------------------------------

export interface DmPage {
  /** dm records, chronological (oldest→newest) within the page. */
  records: DmRecord[];
  next_before: string | null;
}

export interface DmConversation {
  with: string;
  last: DmRecord;
  /**
   * True iff the viewer has no trust path to the counterparty AND has never
   * sent into the conversation — the Phase-3 request tray is classification
   * only (token spend arrives with M4).
   */
  request: boolean;
}

/**
 * GET /dm/with/{id} (auth) — dm records where
 * (author=viewer ∧ to=id) ∨ (author=id ∧ to=viewer); `limit`/`before` page
 * older history exactly like /records.
 */
export function getDmWith(
  id: string,
  opts: { limit?: number; before?: string } = {},
): Promise<DmPage> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before !== undefined) params.set("before", opts.before);
  const qs = params.toString();
  return request(`/dm/with/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`, { auth: true });
}

/** GET /dm/inbox (auth) — conversations sorted by last activity. */
export function getDmInbox(): Promise<{ conversations: DmConversation[] }> {
  return request("/dm/inbox", { auth: true });
}

// --- auth (protocol §6: signed challenge, no passwords) ---------------------

export function authChallenge(): Promise<{ challenge: string; expires_at: string }> {
  return request("/auth/challenge");
}

export function authSession(body: {
  account: string;
  device: string;
  challenge: string;
  sig: string;
}): Promise<{ token: string; expires_at: string }> {
  return request("/auth/session", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Full login round-trip: fetch a challenge, have the caller sign
 * utf8("runa-auth-v1:" + challenge) with a certified device key, exchange it
 * for a token, and keep the token in memory for subsequent calls.
 */
export async function authenticate(
  account: string,
  device: string,
  signChallenge: (challenge: string) => string,
): Promise<void> {
  const { challenge } = await authChallenge();
  const { token } = await authSession({ account, device, challenge, sig: signChallenge(challenge) });
  setSessionToken(token);
}

// --- passphrase backup ------------------------------------------------------

/** POST /backup (auth) — one blob per account, overwrite allowed. */
export function putBackup(blob: PassphraseBackup): Promise<void> {
  return request("/backup", { method: "POST", body: JSON.stringify({ blob }), auth: true });
}

/**
 * GET /backup/{account} — deliberately unauthenticated (the recovering user
 * has no device to sign with); the blob is Argon2id-encrypted client-side.
 */
export function getBackup(account: string): Promise<{ blob: PassphraseBackup }> {
  return request(`/backup/${encodeURIComponent(account)}`);
}
