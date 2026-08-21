/**
 * Messages tab: tier-2 E2E DMs (protocol §4/§6). Conversation list from
 * /dm/inbox with a separate "Requests" tray (design §5.2): Phase 4 adds
 * per-request actions — "Accept & reply" (accepting IS replying; the server
 * clears the request flag) and a local-only "Dismiss" (kv store, this
 * browser only; decline-with-report arrives with M7). Thread view decrypts +
 * verifies every record via dm/openDmRecord and renders failures as
 * placeholders, never as content. Polls inbox + open thread every 10s.
 *
 * Cold-outreach budget (M4): the composer shows the sender-side meter from
 * GET /budget unconditionally — coldness is judged from the RECIPIENT's
 * vantage, which this client cannot compute (see dm/budget.ts) — and a 429
 * budget_exhausted becomes a calm notice that never discards the draft.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordId, type DmRecord } from "@runa/core";
import {
  getAccount,
  getBudget,
  getDmInbox,
  getDmWith,
  type BudgetInfo,
  type DmConversation,
} from "../api/client.js";
import {
  auditDailyBudget,
  composerSendFailure,
  composerSendStart,
  composerSendSuccess,
  formatBudgetMeter,
  initialComposer,
  type ComposerState,
} from "../dm/budget.js";
import { openDmRecord, sendDm, type AuthorKeys } from "../dm/dm.js";
import {
  dismissRequest,
  loadDismissed,
  partitionRequests,
  restoreRequest,
} from "../dm/requests.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

const POLL_MS = 10_000;
const PAGE = 50;

// --- budget meter -------------------------------------------------------------

/**
 * GET /budget wrapper: value + manual refresh. A failing fetch hides the
 * meter rather than blocking messaging — the server still enforces.
 */
function useBudget(): { budget: BudgetInfo | null; refreshBudget: () => void } {
  const [budget, setBudget] = useState<BudgetInfo | null>(null);
  const refreshBudget = useCallback(() => {
    getBudget().then(setBudget, () => setBudget(null));
  }, []);
  useEffect(() => {
    refreshBudget();
  }, [refreshBudget]);
  return { budget, refreshBudget };
}

function BudgetMeter({ budget }: { budget: BudgetInfo | null }) {
  if (budget === null) return null;
  const audited = auditDailyBudget(budget);
  return (
    <p
      style={{ ...styles.muted, marginTop: "0.5rem", marginBottom: 0 }}
      title={
        audited
          ? "Daily budget recomputed locally with the published formula — matches the server."
          : "Warning: the server's daily_budget does not match this client's recomputation of the published formula."
      }
    >
      Cold-outreach budget: <strong>{formatBudgetMeter(budget.tokens, budget.daily_budget)}</strong>{" "}
      tokens{audited ? " ✓" : " (mismatch!)"} — messages to people who don't trust you yet cost 1
      token; warm conversations are free.
    </p>
  );
}

// --- inbox --------------------------------------------------------------------

