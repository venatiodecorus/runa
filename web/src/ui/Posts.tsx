/**
 * Verified timeline rendering. The client is the authority (protocol §3):
 * every record is re-verified with verifyAuthoredRecord against the author's
 * device certs/revocations before its content may render. Records that fail
 * get a visible error placeholder — never their content.
 *
 * Tier-3 scoped posts (protocol §5) are fetched alongside tier-1 posts
 * (`type=scoped-post`, same signature/cert-chain verification, no special
 * case) and, once verified, decrypted via crypto/epochs.ts's
 * decryptScopedPosts — verify-then-decrypt-render, same discipline as
 * ui/Messages.tsx. A missing epoch key is a distinguished BENIGN placeholder
 * ("shared before this device could receive the key"); a decryption/
 * verification failure is a hard-fail placeholder. Both never show content.
 */
import { useCallback, useEffect, useState } from "react";
import {
  recordId,
  verifyAuthoredRecord,
  type DeviceCert,
  type DeviceRevoke,
  type RunaRecord,
  type ScopedPostRecord,
} from "@runa/core";
import { getAccount, listRecords } from "../api/client.js";
import { decryptScopedPosts, scopeLabel, type OpenScopedPostResult } from "../crypto/epochs.js";
import { ReportDialog, ReportLink } from "./Report.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

interface VerifiedItem {
  record: RunaRecord;
  error: string | null; // null = verified OK
  /** Best-effort content-addressed id, for the "view thread" link. */
  id: string;
  /** Only present for type "scoped-post" records that verified OK. */
  opened?: OpenScopedPostResult;
}

/**
 * recordId is total over well-formed records; a malformed record must not
 * crash rendering (it shows the unverifiable placeholder anyway), so fall
 * back to a best-effort stable key.
 */
function safeId(record: RunaRecord): string {
  try {
    return recordId(record);
  } catch {
    return `unverifiable:${record.author}:${String(record.created_at)}:${String(record.sig ?? "")}`;
  }
}

export function verifyAll(
  records: RunaRecord[],
  info: { device_certs: DeviceCert[]; device_revocations: DeviceRevoke[] },
): VerifiedItem[] {
  return records.map((record) => {
    const id = safeId(record);
    try {
      // verifyAuthoredRecord re-validates the certs/revocations themselves
      // (signature + type + binding) before trusting them.
      verifyAuthoredRecord(record, info.device_certs, info.device_revocations);
      return { record, error: null, id };
    } catch (e) {
      return { record, error: e instanceof Error ? e.message : String(e), id };
    }
  });
}

/** Pagination cursors for the two independently-paged record types being merged. `null` = exhausted. */
interface Cursors {
  post: string | null;
  scoped: string | null;
}

async function fetchTypePage(
  account: string,
  type: "post" | "scoped-post",
  before: string | undefined,
): Promise<{ records: RunaRecord[]; next_before: string | null }> {
  return listRecords(account, { type, limit: 50, ...(before !== undefined ? { before } : {}) });
}

export function PostList({
  session,
  account,
  refreshKey,
  onOpenPost,
}: {
  session: Session;
  account: string;
  refreshKey?: number;
  onOpenPost?: (id: string) => void;
}) {
  const [items, setItems] = useState<VerifiedItem[] | null>(null);
  const [cursors, setCursors] = useState<Cursors | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: Cursors) => {
      const [info, postPage, scopedPage] = await Promise.all([
        getAccount(account),
        before?.post === null ? Promise.resolve({ records: [], next_before: null }) : fetchTypePage(account, "post", before?.post),
        before?.scoped === null
          ? Promise.resolve({ records: [], next_before: null })
          : fetchTypePage(account, "scoped-post", before?.scoped),
      ]);
      const verifiedPost = verifyAll(postPage.records, info);
      const verifiedScoped = verifyAll(scopedPage.records, info);

      const decryptable = verifiedScoped
        .filter((v) => v.error === null)
        .map((v) => v.record as ScopedPostRecord);
      const opened = await decryptScopedPosts({ session, records: decryptable });

      const scopedWithOpen: VerifiedItem[] = verifiedScoped.map((v) => ({
        ...v,
        opened: v.error === null ? opened.get(recordId(v.record)) : undefined,
      }));

      const page = [...verifiedPost, ...scopedWithOpen].sort((a, b) =>
        String(a.record.created_at) < String(b.record.created_at) ? 1 : -1,
      );
      setItems((prev) => (before ? mergeSorted(prev ?? [], page) : page));
      setCursors({ post: postPage.next_before, scoped: scopedPage.next_before });
    },
    [account, session],
  );

  useEffect(() => {
    setItems(null);
    setCursors(null);
    setError(null);
    load().catch((e) => setError(String(e)));
  }, [load, refreshKey]);

  if (error) return <p style={{ color: "crimson" }}>Could not load posts: {error}</p>;
  if (items === null) return <p style={styles.muted}>Loading…</p>;
  if (items.length === 0) return <p style={styles.muted}>No posts yet.</p>;

  const canLoadOlder = cursors !== null && (cursors.post !== null || cursors.scoped !== null);

  return (
    <div>
      {items.map((item, i) => (
        <PostCard key={i} item={item} session={session} onOpenPost={onOpenPost} />
      ))}
      {canLoadOlder && cursors && (
        <button style={styles.button} onClick={() => load(cursors).catch((e) => setError(String(e)))}>
          Load older
        </button>
      )}
    </div>
  );
}

