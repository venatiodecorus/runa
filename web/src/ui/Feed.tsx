/**
 * Feed: server-proposed candidates (/feed) verified and RE-RANKED locally.
 * The client is the authority (design §3.3): every record is re-verified
 * against the author's cert chain, effective trust is recomputed from the
 * viewer's entitled 2-hop slice with the INSTANCE's constants (/meta,
 * reference fallback), and the local order is always what renders. Divergence
 * from the server's proposal and non-default instance constants are badged.
 */
import { useCallback, useEffect, useState } from "react";
import { verifyAuthoredRecord } from "@runa/core";
import { fetchMeta, getFeed, getGraph2Hop, type FeedResponse } from "../api/client.js";
import { instanceConstants, rankFeed, type RankedFeed, type RankedItem } from "../feed/rank.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

interface FeedState {
  ranked: RankedFeed;
  /** Verification outcome per ranked-item id; null = verified OK. */
  errors: Map<string, string | null>;
  deviantKeys: string[];
  sliceMs: number;
  recomputeMs: number;
}

export function Feed({ session }: { session: Session }) {
  const [state, setState] = useState<FeedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const t0 = performance.now();
    let sliceMs = 0;
    const [feed, graph, meta] = await Promise.all([
      getFeed(),
      getGraph2Hop().then((g) => {
        // Latency habit (poc-plan Phase 2 / design §13): measure the 2-hop
        // slice fetch and the local recompute separately.
        sliceMs = performance.now() - t0;
        return g;
      }),
      fetchMeta().catch(() => null), // constants fall back to the reference table
    ]);
    const { constants, deviantKeys } = instanceConstants(meta?.constants);
    const t1 = performance.now();
    const ranked = rankFeed(session.root.account, feed.items, graph, constants);
    const recomputeMs = performance.now() - t1;
    console.log(
      `[runa] 2-hop slice fetch ${sliceMs.toFixed(1)}ms · local trustMap+re-rank ${recomputeMs.toFixed(1)}ms` +
        ` (${feed.items.length} candidates)`,
    );
    setState({ ranked, errors: verifyItems(feed, ranked), deviantKeys, sliceMs, recomputeMs });
  }, [session.root.account]);

  useEffect(() => {
    setState(null);
    load().catch((e) => setError(String(e)));
  }, [load]);

  if (error) return <p style={{ color: "crimson" }}>Could not load feed: {error}</p>;
  if (state === null) return <p style={styles.muted}>Loading feed…</p>;

  const { ranked, errors, deviantKeys, sliceMs, recomputeMs } = state;
  const hidden = ranked.belowThreshold.length;

  return (
    <section>
      {deviantKeys.length > 0 && (
        <p style={badgeStyle("#9a6700", "#fff8e1")} title="design §15: clients compute with the instance's values and badge deviations">
          this instance runs non-default constants: {deviantKeys.join(", ")}
        </p>
      )}
      {ranked.diverged && (
        <p style={badgeStyle("#8b2252", "#fdeef5")} title="design §3.3: the server proposes, the client decides — that this is visible is the audit working">
          server ranking diverged from local computation — showing local
        </p>
      )}

      {ranked.normal.length === 0 && (
        <p style={styles.muted}>
          Nothing in your feed yet — follow an account (Profile tab → view an account id → Follow).
        </p>
      )}
      {ranked.normal.map((r) => (
        <FeedCard key={r.id} item={r} error={errors.get(r.id) ?? null} />
      ))}

      {hidden > 0 && (
        <div style={{ margin: "0.75rem 0" }}>
          <button style={styles.button} onClick={() => setExpanded((e) => !e)}>
            {expanded
              ? "Hide below-threshold posts"
              : `${hidden} more post${hidden === 1 ? "" : "s"} below your trust threshold`}
          </button>
          {expanded &&
            ranked.belowThreshold.map((r) => (
              <FeedCard key={r.id} item={r} error={errors.get(r.id) ?? null} />
            ))}
        </div>
      )}

      <footer style={{ ...styles.muted, marginTop: "1rem", display: "flex", gap: "1rem" }}>
        <span title="2-hop slice fetch · local trustMap + re-rank (design §13 latency habit)">
          slice {Math.round(sliceMs)}ms · recompute {Math.round(recomputeMs)}ms
        </span>
        <span style={{ flex: 1 }} />
        <button style={{ ...styles.button, fontSize: "1em" }} onClick={() => load().catch((e) => setError(String(e)))}>
          Refresh
        </button>
      </footer>
    </section>
  );
}

/** Verify every candidate against the feed's authors map (certs+revocations). */
function verifyItems(feed: FeedResponse, ranked: RankedFeed): Map<string, string | null> {
  const errors = new Map<string, string | null>();
  const all = [...ranked.normal, ...ranked.belowThreshold, ...ranked.noPath];
  for (const r of all) {
    const author = feed.authors[r.item.author];
    try {
      // verifyAuthoredRecord re-validates the certs/revocations themselves.
      verifyAuthoredRecord(r.item.record, author?.device_certs ?? [], author?.device_revocations ?? []);
      errors.set(r.id, null);
    } catch (e) {
      errors.set(r.id, e instanceof Error ? e.message : String(e));
    }
  }
  return errors;
}

function FeedCard({ item, error }: { item: RankedItem; error: string | null }) {
  const { record, author } = item.item;
  if (error !== null) {
    // Verification failed: visible placeholder, content never rendered.
    return (
      <div style={styles.errorCard}>
        <strong>Unverifiable record</strong> — not displayed.
        <div style={styles.muted}>{error}</div>
      </div>
    );
  }
  return (
    <div style={styles.card}>
      <div style={{ ...styles.muted, marginBottom: "0.35rem" }}>
        <span style={styles.mono} title={author}>
          {shortId(author)}
        </span>
        <span title="effective trust, recomputed locally from your 2-hop slice">
          {" "}
          · {item.own ? "you" : `trust ${trimTrust(item.trust)}`}
        </span>
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{String(record.body ?? "")}</div>
      <div style={{ ...styles.muted, marginTop: "0.4rem" }}>
        {record.created_at}
        <span title="signature and device-cert chain verified by this client"> · verified ✓</span>
      </div>
    </div>
  );
}

function trimTrust(t: number): string {
  return (Math.round(t * 100) / 100).toString();
}

function badgeStyle(color: string, background: string) {
  return {
    border: `1px solid ${color}`,
    color,
    background,
    borderRadius: 6,
    padding: "0.4rem 0.75rem",
    fontSize: "0.85em",
  } as const;
}
