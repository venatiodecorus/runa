/**
 * API client shape tests with a minimally mocked fetch: request paths,
 * bodies, and the memory-only bearer-token behavior (protocol §6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import type { DeviceCert } from "@runa/core";
import {
  ApiError,
  authenticate,
  createAccount,
  getBackup,
  getDmInbox,
  getDmWith,
  getFeed,
  getFollows,
  getGraph2Hop,
  listRecords,
  postRecord,
  putBackup,
  setSessionToken,
} from "../src/api/client.js";
import { buildDeviceCert, deviceFromSeeds, rootFromSeed, signAuthChallenge } from "../src/crypto/keys.js";

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
    return new Response(next.status === 204 ? null : JSON.stringify(next.body), {
      status: next.status,
    });
  }) as unknown as typeof fetch;
}

const root = rootFromSeed(hexToBytes("11".repeat(32)));
const device = deviceFromSeeds(hexToBytes("22".repeat(32)), hexToBytes("33".repeat(32)));
const cert: DeviceCert = buildDeviceCert(root, device, "t", "2026-08-20T12:00:00Z");

beforeEach(() => {
  calls.length = 0;
  responses = [];
  setSessionToken(null);
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("createAccount posts root_pub + device_cert to /accounts", async () => {
    responses = [{ status: 201, body: { account: root.account } }];
    const res = await createAccount(root.account, cert);
    expect(res.account).toBe(root.account);
    expect(calls[0]).toMatchObject({ url: "/api/v1/accounts", method: "POST" });
    expect(calls[0]!.body).toEqual({ root_pub: root.account, device_cert: cert });
    expect(calls[0]!.headers.get("Content-Type")).toBe("application/json");
  });

  it("listRecords builds the documented query string", async () => {
    responses = [{ status: 200, body: { records: [], next_before: null } }];
    await listRecords(root.account, { type: "post", limit: 50, before: "2026-08-20T12:00:00Z" });
    expect(calls[0]!.url).toBe(
      `/api/v1/accounts/${encodeURIComponent(root.account)}/records?type=post&limit=50&before=2026-08-20T12%3A00%3A00Z`,
    );
  });

  it("authenticate signs 'runa-auth-v1:'+challenge and keeps the token in memory", async () => {
    responses = [
      { status: 200, body: { challenge: "abc123", expires_at: "later" } },
      { status: 200, body: { token: "tok-1", expires_at: "later" } },
      { status: 201, body: { id: "rec-1" } },
    ];
    await authenticate(root.account, device.deviceId, (c) => signAuthChallenge(device.signSeed, c));
    expect(calls[0]!.url).toBe("/api/v1/auth/challenge");
    expect(calls[1]).toMatchObject({ url: "/api/v1/auth/session", method: "POST" });
    expect(calls[1]!.body).toEqual({
      account: root.account,
      device: device.deviceId,
      challenge: "abc123",
      sig: signAuthChallenge(device.signSeed, "abc123"),
    });
    // subsequent authenticated call carries the bearer token
    await postRecord(cert);
    expect(calls[2]!.headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("postRecord works without a session (recovery cert is self-authorizing)", async () => {
    responses = [{ status: 201, body: { id: "rec-1" } }];
    await postRecord(cert);
    expect(calls[0]!.headers.get("Authorization")).toBeNull();
  });

  it("putBackup wraps the blob; getBackup is unauthenticated", async () => {
    setSessionToken("tok-2");
    const blob = { v: 1 as const, salt: "s", params: { m: 64, t: 1, p: 1 }, nonce: "n", ciphertext: "c" };
    responses = [{ status: 204, body: null }, { status: 200, body: { blob } }];
    await putBackup(blob);
    expect(calls[0]).toMatchObject({ url: "/api/v1/backup", method: "POST" });
    expect(calls[0]!.body).toEqual({ blob });
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok-2");
    const res = await getBackup(root.account);
    expect(res.blob).toEqual(blob);
    expect(calls[1]!.url).toBe(`/api/v1/backup/${encodeURIComponent(root.account)}`);
  });

  it("getFollows hits /accounts/{id}/follows with the bearer token (records shape)", async () => {
    setSessionToken("tok-g");
    responses = [{ status: 200, body: { follows: [cert] } }];
    const res = await getFollows(root.account);
    expect(res.follows).toEqual([cert]);
    expect(calls[0]).toMatchObject({
      url: `/api/v1/accounts/${encodeURIComponent(root.account)}/follows`,
      method: "GET",
    });
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok-g");
  });

  it("getGraph2Hop returns the plain id-list slice, authenticated", async () => {
    setSessionToken("tok-g");
    const slice = { follows: { [root.account]: ["x"], x: ["y"] }, mutes: ["z"] };
    responses = [{ status: 200, body: slice }];
    const res = await getGraph2Hop();
    expect(res).toEqual(slice);
    expect(calls[0]).toMatchObject({ url: "/api/v1/graph/2hop", method: "GET" });
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok-g");
  });

  it("getFeed returns items + authors map, authenticated", async () => {
    setSessionToken("tok-g");
    const feed = {
      items: [{ record: cert, author: root.account, candidate_trust: 0.7 }],
      authors: { [root.account]: { device_certs: [cert], device_revocations: [] } },
    };
    responses = [{ status: 200, body: feed }];
    const res = await getFeed();
    expect(res).toEqual(feed);
    expect(calls[0]).toMatchObject({ url: "/api/v1/feed", method: "GET" });
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok-g");
  });

  it("getDmWith builds the documented query string, authenticated", async () => {
    setSessionToken("tok-dm");
    responses = [{ status: 200, body: { records: [], next_before: null } }];
    const res = await getDmWith(root.account, { limit: 50, before: "2026-08-20T12:00:00Z" });
    expect(res).toEqual({ records: [], next_before: null });
    expect(calls[0]!.url).toBe(
      `/api/v1/dm/with/${encodeURIComponent(root.account)}?limit=50&before=2026-08-20T12%3A00%3A00Z`,
    );
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok-dm");
  });

  it("getDmInbox returns conversations with the request flag, authenticated", async () => {
    setSessionToken("tok-dm");
    const inbox = { conversations: [{ with: root.account, last: cert, request: true }] };
    responses = [{ status: 200, body: inbox }];
    const res = await getDmInbox();
    expect(res).toEqual(inbox);
    expect(calls[0]).toMatchObject({ url: "/api/v1/dm/inbox", method: "GET" });
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok-dm");
  });

  it("surfaces structured errors as ApiError", async () => {
    responses = [
      { status: 400, body: { error: { code: "invalid_record", message: "bad sig" } } },
    ];
    await expect(postRecord(cert)).rejects.toMatchObject({
      status: 400,
      code: "invalid_record",
      message: "bad sig",
    });
    await expect(Promise.reject(new ApiError(1, "x", "y"))).rejects.toBeInstanceOf(ApiError);
  });
});
