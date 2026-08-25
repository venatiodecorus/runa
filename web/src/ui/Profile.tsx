/**
 * Profile view for any account id: fetch, client-verify (profile record
 * included — display names are non-unique metadata and render only if their
 * signature + cert chain verify), and show the account's posts.
 * Own profile: display-name/bio editing via a device-signed profile record.
 */
import { useCallback, useEffect, useState } from "react";
import {
  effectiveTrust,
  feedBucket,
  fingerprint,
  nowTimestamp,
  renderFingerprint,
  safetyNumber,
  signRecord,
  trustMap,
  verifyDeviceBinding,
  verifyDomainClaim,
  type AttestationRecord,
  type DomainClaimRecord,
} from "@runa/core";
import {
  ApiError,
  fetchMeta,
  getAccount,
  getAttestations,
  getBudget,
  getGraph2Hop,
  listRecords,
  postRecord,
  type AccountInfo,
  type Graph2Hop,
} from "../api/client.js";
import { formatBudgetMeter } from "../dm/budget.js";
import { buildGraphRecord, type GraphRecordType } from "../crypto/graph.js";
import { buildAttestation, buildAttestationRevoke, buildDomainClaim } from "../crypto/attestation.js";
import { repinFromCerts } from "../dm/pins.js";
import { instanceConstants } from "../feed/rank.js";
import {
  markAttested,
  markUnattested,
  reconcileAttestedCache,
  verifyAndReduceAttestations,
} from "../verify/attestations.js";
import { fetchAndCheckDomainProof, type DomainCheckResult } from "../verify/domain.js";
import { AccountSearch, useVerifiedNames } from "./AccountSearch.js";
import { Identicon } from "./Identicon.js";
import { PostList, verifyAll } from "./Posts.js";
import { ReportDialog } from "./Report.js";
import { downloadJson, shortId } from "./theme.js";
import { IconGlobe, IconShieldCheck, IconUsers, Loading } from "./icons.js";
import type { Session } from "./session.js";

