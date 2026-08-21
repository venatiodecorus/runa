/**
 * Request-tray dismissal filter (dm/requests.ts) — the pure partition over
 * conversations + the local dismissed set. (The kv-backed load/dismiss/
 * restore wrappers are one-line IndexedDB calls, exercised in the browser.)
 */
import { describe, expect, it } from "vitest";
import type { DmConversation } from "../src/api/client.js";
import { partitionRequests } from "../src/dm/requests.js";

const conv = (withId: string): DmConversation => ({
  with: withId,
  last: { created_at: "2026-08-21T00:00:00Z" } as DmConversation["last"],
  request: true,
});

describe("partitionRequests", () => {
  it("splits by the dismissed set, preserving order on both sides", () => {
    const requests = [conv("a"), conv("b"), conv("c"), conv("d")];
    const { visible, dismissed } = partitionRequests(requests, new Set(["b", "d"]));
    expect(visible.map((c) => c.with)).toEqual(["a", "c"]);
    expect(dismissed.map((c) => c.with)).toEqual(["b", "d"]);
  });

  it("empty dismissed set leaves everything visible", () => {
    const requests = [conv("a"), conv("b")];
    const { visible, dismissed } = partitionRequests(requests, new Set());
    expect(visible).toEqual(requests);
    expect(dismissed).toEqual([]);
  });

  it("dismissed ids without a live request are simply ignored", () => {
    const { visible, dismissed } = partitionRequests([conv("a")], new Set(["gone", "a"]));
    expect(visible).toEqual([]);
    expect(dismissed.map((c) => c.with)).toEqual(["a"]);
  });

  it("everything dismissed → 'Show dismissed (N)' count is the full tray", () => {
    const requests = [conv("a"), conv("b")];
    const { visible, dismissed } = partitionRequests(requests, new Set(["a", "b"]));
    expect(visible).toEqual([]);
    expect(dismissed).toHaveLength(2);
  });
});
