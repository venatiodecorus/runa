/**
 * Client-side feed re-ranking (trust-and-reach §2, design §3.3): the server's
 * candidate order is a PROPOSAL; nothing renders as trusted unless this
 * module's own computation agrees. All trust math comes from @runa/core —
 * never reimplemented here.
 *
 * Framework-free and DOM-free so it is unit-testable under plain node.
 */
import {
  CONSTANTS,
  effectiveTrust,
  feedBucket,
  recordId,
  trustMap,
  type GraphView,
  type TrustConstants,
} from "@runa/core";
import type { FeedItem } from "../api/client.js";

/**
 * Merge the instance's published constants (/meta, design §15) over the
 * reference defaults — per-key fallback to CONSTANTS when the instance omits
 * one — and report which reference constants the instance deviates on.
 */
export function instanceConstants(meta: Record<string, number> | null | undefined): {
  constants: TrustConstants;
  deviantKeys: string[];
} {
  const constants: TrustConstants = {
    per_hop_decay: meta?.per_hop_decay ?? CONSTANTS.per_hop_decay,
    multi_path_sum_cap: meta?.multi_path_sum_cap ?? CONSTANTS.multi_path_sum_cap,
    feed_surface_threshold: meta?.feed_surface_threshold ?? CONSTANTS.feed_surface_threshold,
  };
  const deviantKeys = (Object.keys(CONSTANTS) as Array<keyof typeof CONSTANTS>).filter(
    (k) => meta?.[k] !== undefined && meta[k] !== CONSTANTS[k],
  );
  return { constants, deviantKeys };
}

export interface RankedItem {
  item: FeedItem;
  /** Content-addressed record id (for divergence comparison + stable keys). */
  id: string;
  /** Client-computed effective trust (standing 1.0 pre-M7). */
  trust: number;
  /** The viewer's own record — always visible, trust not defined by spec. */
  own: boolean;
}

export interface RankedFeed {
  /** effective_trust ≥ threshold — the feed proper, in local order. */
  normal: RankedItem[];
  /** 0 < effective_trust < threshold — exists, collapsed by default. */
  belowThreshold: RankedItem[];
  /** No trust path (incl. muted authors) — pull-only, never surfaced here. */
  noPath: RankedItem[];
  /** Server candidate order ≠ local order for the normal bucket (§3.3 audit). */
  diverged: boolean;
}

/** trust desc, then created_at desc, then record id asc (determinism). */
function compareRanked(a: RankedItem, b: RankedItem): number {
  if (a.trust !== b.trust) return b.trust - a.trust;
  const ca = String(a.item.record.created_at);
  const cb = String(b.item.record.created_at);
  if (ca !== cb) return ca < cb ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Recompute effective trust for every candidate from the viewer's entitled
 * 2-hop slice, re-rank, and bucket. `constants` should come from
 * instanceConstants(meta.constants); defaults to the reference table.
 */
export function rankFeed(
  viewer: string,
  items: FeedItem[],
  graph: GraphView,
  constants: TrustConstants = CONSTANTS,
): RankedFeed {
  const trust = trustMap(viewer, graph, constants);
  const ranked: RankedItem[] = items.map((item) => {
    const own = item.author === viewer;
    // Own content is outside trust (core throws on self-trust): always
    // visible, ranked at the cap so recency orders it among top items.
    const subjective = own ? constants.multi_path_sum_cap : (trust[item.author] ?? 0);
    return {
      item,
      id: safeRecordId(item),
      trust: effectiveTrust(subjective), // standing constant 1.0 in the PoC
      own,
    };
  });

  const normal: RankedItem[] = [];
  const belowThreshold: RankedItem[] = [];
  const noPath: RankedItem[] = [];
  for (const r of ranked) {
    const bucket = r.own ? "normal" : feedBucket(r.trust, constants);
    if (bucket === "normal") normal.push(r);
    else if (bucket === "below-threshold") belowThreshold.push(r);
    else noPath.push(r);
  }
  normal.sort(compareRanked);
  belowThreshold.sort(compareRanked);
  noPath.sort(compareRanked);

  // Divergence check: the server's candidate order, restricted to the records
  // that ended up in the local normal bucket, must match the local order.
  const normalIds = new Set(normal.map((r) => r.id));
  const serverOrder = ranked.filter((r) => normalIds.has(r.id)).map((r) => r.id);
  const localOrder = normal.map((r) => r.id);
  const diverged = serverOrder.some((id, i) => id !== localOrder[i]);

  return { normal, belowThreshold, noPath, diverged };
}

/**
 * recordId canonicalizes and rejects floats; a malformed record must not
 * crash ranking (it will render as the unverifiable placeholder anyway),
 * so fall back to a best-effort stable key.
 */
function safeRecordId(item: FeedItem): string {
  try {
    return recordId(item.record);
  } catch {
    return `unverifiable:${item.author}:${String(item.record.created_at)}:${String(item.record.sig ?? "")}`;
  }
}

export interface BucketedReplies {
  /** Always shown in-thread: the viewer's own, the post author's, and normal-trust replies. */
  normal: RankedItem[];
  /** Below-threshold or no-path replies from anyone other than the viewer or the post's author. */
  collapsed: RankedItem[];
}

/** created_at asc, then record id asc — thread order, not trust order. */
function compareThreadOrder(a: RankedItem, b: RankedItem): number {
  const ca = String(a.item.record.created_at);
  const cb = String(b.item.record.created_at);
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Bucket one thread's replies for display under a post (design §3.3 applied
 * in-thread rather than across the feed): the viewer's own replies and the
 * post author's replies always show, since the thread belongs to them;
 * everyone else follows the normal feed-bucket cut. Trust math is the exact
 * same `trustMap` call as `rankFeed` — never reimplemented — but the buckets
 * are sorted chronologically, because the reader is inside one conversation,
 * not scanning a ranked feed.
 */
export function bucketReplies(
  viewer: string,
  postAuthor: string,
  items: FeedItem[],
  graph: GraphView,
  constants: TrustConstants = CONSTANTS,
): BucketedReplies {
  const trust = trustMap(viewer, graph, constants);
  const normal: RankedItem[] = [];
  const collapsed: RankedItem[] = [];
  for (const item of items) {
    const own = item.author === viewer;
    // Own content is outside trust (core throws on self-trust); rank it at
    // the cap, matching rankFeed's treatment.
    const subjective = own ? constants.multi_path_sum_cap : (trust[item.author] ?? 0);
    const ranked: RankedItem = {
      item,
      id: safeRecordId(item),
      trust: effectiveTrust(subjective),
      own,
    };
    const alwaysShown = own || item.author === postAuthor;
    if (alwaysShown || feedBucket(ranked.trust, constants) === "normal") {
      normal.push(ranked);
    } else {
      collapsed.push(ranked);
    }
  }
  normal.sort(compareThreadOrder);
  collapsed.sort(compareThreadOrder);
  return { normal, collapsed };
}
