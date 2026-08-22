/**
 * Tier-3 scoped-post epoch manager (docs/protocol.md §5, M5). All crypto and
 * scope/rotation math comes from @runa/core (makeEpoch/sealEpochKey/
 * openEpochKey/sealScopedPost/openScopedPost/enumerateScope/needsRotation) —
 * this module never reimplements it. It owns:
 *
 *   - Rotation (§5.5, client-driven): recompute the concrete scope set,
 *     mint + distribute a new epoch when the set changed or the epoch aged
 *     out, otherwise reuse the current one.
 *   - Local custody of epoch keys, both authored (this device minted them)
 *     and received (granted by someone else's epoch-key record) — disposable
 *     like device keys (design §2.3): losing them is "recovery restores
 *     identity, not history," never a hard failure.
 *   - Key sync from GET /epochs/keys: verify-then-unwrap every grant to this
 *     viewer, same verify-BEFORE-decrypt discipline as dm.ts.
 *   - Late-wrap (§5.3) for the author's own re-enrolled devices.
 *
 * Storage indirection: `EpochStore` is injected (default: a thin IndexedDB-
 * backed implementation over store/db.ts's generic kv store, one-line calls
 * in the same spirit as dm/requests.ts) so the rotation/sync logic itself is
 * testable against a fake store, matching dm.ts's mocked-fetch pattern for
 * the network side.
 *
 * Framework-free: no React imports.
 */
import {
  CONSTANTS,
  b64url,
  nowTimestamp,
  recordId,
  verifyAuthoredRecord,
  makeEpoch,
  sealEpochKey,
  openEpochKey,
  sealScopedPost,
  openScopedPost,
  enumerateScope,
  needsRotation,
  type Constants,
  type DeviceCert,
  type DeviceRevoke,
  type EpochKeyRecord,
  type EpochRecord,
  type EpochScope,
  type GraphView,
  type ScopeSource,
  type ScopedPostRecord,
  type SealRecipient,
} from "@runa/core";
import { getAccount, getEpochsKeys, postRecord } from "../api/client.js";
import { kvGet, kvSet } from "../store/db.js";
import { partyDevices } from "../dm/recipients.js";

/** Structural slice of ui/session.ts's Session that epoch operations need. */
export interface EpochSession {
  root: { account: string };
  device: { deviceId: string; signSeed: Uint8Array; kexSeed: Uint8Array };
  cert: DeviceCert;
}

/** An epoch this device minted (author = this account, possibly from another device). */
export interface AuthoredEpoch {
  epochId: string;
  record: EpochRecord;
  scopeSource: ScopeSource;
  /** enumerateScope's frozen output at distribution time (excludes the author). */
  frozenMembers: string[];
  epochKey: string; // b64url, 32 bytes
  /** The author's own device ids already covered by a self-grant epoch-key record. */
  selfGrantDevices: string[];
}

/** An epoch key this account received as a member (via someone else's epoch-key record). */
export interface ReceivedEpochKey {
  epochId: string;
  /** Inlined epoch metadata from GET /epochs/keys — enough to badge scope/author, no extra round-trip. */
  epoch: { author: string; scope: EpochScope; prev?: string; created_at: string };
  epochKey: string; // b64url, 32 bytes
}

export interface EpochStore {
  getAuthoredEpoch(epochId: string): Promise<AuthoredEpoch | undefined>;
  putAuthoredEpoch(epoch: AuthoredEpoch): Promise<void>;
  getCurrentEpochId(source: ScopeSource): Promise<string | undefined>;
  setCurrentEpochId(source: ScopeSource, epochId: string): Promise<void>;
  getReceivedKey(epochId: string): Promise<ReceivedEpochKey | undefined>;
  putReceivedKey(key: ReceivedEpochKey): Promise<void>;
}

// --- default store: thin wrapper over store/db.ts's generic kv store --------

const kAuthored = (epochId: string) => `epoch.authored:${epochId}`;
const kCurrent = (source: ScopeSource) => `epoch.current:${source}`;
const kReceived = (epochId: string) => `epoch.received:${epochId}`;

/** Real, IndexedDB-backed store (browser storage is disposable — design §2.3). */
export function indexedDbEpochStore(): EpochStore {
  return {
    getAuthoredEpoch: (epochId) => kvGet<AuthoredEpoch>(kAuthored(epochId)),
    putAuthoredEpoch: (epoch) => kvSet(kAuthored(epoch.epochId), epoch),
    getCurrentEpochId: (source) => kvGet<string>(kCurrent(source)),
    setCurrentEpochId: (source, epochId) => kvSet(kCurrent(source), epochId),
    getReceivedKey: (epochId) => kvGet<ReceivedEpochKey>(kReceived(epochId)),
    putReceivedKey: (key) => kvSet(kReceived(key.epochId), key),
  };
}

