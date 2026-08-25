/**
 * Thread view for a single record (protocol §6 "Replies & threads"):
 * GET /records/{id} for the root + GET /records/{id}/replies for every
 * reply, oldest first. Same verify-before-render discipline as Feed/Posts —
 * an unverifiable record is a visible placeholder, never its content.
 * Replies are bucketed exactly like the feed (bucketReplies, feed/rank.ts):
 * the viewer's own, the post author's, and normal-trust replies always show
 * (in thread order); everyone else collapses behind a count, because trust
 * gates rank, never existence (protocol §6).
 */
import { useCallback, useEffect, useState } from "react";
import { recordId, verifyAuthoredRecord } from "@runa/core";
import {
  ApiError,
  fetchMeta,
  getGraph2Hop,
  getRecord,
  getReplies,
  type FeedAuthor,
  type FeedItem,
  type RecordResponse,
} from "../api/client.js";
import { bucketReplies, instanceConstants, type BucketedReplies, type RankedItem } from "../feed/rank.js";
import type { GraphView, TrustConstants } from "@runa/core";
import { AccountLabel } from "./AccountLabel.js";
import { ReplyComposer } from "./ReplyComposer.js";
import { ReportDialog, ReportLink } from "./Report.js";
import { verifiedDisplayName } from "./authors.js";
import { useAttestedCache, VerifiedBadge } from "./attested.js";
import {
  IconAlert,
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconReplyMarker,
  Loading,
} from "./icons.js";
import type { AttestedCache } from "../verify/attestations.js";
import type { Session } from "./session.js";

interface LoadedState {
  recordRes: RecordResponse;
  rootError: string | null;
  items: FeedItem[];
  authors: Record<string, FeedAuthor>;
  errors: Map<string, string | null>;
  bucketed: BucketedReplies;
  nextAfter: string | null;
  graph: GraphView;
  constants: TrustConstants;
  deviantKeys: string[];
}

/**
 * recordId is total over well-formed records; a malformed reply must not
 * crash the thread view (it renders as the unverifiable placeholder anyway),
 * so fall back to a best-effort stable key — mirrors feed/rank.ts's
 * safeRecordId, kept local since that helper isn't exported.
 */
function safeReplyId(item: FeedItem): string {
  try {
    return recordId(item.record);
  } catch {
    return `unverifiable:${item.author}:${String(item.record.created_at)}:${String(item.record.sig ?? "")}`;
  }
}

function verifyReplyItems(items: FeedItem[], authors: Record<string, FeedAuthor>): Map<string, string | null> {
  const errors = new Map<string, string | null>();
  for (const item of items) {
    const id = safeReplyId(item);
    const author = authors[item.author];
    try {
      verifyAuthoredRecord(item.record, author?.device_certs ?? [], author?.device_revocations ?? []);
      errors.set(id, null);
    } catch (e) {
      errors.set(id, e instanceof Error ? e.message : String(e));
    }
  }
  return errors;
}

function mergeReplyItems(prev: FeedItem[], next: FeedItem[]): FeedItem[] {
  const map = new Map<string, FeedItem>();
  for (const item of prev) map.set(safeReplyId(item), item);
  for (const item of next) map.set(safeReplyId(item), item);
  return [...map.values()];
}

function replyCountLabel(n: number): string {
  return `${n} repl${n === 1 ? "y" : "ies"} · view thread`;
}

