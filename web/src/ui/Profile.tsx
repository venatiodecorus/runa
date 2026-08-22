/**
 * Profile view for any account id: fetch, client-verify (profile record
 * included — display names are non-unique metadata and render only if their
 * signature + cert chain verify), and show the account's posts.
 * Own profile: display-name/bio editing via a device-signed profile record.
 */
import { useCallback, useEffect, useState } from "react";
import { nowTimestamp, signRecord } from "@runa/core";
import {
  ApiError,
  getAccount,
  getBudget,
  getGraph2Hop,
  postRecord,
  type AccountInfo,
  type Graph2Hop,
} from "../api/client.js";
import { formatBudgetMeter } from "../dm/budget.js";
import { buildGraphRecord, type GraphRecordType } from "../crypto/graph.js";
import { PostList, verifyAll } from "./Posts.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

export function Profile({
  session,
  account,
  imageboard = false,
}: {
  session: Session;
  account: string;
  /** Instance runs imageboard mode (design §17): no profiles, ids only. */
  imageboard?: boolean;
}) {
  const [lookup, setLookup] = useState(account);
  const [target, setTarget] = useState(account);

  return (
    <section>
      <form
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (lookup.trim()) setTarget(lookup.trim());
        }}
      >
        <input
          style={styles.input}
          placeholder="View any account id…"
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
        />
        <button style={styles.button} type="submit">
          View
        </button>
      </form>
      <ProfileCard key={target} session={session} account={target} imageboard={imageboard} />
      <h3>Posts</h3>
      <PostList session={session} account={target} />
    </section>
  );
}

function ProfileCard({
  session,
  account,
  imageboard = false,
}: {
  session: Session;
  account: string;
  imageboard?: boolean;
}) {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);
  const isOwn = account === session.root.account;

  const load = async () => {
    setError(null);
    try {
      const i = await getAccount(account);
      setInfo(i);
      if (i.profile) {
        const [v] = verifyAll([i.profile], i);
        setProfileError(v?.error ?? null);
        if (v && v.error === null) {
          setDisplayName(String(i.profile.display_name ?? ""));
          setBio(String(i.profile.bio ?? ""));
        }
      } else {
        setProfileError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    load().catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const record = signRecord(
        {
          v: 1,
          type: "profile",
          author: session.root.account,
          device: session.device.deviceId,
          created_at: nowTimestamp(),
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          ...(bio.trim() ? { bio: bio.trim() } : {}),
        },
        session.device.signSeed,
      );
      await postRecord(record);
      setEditing(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p style={{ color: "crimson" }}>Could not load account: {error}</p>;
  if (info === null) return <p style={styles.muted}>Loading…</p>;

  // Imageboard mode (design §17): profile records are neither rendered nor
  // editable — accounts are their ids; judge users by their content.
  const verifiedProfile =
    !imageboard && info.profile !== null && profileError === null ? info.profile : null;

  return (
    <div style={styles.card}>
      <h2 style={{ margin: "0 0 0.25rem" }}>
        {verifiedProfile ? String(verifiedProfile.display_name ?? shortId(account)) : shortId(account)}
        {isOwn && <span style={styles.muted}> (you)</span>}
      </h2>
      <div style={{ ...styles.mono, ...styles.muted }}>{account}</div>
      {imageboard && (
        <p style={styles.muted}>This instance runs imageboard mode — no profiles; accounts are their ids.</p>
      )}
      {!imageboard && profileError !== null && (
        <p style={{ color: "crimson" }}>
          Profile record failed verification and is not displayed: {profileError}
        </p>
      )}
      {verifiedProfile?.bio !== undefined && (
        <p style={{ whiteSpace: "pre-wrap" }}>{String(verifiedProfile.bio)}</p>
      )}
      <p style={styles.muted}>{info.follower_count} follower(s)</p>
      {!isOwn && (
        <GraphActions
          session={session}
          account={account}
          onChange={() => load().catch((e) => setError(String(e)))}
        />
      )}
      {isOwn && !imageboard && !editing && (
        <button style={styles.button} onClick={() => setEditing(true)}>
          Edit profile
        </button>
      )}
      {isOwn && !imageboard && editing && (
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
          <input
            style={styles.input}
            placeholder="Display name (non-unique — never an identifier)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <textarea
            style={styles.textarea}
            rows={2}
            placeholder="Bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button style={styles.primaryButton} disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button style={styles.button} disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Follow/Unfollow + Mute/Unmute for another account. Current state is derived
 * from /graph/2hop (the viewer's own follow list and private mutes — protocol
 * §6); actions are device-signed graph records through POST /records.
 */
function GraphActions({
  session,
  account,
  onChange,
}: {
  session: Session;
  account: string;
  onChange: () => void;
}) {
  const [graph, setGraph] = useState<Graph2Hop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [budgetNotice, setBudgetNotice] = useState<{ serverMessage: string; meter: string | null } | null>(null);

  const loadGraph = useCallback(async () => {
    setGraph(await getGraph2Hop());
  }, []);

  useEffect(() => {
    loadGraph().catch((e) => setError(String(e)));
  }, [loadGraph]);

  const act = async (type: GraphRecordType) => {
    setBusy(true);
    setError(null);
    setBudgetNotice(null);
    try {
      const record = buildGraphRecord(type, session.root.account, session.device, account);
      await postRecord(record);
      await loadGraph();
      onChange(); // follower_count may have changed
    } catch (e) {
      if (e instanceof ApiError && e.code === "budget_exhausted") {
        // A cold follow costs a token (protocol §6, M4) — calm notice, not an error.
        const meter = await getBudget().then(
          (b) => formatBudgetMeter(b.tokens, b.daily_budget),
          () => null,
        );
        setBudgetNotice({ serverMessage: e.message, meter });
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (graph === null) {
    return error !== null ? (
      <p style={{ color: "crimson" }}>Could not load your graph: {error}</p>
    ) : (
      <p style={styles.muted}>Loading graph…</p>
    );
  }

  const following = (graph.follows[session.root.account] ?? []).includes(account);
  const muted = graph.mutes.includes(account);

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button
          style={following ? styles.button : styles.primaryButton}
          disabled={busy}
          onClick={() => act(following ? "unfollow" : "follow")}
        >
          {following ? "Unfollow" : "Follow"}
        </button>
        <button
          style={styles.button}
          disabled={busy}
          title="Private: the mute record is never served to anyone but you"
          onClick={() => act(muted ? "unmute" : "mute")}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        {following && <span style={styles.muted}>Following</span>}
        {muted && <span style={styles.muted}>Muted — zero trust, prunes their hop-2 paths</span>}
      </div>
      {budgetNotice !== null && (
        <div style={{ ...styles.noticeCard, marginTop: "0.5rem" }}>
          <strong>You've used today's cold-outreach budget</strong>
          <div style={{ marginTop: "0.25rem" }}>
            Following someone who doesn't trust you yet costs a token. It refills daily and grows
            as people follow you — try again after the refill.
            {budgetNotice.meter !== null && <> You have {budgetNotice.meter} tokens right now.</>}
          </div>
          <div style={{ ...styles.muted, marginTop: "0.25rem" }}>Server: {budgetNotice.serverMessage}</div>
        </div>
      )}
      {error !== null && <p style={{ color: "crimson" }}>{error}</p>}
    </div>
  );
}