/** Merge a new older page onto the existing list, keeping created_at-desc order. */
function mergeSorted(prev: VerifiedItem[], page: VerifiedItem[]): VerifiedItem[] {
  return [...prev, ...page].sort((a, b) =>
    String(a.record.created_at) < String(b.record.created_at) ? 1 : -1,
  );
}

function AudienceBadge({ record, opened }: { record: RunaRecord; opened?: OpenScopedPostResult }) {
  if (record.type !== "scoped-post") return null;
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

function PostCard({
  item,
  session,
  onOpenPost,
}: {
  item: VerifiedItem;
  session: Session;
  onOpenPost?: (id: string) => void;
}) {
  const [reporting, setReporting] = useState(false);
  const { record, error, opened, id } = item;
  const own = record.author === session.root.account;
  if (error !== null) {
    // Verification failed: visible placeholder, content never rendered.
    return (
      <div style={styles.errorCard}>
        <strong>Unverifiable record</strong> — not displayed.
        <div style={styles.muted}>{error}</div>
      </div>
    );
  }

  if (record.type === "scoped-post") {
    if (opened === undefined || !opened.ok) {
      const benign = opened?.reason === "no-key";
      return (
        <div style={benign ? styles.card : styles.errorCard}>
          <strong>Unreadable scoped post</strong>
          <AudienceBadge record={record} opened={opened} />
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
    return (
      <div style={styles.card}>
        <div style={{ whiteSpace: "pre-wrap" }}>{opened.body}</div>
        <div style={{ ...styles.muted, marginTop: "0.4rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span>
            {record.created_at} · device <span style={styles.mono}>{shortId(record.device ?? "")}</span>
            <AudienceBadge record={record} opened={opened} />
            <span title="signature, device-cert chain, and epoch decryption verified by this client"> · verified ✓</span>
          </span>
          {!own && !reporting && <ReportLink onClick={() => setReporting(true)} />}
        </div>
        {reporting && (
          <div style={{ marginTop: "0.5rem" }}>
            <ReportDialog
              session={session}
              subject={record.author}
              record={id}
              plaintext={opened.body}
              contentLabel="post"
              onClose={() => setReporting(false)}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={{ whiteSpace: "pre-wrap" }}>{String(record.body ?? "")}</div>
      <div style={{ ...styles.muted, marginTop: "0.4rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span>
          {record.created_at} · device <span style={styles.mono}>{shortId(record.device ?? "")}</span>
          <span title="signature and device-cert chain verified by this client"> · verified ✓</span>
        </span>
        {!own && !reporting && <ReportLink onClick={() => setReporting(true)} />}
      </div>
      {reporting && (
        <div style={{ marginTop: "0.5rem" }}>
          <ReportDialog
            session={session}
            subject={record.author}
            record={id}
            contentLabel="post"
            onClose={() => setReporting(false)}
          />
        </div>
      )}
      {typeof record.reply_to === "string" && (
        <div style={{ ...styles.muted, marginTop: "0.3rem" }}>
          ↳ reply
          {onOpenPost && (
            <>
              {" · "}
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
            </>
          )}
        </div>
      )}
      {onOpenPost && (
        <div style={{ ...styles.muted, marginTop: "0.3rem" }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenPost(id);
            }}
          >
            view thread
          </a>
        </div>
      )}
    </div>
  );
}
