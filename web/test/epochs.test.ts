/**
 * Tier-3 epoch manager (crypto/epochs.ts): rotation logic and key sync
 * against a fake API (mocked fetch, routed by URL/method rather than a
 * strict call-order queue — ensureCurrentEpoch fans out to several members
 * in parallel) and a fake in-memory EpochStore (no real IndexedDB in tests,
 * same posture as dm.test.ts's mocked fetch for network). All crypto is the
 * SAME core primitives the app uses — nothing reimplemented here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import {
  b64url,
  makeEpoch,
  openEpochKey,
  sealEpochKey,
  sealScopedPost,
  type EpochKeyRecord,
  type ScopeSource,
} from "@runa/core";
import {
  buildDeviceCert,
  deviceFromSeeds,
  rootFromSeed,
  type DeviceKeys,
  type RootKey,
} from "../src/crypto/keys.js";
import {
  decryptScopedPosts,
  ensureCurrentEpoch,
  lateWrapOwnDevices,
  openScopedPostRecord,
  rotateEpoch,
  syncEpochKeys,
  type AuthoredEpoch,
  type EpochSession,
  type EpochStore,
  type ReceivedEpochKey,
} from "../src/crypto/epochs.js";
import { setSessionToken, type AccountInfo } from "../src/api/client.js";

const T0 = "2026-08-01T00:00:00Z";

function mkDevice(n: number): DeviceKeys {
  return deviceFromSeeds(
    hexToBytes(n.toString(16).padStart(2, "0").repeat(32)),
    hexToBytes((n + 1).toString(16).padStart(2, "0").repeat(32)),
  );
}

const rootAlice: RootKey = rootFromSeed(hexToBytes("a1".repeat(32)));
const rootBob: RootKey = rootFromSeed(hexToBytes("b1".repeat(32)));
const rootCarol: RootKey = rootFromSeed(hexToBytes("c1".repeat(32)));

const aliceDev1 = mkDevice(0x10);
const aliceDev2 = mkDevice(0x20); // re-enrollment device, used by the late-wrap tests
const bobDev = mkDevice(0x30);
const carolDev = mkDevice(0x40);

const certAlice1 = buildDeviceCert(rootAlice, aliceDev1, "a1", T0);
const certAlice2 = buildDeviceCert(rootAlice, aliceDev2, "a2", T0);
const certBob = buildDeviceCert(rootBob, bobDev, "b1", T0);
const certCarol = buildDeviceCert(rootCarol, carolDev, "c1", T0);

const aliceSession: EpochSession = { root: rootAlice, device: aliceDev1, cert: certAlice1 };
const bobSession: EpochSession = { root: rootBob, device: bobDev, cert: certBob };

function accountInfo(root: RootKey, certs: unknown[]): AccountInfo {
  return {
    account: root.account,
    profile: null,
    device_certs: certs as AccountInfo["device_certs"],
    device_revocations: [],
    follower_count: 0,
  };
}

// --- fake in-memory EpochStore (matches dm.test.ts's mocked-fetch posture) ---

function fakeStore(): EpochStore {
  const authored = new Map<string, AuthoredEpoch>();
  const current = new Map<ScopeSource, string>();
  const received = new Map<string, ReceivedEpochKey>();
  return {
    getAuthoredEpoch: async (id) => authored.get(id),
    putAuthoredEpoch: async (e) => {
      authored.set(e.epochId, e);
    },
    getCurrentEpochId: async (s) => current.get(s),
    setCurrentEpochId: async (s, id) => {
      current.set(s, id);
    },
    getReceivedKey: async (id) => received.get(id),
    putReceivedKey: async (k) => {
      received.set(k.epochId, k);
    },
  };
}

// --- mock fetch: routed by URL/method, robust to parallel fan-out calls -----

interface Call {
  url: string;
  method: string;
  body: unknown;
}
const calls: Call[] = [];
let accounts: Record<string, AccountInfo> = {};
let epochsKeysPages: Array<{ status: number; body: unknown }> = [];
let recCounter = 0;

function mockFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    if (method === "GET" && url.startsWith("/api/v1/accounts/")) {
      const id = decodeURIComponent(url.slice("/api/v1/accounts/".length));
      const info = accounts[id];
      if (info === undefined) {
        return new Response(JSON.stringify({ error: { code: "unknown_account", message: "no" } }), { status: 404 });
      }
      return new Response(JSON.stringify(info), { status: 200 });
    }
    if (method === "POST" && url === "/api/v1/records") {
      return new Response(JSON.stringify({ id: `rec-${recCounter++}` }), { status: 201 });
    }
    if (method === "GET" && url.startsWith("/api/v1/epochs/keys")) {
      const page = epochsKeysPages.shift() ?? { status: 200, body: { keys: [], epochs: {}, next_before: null } };
      return new Response(JSON.stringify(page.body), { status: page.status });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
  recCounter = 0;
  accounts = {
    [rootAlice.account]: accountInfo(rootAlice, [certAlice1]),
    [rootBob.account]: accountInfo(rootBob, [certBob]),
    [rootCarol.account]: accountInfo(rootCarol, [certCarol]),
  };
  epochsKeysPages = [];
  setSessionToken("tok-epochs");
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionToken(null);
});

function postedEpochKeyRecords(): EpochKeyRecord[] {
  return calls
    .filter((c) => c.method === "POST" && c.url === "/api/v1/records")
    .map((c) => c.body as EpochKeyRecord)
    .filter((r) => r.type === "epoch-key");
}

// --- rotation ------------------------------------------------------------------

describe("ensureCurrentEpoch / rotateEpoch (§5.5)", () => {
  it("first call for a scope mints an epoch and fans out to every member, including a self-grant", async () => {
    const store = fakeStore();
    const graph = { follows: { [rootAlice.account]: [rootBob.account] } };

    const { epochId, epochKey } = await ensureCurrentEpoch({
      session: aliceSession,
      source: "follows",
      graph,
      nowIso: T0,
      store,
    });

    expect(epochKey).toHaveLength(32);
    expect(await store.getCurrentEpochId("follows")).toBe(epochId);

    const grants = postedEpochKeyRecords();
    expect(grants.map((g) => g.to).sort()).toEqual([rootAlice.account, rootBob.account].sort());

    // Every device wrapped can unwrap to the SAME key the manager returned.
    const selfGrant = grants.find((g) => g.to === rootAlice.account)!;
    const bobGrant = grants.find((g) => g.to === rootBob.account)!;
    expect(openEpochKey(selfGrant, aliceDev1)).toEqual(epochKey);
    expect(openEpochKey(bobGrant, bobDev)).toEqual(epochKey);
  });

  it("reuses the current epoch when the member set is unchanged and it hasn't aged out", async () => {
    const store = fakeStore();
    const graph = { follows: { [rootAlice.account]: [rootBob.account] } };
    const first = await ensureCurrentEpoch({ session: aliceSession, source: "follows", graph, nowIso: T0, store });

    calls.length = 0;
    const second = await ensureCurrentEpoch({
      session: aliceSession,
      source: "follows",
      graph,
      nowIso: "2026-08-02T00:00:00Z", // one day later — within epoch_max_age_days
      store,
    });

    expect(second.epochId).toBe(first.epochId);
    expect(second.epochKey).toEqual(first.epochKey);
    // No rotation → no new epoch/epoch-key POSTs (only the late-wrap device check GET).
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("member-set change triggers a new epoch with prev linkage and a FULL re-fan-out", async () => {
    const store = fakeStore();
    const graph1 = { follows: { [rootAlice.account]: [rootBob.account] } };
    const first = await ensureCurrentEpoch({ session: aliceSession, source: "follows", graph: graph1, nowIso: T0, store });

    calls.length = 0;
    const graph2 = { follows: { [rootAlice.account]: [rootBob.account, rootCarol.account] } };
    const second = await ensureCurrentEpoch({
      session: aliceSession,
      source: "follows",
      graph: graph2,
      nowIso: "2026-08-01T01:00:00Z",
      store,
    });

    expect(second.epochId).not.toBe(first.epochId);
    const newEpochPost = calls.find((c) => c.method === "POST" && c.url === "/api/v1/records" && (c.body as { type: string }).type === "epoch")!;
    expect((newEpochPost.body as { prev: string }).prev).toBe(first.epochId);

    // Full re-fan-out: bob is re-granted under the NEW epoch even though
    // nothing about bob's membership changed, plus the new member carol.
    const grants = postedEpochKeyRecords();
    expect(grants.map((g) => g.to).sort()).toEqual(
      [rootAlice.account, rootBob.account, rootCarol.account].sort(),
    );
    expect(grants.every((g) => g.epoch === second.epochId)).toBe(true);
  });

  it("age past epoch_max_age_days triggers rotation even with an unchanged member set", async () => {
    const store = fakeStore();
    const graph = { follows: { [rootAlice.account]: [rootBob.account] } };
    const first = await ensureCurrentEpoch({ session: aliceSession, source: "follows", graph, nowIso: T0, store });

    const second = await ensureCurrentEpoch({
      session: aliceSession,
      source: "follows",
      graph,
      nowIso: "2026-09-15T00:00:00Z", // > 30 days (CONSTANTS.epoch_max_age_days) after T0
      store,
    });

    expect(second.epochId).not.toBe(first.epochId);
  });

  it("skips a member with zero certified devices instead of failing the whole rotation", async () => {
    const store = fakeStore();
    accounts[rootCarol.account] = accountInfo(rootCarol, []); // no devices
    const graph = { follows: { [rootAlice.account]: [rootBob.account, rootCarol.account] } };

    await ensureCurrentEpoch({ session: aliceSession, source: "follows", graph, nowIso: T0, store });

    const grants = postedEpochKeyRecords();
    expect(grants.map((g) => g.to)).not.toContain(rootCarol.account);
    expect(grants.map((g) => g.to)).toContain(rootBob.account);
  });
});

// --- late-wrap (§5.3) ------------------------------------------------------------

describe("lateWrapOwnDevices", () => {
  it("wraps only the newly-uncovered device when the author re-enrolls one", async () => {
    const store = fakeStore();
    const { record, epochId } = makeEpoch({
      source: "follows",
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const epochKey = hexToBytes("77".repeat(32));
    const authored: AuthoredEpoch = {
      epochId,
      record,
      scopeSource: "follows",
      frozenMembers: [],
      epochKey: b64url.encode(epochKey),
      selfGrantDevices: [aliceDev1.deviceId], // device 2 not covered yet
    };
    await store.putAuthoredEpoch(authored);

    accounts[rootAlice.account] = accountInfo(rootAlice, [certAlice1, certAlice2]); // re-enrolled

    const wrapped = await lateWrapOwnDevices({ session: aliceSession, authored, createdAt: T0, store });
    expect(wrapped).toBe(true);

    const grants = postedEpochKeyRecords();
    expect(grants).toHaveLength(1);
    expect(grants[0]!.to).toBe(rootAlice.account);
    // Covers ONLY the new device — not re-wrapping device 1.
    expect(grants[0]!.recipients.map((r) => r.device)).toEqual([aliceDev2.deviceId]);
    expect(openEpochKey(grants[0]!, aliceDev2)).toEqual(epochKey);

    const updated = await store.getAuthoredEpoch(epochId);
    expect(updated!.selfGrantDevices.sort()).toEqual([aliceDev1.deviceId, aliceDev2.deviceId].sort());
  });

  it("is a no-op when every live device is already covered", async () => {
    const store = fakeStore();
    const { record, epochId } = makeEpoch({
      source: "follows",
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const authored: AuthoredEpoch = {
      epochId,
      record,
      scopeSource: "follows",
      frozenMembers: [],
      epochKey: b64url.encode(hexToBytes("77".repeat(32))),
      selfGrantDevices: [aliceDev1.deviceId],
    };
    await store.putAuthoredEpoch(authored);

    const wrapped = await lateWrapOwnDevices({ session: aliceSession, authored, createdAt: T0, store });
    expect(wrapped).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("ensureCurrentEpoch's reuse path late-wraps automatically, without rotating", async () => {
    const store = fakeStore();
    const graph = { follows: { [rootAlice.account]: [rootBob.account] } };
    const first = await ensureCurrentEpoch({ session: aliceSession, source: "follows", graph, nowIso: T0, store });

    accounts[rootAlice.account] = accountInfo(rootAlice, [certAlice1, certAlice2]); // re-enrolled elsewhere
    calls.length = 0;
    const second = await ensureCurrentEpoch({
      session: aliceSession,
      source: "follows",
      graph,
      nowIso: "2026-08-02T00:00:00Z",
      store,
    });

    expect(second.epochId).toBe(first.epochId); // reused, not rotated
    const grants = postedEpochKeyRecords();
    expect(grants).toHaveLength(1); // just the late-wrap
    expect(grants[0]!.recipients.map((r) => r.device)).toEqual([aliceDev2.deviceId]);
  });
});

// --- key sync (GET /epochs/keys) --------------------------------------------------

describe("syncEpochKeys", () => {
  it("verifies, unwraps, and stores a granted epoch key", async () => {
    const { record: epochRecord, epochId } = makeEpoch({
      source: "web",
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const epochKeyBytes = hexToBytes("aa".repeat(32));
    const grant = sealEpochKey({
      epochId,
      epochKey: epochKeyBytes,
      to: rootBob.account,
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
      recipients: [{ device: bobDev.deviceId, kexPub: bobDev.kexPub }],
    });
    epochsKeysPages = [{ status: 200, body: { keys: [grant], epochs: { [epochId]: epochRecord }, next_before: null } }];

    const store = fakeStore();
    const received = await syncEpochKeys({ session: bobSession, store });

    expect(received).toHaveLength(1);
    expect(received[0]!.epochId).toBe(epochId);
    expect(b64url.decode(received[0]!.epochKey)).toEqual(epochKeyBytes);
    expect(received[0]!.epoch.scope.source).toBe("web");

    const stored = await store.getReceivedKey(epochId);
    expect(stored).toEqual(received[0]);
  });

  it("skips a grant with a tampered signature (never trusted, never stored)", async () => {
    const { record: epochRecord, epochId } = makeEpoch({
      source: "follows",
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const grant = sealEpochKey({
      epochId,
      epochKey: hexToBytes("bb".repeat(32)),
      to: rootBob.account,
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
      recipients: [{ device: bobDev.deviceId, kexPub: bobDev.kexPub }],
    });
    const tampered = { ...grant, to: rootCarol.account }; // header change breaks the signature
    epochsKeysPages = [{ status: 200, body: { keys: [tampered], epochs: { [epochId]: epochRecord }, next_before: null } }];

    const store = fakeStore();
    const received = await syncEpochKeys({ session: bobSession, store });
    expect(received).toHaveLength(0);
    expect(await store.getReceivedKey(epochId)).toBeUndefined();
  });

  it("a wrap not sealed to this device is skipped (benign — resolves as 'no-key' at render time)", async () => {
    const { record: epochRecord, epochId } = makeEpoch({
      source: "follows",
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const grant = sealEpochKey({
      epochId,
      epochKey: hexToBytes("cc".repeat(32)),
      to: rootBob.account,
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
      recipients: [{ device: carolDev.deviceId, kexPub: carolDev.kexPub }], // NOT bob's device
    });
    epochsKeysPages = [{ status: 200, body: { keys: [grant], epochs: { [epochId]: epochRecord }, next_before: null } }];

    const store = fakeStore();
    const received = await syncEpochKeys({ session: bobSession, store });
    expect(received).toHaveLength(0);
  });
});

// --- decrypt-for-render: missing key is a distinguished benign state -------------

describe("openScopedPostRecord / decryptScopedPosts", () => {
  it("no key material at all → benign 'no-key' state, never content", () => {
    const post = sealScopedPost({
      body: "secret",
      epochId: "some-epoch",
      epochKey: hexToBytes("dd".repeat(32)),
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const res = openScopedPostRecord(post, undefined);
    expect(res).toMatchObject({ ok: false, reason: "no-key" });
  });

  it("wrong key material → hard verification-failed, never content", () => {
    const post = sealScopedPost({
      body: "secret",
      epochId: "some-epoch",
      epochKey: hexToBytes("dd".repeat(32)),
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const res = openScopedPostRecord(post, { epochKey: hexToBytes("ee".repeat(32)), scopeSource: "follows" });
    expect(res).toMatchObject({ ok: false, reason: "verification-failed" });
  });

  it("decryptScopedPosts resolves 'no-key' for every record when the store is empty and sync is skipped", async () => {
    const post = sealScopedPost({
      body: "secret",
      epochId: "unknown-epoch",
      epochKey: hexToBytes("dd".repeat(32)),
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const store = fakeStore();
    const results = await decryptScopedPosts({ session: bobSession, records: [post], store, sync: false });
    expect(calls).toHaveLength(0); // sync skipped — no network at all
    expect([...results.values()]).toMatchObject([{ ok: false, reason: "no-key" }]);
  });

  it("decrypts correctly once the store already holds the right authored epoch key", async () => {
    const epochKeyBytes = hexToBytes("ff".repeat(32));
    const { record, epochId } = makeEpoch({
      source: "web",
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const post = sealScopedPost({
      body: "hello, my web",
      epochId,
      epochKey: epochKeyBytes,
      author: rootAlice.account,
      device: aliceDev1.deviceId,
      deviceSignSeed: aliceDev1.signSeed,
      createdAt: T0,
    });
    const store = fakeStore();
    await store.putAuthoredEpoch({
      epochId,
      record,
      scopeSource: "web",
      frozenMembers: [],
      epochKey: b64url.encode(epochKeyBytes),
      selfGrantDevices: [aliceDev1.deviceId],
    });

    const results = await decryptScopedPosts({ session: aliceSession, records: [post], store, sync: false });
    expect([...results.values()]).toEqual([{ ok: true, body: "hello, my web", scopeSource: "web" }]);
  });
});
