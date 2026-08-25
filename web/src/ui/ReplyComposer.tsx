/**
 * Inline reply composer: a tier-1 public `post` record with `reply_to` set
 * (protocol §6 "Replies & threads" — replies are never blocked or metered,
 * throttle-don't-silence). Mirrors Home.tsx's public-post path exactly. A
 * failed send never clears the draft.
 */
import { useState } from "react";
import { nowTimestamp, signRecord } from "@runa/core";
import { postRecord } from "../api/client.js";
import type { Session } from "./session.js";
import { IconSend } from "./icons.js";

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
        className="textarea"
        rows={2}
        placeholder="Write a reply… (public)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoFocus={autoFocus}
      />
      {error && <p className="error-text">{error}</p>}
      <div className="row" style={{ marginTop: "0.4rem" }}>
        <button className="btn btn-primary btn-sm" disabled={busy || body.trim().length === 0} onClick={send}>
          <IconSend size={13} />
          {busy ? "Sending…" : "Send"}
        </button>
        {onCancel && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
