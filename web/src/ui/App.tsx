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
import { Devices } from "./Devices.js";
import { Profile } from "./Profile.js";
import { shortId, styles } from "./theme.js";

type AnonRoute = "signup" | "recover";
type UserRoute = "feed" | "posts" | "devices" | "profile";

export function App() {
  const [meta, setMeta] = useState<InstanceMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [anonRoute, setAnonRoute] = useState<AnonRoute>("signup");
  const [userRoute, setUserRoute] = useState<UserRoute>("feed");

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
            {navButton("Feed", userRoute === "feed", () => setUserRoute("feed"))}
            {navButton("My posts", userRoute === "posts", () => setUserRoute("posts"))}
            {navButton("Devices", userRoute === "devices", () => setUserRoute("devices"))}
            {navButton("Profile", userRoute === "profile", () => setUserRoute("profile"))}
            <span style={{ flex: 1 }} />
            <span style={{ ...styles.mono, ...styles.muted }} title={session.root.account}>
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
          {userRoute === "feed" && <Feed session={session} />}
          {userRoute === "posts" && <Home session={session} />}
          {userRoute === "devices" && <Devices session={session} />}
          {userRoute === "profile" && <Profile session={session} account={session.root.account} />}
        </>
      )}
    </main>
  );
}
