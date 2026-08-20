/**
 * Home: compose box (tier-1 public post, device-signed) + own timeline.
 */
import { useState } from "react";
import { nowTimestamp, signRecord } from "@runa/core";
import { postRecord } from "../api/client.js";
import { PostList } from "./Posts.js";
import { styles } from "./theme.js";
import type { Session } from "./session.js";

export function Home({ session }: { session: Session }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const publish = async () => {
    const text = body.trim();
    if (text.length === 0) return;
    setBusy(true);
    setError(null);
    try {
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
      setBody("");
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div style={styles.card}>
        <textarea
          style={styles.textarea}
          rows={3}
          placeholder="What's happening?"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        <div style={{ marginTop: "0.5rem", textAlign: "right" }}>
          <button
            style={styles.primaryButton}
            disabled={busy || body.trim().length === 0}
            onClick={publish}
          >
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
      <h3>Your posts</h3>
      <PostList account={session.root.account} refreshKey={refreshKey} />
    </section>
  );
}
