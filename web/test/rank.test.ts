/**
 * Pure feed re-ranking (src/feed/rank.ts): the client-authority half of
 * design §3.3. Ranking must agree with @runa/core's trustMap, muting must
 * prune, the divergence flag must fire when the server's proposed order
 * differs, and instance-constant overrides must change bucketing.
 */
import { describe, expect, it } from "vitest";
import { CONSTANTS, trustMap, type GraphView } from "@runa/core";
import type { FeedItem } from "../src/api/client.js";
import { bucketReplies, instanceConstants, rankFeed } from "../src/feed/rank.js";

const V = "viewer";

function item(author: string, created_at: string, body: string, candidate = 0, reply_count = 0): FeedItem {
  return {
    record: { v: 1, type: "post", author, device: "dev", created_at, body, sig: "s" },
    author,
    candidate_trust: candidate,
    reply_count,
  };
}

// V follows A and B; both follow C. trust: A=1, B=1, C=2·0.35=0.7.
const graph: GraphView = {
  follows: { [V]: ["A", "B"], A: ["C"], B: ["C"] },
  mutes: [],
};

const items = [
  item("A", "2026-08-20T12:00:00Z", "a-old"),
  item("B", "2026-08-20T13:00:00Z", "b"),
  item("A", "2026-08-20T14:00:00Z", "a-new"),
  item("C", "2026-08-20T15:00:00Z", "c"),
];

describe("rankFeed", () => {
  it("assigns every non-own item exactly the trustMap value (never reimplemented)", () => {
    const ranked = rankFeed(V, items, graph);
    const tm = trustMap(V, graph);
    for (const r of [...ranked.normal, ...ranked.belowThreshold, ...ranked.noPath]) {
      expect(r.trust).toBe(tm[r.item.author] ?? 0);
    }
  });

  it("orders by trust desc, then created_at desc", () => {
    const ranked = rankFeed(V, items, graph);
    expect(ranked.normal.map((r) => String(r.item.record.body))).toEqual([
      "a-new", // trust 1.0, newest
      "b", // trust 1.0, older
      "a-old", // trust 1.0, oldest
      "c", // trust 0.7 (two hop-2 paths), despite being the newest post
    ]);
    expect(ranked.belowThreshold).toHaveLength(0);
    // The fixture's server order (a-old first) disagrees with the local order.
    expect(ranked.diverged).toBe(true);
  });

  it("does not diverge when the server proposes the same normal-bucket order", () => {
    const serverOrdered = [items[2]!, items[1]!, items[0]!, items[3]!];
    expect(rankFeed(V, serverOrdered, graph).diverged).toBe(false);
  });

  it("flags divergence when the server's order differs, and still ranks locally", () => {
    const shuffled = [items[3]!, items[0]!, items[1]!, items[2]!];
    const ranked = rankFeed(V, shuffled, graph);
    expect(ranked.diverged).toBe(true);
    expect(ranked.normal.map((r) => String(r.item.record.body))).toEqual([
      "a-new",
      "b",
      "a-old",
      "c",
    ]);
  });

  it("muting A zeroes A and halves C's hop-2 support", () => {
    const mutedGraph: GraphView = { ...graph, mutes: ["A"] };
    const ranked = rankFeed(V, items, mutedGraph);
    const bodies = ranked.normal.map((r) => String(r.item.record.body));
    expect(bodies).toEqual(["b", "c"]); // C now 0.35 via B only — still ≥ 0.3
    expect(ranked.noPath.map((r) => r.item.author)).toEqual(["A", "A"]);
  });

  it("muting both middlemen leaves C with no path at all", () => {
    const ranked = rankFeed(V, items, { ...graph, mutes: ["A", "B"] });
    expect(ranked.normal).toHaveLength(0);
    expect(ranked.noPath).toHaveLength(4);
  });

  it("an instance threshold override moves hop-2 posts below the fold", () => {
    const { constants } = instanceConstants({ feed_surface_threshold: 0.8 });
    const ranked = rankFeed(V, items, graph, constants);
    expect(ranked.normal.map((r) => String(r.item.record.body))).toEqual(["a-new", "b", "a-old"]);
    expect(ranked.belowThreshold.map((r) => String(r.item.record.body))).toEqual(["c"]); // 0.7 < 0.8
  });

  it("an instance decay override changes computed trust", () => {
    const { constants } = instanceConstants({ per_hop_decay: 0.1 });
    const ranked = rankFeed(V, items, graph, constants);
    const c = ranked.normal.find((r) => r.item.author === "C");
    expect(c).toBeUndefined(); // 2 · 0.1 = 0.2 < 0.3 → below-threshold
    expect(ranked.belowThreshold.map((r) => r.item.author)).toEqual(["C"]);
    expect(ranked.belowThreshold[0]!.trust).toBeCloseTo(0.2);
  });

  it("the viewer's own posts are always normal-bucket and marked own", () => {
    const ranked = rankFeed(V, [item(V, "2026-08-20T16:00:00Z", "mine"), ...items], graph);
    expect(ranked.normal[0]).toMatchObject({ own: true });
    expect(String(ranked.normal[0]!.item.record.body)).toBe("mine");
  });
});

