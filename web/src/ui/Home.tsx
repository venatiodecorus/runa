/**
 * Home: compose box (tier-1 public post OR tier-3 scoped post, both
 * device-signed) + own timeline. Audience selector (protocol §5.1): Public
 * uses the existing plain `post` record; "My follows"/"My web" route through
 * the epoch manager (crypto/epochs.ts) — recompute the scope's concrete
 * member set, rotate if needed (§5.5), seal, and post. A failed send NEVER
 * clears the draft (same convention as the DM composer's budget-exhausted
 * notice, dm/budget.ts).
 */
import { useState } from "react";
import { CONSTANTS, nowTimestamp, signRecord, type Constants } from "@runa/core";
import { fetchMeta, getGraph2Hop, postRecord } from "../api/client.js";
import { scopeLabel, sendScopedPost } from "../crypto/epochs.js";
import { PostList } from "./Posts.js";
import { IconLock, IconSend } from "./icons.js";
import type { Session } from "./session.js";

type Audience = "public" | "follows" | "web";

export function Home({
  session,
  imageboard: _imageboard,
  onOpenPost,
}: {
  session: Session;
  /** Own timeline stays id-only regardless — kept for call-site consistency. */
  imageboard?: boolean;
  onOpenPost?: (id: string) => void;
}) {
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<Audience>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const publish = async () => {
    const text = body.trim();
    if (text.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (audience === "public") {
        const record = signRecord(
          {
            v: 1,
            type: "post",
            author: session.root.account,
            device: session.device.deviceId,
            created_at: nowTimestamp(),
            body: text,
          },
          session.device.signSeed,
        );
        await postRecord(record);
      } else {
        // Recompute the scope's concrete set from a FRESH graph slice, per
        // §5.5 — the epoch manager rotates automatically if it changed.
        const [graph, meta] = await Promise.all([getGraph2Hop(), fetchMeta().catch(() => null)]);
        const constants: Constants = { ...CONSTANTS, ...(meta?.constants ?? {}) };
        await sendScopedPost({
          session,
          source: audience,
          body: text,
          graph,
          constants,
        });
      }
      setBody("");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      // Draft preserved on failure — nothing composed is ever lost.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="card">
        <textarea
          className="textarea"
          rows={3}
          placeholder="What's happening?"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error && <p className="error-text">{error}</p>}
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <select
            className="input"
            style={{ width: "auto" }}
            aria-label="Audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value as Audience)}
          >
            <option value="public">Public</option>
            <option value="follows">{scopeLabel("follows")}</option>
            <option value="web">{scopeLabel("web")}</option>
          </select>
          {audience !== "public" && (
            <span
              className="muted"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
              title="protocol §5: encrypted under a rotating epoch key, member-only delivery"
            >
              <IconLock size={12} /> encrypted to {audience === "follows" ? "your followers" : "your trusted web"}
            </span>
          )}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={busy || body.trim().length === 0} onClick={publish}>
            <IconSend size={13} />
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
      <h3>Your posts</h3>
      <PostList session={session} account={session.root.account} refreshKey={refreshKey} onOpenPost={onOpenPost} />
    </section>
  );
}
