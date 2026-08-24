/**
 * Shared account search: fuzzy-searches the accounts the session follows
 * (dm/search.ts subsequence ranking) — plus, where the caller has them,
 * existing conversation partners — falling back to a raw pasted account id.
 * Used by the Messages "new message" box and the Profile lookup.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAccount, getGraph2Hop } from "../api/client.js";
import {
  looksLikeAccountId,
  mergeContacts,
  rankContacts,
  type Contact,
} from "../dm/search.js";
import { Identicon } from "./Identicon.js";
import { verifiedDisplayName } from "./authors.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

// --- verified-name cache ------------------------------------------------------

/**
 * Shared cache of verified display names, keyed by account id (authors.ts:
 * a display name only ever renders if its profile record verified). All
 * consumers on a page read the same cache so a name is fetched once per
 * account per session.
 */
export function useVerifiedNames(imageboard: boolean): {
  names: Record<string, string | null>;
  ensureNames: (ids: string[]) => void;
} {
  const [names, setNames] = useState<Record<string, string | null>>({});
  const namesRef = useRef<Record<string, string | null>>({});
  namesRef.current = names;
  const pendingRef = useRef<Set<string>>(new Set());

  const ensureNames = useCallback(
    (ids: string[]) => {
      const toFetch = ids.filter((id) => !(id in namesRef.current) && !pendingRef.current.has(id));
      if (toFetch.length === 0) return;
      for (const id of toFetch) pendingRef.current.add(id);
      Promise.allSettled(toFetch.map((id) => getAccount(id))).then((results) => {
        setNames((prev) => {
          const next = { ...prev };
          results.forEach((res, i) => {
            const id = toFetch[i]!;
            pendingRef.current.delete(id);
            next[id] = res.status === "fulfilled" ? verifiedDisplayName(id, res.value, imageboard) : null;
          });
          return next;
        });
      });
    },
    [imageboard],
  );

  return { names, ensureNames };
}

// --- search box ---------------------------------------------------------------

function sourceLabel(source: Contact["source"]): string {
  if (source === "both") return "following · conversation";
  if (source === "follow") return "following";
  return "conversation";
}

export function AccountSearch({
  session,
  conversationIds = [],
  names,
  ensureNames,
  placeholder,
  buttonLabel,
  emptyHint,
  onPick,
}: {
  session: Session;
  /** Existing conversation partners to search alongside follows (Messages). */
  conversationIds?: string[];
  names: Record<string, string | null>;
  ensureNames: (ids: string[]) => void;
  placeholder: string;
  buttonLabel: string;
  /** Shown when the query matches nothing and isn't a pasteable id. */
  emptyHint: string;
  onPick: (id: string) => void;
}) {
  const [follows, setFollows] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    getGraph2Hop().then(
      (g) => setFollows(g.follows[session.root.account] ?? []),
      () => setFollows([]),
    );
  }, [session.root.account]);

  const conversationIdsKey = conversationIds.join(",");
  const contactIds = useMemo(
    () => Array.from(new Set([...follows, ...conversationIds])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [follows, conversationIdsKey],
  );

  useEffect(() => {
    ensureNames(contactIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactIds.join(","), ensureNames]);

  const contacts = useMemo(
    () => mergeContacts(follows, conversationIds, names),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [follows, conversationIdsKey, names],
  );

  const trimmed = query.trim();
  const rows = focused ? rankContacts(trimmed, contacts) : [];
  const looksLikeId = looksLikeAccountId(trimmed);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  const pick = (id: string) => {
    setQuery("");
    setFocused(false);
    onPick(id);
  };

  const submit = () => {
    if (rows.length > 0) pick(rows[Math.min(highlighted, rows.length - 1)]!.id);
    else if (looksLikeId) pick(trimmed);
  };

  return (
    <div style={{ position: "relative", marginBottom: "1rem" }}>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          style={styles.input}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlighted((h) => Math.min(h + 1, Math.max(rows.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              setFocused(false);
            }
          }}
        />
        <button style={styles.primaryButton} onClick={submit} disabled={!looksLikeId && rows.length === 0}>
          {buttonLabel}
        </button>
      </div>
      {focused && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 0.25rem)",
            left: 0,
            right: 0,
            zIndex: 10,
            background: "#fff",
            border: "1px solid #ccc",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            maxHeight: 280,
            overflowY: "auto",
          }}
        >
          {rows.map((c, i) => (
            <div
              key={c.id}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c.id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.5rem 0.75rem",
                cursor: "pointer",
                background: i === highlighted ? "#eef5fc" : "transparent",
              }}
            >
              <Identicon id={c.id} size={20} />
              {c.displayName && <strong>{c.displayName}</strong>}
              <span style={{ ...styles.mono, ...styles.muted }}>{shortId(c.id)}</span>
              <span style={{ flex: 1 }} />
              <span style={styles.muted}>{sourceLabel(c.source)}</span>
            </div>
          ))}
          {rows.length === 0 && trimmed.length > 0 && !looksLikeId && (
            <p style={{ ...styles.muted, padding: "0.5rem 0.75rem", margin: 0 }}>{emptyHint}</p>
          )}
        </div>
      )}
    </div>
  );
}