describe("instanceConstants", () => {
  it("uses reference defaults for keys the instance omits", () => {
    const { constants, deviantKeys } = instanceConstants({ per_hop_decay: 0.5 });
    expect(constants).toEqual({
      per_hop_decay: 0.5,
      multi_path_sum_cap: CONSTANTS.multi_path_sum_cap,
      feed_surface_threshold: CONSTANTS.feed_surface_threshold,
    });
    expect(deviantKeys).toEqual(["per_hop_decay"]);
  });

  it("reports no deviation for a null /meta or exact reference values", () => {
    expect(instanceConstants(null).deviantKeys).toEqual([]);
    expect(instanceConstants({ ...CONSTANTS }).deviantKeys).toEqual([]);
  });

  it("badges deviations on non-trust constants too (design §15)", () => {
    const { deviantKeys } = instanceConstants({ ...CONSTANTS, cold_budget_open: 7 });
    expect(deviantKeys).toEqual(["cold_budget_open"]);
  });
});

describe("bucketReplies", () => {
  it("shows a followed replier's reply in the normal bucket", () => {
    const reply = item("A", "2026-08-20T12:00:00Z", "reply-a");
    const { normal, collapsed } = bucketReplies(V, "someone-else", [reply], graph);
    expect(normal.map((r) => r.item.author)).toEqual(["A"]);
    expect(collapsed).toHaveLength(0);
  });

  it("collapses a stranger's reply with no trust path", () => {
    const reply = item("stranger", "2026-08-20T12:00:00Z", "reply-x");
    const { normal, collapsed } = bucketReplies(V, "someone-else", [reply], graph);
    expect(normal).toHaveLength(0);
    expect(collapsed.map((r) => r.item.author)).toEqual(["stranger"]);
  });

  it("always shows the viewer's own reply and the post author's reply, even with no trust path", () => {
    const own = item(V, "2026-08-20T12:00:00Z", "mine");
    const authorReply = item("stranger-author", "2026-08-20T12:05:00Z", "author-reply");
    const { normal, collapsed } = bucketReplies(V, "stranger-author", [own, authorReply], graph);
    expect(normal.map((r) => r.item.author)).toEqual([V, "stranger-author"]);
    expect(normal.find((r) => r.item.author === V)).toMatchObject({ own: true });
    expect(collapsed).toHaveLength(0);
  });

  it("sorts each bucket chronologically ascending by created_at, not by trust", () => {
    const items2 = [
      item("A", "2026-08-20T14:00:00Z", "a-later"),
      item("B", "2026-08-20T12:00:00Z", "b-earlier"),
    ];
    const { normal } = bucketReplies(V, "someone-else", items2, graph);
    expect(normal.map((r) => String(r.item.record.body))).toEqual(["b-earlier", "a-later"]);
  });

  it("collapses a muted author's reply even though they're followed", () => {
    const mutedGraph: GraphView = { ...graph, mutes: ["A"] };
    const reply = item("A", "2026-08-20T12:00:00Z", "muted-reply");
    const { normal, collapsed } = bucketReplies(V, "someone-else", [reply], mutedGraph);
    expect(normal).toHaveLength(0);
    expect(collapsed.map((r) => r.item.author)).toEqual(["A"]);
  });
});