export function scopeLabel(source: ScopeSource): string {
  return source === "follows" ? "My follows" : "My web";
}

// --- device-set helpers -------------------------------------------------------

/** partyDevices, plus the session's own cert in case the server's view lags it (dm.ts pattern). */
function ownDevicesIncludingSession(
  info: { account: string; device_certs: DeviceCert[]; device_revocations: DeviceRevoke[] },
  cert: DeviceCert,
): SealRecipient[] {
  const devices = partyDevices(info);
  if (devices.some((d) => d.device === cert.device_sign_pub)) return devices;
  return [...devices, { device: cert.device_sign_pub, kexPub: b64url.decode(cert.device_kex_pub) }];
}

/** Seal + POST one epoch-key record, skipping members with zero sealable devices (never send an unreadable grant). */
async function grantEpochKey(opts: {
  epochId: string;
  epochKey: Uint8Array;
  to: string;
  author: string;
  device: string;
  deviceSignSeed: Uint8Array;
  createdAt: string;
  recipients: SealRecipient[];
}): Promise<void> {
  if (opts.recipients.length === 0) {
    console.warn(`[runa] epoch ${opts.epochId}: skipping grant to ${opts.to} — no certified, unrevoked devices`);
    return;
  }
  const record = sealEpochKey({
    epochId: opts.epochId,
    epochKey: opts.epochKey,
    to: opts.to,
    author: opts.author,
    device: opts.device,
    deviceSignSeed: opts.deviceSignSeed,
    createdAt: opts.createdAt,
    recipients: opts.recipients,
  });
  await postRecord(record);
}

// --- rotation (§5.5) -----------------------------------------------------------

/**
 * Mint a new epoch and fan out K_e to every current member, INCLUDING a
 * self-grant to the author's own account (§5.3) so the author's other
 * devices can read their own posts from epoch zero. Members with zero
 * sealable devices are skipped, never blocking the rest of the fan-out.
 */
export async function rotateEpoch(opts: {
  session: EpochSession;
  source: ScopeSource;
  members: readonly string[]; // enumerateScope output — excludes the author
  prev?: string;
  createdAt?: string;
  store?: EpochStore;
}): Promise<AuthoredEpoch> {
  const store = opts.store ?? indexedDbEpochStore();
  const createdAt = opts.createdAt ?? nowTimestamp();
  const { root, device, cert } = opts.session;

  const { record, epochId } = makeEpoch({
    source: opts.source,
    prev: opts.prev,
    author: root.account,
    device: device.deviceId,
    deviceSignSeed: device.signSeed,
    createdAt,
  });
  await postRecord(record);

  const epochKey = crypto.getRandomValues(new Uint8Array(32));

  const selfInfo = await getAccount(root.account);
  const selfRecipients = ownDevicesIncludingSession(selfInfo, cert);
  await grantEpochKey({
    epochId,
    epochKey,
    to: root.account,
    author: root.account,
    device: device.deviceId,
    deviceSignSeed: device.signSeed,
    createdAt,
    recipients: selfRecipients,
  });

  const others = opts.members.filter((m) => m !== root.account);
  const infos = await Promise.all(
    others.map((m) =>
      getAccount(m).then(
        (info) => [m, info] as const,
        () => [m, null] as const,
      ),
    ),
  );
  for (const [member, info] of infos) {
    if (info === null) {
      console.warn(`[runa] epoch ${epochId}: could not fetch ${member} — skipping grant`);
      continue;
    }
    await grantEpochKey({
      epochId,
      epochKey,
      to: member,
      author: root.account,
      device: device.deviceId,
      deviceSignSeed: device.signSeed,
      createdAt,
      recipients: partyDevices(info),
    });
  }

  const authored: AuthoredEpoch = {
    epochId,
    record,
    scopeSource: opts.source,
    frozenMembers: [...opts.members].sort(),
    epochKey: b64url.encode(epochKey),
    selfGrantDevices: [...new Set(selfRecipients.map((r) => r.device))].sort(),
  };
  await store.putAuthoredEpoch(authored);
  await store.setCurrentEpochId(opts.source, epochId);
  return authored;
}

/**
 * Late-wrap (§5.3, design §18.1 availability model): if the author's live
 * device set has grown past what the current epoch's self-grant covers
 * (e.g. a device re-enrolled), seal one more epoch-key record wrapping ONLY
 * the newly-uncovered devices. Returns whether a wrap was issued.
 */
