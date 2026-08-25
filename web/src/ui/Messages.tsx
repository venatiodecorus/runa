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
 *
 * "Decline & report" (M7, protocol §9.2): decrypts the request's message
 * locally (same openDmRecord as the thread view), then hands it to
 * ui/Report.tsx's consent-gated dialog with `record` = the dm's id and
 * `plaintext` = the decrypted body — the reporter's own copy, forwarded only
 * after explicit consent. On success it dismisses the request exactly like
 * plain Dismiss (dm/requests.ts) — the sender is never notified either way.
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
  currentDeviceIds,
  diffPin,
  loadPin,
  repinFromCerts,
  type PinDiff,
} from "../dm/pins.js";
import {
  dismissRequest,
  loadDismissed,
  partitionRequests,
  restoreRequest,
} from "../dm/requests.js";
import { AccountLabel } from "./AccountLabel.js";
import { AccountSearch, useVerifiedNames } from "./AccountSearch.js";
import { Identicon } from "./Identicon.js";
import { ReportDialog } from "./Report.js";
import { useAttestedCache, VerifiedBadge } from "./attested.js";
import { shortId } from "./theme.js";
import {
  IconAlert,
  IconArrowLeft,
  IconCheck,
  IconDevices,
  IconLock,
  IconSend,
  Loading,
} from "./icons.js";
import type { AttestedCache } from "../verify/attestations.js";
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
      className="faint"
      style={{ marginTop: "0.5rem", marginBottom: 0 }}
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

// --- decline & report (M7) -----------------------------------------------------

type DeclineState =
  | { kind: "loading" }
  | { kind: "ready"; dmRecordId: string; plaintext: string | undefined; note: string | null }
  | { kind: "error"; message: string };

/**
 * Decrypts the request's message (same verify-then-decrypt path as the
 * thread view) and hands it to ReportDialog with `record`/`plaintext` set —
 * the consent screen itself lives there. A decrypt failure still lets the
 * reporter file the report (record id only, explained note, no plaintext)
 * rather than silently blocking "decline & report" on a corrupted message.
 */
