/**
 * Verified timeline rendering. The client is the authority (protocol §3):
 * every record is re-verified with verifyAuthoredRecord against the author's
 * device certs/revocations before its content may render. Records that fail
 * get a visible error placeholder — never their content.
 */
import { useCallback, useEffect, useState } from "react";
import {
  verifyAuthoredRecord,
  type DeviceCert,
  type DeviceRevoke,
  type RunaRecord,
} from "@runa/core";
import { getAccount, listRecords } from "../api/client.js";
import { shortId, styles } from "./theme.js";

interface VerifiedItem {
  record: RunaRecord;
  error: string | null; // null = verified OK
}

export function verifyAll(
  records: RunaRecord[],
  info: { device_certs: DeviceCert[]; device_revocations: DeviceRevoke[] },
): VerifiedItem[] {
  return records.map((record) => {
    try {
      // verifyAuthoredRecord re-validates the certs/revocations themselves
      // (signature + type + binding) before trusting them.
      verifyAuthoredRecord(record, info.device_certs, info.device_revocations);
      return { record, error: null };
    } catch (e) {
      return { record, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function PostList({ account, refreshKey }: { account: string; refreshKey?: number }) {
  const [items, setItems] = useState<VerifiedItem[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      const [info, page] = await Promise.all([
        getAccount(account),
        listRecords(account, { type: "post", limit: 50, ...(before ? { before } : {}) }),
      ]);
      const verified = verifyAll(page.records, info);
      setItems((prev) => (before && prev ? [...prev, ...verified] : verified));
      setNextBefore(page.next_before);
    },
    [account],
  );

  useEffect(() => {
    setItems(null);
    setError(null);
    load().catch((e) => setError(String(e)));
  }, [load, refreshKey]);

  if (error) return <p style={{ color: "crimson" }}>Could not load posts: {error}</p>;
  if (items === null) return <p style={styles.muted}>Loading…</p>;
  if (items.length === 0) return <p style={styles.muted}>No posts yet.</p>;

  return (
    <div>
      {items.map((item, i) => (
        <PostCard key={i} item={item} />
      ))}
      {nextBefore && (
        <button style={styles.button} onClick={() => load(nextBefore).catch((e) => setError(String(e)))}>
          Load older
        </button>
      )}
    </div>
  );
}

function PostCard({ item }: { item: VerifiedItem }) {
  const { record, error } = item;
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
      <div style={{ whiteSpace: "pre-wrap" }}>{String(record.body ?? "")}</div>
      <div style={{ ...styles.muted, marginTop: "0.4rem" }}>
        {record.created_at} · device <span style={styles.mono}>{shortId(record.device ?? "")}</span>
        <span title="signature and device-cert chain verified by this client"> · verified ✓</span>
      </div>
    </div>
  );
}
