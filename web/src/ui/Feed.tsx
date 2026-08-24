/**
 * Feed: server-proposed candidates (/feed) verified and RE-RANKED locally.
 * The client is the authority (design §3.3): every record is re-verified
 * against the author's cert chain, effective trust is recomputed from the
 * viewer's entitled 2-hop slice with the INSTANCE's constants (/meta,
 * reference fallback), and the local order is always what renders. Divergence
 * from the server's proposal and non-default instance constants are badged.
 *
 * Tier-3 scoped posts arrive in the same /feed response (protocol §5.6:
 * scoped posts surface only if the viewer's own trust clears
 * feed_surface_threshold, exactly as tier-1 — key possession is necessary
 * but never sufficient). Re-ranking treats them identically to tier-1 (trust
 * math is tier-blind, rankFeed never looks at `type`); this module only adds
 * decryption AFTER verification, via crypto/epochs.ts, plus a scope badge.
 *
 * Replies & threads (protocol §6): each item's reply_count and the
 * `authors[].profile` bundle ride along in the same /feed response. A
 * verified display name (authors.ts) is shown next to the identicon; a
 * tier-1 post gets an inline reply composer and a "view thread" link.
 */
import { useCallback, useEffect, useState } from "react";
import { verifyAuthoredRecord, type ScopedPostRecord } from "@runa/core";
import { fetchMeta, getFeed, getGraph2Hop, type FeedAuthor, type FeedResponse } from "../api/client.js";
import { decryptScopedPosts, scopeLabel, type OpenScopedPostResult } from "../crypto/epochs.js";
import { instanceConstants, rankFeed, type RankedFeed, type RankedItem } from "../feed/rank.js";
import { AccountLabel } from "./AccountLabel.js";
import { ReplyComposer } from "./ReplyComposer.js";
import { badgeStyle, styles } from "./theme.js";
import { verifiedDisplayName } from "./authors.js";
import { useAttestedCache, VerifiedBadge } from "./attested.js";
import type { AttestedCache } from "../verify/attestations.js";
import type { Session } from "./session.js";

interface FeedState {
  /** Kept in full so cards can read authors[author] and item.reply_count. */
  feed: FeedResponse;
  ranked: RankedFeed;
  /** Verification outcome per ranked-item id; null = verified OK. */
  errors: Map<string, string | null>;
  /** Decrypted scoped-post bodies, keyed by ranked-item id (record id). Absent = not a scoped post. */
  opened: Map<string, OpenScopedPostResult>;
  deviantKeys: string[];
  sliceMs: number;
  recomputeMs: number;
}