function DeclineAndReportDialog({
  session,
  conv,
  onClose,
  onDeclined,
}: {
  session: Session;
  conv: DmConversation;
  onClose: () => void;
  onDeclined: () => void;
}) {
  const [state, setState] = useState<DeclineState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      const [selfInfo, theirInfo] = await Promise.all([
        getAccount(session.root.account),
        getAccount(conv.with),
      ]);
      const certsByAccount: Record<string, AuthorKeys> = {
        [session.root.account]: {
          device_certs: selfInfo.device_certs,
          device_revocations: selfInfo.device_revocations,
        },
        [conv.with]: { device_certs: theirInfo.device_certs, device_revocations: theirInfo.device_revocations },
      };
      const id = recordId(conv.last);
      const opened = openDmRecord(conv.last, certsByAccount, session);
      if (cancelled) return;
      if (opened.ok) {
        setState({ kind: "ready", dmRecordId: id, plaintext: opened.body, note: null });
      } else {
        setState({
          kind: "ready",
          dmRecordId: id,
          plaintext: undefined,
          note: "Could not decrypt this message on this device — the report will reference it but won't include its content.",
        });
      }
    })().catch((e) => {
      if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [session, conv]);

  if (state.kind === "loading") return <Loading label="Loading message…" />;
  if (state.kind === "error") {
    return (
      <div className="card card-error">
        <strong>Could not load this message</strong>
        <div className="muted">{state.message}</div>
        <button className="btn btn-sm" style={{ marginTop: "0.5rem" }} onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  return (
    <div>
      {state.note !== null && <p className="muted" style={{ marginBottom: "0.5rem" }}>{state.note}</p>}
      <ReportDialog
        session={session}
        subject={conv.with}
        record={state.dmRecordId}
        plaintext={state.plaintext}
        contentLabel="message"
        onClose={onClose}
        onSubmitted={onDeclined}
      />
    </div>
  );
}

// --- inbox --------------------------------------------------------------------

export function Messages({ session, imageboard }: { session: Session; imageboard: boolean }) {
  const [conversations, setConversations] = useState<DmConversation[] | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [openWith, setOpenWith] = useState<{ id: string; focusCompose: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  const [decliningWith, setDecliningWith] = useState<string | null>(null);
  const { names, ensureNames } = useVerifiedNames(imageboard);
  const { attested } = useAttestedCache();

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

  useEffect(() => {
    if (conversations) ensureNames(conversations.map((c) => c.with));
  }, [conversations, ensureNames]);

  if (openWith !== null) {
    return (
      <Thread
        session={session}
        withId={openWith.id}
        name={names[openWith.id] ?? null}
        ensureNames={ensureNames}
        attested={attested}
        focusCompose={openWith.focusCompose}
        onBack={() => setOpenWith(null)}
        onActivity={() => loadInbox().catch(() => {})}
      />
    );
  }

  const normal = (conversations ?? []).filter((c) => !c.request);
  const requests = (conversations ?? []).filter((c) => c.request);
  const tray = partitionRequests(requests, dismissed);

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
      <AccountSearch
        session={session}
        conversationIds={(conversations ?? []).map((c) => c.with)}
        names={names}
        ensureNames={ensureNames}
        placeholder="Search people you follow, or paste an account id…"
        buttonLabel="New message"
        emptyHint="No matches — paste a full account id to message someone new."
        onPick={(id) => setOpenWith({ id, focusCompose: true })}
      />

      {inboxError && <p className="error-text">Could not load conversations: {inboxError}</p>}
      {conversations === null && !inboxError && <Loading label="Loading conversations…" />}

      {conversations !== null && normal.length === 0 && requests.length === 0 && (
        <p className="muted">No conversations yet — start one with an account id above.</p>
      )}

      {normal.map((c) => (
        <ConversationRow
          key={c.with}
          conv={c}
          name={names[c.with] ?? null}
          attested={attested}
          onOpen={() => setOpenWith({ id: c.with, focusCompose: false })}
        />
      ))}

      {requests.length > 0 && (
        <>
          <h3>Requests</h3>
          <p className="muted">
            From accounts outside your web of trust — reaching you cost the sender a cold-outreach
            token. Accepting is just replying: once you reply, the conversation moves to your inbox
            and stays free for both of you. Dismissing only hides a request in this browser, and the
            sender is never notified either way — that's true of "Decline &amp; report" too, which
            additionally lets you forward your own decrypted copy of the message for review, with
            your explicit consent.
          </p>
          {tray.visible.map((c) => (
            <ConversationRow
              key={c.with}
              conv={c}
              name={names[c.with] ?? null}
              attested={attested}
              onOpen={() => setOpenWith({ id: c.with, focusCompose: false })}
              actions={
                <>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setOpenWith({ id: c.with, focusCompose: true })}
                  >
                    Accept &amp; reply
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Hides this request in this browser only — the sender is not notified."
                    onClick={() => dismiss(c.with)}
                  >
                    Dismiss
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    title="Decline and optionally forward your decrypted copy of the message for review — the sender is not notified."
                    onClick={() => setDecliningWith(c.with)}
                  >
                    Decline &amp; report
                  </button>
                </>
              }
            />
          ))}
          {decliningWith !== null &&
            (() => {
              const target = tray.visible.find((c) => c.with === decliningWith);
              if (!target) return null;
              return (
                <div style={{ marginTop: "0.5rem", marginBottom: "0.75rem" }}>
                  <DeclineAndReportDialog
                    session={session}
                    conv={target}
                    onClose={() => setDecliningWith(null)}
                    onDeclined={() => {
                      setDecliningWith(null);
                      dismiss(target.with);
                    }}
                  />
                </div>
              );
            })()}
          {tray.visible.length === 0 && tray.dismissed.length > 0 && (
            <p className="muted">No open requests.</p>
          )}
          {tray.dismissed.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginBottom: "0.75rem" }}
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
                name={names[c.with] ?? null}
                attested={attested}
                onOpen={() => setOpenWith({ id: c.with, focusCompose: false })}
                actions={
                  <button className="btn btn-ghost btn-sm" onClick={() => restore(c.with)}>
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
  name,
  attested,
  onOpen,
  actions,
}: {
  conv: DmConversation;
  name: string | null;
  attested?: AttestedCache;
  onOpen: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="card card-interactive" onClick={onOpen} role="button" title={conv.with}>
      <div className="card-head">
        <AccountLabel
          id={conv.with}
          name={name}
          size={20}
          suffix={attested && attested[conv.with] !== undefined ? <VerifiedBadge since={attested[conv.with]} /> : undefined}
        />
        <span className="badge badge-scoped">
          <IconLock size={12} /> encrypted
        </span>
        <span className="spacer" />
        <span className="faint">{conv.last?.created_at ?? ""}</span>
      </div>
      {actions !== undefined && (
        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
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
  /** Key continuity (protocol §8.3): current device set vs. the stored pin. */
  pinDiff: PinDiff | null;
}

function Thread({
  session,
  withId,
  name,
  ensureNames,
  attested,
  focusCompose,
  onBack,
  onActivity,
}: {
  session: Session;
  withId: string;
  name: string | null;
  ensureNames: (ids: string[]) => void;
  attested: AttestedCache;
  focusCompose: boolean;
  onBack: () => void;
  onActivity: () => void;
}) {
  const [state, setState] = useState<ThreadState>({
    byId: {},
    olderCursor: undefined,
    certsByAccount: {},
    pinDiff: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(initialComposer);
  const initialCursorSet = useRef(false);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);
  const { budget, refreshBudget } = useBudget();

  useEffect(() => {
    // A brand-new contact reached via a raw account id may not be covered by
    // the inbox-driven ensureNames call yet — make sure the header can show
    // a verified name as soon as one is available.
    ensureNames([withId]);
  }, [withId, ensureNames]);

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
    const [page, certsByAccount, stored] = await Promise.all([
      getDmWith(withId, { limit: PAGE }),
      fetchCerts(),
      loadPin(withId),
    ]);
    const contact = certsByAccount[withId];
    const current = contact ? currentDeviceIds(contact.device_certs, contact.device_revocations) : [];
    const pinDiff = diffPin(current, stored);
    setState((prev) => {
      const byId = { ...prev.byId };
      for (const rec of page.records) byId[recordId(rec)] = rec;
      const olderCursor = initialCursorSet.current ? prev.olderCursor : page.next_before;
      initialCursorSet.current = true;
      return { byId, olderCursor, certsByAccount, pinDiff };
    });
    setLoaded(true);
    setError(null);
  }, [withId, fetchCerts]);

  /**
   * Key continuity (§8.3): click-through, never a wall — re-pins the current
   * device set and clears the banner. Does NOT block sending in the meantime.
   */
  const trustNewDevices = async () => {
    const contact = state.certsByAccount[withId];
    if (!contact) return;
    await repinFromCerts(withId, contact.device_certs, contact.device_revocations);
    setState((prev) => ({ ...prev, pinDiff: { firstContact: false, newDevices: [] } }));
  };

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
    setState({ byId: {}, olderCursor: undefined, certsByAccount: {}, pinDiff: null });
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
      // Key continuity (§8.3): a successful send re-pins the current device
      // set — this is also how a brand-new contact gets its first pin (TOFU).
      const contact = state.certsByAccount[withId];
      if (contact) {
        await repinFromCerts(withId, contact.device_certs, contact.device_revocations);
      }
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
      <header className="row" style={{ marginBottom: "0.5rem" }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={15} /> Back
        </button>
        <AccountLabel
          id={withId}
          name={name}
          size={20}
          suffix={attested[withId] !== undefined ? <VerifiedBadge since={attested[withId]} /> : undefined}
        />
      </header>
      <p
        className="row faint"
        style={{ marginBottom: "1rem" }}
        title="tier-2 envelope: sealed to every certified device of both participants"
      >
        <IconLock size={12} /> End-to-end encrypted — the server stores only ciphertext.
      </p>

      {error && <p className="error-text">Could not load messages: {error}</p>}
      {!loaded && !error && <Loading label="Loading messages…" />}

      {loaded && state.olderCursor !== null && state.olderCursor !== undefined && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginBottom: "0.75rem" }}
          onClick={() => loadOlder().catch((e) => setError(String(e)))}
        >
          Load older messages
        </button>
      )}

      {loaded && ordered.length === 0 && (
        <p className="muted">No messages yet — say hello below.</p>
      )}

      {ordered.map(({ id, rec, opened }) => (
        <MessageCard key={id} record={rec} opened={opened} own={rec.author === session.root.account} />
      ))}

      <div style={{ marginTop: "1rem" }}>
        {/* Key continuity (§8.3): informational only — never blocks sending. */}
        {!state.pinDiff?.firstContact && (state.pinDiff?.newDevices.length ?? 0) > 0 && (
          <div className="card card-notice">
            <div className="row">
              <IconDevices size={14} />
              <strong>New device detected</strong>
            </div>
            <div style={{ marginTop: "0.25rem" }}>
              {name ?? shortId(withId)} added a new device since you last messaged them.
            </div>
            {attested[withId] !== undefined && (
              <div style={{ marginTop: "0.25rem" }}>
                You verified this account on {attested[withId]}; a new device has appeared since. If
                you can, re-compare your safety numbers.
              </div>
            )}
            <div style={{ marginTop: "0.5rem" }}>
              <button className="btn btn-sm" onClick={() => trustNewDevices().catch((e) => setError(String(e)))}>
                Got it — trust their new devices
              </button>
            </div>
          </div>
        )}
        {composer.notice?.kind === "budget_exhausted" && (
          <div className="card card-notice">
            <div className="row">
              <IconAlert size={14} />
              <strong>You've used today's cold-outreach budget</strong>
            </div>
            <div style={{ marginTop: "0.25rem" }}>
              It refills daily and grows as people follow you. Your message is kept below — send it
              after the refill, or once this person follows you back the conversation is free.
              {budget !== null && (
                <> You have {formatBudgetMeter(budget.tokens, budget.daily_budget)} tokens right now.</>
              )}
            </div>
            <div className="faint" style={{ marginTop: "0.25rem" }}>Server: {composer.notice.serverMessage}</div>
          </div>
        )}
        <textarea
          ref={composeRef}
          className="textarea"
          rows={3}
          placeholder="Write a message… (encrypted before it leaves this browser)"
          value={composer.draft}
          onChange={(e) => setComposer((prev) => ({ ...prev, draft: e.target.value }))}
        />
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button
            className="btn btn-primary"
            onClick={send}
            disabled={composer.sending || composer.draft.trim().length === 0}
          >
            <IconSend size={13} /> {composer.sending ? "Sending…" : "Send"}
          </button>
          {composer.notice?.kind === "error" && (
            <span className="error-text">{composer.notice.message}</span>
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
      <div className={benign ? "card card-muted" : "card card-error"}>
        <strong>Unreadable message</strong>
        {benign ? (
          <div className="muted">
            Not sent to this device — it was probably written before this device was enrolled.
          </div>
        ) : (
          <div className="muted">Failed verification ({opened.detail}) — not displayed.</div>
        )}
        <div className="muted" style={{ marginTop: "0.3rem" }}>{record.created_at}</div>
      </div>
    );
  }
  return (
    <div className={own ? "msg-row own" : "msg-row"}>
      <div className={own ? "bubble own" : "bubble"}>
        {!own && (
          <div className="bubble-meta">
            <Identicon id={record.author} size={16} />
            <span className="mono" title={record.author}>
              {shortId(record.author)}
            </span>
          </div>
        )}
        <div className="card-body">{opened.body}</div>
        <div className="bubble-time">
          {record.created_at}{" "}
          <span
            className="verified-check"
            title="signature, device-cert chain, AEAD and conversation binding verified by this client"
          >
            <IconCheck size={11} /> verified
          </span>
        </div>
      </div>
    </div>
  );
}
