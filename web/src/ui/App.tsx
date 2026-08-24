/**
 * App shell: instance banner (/meta — the client is instance-agnostic,
 * design §15) + routing between signup/recover (no local account) and
 * home/devices/profile (account present in IndexedDB).
 */
import { useEffect, useState } from "react";
import { fetchMeta, type InstanceMeta } from "../api/client.js";
import { restoreSession, login, forgetThisBrowser, type Session } from "./session.js";
import { Signup } from "./Signup.js";
import { Recover } from "./Recover.js";
import { Home } from "./Home.js";
import { Feed } from "./Feed.js";
import { Messages } from "./Messages.js";
import { Devices } from "./Devices.js";
import { Profile } from "./Profile.js";
import { PostPage } from "./PostPage.js";
import { Identicon } from "./Identicon.js";
import { StandingBanner, useStanding } from "./StandingBanner.js";
import { shortId, styles } from "./theme.js";

type AnonRoute = "signup" | "recover";
type UserRoute =
  | { kind: "feed" }
  | { kind: "messages" }
  | { kind: "posts" }
  | { kind: "devices" }
  | { kind: "profile"; account: string }
  /** `back` = the route the thread was opened from, so ← Back returns there
   *  (threads opened from a thread chain naturally, like a stack). */
  | { kind: "post"; id: string; back: UserRoute };

export function App() {
  const [meta, setMeta] = useState<InstanceMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [anonRoute, setAnonRoute] = useState<AnonRoute>("signup");
  const [route, setRoute] = useState<UserRoute>({ kind: "feed" });
  const standing = useStanding(session);

  useEffect(() => {
    fetchMeta().then(setMeta, (e) => setMetaError(String(e)));
    restoreSession()
      .then(async (s) => {
        setSession(s);
        if (s) {
          try {
            await login(s);
          } catch (e) {
            setAuthError(String(e));
          }
        }
      })
      .finally(() => setBooted(true));
  }, []);

  const logout = async () => {
    await forgetThisBrowser();
    setSession(null);
    setAuthError(null);
    setAnonRoute("recover");
  };

  const openPost = (id: string) =>
    setRoute((prev) =>
      // Re-opening the thread already on screen must not push it onto its own
      // back-chain — ← Back would then appear to do nothing.
      prev.kind === "post" && prev.id === id ? prev : { kind: "post", id, back: prev },
    );
  const viewAccount = (account: string) => setRoute({ kind: "profile", account });

  const navButton = (label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        ...styles.button,
        ...(active ? { background: "#1a5fb4", color: "#fff", borderColor: "#1a5fb4" } : {}),
      }}
    >
      {label}
    </button>
  );

  const imageboard = meta?.imageboard_mode === true;

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ marginBottom: "0.25rem" }}>Runa</h1>
        {metaError && <p style={{ color: "crimson" }}>Instance unreachable: {metaError}</p>}
        {meta && (
          <p style={styles.muted}>
            Connected to instance <strong>{meta.name}</strong> (protocol v{meta.protocol_version}).
          </p>
        )}
      </header>

      {!booted && <p style={styles.muted}>Loading…</p>}

      {booted && session === null && (
        <>
          <nav style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
            {navButton("Sign up", anonRoute === "signup", () => setAnonRoute("signup"))}
            {navButton("Recover", anonRoute === "recover", () => setAnonRoute("recover"))}
          </nav>
          {anonRoute === "signup" ? (
            <Signup onDone={setSession} />
          ) : (
            <Recover onDone={setSession} />
          )}
        </>
      )}

      {booted && session !== null && (
        <>
          <nav
            style={{
              display: "flex",
              gap: "0.5rem",
              marginBottom: "1.5rem",
              alignItems: "center",
            }}
          >
            {navButton("Feed", route.kind === "feed", () => setRoute({ kind: "feed" }))}
            {navButton("Messages", route.kind === "messages", () => setRoute({ kind: "messages" }))}
            {navButton("My posts", route.kind === "posts", () => setRoute({ kind: "posts" }))}
            {navButton("Devices", route.kind === "devices", () => setRoute({ kind: "devices" }))}
            {navButton("Profile", route.kind === "profile", () => viewAccount(session.root.account))}
            <span style={{ flex: 1 }} />
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", ...styles.mono, ...styles.muted }}
              title={session.root.account}
            >
              <Identicon id={session.root.account} size={20} />
              {shortId(session.root.account)}
            </span>
            <button style={styles.button} onClick={logout} title="Wipes keys from this browser — your recovery kit stays valid">
              Forget this browser
            </button>
          </nav>
          {authError && (
            <p style={{ color: "crimson" }}>
              Not authenticated with the instance ({authError}) — posting will fail until it is
              reachable again.
            </p>
          )}
          <StandingBanner standing={standing} />
          {route.kind === "feed" && (
            <Feed session={session} imageboard={imageboard} onOpenPost={openPost} onViewAccount={viewAccount} />
          )}
          {route.kind === "messages" && <Messages session={session} imageboard={imageboard} />}
          {route.kind === "posts" && (
            <Home session={session} imageboard={imageboard} onOpenPost={openPost} />
          )}
          {route.kind === "devices" && <Devices session={session} />}
          {route.kind === "profile" && (
            <Profile
              key={route.account}
              session={session}
              account={route.account}
              imageboard={imageboard}
              onOpenPost={openPost}
            />
          )}
          {route.kind === "post" && (
            <PostPage
              key={route.id}
              session={session}
              id={route.id}
              imageboard={imageboard}
              onBack={() => setRoute(route.back)}
              onOpenPost={openPost}
              onViewAccount={viewAccount}
            />
          )}
        </>
      )}
    </main>
  );
}
