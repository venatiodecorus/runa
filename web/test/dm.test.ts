/**
 * Tier-2 DM client logic (protocol §4): recipient-set enumeration
 * (revoked-device exclusion, zero-device refusal), the sendDm round trip
 * through a minimally mocked fetch, and openDmRecord's failure paths —
 * fixtures built with the SAME core primitives the app uses (no crypto
 * reimplementation here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import {
  conversationId,
  openDm,
  sealDm,
  type DmRecord,
  type SealRecipient,
} from "@runa/core";
import {
  buildDeviceCert,
  buildDeviceRevoke,
  deviceFromSeeds,
  rootFromSeed,
  type DeviceKeys,
  type RootKey,
} from "../src/crypto/keys.js";
import { dmRecipientSet, partyDevices, type DmParty } from "../src/dm/recipients.js";
import { openDmRecord, sendDm, type AuthorKeys, type DmSession } from "../src/dm/dm.js";
import { setSessionToken, type AccountInfo } from "../src/api/client.js";

const TS = "2026-08-20T12:00:00Z";

function mkDevice(n: number): DeviceKeys {
  return deviceFromSeeds(
    hexToBytes(n.toString(16).padStart(2, "0").repeat(32)),
    hexToBytes((n + 1).toString(16).padStart(2, "0").repeat(32)),
  );
}

// Two accounts: A with devices a1,a2 — B with devices b1,b2 (b2 revoked) + b3.
const rootA: RootKey = rootFromSeed(hexToBytes("a1".repeat(32)));
const rootB: RootKey = rootFromSeed(hexToBytes("b1".repeat(32)));
const a1 = mkDevice(0x10);
const a2 = mkDevice(0x20);
const b1 = mkDevice(0x30);
const b2 = mkDevice(0x40);
const b3 = mkDevice(0x50);

const certA1 = buildDeviceCert(rootA, a1, "a1", TS);
const certA2 = buildDeviceCert(rootA, a2, "a2", TS);
const certB1 = buildDeviceCert(rootB, b1, "b1", TS);
const certB2 = buildDeviceCert(rootB, b2, "b2", TS);
const certB3 = buildDeviceCert(rootB, b3, "b3", TS);
const revokeB2 = buildDeviceRevoke(rootB, b2.deviceId, "2026-08-20T13:00:00Z");

const partyA: DmParty = {
  account: rootA.account,
  device_certs: [certA1, certA2],
  device_revocations: [],
};
const partyB: DmParty = {
  account: rootB.account,
  device_certs: [certB1, certB2],
  device_revocations: [revokeB2],
};

const sessionA: DmSession = { root: rootA, device: a1, cert: certA1 };

function keysOf(party: DmParty): AuthorKeys {
  return { device_certs: party.device_certs, device_revocations: party.device_revocations };
}
const certsByAccount: Record<string, AuthorKeys> = {
  [rootA.account]: keysOf(partyA),
  [rootB.account]: keysOf(partyB),
};

function ids(rs: SealRecipient[]): string[] {
  return rs.map((r) => r.device).sort();
}

describe("dm recipient set (protocol §4: all certified, unrevoked devices of both)", () => {
  it("unions both participants' devices and excludes revoked ones", () => {
    const rs = dmRecipientSet(partyA, partyB);
    expect(ids(rs)).toEqual([a1.deviceId, a2.deviceId, b1.deviceId].sort());
    expect(ids(rs)).not.toContain(b2.deviceId);
  });

  it("refuses to send when the recipient has zero unrevoked devices", () => {
    const dead: DmParty = {
      account: rootB.account,
      device_certs: [certB2],
      device_revocations: [revokeB2],
    };
    expect(() => dmRecipientSet(partyA, dead)).toThrow(/refusing to send/);
  });

  it("skips certs that fail verification (tampered kex key)", () => {
    const tampered = { ...certB1, device_kex_pub: b3.kexPubB64 }; // sig no longer matches
    const devices = partyDevices({
      account: rootB.account,
      device_certs: [tampered, certB3],
      device_revocations: [],
    });
    expect(ids(devices)).toEqual([b3.deviceId]);
  });

  it("ignores revocations not signed by the account root", () => {
    const forgedRevoke = buildDeviceRevoke(rootA, b1.deviceId, TS); // wrong root
    const devices = partyDevices({
      account: rootB.account,
      device_certs: [certB1],
      device_revocations: [forgedRevoke],
    });
    expect(ids(devices)).toEqual([b1.deviceId]);
  });

  it("merges the session's own cert when the server view lags it", () => {
    const laggy: DmParty = { account: rootA.account, device_certs: [certA2], device_revocations: [] };
    const rs = dmRecipientSet(laggy, partyB, certA1);
    expect(ids(rs)).toContain(a1.deviceId);
  });

  it("dedupes for self-DM (both parties the same account)", () => {
    const rs = dmRecipientSet(partyA, partyA, certA1);
    expect(ids(rs)).toEqual([a1.deviceId, a2.deviceId].sort());
  });
});

// --- sendDm round trip through a minimally mocked fetch ----------------------

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}
const calls: Call[] = [];
let responses: Array<{ status: number; body: unknown }> = [];

function mockFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
}

function accountInfo(party: DmParty): AccountInfo {
  return {
    account: party.account,
    profile: null,
    device_certs: party.device_certs,
    device_revocations: party.device_revocations,
    follower_count: 0,
  };
}

beforeEach(() => {
  calls.length = 0;
  responses = [];
  setSessionToken("tok-dm");
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionToken(null);
});

describe("sendDm", () => {
  it("fetches both accounts, seals to the full device set, posts, and the recipient can open", async () => {
    responses = [
      { status: 200, body: accountInfo(partyA) },
      { status: 200, body: accountInfo(partyB) },
      { status: 201, body: { id: "rec-1" } },
    ];
    const record = await sendDm(sessionA, rootB.account, "hello, over ciphertext");

    expect(calls[0]!.url).toBe(`/api/v1/accounts/${encodeURIComponent(rootA.account)}`);
    expect(calls[1]!.url).toBe(`/api/v1/accounts/${encodeURIComponent(rootB.account)}`);
    expect(calls[2]).toMatchObject({ url: "/api/v1/records", method: "POST" });
    expect(calls[2]!.headers.get("Authorization")).toBe("Bearer tok-dm");

    const posted = calls[2]!.body as DmRecord;
    expect(posted.type).toBe("dm");
    expect(posted.to).toBe(rootB.account);
    expect(posted).toEqual(record);
    // Sealed to a1, a2, b1 — NOT the revoked b2.
    expect(posted.recipients.map((r) => r.device).sort()).toEqual(
      [a1.deviceId, a2.deviceId, b1.deviceId].sort(),
    );
    // No plaintext anywhere in the posted body.
    expect(JSON.stringify(posted)).not.toContain("hello, over ciphertext");

    // Recipient device decrypts via core openDm; conversation binding matches.
    const plain = openDm(posted, b1);
    expect(plain.body).toBe("hello, over ciphertext");
    expect(plain.conversation).toBe(conversationId([rootA.account, rootB.account]));

    // Full client-side open path as B's session.
    const opened = openDmRecord(posted, certsByAccount, { root: rootB, device: b1 });
    expect(opened).toMatchObject({ ok: true, body: "hello, over ciphertext" });

    // Sender's OTHER device (a2) can also read its own conversation.
    const openedA2 = openDmRecord(posted, certsByAccount, { root: rootA, device: a2 });
    expect(openedA2).toMatchObject({ ok: true, body: "hello, over ciphertext" });
  });

  it("refuses (and does not POST) when the recipient has no unrevoked devices", async () => {
    responses = [
      { status: 200, body: accountInfo(partyA) },
      {
        status: 200,
        body: accountInfo({ account: rootB.account, device_certs: [certB2], device_revocations: [revokeB2] }),
      },
    ];
    await expect(sendDm(sessionA, rootB.account, "x")).rejects.toThrow(/refusing to send/);
    expect(calls.filter((c) => c.url === "/api/v1/records")).toHaveLength(0);
  });
});

// --- openDmRecord failure paths ----------------------------------------------

function seal(opts: { body?: string; participants?: string[]; recipients?: SealRecipient[] }): DmRecord {
  return sealDm({
    body: opts.body ?? "fixture",
    participants: opts.participants ?? [rootA.account, rootB.account],
    to: rootB.account,
    author: rootA.account,
    device: a1.deviceId,
    deviceSignSeed: a1.signSeed,
    createdAt: TS,
    recipients:
      opts.recipients ?? [
        { device: a1.deviceId, kexPub: a1.kexPub },
        { device: b1.deviceId, kexPub: b1.kexPub },
      ],
  });
}

describe("openDmRecord (verify FIRST, decrypt second, binding third)", () => {
  const viewerB = { root: rootB, device: b1 };

  it("returns ok for a valid record", () => {
    const res = openDmRecord(seal({}), certsByAccount, viewerB);
    expect(res).toEqual({
      ok: true,
      body: "fixture",
      conversation: conversationId([rootA.account, rootB.account]),
    });
  });

  it("tampered record → verification-failed (never rendered)", () => {
    const rec = seal({});
    const tampered = { ...rec, to: rootA.account }; // header change breaks the signature
    const res = openDmRecord(tampered, certsByAccount, viewerB);
    expect(res).toMatchObject({ ok: false, reason: "verification-failed" });
  });

  it("tampered ciphertext → verification-failed", () => {
    const rec = seal({});
    const flipped = rec.ciphertext.startsWith("A") ? "B" + rec.ciphertext.slice(1) : "A" + rec.ciphertext.slice(1);
    const res = openDmRecord({ ...rec, ciphertext: flipped }, certsByAccount, viewerB);
    expect(res).toMatchObject({ ok: false, reason: "verification-failed" });
  });

  it("author with no known certs → verification-failed", () => {
    const res = openDmRecord(seal({}), {}, viewerB);
    expect(res).toMatchObject({ ok: false, reason: "verification-failed" });
  });

  it("record from a device revoked before it was written → verification-failed", () => {
    const rec = sealDm({
      body: "from revoked device",
      participants: [rootA.account, rootB.account],
      to: rootB.account,
      author: rootB.account,
      device: b2.deviceId,
      deviceSignSeed: b2.signSeed,
      createdAt: "2026-08-20T14:00:00Z", // after revokeB2 at 13:00
      recipients: [{ device: b1.deviceId, kexPub: b1.kexPub }],
    });
    const res = openDmRecord(rec, certsByAccount, viewerB);
    expect(res).toMatchObject({ ok: false, reason: "verification-failed" });
  });

  it("not sealed to this device → distinct benign reason (pre-enrollment message)", () => {
    // b3 is certified but was not a seal target — e.g. enrolled after send.
    const certsWithB3: Record<string, AuthorKeys> = {
      ...certsByAccount,
      [rootB.account]: { device_certs: [certB1, certB3], device_revocations: [] },
    };
    const res = openDmRecord(seal({}), certsWithB3, { root: rootB, device: b3 });
    expect(res).toMatchObject({ ok: false, reason: "not-recipient" });
  });

  it("wrong conversation binding → verification-failed (cross-conversation replay)", () => {
    const rootC = rootFromSeed(hexToBytes("c1".repeat(32)));
    // Validly signed and decryptable, but the plaintext names the A:C pair.
    const rec = seal({ participants: [rootA.account, rootC.account] });
    const res = openDmRecord(rec, certsByAccount, viewerB);
    expect(res).toMatchObject({ ok: false, reason: "verification-failed" });
    expect((res as { detail: string }).detail).toMatch(/conversation binding/);
  });

  it("record involving neither side of the viewer → verification-failed", () => {
    const rootC = rootFromSeed(hexToBytes("c1".repeat(32)));
    const res = openDmRecord(seal({}), certsByAccount, { root: rootC, device: b1 });
    expect(res).toMatchObject({ ok: false, reason: "verification-failed" });
  });
});