export function Messages({ session }: { session: Session }) {
  const [conversations, setConversations] = useState<DmConversation[] | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [openWith, setOpenWith] = useState<{ id: string; focusCompose: boolean } | null>(null);
  const [newTo, setNewTo] = useState("");
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);

  const loadInbox = useCallback(async () => {
    const res = await getDmInbox();
    setConversations(res.conversations);
    setDismissed(await loadDismissed(res.conversations.filter((c) => c.request).map((c) => c.with)));
    setInboxError(null);
  }, []);

  useEffect(() => {
    loadInbox().catch((e) => setInboxError(String(e)));
    const timer = setInterval(() => {
      loadInbox().catch((e) => setInboxError(String(e)));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadInbox]);

  if (openWith !== null) {
    return (
      <Thread
        session={session}
        withId={openWith.id}
        focusCompose={openWith.focusCompose}
        onBack={() => setOpenWith(null)}
        onActivity={() => loadInbox().catch(() => {})}
      />
    );
  }

  const normal = (conversations ?? []).filter((c) => !c.request);
  const requests = (conversations ?? []).filter((c) => c.request);
  const tray = partitionRequests(requests, dismissed);

  const openNew = () => {
    const id = newTo.trim();
    if (id.length > 0) {
      setNewTo("");
      setOpenWith({ id, focusCompose: true });
    }
  };

  const dismiss = (id: string) => {
    dismissRequest(id)
      .then(() => setDismissed((prev) => new Set(prev).add(id)))
      .catch((e) => setInboxError(String(e)));
  };

  const restore = (id: string) => {
    restoreRequest(id)
      .then(() =>
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      )
      .catch((e) => setInboxError(String(e)));
  };

  return (
    <section>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <input
          style={styles.input}
          placeholder="Account id to message…"
          value={newTo}
          onChange={(e) => setNewTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openNew();
          }}
        />
        <button style={styles.primaryButton} onClick={openNew} disabled={newTo.trim().length === 0}>
          New message
        </button>
      </div>

      {inboxError && <p style={{ color: "crimson" }}>Could not load conversations: {inboxError}</p>}
      {conversations === null && !inboxError && <p style={styles.muted}>Loading conversations…</p>}

      {conversations !== null && normal.length === 0 && requests.length === 0 && (
        <p style={styles.muted}>No conversations yet — start one with an account id above.</p>
      )}

      {normal.map((c) => (
        <ConversationRow
          key={c.with}
          conv={c}
          onOpen={() => setOpenWith({ id: c.with, focusCompose: false })}
        />
      ))}

      {requests.length > 0 && (
        <>
          <h3 style={{ marginTop: "1.5rem", marginBottom: "0.25rem" }}>Requests</h3>
          <p style={styles.muted}>
            From accounts outside your web of trust — reaching you cost the sender a cold-outreach
            token. Accepting is just replying: once you reply, the conversation moves to your inbox
            and stays free for both of you. Dismissing only hides a request in this browser;
            decline-with-report arrives with the moderation milestone.
          </p>
          {tray.visible.map((c) => (
            <ConversationRow
              key={c.with}
              conv={c}
              onOpen={() => setOpenWith({ id: c.with, focusCompose: false })}
              actions={
                <>
                  <button
                    style={styles.primaryButton}
                    onClick={() => setOpenWith({ id: c.with, focusCompose: true })}
                  >
                    Accept &amp; reply
                  </button>
                  <button
                    style={styles.button}
                    title="Hides this request in this browser only — the sender is not notified."
                    onClick={() => dismiss(c.with)}
                  >
                    Dismiss
                  </button>
                </>
              }
            />
          ))}
          {tray.visible.length === 0 && tray.dismissed.length > 0 && (
            <p style={styles.muted}>No open requests.</p>
          )}
          {tray.dismissed.length > 0 && (
            <button
              style={{ ...styles.button, marginBottom: "0.75rem" }}
              onClick={() => setShowDismissed((v) => !v)}
            >
              {showDismissed ? "Hide dismissed" : `Show dismissed (${tray.dismissed.length})`}
            </button>
          )}
          {showDismissed &&
            tray.dismissed.map((c) => (
              <ConversationRow
                key={c.with}
                conv={c}
                onOpen={() => setOpenWith({ id: c.with, focusCompose: false })}
                actions={
                  <button style={styles.button} onClick={() => restore(c.with)}>
                    Restore
                  </button>
                }
              />
            ))}
        </>
      )}
    </section>
  );
}

