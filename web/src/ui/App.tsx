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
import { shortId } from "./theme.js";
import { useTheme } from "./themeMode.js";
import {
  RuneMark,
  IconFeed,
  IconMessage,
  IconPen,
  IconDevices,
  IconUser,
  IconSun,
  IconMoon,
  IconLogOut,
  Loading,
} from "./icons.js";

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
  const [theme, toggleTheme] = useTheme();

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

  const navTab = (
    label: string,
    icon: React.ReactNode,
    active: boolean,
    onClick: () => void,
  ) => (
    <button className={active ? "nav-tab active" : "nav-tab"} onClick={onClick}>
      {icon}
      {label}
    </button>
  );

  const themeToggle = (
    <button
      className="icon-btn"
      onClick={toggleTheme}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
    </button>
  );

  const imageboard = meta?.imageboard_mode === true;

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <button className="brand" onClick={() => session && setRoute({ kind: "feed" })}>
            <span className="brand-mark">
              <RuneMark size={17} />
            </span>
            Runa
          </button>
          {booted && session !== null && (
            <nav className="nav-tabs">
              {navTab("Feed", <IconFeed size={15} />, route.kind === "feed", () =>
                setRoute({ kind: "feed" }),
              )}
              {navTab("Messages", <IconMessage size={15} />, route.kind === "messages", () =>
                setRoute({ kind: "messages" }),
              )}
              {navTab("Posts", <IconPen size={15} />, route.kind === "posts", () =>
                setRoute({ kind: "posts" }),
              )}
              {navTab("Devices", <IconDevices size={15} />, route.kind === "devices", () =>
                setRoute({ kind: "devices" }),
              )}
              {navTab("Profile", <IconUser size={15} />, route.kind === "profile", () =>
                viewAccount(session.root.account),
              )}
            </nav>
          )}
          <span className="spacer" />
          {booted && session !== null && (
            <span className="account-chip" title={session.root.account}>
              <Identicon id={session.root.account} size={18} />
              {shortId(session.root.account)}
            </span>
          )}
          {themeToggle}
          {booted && session !== null && (
            <button
              className="icon-btn"
              onClick={logout}
              title="Forget this browser — wipes keys from this device; your recovery kit stays valid"
            >
              <IconLogOut size={17} />
            </button>
          )}
        </div>
      </div>

      <main className="app-main">
        {metaError && <p className="error-text">Instance unreachable: {metaError}</p>}
        {meta && (
          <p className="instance-line">
            Connected to <strong>{meta.name}</strong> · protocol v{meta.protocol_version}
          </p>
        )}

        {!booted && <Loading />}

        {booted && session === null && (
          <>
            <div className="seg">
              <button
                className={anonRoute === "signup" ? "seg-tab active" : "seg-tab"}
                onClick={() => setAnonRoute("signup")}
              >
                Sign up
              </button>
              <button
                className={anonRoute === "recover" ? "seg-tab active" : "seg-tab"}
                onClick={() => setAnonRoute("recover")}
              >
                Recover
              </button>
            </div>
            {anonRoute === "signup" ? (
              <Signup onDone={setSession} />
            ) : (
              <Recover onDone={setSession} />
            )}
          </>
        )}

        {booted && session !== null && (
          <>
            {authError && (
              <p className="error-text">
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
    </>
  );
}
