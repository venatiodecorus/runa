/**
 * Inline reply composer: a tier-1 public `post` record with `reply_to` set
 * (protocol §6 "Replies & threads" — replies are never blocked or metered,
 * throttle-don't-silence). Mirrors Home.tsx's public-post path exactly. A
 * failed send never clears the draft.
 */
import { useState } from "react";
import { nowTimestamp, signRecord } from "@runa/core";
import { postRecord } from "../api/client.js";
import { styles } from "./theme.js";
import type { Session } from "./session.js";

export function ReplyComposer({
  session,
  parentId,
  onPosted,
  onCancel,
  autoFocus,
}: {
  session: Session;
  parentId: string;
  onPosted: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
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
          reply_to: parentId,
        },
        session.device.signSeed,
      );
      await postRecord(record);
      setBody("");
      onPosted();
    } catch (e) {
      // Draft preserved on failure — nothing composed is ever lost.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <textarea
        style={styles.textarea}
        rows={2}
        placeholder="Write a reply… (public)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoFocus={autoFocus}
      />
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
        <button style={styles.primaryButton} disabled={busy || body.trim().length === 0} onClick={send}>
          {busy ? "Sending…" : "Send"}
        </button>
        {onCancel && (
          <button style={styles.button} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