export async function lateWrapOwnDevices(opts: {
  session: EpochSession;
  authored: AuthoredEpoch;
  createdAt?: string;
  store?: EpochStore;
}): Promise<boolean> {
  const store = opts.store ?? indexedDbEpochStore();
  const { root, device, cert } = opts.session;

  const info = await getAccount(root.account);
  const live = ownDevicesIncludingSession(info, cert);
  const covered = new Set(opts.authored.selfGrantDevices);
  const missing = live.filter((r) => !covered.has(r.device));
  if (missing.length === 0) return false;

  const createdAt = opts.createdAt ?? nowTimestamp();
  await grantEpochKey({
    epochId: opts.authored.epochId,
    epochKey: b64url.decode(opts.authored.epochKey),
    to: root.account,
    author: root.account,
    device: device.deviceId,
    deviceSignSeed: device.signSeed,
    createdAt,
    recipients: missing,
  });

  await store.putAuthoredEpoch({
    ...opts.authored,
    selfGrantDevices: [...covered, ...missing.map((r) => r.device)].sort(),
  });
  return true;
}

/**
 * The core rotation entry point (§5.5): recompute the concrete scope set
 * from the CURRENT GraphView and, before every scoped post, rotate if the
 * set changed or the epoch aged past `epoch_max_age_days`; otherwise reuse
 * the current epoch (and opportunistically late-wrap the author's devices).
 */
export async function ensureCurrentEpoch(opts: {
  session: EpochSession;
  source: ScopeSource;
  graph: GraphView;
  constants?: Constants;
  nowIso?: string;
  store?: EpochStore;
}): Promise<{ epochId: string; epochKey: Uint8Array }> {
  const store = opts.store ?? indexedDbEpochStore();
  const nowIso = opts.nowIso ?? nowTimestamp();
  const constants = opts.constants ?? CONSTANTS;
  const currentMembers = enumerateScope(opts.graph, opts.session.root.account, opts.source, constants);

  const currentId = await store.getCurrentEpochId(opts.source);
  const current = currentId !== undefined ? await store.getAuthoredEpoch(currentId) : undefined;

  let authored: AuthoredEpoch;
  if (
    current === undefined ||
    needsRotation({
      createdAt: current.record.created_at,
      currentMembers,
      frozenMembers: current.frozenMembers,
      nowIso,
      constants,
    })
  ) {
    authored = await rotateEpoch({
      session: opts.session,
      source: opts.source,
      members: currentMembers,
      prev: current?.epochId,
      createdAt: nowIso,
      store,
    });
  } else {
    authored = current;
    await lateWrapOwnDevices({ session: opts.session, authored, createdAt: nowIso, store });
  }

  return { epochId: authored.epochId, epochKey: b64url.decode(authored.epochKey) };
}

// --- compose: seal + post one scoped post -------------------------------------

/** ensureCurrentEpoch + sealScopedPost + postRecord — the compose-side round trip (mirrors dm.ts's sendDm). */
export async function sendScopedPost(opts: {
  session: EpochSession;
  source: ScopeSource;
  body: string;
  graph: GraphView;
  constants?: Constants;
  store?: EpochStore;
  nowIso?: string;
}): Promise<ScopedPostRecord> {
  const store = opts.store ?? indexedDbEpochStore();
  const nowIso = opts.nowIso ?? nowTimestamp();
  const { epochId, epochKey } = await ensureCurrentEpoch({
    session: opts.session,
    source: opts.source,
    graph: opts.graph,
    constants: opts.constants,
    nowIso,
    store,
  });
  const record = sealScopedPost({
    body: opts.body,
    epochId,
    epochKey,
    author: opts.session.root.account,
    device: opts.session.device.deviceId,
    deviceSignSeed: opts.session.device.signSeed,
    createdAt: nowIso,
  });
  await postRecord(record);
  return record;
}

// --- key sync (GET /epochs/keys) ----------------------------------------------

/**
 * Fetch every epoch-key record granted to this viewer, verify-then-unwrap
 * each one, and persist the successes. Verification failures (tampered
 * grant, unknown author) and non-recipient wraps (rotated before this
 * device could receive it) are both skipped silently here — they surface to
 * the user as the "no key for this epoch" benign placeholder at render time,
 * never as content.
 */
