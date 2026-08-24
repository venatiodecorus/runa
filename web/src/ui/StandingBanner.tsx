/**
 * "Your reach is currently limited" banner (protocol §9.3 `GET /standing`,
 * design §4.2 "told that, not why"): fetched once per session load — the
 * `useStanding` hook re-fires only when the session object itself changes
 * (login/logout), never on route navigation, so the endpoint is never
 * hammered. Names mechanisms only, in plain language — never numbers,
 * thresholds, reporters, or counts — and is quietly dismissible per session.
 */
import { useEffect, useState } from "react";
import { getStanding, type StandingInfo } from "../api/client.js";
import { styles } from "./theme.js";
import type { Session } from "./session.js";

/** Fetches GET /standing once when a session appears; null while unknown/unauthenticated/unreachable. */
export function useStanding(session: Session | null): StandingInfo | null {
  const [standing, setStanding] = useState<StandingInfo | null>(null);
  useEffect(() => {
    if (session === null) {
      setStanding(null);
      return;
    }
    let cancelled = false;
    getStanding().then(
      (s) => {
        if (!cancelled) setStanding(s);
      },
      () => {
        // A failed fetch (older server, transient network) just means no
        // banner — standing is advisory display, never gates the app.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session]);
  return standing;
}

function reasonLabel(reason: string, frozenUntil: string | null): string {
  if (reason === "reports") return "due to reports";
  if (reason === "adjudication") return "due to a moderation decision";
  if (reason === "frozen") {
    return frozenUntil !== null ? `cold outreach frozen until ${formatDate(frozenUntil)}` : "cold outreach frozen";
  }
  return reason; // forward-compatible: an unrecognized reason still renders as-is, never hidden
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function StandingBanner({ standing }: { standing: StandingInfo | null }) {
  const [dismissed, setDismissed] = useState(false);
  if (standing === null || !standing.limited || dismissed) return null;
  const reasons = standing.reasons.length > 0 ? standing.reasons : ["reports"];
  return (
    <div
      style={{
        ...styles.noticeCard,
        marginBottom: "1rem",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
      }}
    >
      <span>
        Your reach is currently limited ({reasons.map((r) => reasonLabel(r, standing.frozen_until)).join(", ")}).
      </span>
      <span style={{ flex: 1 }} />
      <button style={styles.button} onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