export function Feed({
  session,
  imageboard,
  onOpenPost,
  onViewAccount,
}: {
  session: Session;
  imageboard: boolean;
  onOpenPost: (id: string) => void;
  onViewAccount: (id: string) => void;
}) {
  const [state, setState] = useState<FeedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { attested } = useAttestedCache();

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
    const errors = verifyItems(feed, ranked);

    // Decrypt scoped posts AFTER verification — only records that verified
    // OK are ever handed to the decryptor (verify-then-decrypt-render, §5.4).
    const all = [...ranked.normal, ...ranked.belowThreshold, ...ranked.noPath];
    const scopedRecords = all
      .filter((r) => errors.get(r.id) === null && r.item.record.type === "scoped-post")
      .map((r) => r.item.record as ScopedPostRecord);
    const opened = await decryptScopedPosts({ session, records: scopedRecords });

    setState({ feed, ranked, errors, opened, deviantKeys, sliceMs, recomputeMs });
  }, [session]);

  useEffect(() => {
    setState(null);
    load().catch((e) => setError(String(e)));
  }, [load]);

  if (error) return <p style={{ color: "crimson" }}>Could not load feed: {error}</p>;
  if (state === null) return <p style={styles.muted}>Loading feed…</p>;

  const { feed, ranked, errors, opened, deviantKeys, sliceMs, recomputeMs } = state;
  const hidden = ranked.belowThreshold.length;

  const card = (r: RankedItem) => (
    <FeedCard
      key={r.id}
      item={r}
      error={errors.get(r.id) ?? null}
      opened={opened.get(r.id)}
      authorBundle={feed.authors[r.item.author]}
      imageboard={imageboard}
      session={session}
      attested={attested}
      onOpenPost={onOpenPost}
      onViewAccount={onViewAccount}
      onReplyPosted={() => load().catch((e) => setError(String(e)))}
    />
  );

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
      {ranked.normal.map(card)}

      {hidden > 0 && (
        <div style={{ margin: "0.75rem 0" }}>
          <button style={styles.button} onClick={() => setExpanded((e) => !e)}>
            {expanded
              ? "Hide below-threshold posts"
              : `${hidden} more post${hidden === 1 ? "" : "s"} below your trust threshold`}
          </button>
          {expanded && ranked.belowThreshold.map(card)}
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

function AudienceBadge({ scoped, opened }: { scoped: boolean; opened?: OpenScopedPostResult }) {
  if (!scoped) return null;
  const label = opened?.ok ? scopeLabel(opened.scopeSource) : "Scoped";
  return (
    <span
      style={{ ...styles.muted, marginLeft: "0.5rem" }}
      title="protocol §5: encrypted under a rotating epoch key, member-only delivery"
    >
      🔒 {label}
    </span>
  );
}

function replyCountLabel(n: number): string {
  return `${n} repl${n === 1 ? "y" : "ies"} · view thread`;
}

function FeedCard({
  item,
  error,
  opened,
  authorBundle,
  imageboard,
  session,
  attested,
  onOpenPost,
  onViewAccount,
  onReplyPosted,
}: {
  item: RankedItem;
  error: string | null;
  opened?: OpenScopedPostResult;
  authorBundle?: FeedAuthor;
  imageboard: boolean;
  session: Session;
  attested: AttestedCache;
  onOpenPost: (id: string) => void;
  onViewAccount: (id: string) => void;
  onReplyPosted: () => void;
}) {
  const [replying, setReplying] = useState(false);
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

  const scoped = record.type === "scoped-post";
  const name = verifiedDisplayName(author, authorBundle, imageboard);

  if (scoped && (opened === undefined || !opened.ok)) {
    // Distinguished benign state ("no-key") vs. a hard decryption failure —
    // never render content in either case (§5.4 verify-then-decrypt-render).
    const benign = opened?.reason === "no-key";
    return (
      <div style={benign ? styles.card : styles.errorCard}>
        <strong>Unreadable scoped post</strong>
        <AudienceBadge scoped={scoped} opened={opened} />
        {benign ? (
          <div style={styles.muted}>
            Shared before this device could receive the epoch key — try syncing again later.
          </div>
        ) : (
          <div style={styles.muted}>Failed to decrypt ({opened?.detail}) — not displayed.</div>
        )}
        <div style={{ ...styles.muted, marginTop: "0.3rem" }}>{record.created_at}</div>
      </div>
    );
  }

  const body = scoped && opened?.ok ? opened.body : String(record.body ?? "");
  return (
    <div style={styles.card}>
      <div style={{ ...styles.muted, marginBottom: "0.35rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
        <AccountLabel
          id={author}
          name={name}
          onClick={() => onViewAccount(author)}
          suffix={attested[author] !== undefined ? <VerifiedBadge since={attested[author]} /> : undefined}
        />
        <span title="effective trust, recomputed locally from your 2-hop slice">
          {item.own ? "you" : `trust ${trimTrust(item.trust)}`}
        </span>
        <AudienceBadge scoped={scoped} opened={opened} />
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{body}</div>
      <div style={{ ...styles.muted, marginTop: "0.4rem" }}>
        {record.created_at}
        <span title="signature and device-cert chain verified by this client"> · verified ✓</span>
      </div>
      {typeof record.reply_to === "string" && (
        <div style={{ ...styles.muted, marginTop: "0.3rem" }}>
          ↳ reply ·{" "}
          <a
            href="#"
            title="open the thread this post replies into"
            onClick={(e) => {
              e.preventDefault();
              onOpenPost(String(record.reply_to));
            }}
          >
            view parent
          </a>
        </div>
      )}
      {!scoped && record.type === "post" && (
        <div style={{ marginTop: "0.5rem" }}>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button style={styles.button} onClick={() => setReplying((r) => !r)}>
              {replying ? "Cancel reply" : "Reply"}
            </button>
            <a
              href="#"
              style={styles.muted}
              onClick={(e) => {
                e.preventDefault();
                onOpenPost(item.id);
              }}
            >
              {replyCountLabel(item.item.reply_count)}
            </a>
          </div>
          {replying && (
            <div style={{ marginTop: "0.5rem" }}>
              <ReplyComposer
                session={session}
                parentId={item.id}
                autoFocus
                onCancel={() => setReplying(false)}
                onPosted={() => {
                  setReplying(false);
                  onReplyPosted();
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function trimTrust(t: number): string {
  return (Math.round(t * 100) / 100).toString();
}
