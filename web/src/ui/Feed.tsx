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
import { decryptScopedPosts, type OpenScopedPostResult } from "../crypto/epochs.js";
import { instanceConstants, rankFeed, type RankedFeed, type RankedItem } from "../feed/rank.js";
import { AccountLabel } from "./AccountLabel.js";
import { AudienceBadge } from "./AudienceBadge.js";
import { ReplyComposer } from "./ReplyComposer.js";
import { ReportDialog, ReportLink } from "./Report.js";
import { verifiedDisplayName } from "./authors.js";
import { useAttestedCache, VerifiedBadge } from "./attested.js";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconMessage,
  IconRefresh,
  IconReply,
  IconReplyMarker,
  Loading,
} from "./icons.js";
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

  if (error) return <p className="error-text">Could not load feed: {error}</p>;
  if (state === null) return <Loading label="Loading feed…" />;

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
        <p className="notice notice-warn" title="design §15: clients compute with the instance's values and badge deviations">
          <IconAlert size={14} />
          <span>this instance runs non-default constants: {deviantKeys.join(", ")}</span>
        </p>
      )}
      {ranked.diverged && (
        <p className="notice notice-berry" title="design §3.3: the server proposes, the client decides — that this is visible is the audit working">
          <IconAlert size={14} />
          <span>server ranking diverged from local computation — showing local</span>
        </p>
      )}

      {ranked.normal.length === 0 && (
        <p className="muted">
          Nothing in your feed yet — follow an account (Profile tab → view an account id → Follow).
        </p>
      )}
      {ranked.normal.map(card)}

      {hidden > 0 && (
        <div style={{ margin: "0.75rem 0" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setExpanded((e) => !e)}>
            <span style={{ display: "inline-flex", transform: expanded ? "rotate(180deg)" : undefined }}>
              <IconChevronDown size={14} />
            </span>
            {expanded
              ? "Hide below-threshold posts"
              : `${hidden} more post${hidden === 1 ? "" : "s"} below your trust threshold`}
          </button>
          {expanded && <div style={{ marginTop: "0.6rem" }}>{ranked.belowThreshold.map(card)}</div>}
        </div>
      )}

      <footer className="row faint" style={{ marginTop: "1rem" }}>
        <span title="2-hop slice fetch · local trustMap + re-rank (design §13 latency habit)">
          slice {Math.round(sliceMs)}ms · recompute {Math.round(recomputeMs)}ms
        </span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => load().catch((e) => setError(String(e)))}>
          <IconRefresh size={13} />
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

function replyCountLabel(n: number): string {
  return `${n} repl${n === 1 ? "y" : "ies"}`;
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
  const [reporting, setReporting] = useState(false);
  const { record, author } = item.item;
  if (error !== null) {
    // Verification failed: visible placeholder, content never rendered.
    return (
      <div className="card card-error">
        <strong>Unverifiable record</strong> — not displayed.
        <div className="muted">{error}</div>
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
      <div className={benign ? "card card-muted" : "card card-error"}>
        <div className="card-head">
          <strong>Unreadable scoped post</strong>
          <AudienceBadge record={record} opened={opened} />
        </div>
        {benign ? (
          <div className="muted">
            Shared before this device could receive the epoch key — try syncing again later.
          </div>
        ) : (
          <div className="muted">Failed to decrypt ({opened?.detail}) — not displayed.</div>
        )}
        <div className="card-foot">{record.created_at}</div>
      </div>
    );
  }

  const body = scoped && opened?.ok ? opened.body : String(record.body ?? "");
  return (
    <div className="card">
      <div className="card-head">
        <AccountLabel
          id={author}
          name={name}
          onClick={() => onViewAccount(author)}
          suffix={attested[author] !== undefined ? <VerifiedBadge since={attested[author]} /> : undefined}
        />
        <span className="faint" title="effective trust, recomputed locally from your 2-hop slice">
          {item.own ? "you" : `trust ${trimTrust(item.trust)}`}
        </span>
        <span className="spacer" />
        <AudienceBadge record={record} opened={opened} />
      </div>
      <div className="card-body">{body}</div>
      {typeof record.reply_to === "string" && (
        <div className="card-foot">
          <IconReplyMarker size={12} />
          <span>reply ·</span>
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
      <div className="card-foot">
        <span>{record.created_at}</span>
        <span className="verified-check" title="signature and device-cert chain verified by this client">
          <IconCheck size={12} /> verified
        </span>
        <span className="spacer" />
        {!scoped && record.type === "post" && (
          <>
            <button
              className="link-quiet"
              title="view thread"
              onClick={() => onOpenPost(item.id)}
            >
              <IconMessage size={13} />
              {replyCountLabel(item.item.reply_count)}
            </button>
            <button className="link-quiet" onClick={() => setReplying((r) => !r)}>
              <IconReply size={13} />
              {replying ? "Cancel" : "Reply"}
            </button>
          </>
        )}
        {!item.own && !reporting && <ReportLink onClick={() => setReporting(true)} />}
      </div>
      {reporting && (
        <div style={{ marginTop: "0.5rem" }}>
          <ReportDialog
            session={session}
            subject={author}
            record={item.id}
            plaintext={scoped && opened?.ok ? opened.body : undefined}
            contentLabel="post"
            onClose={() => setReporting(false)}
          />
        </div>
      )}
      {replying && !scoped && record.type === "post" && (
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
  );
}

function trimTrust(t: number): string {
  return (Math.round(t * 100) / 100).toString();
}
