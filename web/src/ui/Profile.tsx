/**
 * Profile view for any account id: fetch, client-verify (profile record
 * included — display names are non-unique metadata and render only if their
 * signature + cert chain verify), and show the account's posts.
 * Own profile: display-name/bio editing via a device-signed profile record.
 */
import { useEffect, useState } from "react";
import { nowTimestamp, signRecord } from "@runa/core";
import { getAccount, postRecord, type AccountInfo } from "../api/client.js";
import { PostList, verifyAll } from "./Posts.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

export function Profile({ session, account }: { session: Session; account: string }) {
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
      <ProfileCard key={target} session={session} account={target} />
      <h3>Posts</h3>
      <PostList account={target} />
    </section>
  );
}

function ProfileCard({ session, account }: { session: Session; account: string }) {
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

  const verifiedProfile = info.profile !== null && profileError === null ? info.profile : null;

  return (
    <div style={styles.card}>
      <h2 style={{ margin: "0 0 0.25rem" }}>
        {verifiedProfile ? String(verifiedProfile.display_name ?? shortId(account)) : shortId(account)}
        {isOwn && <span style={styles.muted}> (you)</span>}
      </h2>
      <div style={{ ...styles.mono, ...styles.muted }}>{account}</div>
      {profileError !== null && (
        <p style={{ color: "crimson" }}>
          Profile record failed verification and is not displayed: {profileError}
        </p>
      )}
      {verifiedProfile?.bio !== undefined && (
        <p style={{ whiteSpace: "pre-wrap" }}>{String(verifiedProfile.bio)}</p>
      )}
      <p style={styles.muted}>{info.follower_count} follower(s)</p>
      {isOwn && !editing && (
        <button style={styles.button} onClick={() => setEditing(true)}>
          Edit profile
        </button>
      )}
      {isOwn && editing && (
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