function ConversationRow({
  conv,
  onOpen,
  actions,
}: {
  conv: DmConversation;
  onOpen: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      style={{ ...styles.card, cursor: "pointer" }}
      onClick={onOpen}
      role="button"
      title={conv.with}
    >
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "baseline" }}>
        <span style={styles.mono}>{shortId(conv.with)}</span>
        <span style={styles.muted}>🔒 encrypted</span>
        <span style={{ flex: 1 }} />
        <span style={styles.muted}>{conv.last?.created_at ?? ""}</span>
      </div>
      {actions !== undefined && (
        <div
          style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

// --- thread ------------------------------------------------------------------

interface ThreadState {
  /** record id → record; merged across initial load, polls, pages, sends. */
  byId: Record<string, DmRecord>;
  /** Cursor for OLDER history; null = no more; undefined = not loaded yet. */
  olderCursor: string | null | undefined;
  certsByAccount: Record<string, AuthorKeys>;
}

function Thread({
  session,
  withId,
  focusCompose,
  onBack,
  onActivity,
}: {
  session: Session;
  withId: string;
  focusCompose: boolean;
  onBack: () => void;
  onActivity: () => void;
}) {
  const [state, setState] = useState<ThreadState>({
    byId: {},
    olderCursor: undefined,
    certsByAccount: {},
  });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(initialComposer);
  const initialCursorSet = useRef(false);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const { budget, refreshBudget } = useBudget();

  useEffect(() => {
    if (focusCompose) composeRef.current?.focus();
  }, [focusCompose]);

  const fetchCerts = useCallback(async (): Promise<Record<string, AuthorKeys>> => {
    const ids = withId === session.root.account ? [session.root.account] : [session.root.account, withId];
    const infos = await Promise.all(
      ids.map((id) =>
        getAccount(id).then(
          (info) => [id, { device_certs: info.device_certs, device_revocations: info.device_revocations }] as const,
          () => [id, { device_certs: [], device_revocations: [] }] as const,
        ),
      ),
    );
    return Object.fromEntries(infos);
  }, [session.root.account, withId]);

  /** Latest page + fresh certs; sets the older-cursor only on the first load. */
  const loadLatest = useCallback(async () => {
    const [page, certsByAccount] = await Promise.all([getDmWith(withId, { limit: PAGE }), fetchCerts()]);
    setState((prev) => {
      const byId = { ...prev.byId };
      for (const rec of page.records) byId[recordId(rec)] = rec;
      const olderCursor = initialCursorSet.current ? prev.olderCursor : page.next_before;
      initialCursorSet.current = true;
      return { byId, olderCursor, certsByAccount };
    });
    setLoaded(true);
    setError(null);
  }, [withId, fetchCerts]);

  const loadOlder = useCallback(async () => {
    const cursor = state.olderCursor;
    if (cursor === null || cursor === undefined) return;
    const page = await getDmWith(withId, { limit: PAGE, before: cursor });
    setState((prev) => {
      const byId = { ...prev.byId };
      for (const rec of page.records) byId[recordId(rec)] = rec;
      return { ...prev, byId, olderCursor: page.next_before };
    });
  }, [withId, state.olderCursor]);

  useEffect(() => {
    initialCursorSet.current = false;
    setState({ byId: {}, olderCursor: undefined, certsByAccount: {} });
    setLoaded(false);
    loadLatest().catch((e) => setError(String(e)));
    const timer = setInterval(() => {
      loadLatest().catch((e) => setError(String(e)));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadLatest]);

  const ordered = useMemo(() => {
    return Object.entries(state.byId)
      .sort(([ia, a], [ib, b]) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : ia < ib ? -1 : 1,
      )
      .map(([id, rec]) => ({ id, rec, opened: openDmRecord(rec, state.certsByAccount, session) }));
  }, [state.byId, state.certsByAccount, session]);

  const send = async () => {
    const body = composer.draft.trim();
    if (body.length === 0 || composer.sending) return;
    setComposer(composerSendStart);
    try {
      const rec = await sendDm(session, withId, body);
      setComposer(composerSendSuccess);
      // Optimistic: show our own record immediately, then refresh.
      setState((prev) => ({ ...prev, byId: { ...prev.byId, [recordId(rec)]: rec } }));
      onActivity();
      loadLatest().catch(() => {});
    } catch (e) {
      // The draft is preserved by the state helper — nothing composed is lost.
      setComposer((prev) => composerSendFailure(prev, e));
    } finally {
      // A send may have spent (or failed to spend) a token — re-read the meter.
      refreshBudget();
    }
  };

  return (
    <section>
      <header style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", marginBottom: "0.5rem" }}>
        <button style={styles.button} onClick={onBack}>
          ← Back
        </button>
        <span style={styles.mono} title={withId}>
          {shortId(withId)}
        </span>
      </header>
      <p style={{ ...styles.muted, marginBottom: "1rem" }} title="tier-2 envelope: sealed to every certified device of both participants">
        🔒 End-to-end encrypted — the server stores only ciphertext.
      </p>

      {error && <p style={{ color: "crimson" }}>Could not load messages: {error}</p>}
      {!loaded && !error && <p style={styles.muted}>Loading messages…</p>}

      {loaded && state.olderCursor !== null && state.olderCursor !== undefined && (
        <button style={{ ...styles.button, marginBottom: "0.75rem" }} onClick={() => loadOlder().catch((e) => setError(String(e)))}>
          Load older messages
        </button>
      )}

      {loaded && ordered.length === 0 && (
        <p style={styles.muted}>No messages yet — say hello below.</p>
      )}

      {ordered.map(({ id, rec, opened }) => (
        <MessageCard key={id} record={rec} opened={opened} own={rec.author === session.root.account} />
      ))}

      <div style={{ marginTop: "1rem" }}>
        {composer.notice?.kind === "budget_exhausted" && (
          <div style={styles.noticeCard}>
            <strong>You've used today's cold-outreach budget</strong>
            <div style={{ marginTop: "0.25rem" }}>
              It refills daily and grows as people follow you. Your message is kept below — send it
              after the refill, or once this person follows you back the conversation is free.
              {budget !== null && (
                <> You have {formatBudgetMeter(budget.tokens, budget.daily_budget)} tokens right now.</>
              )}
            </div>
            <div style={{ ...styles.muted, marginTop: "0.25rem" }}>Server: {composer.notice.serverMessage}</div>
          </div>
        )}
        <textarea
          ref={composeRef}
          style={styles.textarea}
          rows={3}
          placeholder="Write a message… (encrypted before it leaves this browser)"
          value={composer.draft}
          onChange={(e) => setComposer((prev) => ({ ...prev, draft: e.target.value }))}
        />
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "0.5rem" }}>
          <button
            style={styles.primaryButton}
            onClick={send}
            disabled={composer.sending || composer.draft.trim().length === 0}
          >
            {composer.sending ? "Sending…" : "Send"}
          </button>
          {composer.notice?.kind === "error" && (
            <span style={{ color: "crimson" }}>{composer.notice.message}</span>
          )}
        </div>
        <BudgetMeter budget={budget} />
      </div>
    </section>
  );
}

function MessageCard({
  record,
  opened,
  own,
}: {
  record: DmRecord;
  opened: ReturnType<typeof openDmRecord>;
  own: boolean;
}) {
  if (!opened.ok) {
    // Placeholder ONLY — undecryptable/unverifiable content never renders.
    const benign = opened.reason === "not-recipient";
    return (
      <div style={benign ? styles.card : styles.errorCard}>
        <strong>Unreadable message</strong>
        {benign ? (
          <div style={styles.muted}>
            Not sent to this device — it was probably written before this device was enrolled.
          </div>
        ) : (
          <div style={styles.muted}>Failed verification ({opened.detail}) — not displayed.</div>
        )}
        <div style={{ ...styles.muted, marginTop: "0.3rem" }}>{record.created_at}</div>
      </div>
    );
  }
  return (
    <div style={{ ...styles.card, ...(own ? { background: "#f0f6ff" } : {}) }}>
      <div style={{ ...styles.muted, marginBottom: "0.35rem" }}>
        <span style={styles.mono} title={record.author}>
          {own ? "you" : shortId(record.author)}
        </span>
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{opened.body}</div>
      <div style={{ ...styles.muted, marginTop: "0.4rem" }}>
        {record.created_at}
        <span title="signature, device-cert chain, AEAD and conversation binding verified by this client">
          {" "}
          · verified ✓
        </span>
      </div>
    </div>
  );
}