export function Profile({
  session,
  account,
  imageboard = false,
  onOpenPost,
}: {
  session: Session;
  account: string;
  /** Instance runs imageboard mode (design §17): no profiles, ids only. */
  imageboard?: boolean;
  onOpenPost?: (id: string) => void;
}) {
  const [target, setTarget] = useState(account);
  const { names, ensureNames } = useVerifiedNames(imageboard);

  return (
    <section>
      <AccountSearch
        session={session}
        names={names}
        ensureNames={ensureNames}
        placeholder="Search people you follow, or paste any account id…"
        buttonLabel="View"
        emptyHint="No matches among your follows — paste a full account id to view any profile."
        onPick={setTarget}
      />
      <ProfileCard key={target} session={session} account={target} imageboard={imageboard} />
      <h3>Posts</h3>
      <PostList session={session} account={target} onOpenPost={onOpenPost} />
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

  if (error) return <p className="error-text">Could not load account: {error}</p>;
  if (info === null) return <Loading label="Loading…" />;

  // Imageboard mode (design §17): profile records are neither rendered nor
  // editable — accounts are their ids; judge users by their content.
  const verifiedProfile =
    !imageboard && info.profile !== null && profileError === null ? info.profile : null;

  return (
    <div className="card">
      <h2 style={{ margin: "0 0 0.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Identicon id={account} size={40} title={account} />
        {verifiedProfile ? String(verifiedProfile.display_name ?? shortId(account)) : shortId(account)}
        {isOwn && <span className="muted"> (you)</span>}
      </h2>
      <div className="mono faint">{account}</div>
      {imageboard && (
        <p className="muted">This instance runs imageboard mode — no profiles; accounts are their ids.</p>
      )}
      {!imageboard && profileError !== null && (
        <p className="error-text">
          Profile record failed verification and is not displayed: {profileError}
        </p>
      )}
      {verifiedProfile?.bio !== undefined && (
        <p style={{ whiteSpace: "pre-wrap" }}>{String(verifiedProfile.bio)}</p>
      )}
      <p className="muted row">
        <IconUsers size={13} />
        {info.follower_count} follower(s)
      </p>
      {!isOwn && (
        <GraphActions
          session={session}
          account={account}
          onChange={() => load().catch((e) => setError(String(e)))}
        />
      )}
      {!isOwn && <VerificationSection session={session} account={account} accountInfo={info} />}
      <DomainsSection session={session} account={account} isOwn={isOwn} accountInfo={info} />
      {isOwn && !imageboard && !editing && (
        <button className="btn btn-ghost btn-sm" style={{ marginTop: "0.75rem" }} onClick={() => setEditing(true)}>
          Edit profile
        </button>
      )}
      {isOwn && !imageboard && editing && (
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
          <input
            className="input"
            placeholder="Display name (non-unique — never an identifier)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <textarea
            className="textarea"
            rows={2}
            placeholder="Bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
          <div className="row">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(false)}>
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
  const [reporting, setReporting] = useState(false);

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
      <p className="error-text">Could not load your graph: {error}</p>
    ) : (
      <Loading label="Loading graph…" />
    );
  }

  const following = (graph.follows[session.root.account] ?? []).includes(account);
  const muted = graph.mutes.includes(account);

  return (
    <div className="card card-nested">
      <div className="row">
        <button
          className={following ? "btn btn-sm" : "btn btn-primary btn-sm"}
          disabled={busy}
          onClick={() => act(following ? "unfollow" : "follow")}
        >
          {following ? "Unfollow" : "Follow"}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy}
          title="Private: the mute record is never served to anyone but you"
          onClick={() => act(muted ? "unmute" : "mute")}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        {following && <span className="muted">Following</span>}
        {muted && <span className="muted">Muted — zero trust, prunes their hop-2 paths</span>}
        <span className="spacer" />
        {!reporting && (
          <button
            className="btn btn-ghost btn-sm"
            title="Report this account to the instance operator — private, never shown to them"
            onClick={() => setReporting(true)}
          >
            Report
          </button>
        )}
      </div>
      {reporting && (
        <div style={{ marginTop: "0.5rem" }}>
          <ReportDialog session={session} subject={account} onClose={() => setReporting(false)} />
        </div>
      )}
      {budgetNotice !== null && (
        <div className="card card-notice" style={{ marginTop: "0.5rem" }}>
          <strong>You've used today's cold-outreach budget</strong>
          <div style={{ marginTop: "0.25rem" }}>
            Following someone who doesn't trust you yet costs a token. It refills daily and grows
            as people follow you — try again after the refill.
            {budgetNotice.meter !== null && <> You have {budgetNotice.meter} tokens right now.</>}
          </div>
          <div className="muted" style={{ marginTop: "0.25rem" }}>Server: {budgetNotice.serverMessage}</div>
        </div>
      )}
      {error !== null && <p className="error-text">{error}</p>}
    </div>
  );
}

/**
 * Verify flow (protocol §8.2/§8.3): fingerprint + pairwise safety number for
 * the viewer to compare with `account` over a channel they trust, publish/
 * withdraw the viewer's own attestation, and show social confidence — how
 * many of the viewer's trusted accounts (and how many in total) have
 * attested this key. TOFU: none of this gates any capability.
 */
function VerificationSection({
  session,
  account,
  accountInfo,
}: {
  session: Session;
  account: string;
  accountInfo: AccountInfo;
}) {
  const [active, setActive] = useState<AttestationRecord[] | null>(null);
  const [trustedCount, setTrustedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getAttestations(account);
      const verified = verifyAndReduceAttestations(account, res.attestations, res.authors);
      setActive(verified);
      // Opportunistic cache reconcile (§8.3): fold in case the viewer's own
      // attestation state drifted (attested/withdrawn on another device).
      await reconcileAttestedCache(session.root.account, account, verified);

      // Social confidence, computed lazily on render of this section: filter
      // attesters by the viewer's own trust (same math as the feed).
      const [graph, meta] = await Promise.all([getGraph2Hop(), fetchMeta().catch(() => null)]);
      const { constants } = instanceConstants(meta?.constants);
      const trust = trustMap(session.root.account, graph, constants);
      const trusted = verified.filter((a) => {
        if (a.author === session.root.account) return false;
        return feedBucket(effectiveTrust(trust[a.author] ?? 0), constants) === "normal";
      });
      setTrustedCount(trusted.length);
    } catch (e) {
      setError(String(e));
    }
  }, [account, session.root.account]);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const own = active?.find((a) => a.author === session.root.account) ?? null;

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const record = buildAttestation(session.root.account, session.device, account, "safety-number");
      await postRecord(record);
      await markAttested(account, record.created_at);
      await repinFromCerts(account, accountInfo.device_certs, accountInfo.device_revocations);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      const record = buildAttestationRevoke(session.root.account, session.device, account);
      await postRecord(record);
      await markUnattested(account);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-nested">
      <h3 style={{ marginTop: 0 }} className="row">
        <IconShieldCheck size={14} />
        Verification
      </h3>
      <p className="muted">
        Compare these numbers over a channel you trust — in person, on a call, or any channel
        you're already confident this person controls. If they match on both ends, you've verified
        this key.
      </p>
      <div className="mono" style={{ marginBottom: "0.5rem" }}>
        <div>Fingerprint: {renderFingerprint(fingerprint(account))}</div>
        <div>Safety number: {safetyNumber(session.root.account, account)}</div>
      </div>
      {error !== null && <p className="error-text">{error}</p>}
      {active === null && error === null && <Loading label="Loading attestations…" />}
      {active !== null && (
        <>
          {own ? (
            <div>
              <p>Verified by you since {own.created_at}.</p>
              <button className="btn btn-sm" disabled={busy} onClick={() => withdraw()}>
                Withdraw verification
              </button>
            </div>
          ) : (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => publish()}>
              I compared the numbers — publish verification
            </button>
          )}
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Verified by {trustedCount ?? "…"} people you trust ({active.length} attestation
            {active.length === 1 ? "" : "s"} total).
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Domain proofs (protocol §8.4, Keybase model). Own profile: publish/list
 * claims and download the well-known file to serve. Other profiles: list
 * their claims and check each against the live well-known file — client-
 * checked only, the server never proxies this fetch.
 */
function DomainsSection({
  session,
  account,
  isOwn,
  accountInfo,
}: {
  session: Session;
  account: string;
  isOwn: boolean;
  accountInfo: AccountInfo;
}) {
  const [claims, setClaims] = useState<DomainClaimRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, DomainCheckResult | "checking">>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await listRecords(account, { type: "domain-claim", limit: 50 });
      const verified: DomainClaimRecord[] = [];
      for (const r of page.records) {
        if (r.type !== "domain-claim" || r.author !== account) continue;
        try {
          verifyDomainClaim(r as DomainClaimRecord);
          verifyDeviceBinding(r, accountInfo.device_certs, accountInfo.device_revocations);
          verified.push(r as DomainClaimRecord);
        } catch {
          // discard — never trust an unverifiable claim
        }
      }
      // Latest per domain (as protocol §6 specifies).
      const byDomain = new Map<string, DomainClaimRecord>();
      for (const c of verified) {
        const prev = byDomain.get(c.domain);
        if (!prev || c.created_at > prev.created_at) byDomain.set(c.domain, c);
      }
      setClaims([...byDomain.values()].sort((a, b) => (a.domain < b.domain ? -1 : 1)));
    } catch (e) {
      setError(String(e));
    }
  }, [account, accountInfo]);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const claim = async () => {
    const domain = newDomain.trim().toLowerCase();
    setBusy(true);
    setError(null);
    try {
      const record = buildDomainClaim(session.root.account, session.device, domain);
      verifyDomainClaim(record); // shape validation (hostname rules, §8.4) before posting
      await postRecord(record);
      setNewDomain("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const check = async (record: DomainClaimRecord) => {
    setChecks((prev) => ({ ...prev, [record.domain]: "checking" }));
    const result = await fetchAndCheckDomainProof(
      record,
      account,
      accountInfo.device_certs,
      accountInfo.device_revocations,
    );
    setChecks((prev) => ({ ...prev, [record.domain]: result }));
  };

  const attestDomain = async () => {
    setBusy(true);
    setError(null);
    try {
      const record = buildAttestation(session.root.account, session.device, account, "domain-proof");
      await postRecord(record);
      await markAttested(account, record.created_at);
      await repinFromCerts(account, accountInfo.device_certs, accountInfo.device_revocations);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-nested">
      <h3 style={{ marginTop: 0 }} className="row">
        <IconGlobe size={14} />
        Domains
      </h3>
      {isOwn && (
        <>
          <p className="muted">
            Prove you control a domain: claim it, then serve the downloaded file at{" "}
            <span className="mono">https://&lt;domain&gt;/.well-known/runa.json</span> with header{" "}
            <span className="mono">Access-Control-Allow-Origin: *</span> (required for browser
            clients to check it). There is no "unclaim" record — removing the file simply stops the
            claim from verifying.
          </p>
          <div className="row" style={{ marginBottom: "0.5rem" }}>
            <input
              className="input"
              placeholder="example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
            />
            <button className="btn btn-sm" disabled={busy || newDomain.trim().length === 0} onClick={() => claim()}>
              Claim domain
            </button>
          </div>
        </>
      )}
      {error !== null && <p className="error-text">{error}</p>}
      {claims === null && error === null && <Loading label="Loading domain claims…" />}
      {claims !== null && claims.length === 0 && (
        <p className="muted">No domain claims{isOwn ? " yet" : ""}.</p>
      )}
      {claims !== null &&
        claims.map((c) => {
          const result = checks[c.domain];
          return (
            <div key={c.domain} style={{ marginBottom: "0.5rem" }}>
              <div className="row">
                <span className="mono">{c.domain}</span>
                {isOwn && (
                  <button className="btn btn-sm" onClick={() => downloadJson("runa.json", { v: 1, claims: [c] })}>
                    Download well-known file
                  </button>
                )}
                {!isOwn && (
                  <button className="btn btn-sm" disabled={result === "checking"} onClick={() => check(c)}>
                    {result === "checking" ? "Checking…" : "Check"}
                  </button>
                )}
              </div>
              {!isOwn && result !== undefined && result !== "checking" && (
                <div style={{ marginTop: "0.25rem" }}>
                  {result.ok ? (
                    <>
                      <span className="verified-check">verified ✓</span>
                      <button
                        className="btn btn-sm"
                        style={{ marginLeft: "0.5rem" }}
                        disabled={busy}
                        onClick={() => attestDomain()}
                      >
                        Publish verification (domain proof)
                      </button>
                    </>
                  ) : (
                    <span className="muted" title={result.reason}>
                      couldn't verify (file missing, mismatched, or the domain doesn't allow browser
                      checks — CORS)
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
