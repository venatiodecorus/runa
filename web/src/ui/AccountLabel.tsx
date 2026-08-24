/**
 * Account identity chip: identicon + (verified display name and/or short id).
 * Used everywhere an author or DM counterpart is shown — Feed, PostPage,
 * Posts, Messages. `name` must already have passed verifiedDisplayName
 * (authors.ts); this component renders whatever it is handed, verified or
 * not — callers are the verification boundary.
 */
import type { ReactNode } from "react";
import { Identicon } from "./Identicon.js";
import { shortId, styles } from "./theme.js";

export function AccountLabel({
  id,
  name,
  size = 20,
  onClick,
  suffix,
}: {
  id: string;
  name: string | null;
  size?: number;
  onClick?: () => void;
  suffix?: ReactNode;
}) {
  const inner = (
    <>
      <Identicon id={id} size={size} title={id} />
      {name ? (
        <>
          <strong>{name}</strong>
          <span style={{ ...styles.mono, ...styles.muted }}>{shortId(id)}</span>
        </>
      ) : (
        <span style={styles.mono}>{shortId(id)}</span>
      )}
      {suffix}
    </>
  );

  if (onClick === undefined) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }} title={id}>
        {inner}
      </span>
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      title={id}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        cursor: "pointer",
        background: "none",
        border: "none",
        padding: 0,
        font: "inherit",
        color: "inherit",
      }}
    >
      {inner}
    </span>
  );
}
