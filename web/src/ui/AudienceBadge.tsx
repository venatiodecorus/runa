/**
 * Per-post visibility indicator: 🌐 for tier-1 public plaintext, 🔒 for
 * tier-3 scoped posts (protocol §5). A scoped post this client could open
 * is labeled with its audience scope ("My follows" / "My web" — the
 * author's "my") — readable here precisely because the author's epoch-key
 * delivery reached this account through the follow graph, never because
 * the server decided so.
 */
import type { RunaRecord } from "@runa/core";
import { scopeLabel, type OpenScopedPostResult } from "../crypto/epochs.js";
import { styles } from "./theme.js";

export function AudienceBadge({ record, opened }: { record: RunaRecord; opened?: OpenScopedPostResult }) {
  const style = { ...styles.muted, marginLeft: "0.5rem" };
  if (record.type !== "scoped-post") {
    return (
      <span style={style} title="public plaintext — stored and served unencrypted, readable by anyone">
        🌐 Public
      </span>
    );
  }
  const title = opened?.ok
    ? "protocol §5: encrypted under a rotating epoch key — you can read this because the author's key delivery includes you (your place in their follow graph), not because the server granted access"
    : "protocol §5: encrypted under a rotating epoch key, member-only delivery";
  return (
    <span style={style} title={title}>
      🔒 {opened?.ok ? scopeLabel(opened.scopeSource) : "Scoped"}
    </span>
  );
}