export async function syncEpochKeys(opts: {
  session: EpochSession;
  store?: EpochStore;
}): Promise<ReceivedEpochKey[]> {
  const store = opts.store ?? indexedDbEpochStore();
  const { root, device } = opts.session;

  const keys: EpochKeyRecord[] = [];
  const epochsById: Record<string, EpochRecord> = {};
  let before: string | undefined;
  for (;;) {
    const page = await getEpochsKeys({ limit: 100, before });
    keys.push(...page.keys);
    Object.assign(epochsById, page.epochs);
    if (page.next_before === null) break;
    before = page.next_before;
  }

  const authors = [...new Set(keys.map((k) => k.author))];
  const certsByAuthor: Record<string, { device_certs: DeviceCert[]; device_revocations: DeviceRevoke[] }> = {};
  await Promise.all(
    authors.map((a) =>
      getAccount(a).then(
        (info) => {
          certsByAuthor[a] = { device_certs: info.device_certs, device_revocations: info.device_revocations };
        },
        () => {
          certsByAuthor[a] = { device_certs: [], device_revocations: [] };
        },
      ),
    ),
  );

  const received: ReceivedEpochKey[] = [];
  for (const key of keys) {
    if (key.to !== root.account) continue; // defensive; the server already filters to=viewer

    const authorKeys = certsByAuthor[key.author] ?? { device_certs: [], device_revocations: [] };
    try {
      verifyAuthoredRecord(key, authorKeys.device_certs, authorKeys.device_revocations);
    } catch {
      continue; // unverifiable grant — never trusted, never stored
    }

    const epochMeta = epochsById[key.epoch];
    // Content-addressing check: the inlined epoch record must actually be
    // the one this grant references (defense against a substituted inline).
    if (epochMeta === undefined || recordId(epochMeta) !== key.epoch) continue;

    let epochKey: Uint8Array;
    try {
      epochKey = openEpochKey(key, device);
    } catch {
      continue; // not sealed to this device — benign (e.g. a stale/rotated wrap)
    }

    const entry: ReceivedEpochKey = {
      epochId: key.epoch,
      epoch: { author: epochMeta.author, scope: epochMeta.scope, prev: epochMeta.prev, created_at: epochMeta.created_at },
      epochKey: b64url.encode(epochKey),
    };
    await store.putReceivedKey(entry);
    received.push(entry);
  }
  return received;
}

// --- decrypt-for-render --------------------------------------------------------

export interface EpochKeyMaterial {
  epochKey: Uint8Array;
  scopeSource: ScopeSource;
}

/** Look up decryption material for one epoch, checking authored epochs first (own posts), then received grants. */
export async function getEpochKeyMaterial(
  epochId: string,
  store: EpochStore = indexedDbEpochStore(),
): Promise<EpochKeyMaterial | undefined> {
  const authored = await store.getAuthoredEpoch(epochId);
  if (authored !== undefined) return { epochKey: b64url.decode(authored.epochKey), scopeSource: authored.scopeSource };
  const received = await store.getReceivedKey(epochId);
  if (received !== undefined) return { epochKey: b64url.decode(received.epochKey), scopeSource: received.epoch.scope.source };
  return undefined;
}

export type OpenScopedPostResult =
  | { ok: true; body: string; scopeSource: ScopeSource }
  | {
      ok: false;
      /**
       * "no-key": distinguished benign state — shared before this device
       * could receive the epoch key (or key sync hasn't run yet).
       * "verification-failed": AEAD/binding failure with a key we DO hold —
       * render as tampered, never as content. (Signature + cert-chain
       * verification happens earlier, generically, alongside every other
       * record type — see ui/Posts.tsx / ui/Feed.tsx.)
       */
      reason: "no-key" | "verification-failed";
      detail: string;
    };

/** Decrypt one scoped-post record given (possibly absent) key material. Pure — no IO. */
export function openScopedPostRecord(
  record: ScopedPostRecord,
  keyMaterial: EpochKeyMaterial | undefined,
): OpenScopedPostResult {
  if (keyMaterial === undefined) {
    return {
      ok: false,
      reason: "no-key",
      detail: "no epoch key for this post on this device yet",
    };
  }
  try {
    const plaintext = openScopedPost(record, keyMaterial.epochKey);
    return { ok: true, body: plaintext.body, scopeSource: keyMaterial.scopeSource };
  } catch (e) {
    return { ok: false, reason: "verification-failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Batch helper for rendering a page of scoped posts: sync this viewer's key
 * grants (best-effort — a sync failure just means fewer keys resolve, not a
 * hard error), resolve key material for every distinct epoch referenced,
 * then open each record. Records MUST already have passed
 * verifyAuthoredRecord — this function only decrypts.
 */
export async function decryptScopedPosts(opts: {
  session: EpochSession;
  records: readonly ScopedPostRecord[];
  store?: EpochStore;
  sync?: boolean; // default true; callers that already synced this render pass can skip it
}): Promise<Map<string, OpenScopedPostResult>> {
  const store = opts.store ?? indexedDbEpochStore();
  if (opts.sync ?? true) {
    await syncEpochKeys({ session: opts.session, store }).catch(() => []);
  }
  const epochIds = [...new Set(opts.records.map((r) => r.epoch))];
  const materials = new Map<string, EpochKeyMaterial | undefined>(
    await Promise.all(
      epochIds.map(async (id) => [id, await getEpochKeyMaterial(id, store)] as const),
    ),
  );
  const out = new Map<string, OpenScopedPostResult>();
  for (const record of opts.records) {
    out.set(recordId(record), openScopedPostRecord(record, materials.get(record.epoch)));
  }
  return out;
}