export function PostPage({
  session,
  id,
  imageboard,
  onBack,
  onOpenPost,
  onViewAccount,
}: {
  session: Session;
  id: string;
  imageboard: boolean;
  onBack: () => void;
  onOpenPost: (id: string) => void;
  onViewAccount: (id: string) => void;
}) {
  const [state, setState] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCollapsed, setShowCollapsed] = useState(false);
  const [reportingRoot, setReportingRoot] = useState(false);
  const { attested } = useAttestedCache();

  const load = useCallback(async (): Promise<LoadedState> => {
    const [recordRes, repliesRes, graph, meta] = await Promise.all([
      getRecord(id),
      getReplies(id, { limit: 50 }),
      getGraph2Hop(),
      fetchMeta().catch(() => null),
    ]);
    const { constants, deviantKeys } = instanceConstants(meta?.constants);
    let rootError: string | null = null;
    try {
      verifyAuthoredRecord(recordRes.record, recordRes.author.device_certs, recordRes.author.device_revocations);
    } catch (e) {
      rootError = e instanceof Error ? e.message : String(e);
    }
    const errors = verifyReplyItems(repliesRes.items, repliesRes.authors);
    const bucketed = bucketReplies(session.root.account, recordRes.record.author, repliesRes.items, graph, constants);
    return {
      recordRes,
      rootError,
      items: repliesRes.items,
      authors: repliesRes.authors,
      errors,
      bucketed,
      nextAfter: repliesRes.next_after,
      graph,
      constants,
      deviantKeys,
    };
  }, [id, session]);

  useEffect(() => {
    setState(null);
    setError(null);
    setShowCollapsed(false);
    load()
      .then(setState)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          setError("Post not found, or not public.");
        } else {
          setError(String(e));
        }
      });
  }, [load]);

  const reloadReplies = useCallback(async () => {
    const page = await getReplies(id, { limit: 50 });
    setState((prev) => {
      if (!prev) return prev;
      const errors = verifyReplyItems(page.items, page.authors);
      const bucketed = bucketReplies(
        session.root.account,
        prev.recordRes.record.author,
        page.items,
        prev.graph,
        prev.constants,
      );
      return { ...prev, items: page.items, authors: page.authors, errors, bucketed, nextAfter: page.next_after };
    });
  }, [id, session]);

  const loadMore = async () => {
    if (state === null || state.nextAfter === null) return;
    try {
      const page = await getReplies(id, { limit: 50, after: state.nextAfter });
      setState((prev) => {
        if (!prev) return prev;
        const items = mergeReplyItems(prev.items, page.items);
        const authors = { ...prev.authors, ...page.authors };
        const errors = verifyReplyItems(items, authors);
        const bucketed = bucketReplies(
          session.root.account,
          prev.recordRes.record.author,
          items,
          prev.graph,
          prev.constants,
        );
        return { ...prev, items, authors, errors, bucketed, nextAfter: page.next_after };
      });
    } catch (e) {
      setError(String(e));
    }
  };

  if (error) {
    return (
      <section>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={15} />
          Back
        </button>
        <p className="error-text" style={{ marginTop: "0.75rem" }}>{error}</p>
      </section>
    );
  }
  if (state === null) return <Loading label="Loading thread…" />;

  const { recordRes, rootError, authors, errors, bucketed, nextAfter, deviantKeys } = state;
  const rootName = verifiedDisplayName(recordRes.record.author, recordRes.author, imageboard);

  return (
    <section>
      <div className="row" style={{ marginBottom: "1rem" }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={15} />
          Back
        </button>
        <h2 style={{ margin: 0 }}>Thread</h2>
      </div>

      {deviantKeys.length > 0 && (
        <p className="notice notice-warn" title="design §15: clients compute with the instance's values and badge deviations">
          <IconAlert size={14} />
          <span>this instance runs non-default constants: {deviantKeys.join(", ")}</span>
        </p>
      )}

      {rootError !== null ? (
        <div className="card card-error">
          <strong>Unverifiable record</strong> — not displayed.
          <div className="muted">{rootError}</div>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <AccountLabel
              id={recordRes.record.author}
              name={rootName}
              onClick={() => onViewAccount(recordRes.record.author)}
              suffix={
                attested[recordRes.record.author] !== undefined ? (
                  <VerifiedBadge since={attested[recordRes.record.author]} />
                ) : undefined
              }
            />
          </div>
          <div className="card-body">{String(recordRes.record.body ?? "")}</div>
          <div className="card-foot">
            <span>{recordRes.record.created_at}</span>
            <span className="verified-check" title="signature and device-cert chain verified by this client">
              <IconCheck size={12} /> verified
            </span>
            <span className="spacer" />
            {recordRes.record.author !== session.root.account && !reportingRoot && (
              <ReportLink onClick={() => setReportingRoot(true)} />
            )}
          </div>
          {reportingRoot && (
            <div style={{ marginTop: "0.5rem" }}>
              <ReportDialog
                session={session}
                subject={recordRes.record.author}
                record={id}
                contentLabel="post"
                onClose={() => setReportingRoot(false)}
              />
            </div>
          )}
          {typeof recordRes.record.reply_to === "string" && (
            <div className="card-foot">
              <IconReplyMarker size={12} />
              <span>reply ·</span>
              <a
                href="#"
                title="open the thread this post replies into"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenPost(String(recordRes.record.reply_to));
                }}
              >
                view parent
              </a>
            </div>
          )}
        </div>
      )}

      {rootError === null && (
        <ReplyComposer
          session={session}
          parentId={id}
          onPosted={() => reloadReplies().catch((e) => setError(String(e)))}
        />
      )}

      <h3>Replies</h3>
      {bucketed.normal.length === 0 && bucketed.collapsed.length === 0 && (
        <p className="muted">No replies yet.</p>
      )}
      {bucketed.normal.map((r) => (
        <ReplyCard
          key={r.id}
          item={r}
          error={errors.get(r.id) ?? null}
          authorBundle={authors[r.item.author]}
          imageboard={imageboard}
          muted={false}
          attested={attested}
          session={session}
          onOpenPost={onOpenPost}
          onViewAccount={onViewAccount}
        />
      ))}

      {bucketed.collapsed.length > 0 && (
        <div style={{ margin: "0.75rem 0" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowCollapsed((v) => !v)}>
            <span style={{ display: "inline-flex", transform: showCollapsed ? "rotate(180deg)" : undefined }}>
              <IconChevronDown size={14} />
            </span>
            {showCollapsed
              ? "Hide"
              : `${bucketed.collapsed.length} repl${bucketed.collapsed.length === 1 ? "y" : "ies"} from outside your web`}
          </button>
          {showCollapsed && (
            <div style={{ marginTop: "0.6rem" }}>
              {bucketed.collapsed.map((r) => (
                <ReplyCard
                  key={r.id}
                  item={r}
                  error={errors.get(r.id) ?? null}
                  authorBundle={authors[r.item.author]}
                  imageboard={imageboard}
                  muted
                  attested={attested}
                  session={session}
                  onOpenPost={onOpenPost}
                  onViewAccount={onViewAccount}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {nextAfter !== null && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginTop: "0.75rem" }}
          onClick={() => loadMore().catch((e) => setError(String(e)))}
        >
          Load more replies
        </button>
      )}
    </section>
  );
}

function ReplyCard({
  item,
  error,
  authorBundle,
  imageboard,
  muted,
  attested,
  session,
  onOpenPost,
  onViewAccount,
}: {
  item: RankedItem;
  error: string | null;
  authorBundle?: FeedAuthor;
  imageboard: boolean;
  muted: boolean;
  attested: AttestedCache;
  session: Session;
  onOpenPost: (id: string) => void;
  onViewAccount: (id: string) => void;
}) {
  const [reporting, setReporting] = useState(false);
  if (error !== null) {
    return (
      <div className="card card-error">
        <strong>Unverifiable record</strong> — not displayed.
        <div className="muted">{error}</div>
      </div>
    );
  }
  const { record, author } = item.item;
  const name = verifiedDisplayName(author, authorBundle, imageboard);
  const own = author === session.root.account;
  return (
    <div className={muted ? "card card-muted" : "card"}>
      <div className="card-head">
        <AccountLabel
          id={author}
          name={name}
          onClick={() => onViewAccount(author)}
          suffix={attested[author] !== undefined ? <VerifiedBadge since={attested[author]} /> : undefined}
        />
      </div>
      <div className="card-body">{String(record.body ?? "")}</div>
      <div className="card-foot">
        <span>{record.created_at}</span>
        <span className="verified-check" title="signature and device-cert chain verified by this client">
          <IconCheck size={12} /> verified
        </span>
        <span className="spacer" />
        {item.item.reply_count > 0 && (
          <button className="link-quiet" title="view thread" onClick={() => onOpenPost(item.id)}>
            {replyCountLabel(item.item.reply_count)}
          </button>
        )}
        {!own && !reporting && <ReportLink onClick={() => setReporting(true)} />}
      </div>
      {reporting && (
        <div style={{ marginTop: "0.5rem" }}>
          <ReportDialog
            session={session}
            subject={author}
            record={item.id}
            contentLabel="post"
            onClose={() => setReporting(false)}
          />
        </div>
      )}
    </div>
  );
}
