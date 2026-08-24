/**
 * M7 exit-criteria harness (docs/poc-plan.md, "Phase 7 — Standing & reports",
 * **Exit:**). A scripted client-vs-runad run: it builds and starts a real
 * `runad` on a spare port against a FRESH temp SQLite db, then drives the
 * whole standing/report surface as ~160 independent clients using the web
 * client's OWN modules — api/client.ts, crypto/keys.ts, crypto/graph.ts,
 * dm/dm.ts, moderation/report.ts, feed/rank.ts — and the published math in
 * @runa/core. Nothing here touches the database, and no expectation is
 * hardcoded that core can compute instead.
 *
 *   npm run m7-exit -w web        (from the repo root; starts its own server)
 *
 * The port/base URL is fixed by the npm script (VITE_API_BASE), because the
 * client reads it at import time. Every assertion prints a numbered PASS/FAIL
 * line; the process exits non-zero if any fails.
 *
 * Deliberately NOT covered here (see the summary the script prints): the
 * "30 days simulated → penalties halve" item cannot be exercised against a
 * live wall clock — the server's clock is injectable only from Go tests, and
 * time-travelling a running instance would mean editing its db. Decay is
 * therefore asserted as core math here, and end-to-end over the same lazy
 * read path by TestAdminUpholdDecays in server/internal/api/standing_test.go
 * (frozen clock + backdated decay clock).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import {
  CONSTANTS,
  autoPenalty,
  clusterReporters,
  decayPenalty,
  nowTimestamp,
  recordId,
  reportMass,
  reporterWeight,
  signRecord,
  standingFrom,
  utf8,
  type DeviceCert,
  type DmRecord,
} from "@runa/core";
import {
  API_BASE,
  ApiError,
  authenticate,
  createAccount,
  getAccount,
  getBudget,
  getDmWith,
  getFeed,
  getGraph2Hop,
  getRecord,
  getStanding,
  listRecords,
  postRecord,
  setSessionToken,
} from "../src/api/client.js";
import { buildFollow } from "../src/crypto/graph.js";
import {
  buildDeviceCert,
  deviceFromSeeds,
  rootFromSeed,
  signAuthChallenge,
  type DeviceKeys,
  type RootKey,
} from "../src/crypto/keys.js";
import { openDmRecord, sendDm } from "../src/dm/dm.js";
import { rankFeed } from "../src/feed/rank.js";
import { submitReport } from "../src/moderation/report.js";

// --- harness plumbing --------------------------------------------------------

const ADMIN_TOKEN = "m7-exit-admin";
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..", "..");
const serverDir = join(repoRoot, "server");

if (API_BASE === "") {
  console.error("VITE_API_BASE is not set — run `npm run m7-exit -w web`.");
  process.exit(2);
}
const mainAddr = new URL(API_BASE).host;
const spareAddr = `${new URL(API_BASE).hostname}:${Number(new URL(API_BASE).port) + 1}`;

const jobTmp = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir();
const workDir = mkdtempSync(join(jobTmp, "m7-exit-"));
const children = new Set<ChildProcess>();

function killAll(): void {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.clear();
}
process.on("exit", killAll);
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Refuse to run against a stale instance: the assertions assume a fresh db. */
async function requireFreePort(addr: string): Promise<void> {
  try {
    const resp = await fetch(`http://${addr}/api/v1/meta`);
    if (resp.ok) {
      console.error(`something is already listening on ${addr} — stop it first (this harness needs a fresh instance).`);
      process.exit(2);
    }
  } catch {
    /* nothing there: good */
  }
}

async function startRunad(bin: string, addr: string, db: string, adminToken: string | null): Promise<ChildProcess> {
  await requireFreePort(addr);
  const env = { ...process.env };
  delete env.RUNAD_ADMIN_TOKEN;
  if (adminToken !== null) env.RUNAD_ADMIN_TOKEN = adminToken;
  const child = spawn(bin, ["-addr", addr, "-db", db], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    if (children.has(child)) console.error(`[runad ${addr}] exited early with code ${String(code)}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line && !line.includes("runad listening")) console.error(`[runad ${addr}] ${line}`);
  });
  for (let i = 0; i < 100 && !exited; i++) {
    try {
      const resp = await fetch(`http://${addr}/api/v1/meta`);
      if (resp.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`runad on ${addr} did not become ready`);
}

/** Raw admin call — the review queue is an operator surface, deliberately absent from the client. */
async function admin(
  path: string,
  opts: { token?: string | null; method?: string; body?: unknown; base?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.token !== null && opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${opts.base ?? API_BASE}/api/v1${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

// --- assertions --------------------------------------------------------------

let assertionCount = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): boolean {
  assertionCount++;
  const line = `${assertionCount}. ${label}${detail ? ` — ${detail}` : ""}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures.push(line);
  return ok;
}

const near = (a: number, b: number, eps = 1e-6): boolean => Number.isFinite(a) && Math.abs(a - b) <= eps;
const f = (x: number): string => x.toFixed(9);

async function expectApiError(fn: () => Promise<unknown>): Promise<ApiError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
}

/** Run a request that is expected to succeed, capturing any refusal as a FAIL detail. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; detail: string; value: T | null }> {
  try {
    const value = await fn();
    return { ok: true, detail: "accepted", value };
  } catch (e) {
    return { ok: false, detail: e instanceof ApiError ? `${e.status} ${e.code}` : String(e), value: null };
  }
}

// --- cast --------------------------------------------------------------------

interface Actor {
  name: string;
  root: RootKey;
  device: DeviceKeys;
  cert: DeviceCert;
  account: string;
}

function derivedSeed(name: string, role: string): Uint8Array {
  return sha256(utf8(`runa-m7-exit:v1:${name}:${role}`));
}

function actor(name: string): Actor {
  const root = rootFromSeed(derivedSeed(name, "root"));
  const device = deviceFromSeeds(derivedSeed(name, "device-sign"), derivedSeed(name, "device-kex"));
  return { name, root, device, cert: buildDeviceCert(root, device, "m7-exit"), account: root.account };
}

const A = actor("A"); // the target
const F = actor("F"); // direct follower of A (and DM correspondent)
const G = actor("G"); // second genuine follower of A
const H = actor("H"); // hop-2-only viewer of A (follows G)
const W = actor("W"); // DMs A first → reciprocal window, survives the freeze
const X = actor("X"); // unrelated account: fabricates a report for someone else's DM
const Z = actor("Z"); // drains its budget, then reports anyway (reports are unmetered)
const B = actor("B"); // first reporter
const R = Array.from({ length: 5 }, (_, i) => actor(`R${i + 1}`)); // five unconnected reporters
const S = Array.from({ length: 5 }, (_, i) => actor(`S${i + 1}`)); // five FRESH unconnected reporters (freeze round)
const C = Array.from({ length: 20 }, (_, i) => actor(`C${i + 1}`)); // tight mutual-follow cluster
const Ctarget = actor("Ctarget"); // the cluster's target

/** 11 distinct follower accounts per reporter — weight ln(1 + 11) = ln 12. */
const FOLLOWERS_PER_REPORTER = 11;
const reporters = [B, ...R, ...S];
const pools = new Map<string, Actor[]>(
  reporters.map((r) => [
    r.name,
    Array.from({ length: FOLLOWERS_PER_REPORTER }, (_, i) => actor(`${r.name}f${i + 1}`)),
  ]),
);
const fillers = [...pools.values()].flat();
const cast = [A, F, G, H, W, X, Z, ...reporters, ...C, Ctarget, ...fillers];

// --- graph bookkeeping (our own mirror of what we posted) --------------------

const outbound = new Map<string, Set<string>>();
const inbound = new Map<string, Set<string>>();

function recordEdge(from: string, to: string): void {
  if (!outbound.has(from)) outbound.set(from, new Set());
  if (!inbound.has(to)) inbound.set(to, new Set());
  outbound.get(from)!.add(to);
  inbound.get(to)!.add(from);
}

async function login(a: Actor): Promise<void> {
  await authenticate(a.account, a.device.deviceId, (c) => signAuthChallenge(a.device.signSeed, c));
}

/** POST a follow as `from` (caller must be logged in as `from`). */
async function follow(from: Actor, to: Actor): Promise<void> {
  await postRecord(buildFollow(from.account, from.device, to.account));
  recordEdge(from.account, to.account);
}

async function post(a: Actor, body: string): Promise<{ id: string; record: ReturnType<typeof signRecord> }> {
  const record = signRecord(
    { v: 1, type: "post", author: a.account, device: a.device.deviceId, created_at: nowTimestamp(), body },
    a.device.signSeed,
  );
  const { id } = await postRecord(record);
  return { id, record };
}

/**
 * The expected standing of a target reported by `rs`, computed with the CORE
 * functions over the graph this script actually built — never a hardcoded
 * number. Reporter weight uses the ADJUDICATED component only (core's
 * reporterWeight), and its Σ inbound_trust weights each follower by
 * 1 − p_adj (trust-and-reach §4's grounding rule).
 */
function expectFromReports(
  rs: Actor[],
  pAdj: Record<string, number> = {},
): { clusters: string[][]; mass: number; pAuto: number; standing: number } {
  const ids = rs.map((r) => r.account);
  const follows: Record<string, string[]> = {};
  const weights: Record<string, number> = {};
  for (const id of ids) {
    follows[id] = [...(outbound.get(id) ?? [])];
    let inboundTrust = 0;
    for (const follower of inbound.get(id) ?? []) inboundTrust += 1 - (pAdj[follower] ?? 0);
    weights[id] = reporterWeight(pAdj[id] ?? 0, inboundTrust);
  }
  const clusters = clusterReporters(ids, follows);
  const mass = reportMass(clusters, weights);
  const pAuto = autoPenalty(mass);
  return { clusters, mass, pAuto, standing: standingFrom(pAuto, 0) };
}

async function standingOf(a: Actor): Promise<Awaited<ReturnType<typeof getStanding>>> {
  await login(a);
  return getStanding();
}

// --- run ---------------------------------------------------------------------

console.log("M7 exit criteria — client modules vs a live runad\n");

const bin = join(workDir, "runad");
console.log(`building runad → ${bin}`);
execFileSync("go", ["build", "-o", bin, "./cmd/runad"], { cwd: serverDir, stdio: "inherit" });
const db = join(workDir, "m7-exit.db");
await startRunad(bin, mainAddr, db, ADMIN_TOKEN);
console.log(`runad up on ${API_BASE} (db: ${db}, admin token set)\n`);

// 1. Accounts (open signup, no auth) — created in parallel batches.
for (let i = 0; i < cast.length; i += 20) {
  await Promise.all(cast.slice(i, i + 20).map((a) => createAccount(a.account, a.cert)));
}
console.log(`created ${cast.length} accounts`);

// 2. Follow graph.
//    a) A's genuine followers, and a hop-2-only viewer behind one of them.
await login(F);
await follow(F, A);
await login(G);
await follow(G, A);
await login(H);
await follow(H, G);
//    b) each reporter's own distinct follower pool (no reporter follows anything,
//       and no pool is shared — so no follow-link and no Jaccard overlap can
//       cluster the reporters together).
for (const r of reporters) {
  for (const p of pools.get(r.name)!) {
    await login(p);
    await follow(p, r);
  }
}
//    c) the tight cluster: every Ci mutually follows its 4 neighbours on each
//       side. Phase 1's initiations are cold (4 of each account's 5 tokens);
//       phase 2's follow-backs are warm, so nobody runs out of budget.
const CLUSTER_DEG = 4;
for (const [i, ci] of C.entries()) {
  await login(ci);
  for (let d = 1; d <= CLUSTER_DEG; d++) await follow(ci, C[(i + d) % C.length]!);
}
for (const [i, ci] of C.entries()) {
  await login(ci);
  for (let d = 1; d <= CLUSTER_DEG; d++) await follow(ci, C[(i - d + C.length) % C.length]!);
}
console.log(`built the follow graph (${[...outbound.values()].reduce((n, s) => n + s.size, 0)} edges)`);

// 3. Content + the pre-report baselines.
await login(A);
const postA = await post(A, "M7: a public post from A");
await login(Ctarget);
const postC = await post(Ctarget, "M7: a public post from Ctarget");
await login(A);
const budgetBefore = await getBudget();
const standingBefore = await getStanding();
console.log(
  `baseline: A standing=${f(standingBefore.standing)} daily_budget=${f(budgetBefore.daily_budget)}\n`,
);

// DMs that must predate the freeze: F→A (the encrypted-report subject) and
// W→A (opens the reciprocal window used after the freeze).
await login(F);
const dmBody = "M7: an encrypted message from F to A that A will decline-with-report";
await sendDm({ root: F.root, device: F.device, cert: F.cert }, A.account, dmBody);
await login(W);
await sendDm({ root: W.root, device: W.device, cert: W.cert }, A.account, "M7: cold hello from W");

// --- (a) one reporter's worth -----------------------------------------------

await login(B);
const bReport = await attempt(() =>
  submitReport(B.account, B.device, { subject: A.account, record: postA.id, reason: "spam" }),
);
const afterB = await standingOf(A);
const expB = expectFromReports([B]);
check(
  "(a) B's report of A's public post is accepted (moderation/report.ts → POST /records)",
  bReport.ok,
  bReport.detail,
);
check(
  "(a) A's standing dips by exactly one reporter's worth",
  near(afterB.standing, expB.standing),
  `server=${f(afterB.standing)} core=(1−min(cap, ${CONSTANTS.report_impact}·ln(1+11)))=${f(expB.standing)}`,
);
check(
  "(a) told-that-not-why: reasons == [\"reports\"], limited true",
  afterB.limited === true && JSON.stringify(afterB.reasons) === JSON.stringify(["reports"]),
  `limited=${afterB.limited} reasons=${JSON.stringify(afterB.reasons)}`,
);
check(
  "(a) /standing carries only the 4 spec'd fields, no counts or thresholds",
  JSON.stringify(Object.keys(afterB).sort()) ===
    JSON.stringify(["frozen_until", "limited", "reasons", "standing"]) && afterB.frozen_until === null,
  `keys=${JSON.stringify(Object.keys(afterB).sort())} frozen_until=${String(afterB.frozen_until)}`,
);

// --- (b) five unconnected reporters cap p_auto and open the queue ------------

for (const r of R) {
  await login(r);
  await submitReport(r.account, r.device, { subject: A.account, record: postA.id, reason: "harassment" });
}
const afterR = await standingOf(A);
const expR = expectFromReports([B, ...R]);
check(
  "(b) five more unconnected reporters cap p_auto: standing = (1 − report_auto_cap)",
  near(afterR.standing, 1 - CONSTANTS.report_auto_cap) && near(afterR.standing, expR.standing),
  `server=${f(afterR.standing)} expected=${f(1 - CONSTANTS.report_auto_cap)}`,
);
check(
  "(b) the cap is what bit (uncapped mass would have gone further)",
  expR.clusters.length === 6 && CONSTANTS.report_impact * expR.mass > CONSTANTS.report_auto_cap,
  `${expR.clusters.length} clusters, impact×mass=${f(CONSTANTS.report_impact * expR.mass)} > cap=${CONSTANTS.report_auto_cap}`,
);
const queue1 = await admin("/admin/review", { token: ADMIN_TOKEN });
const entryA = queue1.body?.entries?.find((e: any) => e.account === A.account);
check(
  "(b) the operator review queue auto-opened an entry for A with the 6 window reports",
  queue1.status === 200 && entryA !== undefined && entryA.reports.length === 6 && near(entryA.p_auto, CONSTANTS.report_auto_cap),
  `entries=${queue1.body?.entries?.length ?? 0} reports=${entryA?.reports?.length ?? 0} p_auto=${f(entryA?.p_auto ?? NaN)}`,
);

// --- (c) chosen edges survive; strangers stop surfacing ---------------------

await login(F);
const feedF = await getFeed();
const graphF = await getGraph2Hop();
const itemF = feedF.items.find((it) => recordId(it.record) === postA.id);
check(
  "(c) A's post still reaches F, their direct follower, carrying standing 0.4",
  itemF !== undefined && near(itemF!.standing ?? 1, 1 - CONSTANTS.report_auto_cap),
  `item.standing=${f(itemF?.standing ?? NaN)}`,
);
const rankedF = rankFeed(F.account, feedF.items, graphF);
check(
  "(c) the client's own rankFeed keeps it in F's normal bucket",
  rankedF.normal.some((r) => r.id === postA.id),
  `client-recomputed effective trust=${f(rankedF.normal.find((r) => r.id === postA.id)?.trust ?? NaN)} = 1.0×0.4 ` +
    `(still ≥ threshold ${CONSTANTS.feed_surface_threshold}; the direct-follow override's teeth are asserted below, after an uphold)`,
);
await login(H);
const feedH = await getFeed();
const graphH = await getGraph2Hop();
const rankedH = rankFeed(H.account, feedH.items, graphH);
const hopTwo = rankedH.belowThreshold.find((r) => r.id === postA.id);
check(
  "(c) a hop-2-only viewer does NOT surface it: effective trust falls under the threshold",
  !rankedH.normal.some((r) => r.id === postA.id) &&
    hopTwo !== undefined &&
    near(hopTwo!.trust, CONSTANTS.per_hop_decay * (1 - CONSTANTS.report_auto_cap)),
  `bucket=below-threshold trust=${f(hopTwo?.trust ?? NaN)} = ${CONSTANTS.per_hop_decay}×0.4 < ${CONSTANTS.feed_surface_threshold}`,
);

// --- (d) cold-outreach budget shrinks by the standing factor ----------------

await login(A);
const budgetAfter = await getBudget();
check(
  "(d) A's daily cold-outreach budget shrank by exactly ×standing",
  near(budgetAfter.daily_budget, budgetBefore.daily_budget * (1 - CONSTANTS.report_auto_cap)),
  `${f(budgetBefore.daily_budget)} → ${f(budgetAfter.daily_budget)} (×${f(budgetAfter.daily_budget / budgetBefore.daily_budget)})`,
);

// --- (e) diversity weighting: a 20-strong tight cluster barely moves C ------

for (const ci of C) {
  await login(ci);
  await submitReport(ci.account, ci.device, { subject: Ctarget.account, record: postC.id, reason: "spam" });
}
const afterCluster = await standingOf(Ctarget);
const expC = expectFromReports(C);
check(
  "(e) 20 tight-cluster reports move Ctarget's standing only by the cluster's MAX member weight",
  near(afterCluster.standing, expC.standing) && expC.clusters.length === 1,
  `server=${f(afterCluster.standing)} core=${f(expC.standing)} (1 cluster of ${expC.clusters[0]!.length}, mass=${f(expC.mass)})`,
);
const queue2 = await admin("/admin/review", { token: ADMIN_TOKEN });
check(
  "(e) no review-queue entry opened for Ctarget (p_auto never reached the cap)",
  queue2.body?.entries?.every((e: any) => e.account !== Ctarget.account) === true,
  `p_auto=${f(expC.pAuto)} < cap=${CONSTANTS.report_auto_cap}`,
);

// --- (i.1) decline-with-report over an encrypted DM -------------------------

await login(A);
const inboxA = await getDmWith(F.account);
const dmFromF = inboxA.records[inboxA.records.length - 1] as DmRecord;
const fKeys = await getAccount(F.account);
const opened = openDmRecord(dmFromF, { [F.account]: fKeys }, { root: { account: A.account }, device: A.device });
check(
  "(i) A opens F's DM with the client's own verify-then-decrypt path",
  opened.ok === true && opened.ok && opened.body === dmBody,
  opened.ok ? "openDmRecord → plaintext recovered" : `openDmRecord failed: ${opened.reason}`,
);
const dmId = recordId(dmFromF);
const plaintext = opened.ok ? opened.body : "";
const forwardedReport = await attempt(() =>
  submitReport(A.account, A.device, {
    subject: F.account,
    record: dmId,
    reason: "harassment",
    comment: "declining this request and forwarding the message",
    plaintext,
  }),
);
check(
  "(i) the true recipient's report carries the forwarded plaintext and is accepted (structural recipiency, no key material on the wire)",
  forwardedReport.ok,
  `envelope to == reporter → ${forwardedReport.detail}`,
);
await login(X);
const fabricated = await expectApiError(() =>
  submitReport(X.account, X.device, { subject: F.account, record: dmId, reason: "harassment", plaintext }),
);
check(
  "(i) the same report from a non-recipient is refused",
  fabricated?.status === 403 && fabricated?.code === "not_recipient",
  `${fabricated?.status ?? "no error"} ${fabricated?.code ?? ""}`,
);
const reportId = forwardedReport.value ? recordId(forwardedReport.value) : "";
await login(A);
const reportFetch = await expectApiError(() => getRecord(reportId));
const publicPostFetch = await getRecord(postA.id);
const listA = await listRecords(A.account);
check(
  "(i) the report record is invisible to users: GET /records/{id} 404s and it is absent from public listings",
  reportFetch?.status === 404 &&
    publicPostFetch.record !== undefined &&
    postA.id === recordId(postA.record) &&
    !listA.records.some((r) => recordId(r) === reportId) &&
    !listA.records.some((r) => (r as any).type === "report"),
  `report 404 (a public record id from the same content-addressing scheme fetches fine), ${listA.records.length} listed records, none a report`,
);

// --- (f) dismissal burns the reporters --------------------------------------

const dismiss = await admin(`/admin/review/${encodeURIComponent(A.account)}`, {
  token: ADMIN_TOKEN,
  method: "POST",
  body: { decision: "dismiss", note: "m7-exit: adjudicated false" },
});
const afterDismiss = await standingOf(A);
check(
  "(f) operator dismissal clears A: standing back to 1.0, limited false, no reasons",
  dismiss.status === 200 &&
    near(afterDismiss.standing, 1.0) &&
    afterDismiss.limited === false &&
    afterDismiss.reasons.length === 0,
  `standing=${f(afterDismiss.standing)} limited=${afterDismiss.limited} reasons=${JSON.stringify(afterDismiss.reasons)}`,
);
const burned: string[] = [];
let burnOk = true;
for (const r of [B, ...R]) {
  const st = await standingOf(r);
  const ok =
    near(st.standing, 1 - CONSTANTS.false_report_burn, 1e-4) &&
    st.limited === true &&
    JSON.stringify(st.reasons) === JSON.stringify(["adjudication"]);
  burnOk &&= ok;
  burned.push(`${r.name}=${st.standing.toFixed(6)}`);
}
check(
  "(f) every dismissed reporter's own standing burns to 1 − false_report_burn, reasons [\"adjudication\"]",
  burnOk,
  `${burned.join(" ")} (tolerance 1e-4: p_adj decays continuously from the moment it is set)`,
);

// --- (g) the operator surface is closed without the token -------------------

const noToken = await admin("/admin/review", { token: null });
check(
  "(g) the review queue rejects an unauthenticated operator call",
  noToken.status === 401 && noToken.body?.error?.code === "unauthorized",
  `${noToken.status} ${noToken.body?.error?.code ?? ""}`,
);
const spareDb = join(workDir, "no-admin.db");
const spare = await startRunad(bin, spareAddr, spareDb, null);
const spareResp = await admin("/admin/review", { token: ADMIN_TOKEN, base: `http://${spareAddr}` });
const spareMeta = await fetch(`http://${spareAddr}/api/v1/meta`);
check(
  "(g) a runad started with no RUNAD_ADMIN_TOKEN has no admin routes at all (404, while the instance is up)",
  spareResp.status === 404 && spareMeta.ok,
  `admin/review=${spareResp.status}, meta=${spareMeta.status} on ${spareAddr}`,
);
spare.kill("SIGKILL");
children.delete(spare);

// --- (h) freeze: cold outreach stops, warm paths and posting do not ---------

await sleep(1200); // report timestamps are second-precision; the queue only
// re-opens on reports newer than the last adjudication.
for (const s of S) {
  await login(s);
  await submitReport(s.account, s.device, { subject: A.account, record: postA.id, reason: "spam" });
}
const afterS = await standingOf(A);
const queue3 = await admin("/admin/review", { token: ADMIN_TOKEN });
const entryA2 = queue3.body?.entries?.find((e: any) => e.account === A.account);
const expS = expectFromReports(S);
check(
  "(h) five FRESH unconnected reporters re-cap A's p_auto and re-open the queue",
  near(afterS.standing, 1 - CONSTANTS.report_auto_cap) &&
    near(afterS.standing, expS.standing) &&
    entryA2 !== undefined &&
    entryA2.reports.length === 5,
  `standing=${f(afterS.standing)} core=${f(expS.standing)} entry reports=${entryA2?.reports?.length ?? 0} (dismissed ones excluded from mass)`,
);
const freezeAt = Date.now();
const freeze = await admin(`/admin/review/${encodeURIComponent(A.account)}`, {
  token: ADMIN_TOKEN,
  method: "POST",
  body: { decision: "freeze" },
});
const afterFreeze = await standingOf(A);
const frozenUntil = afterFreeze.frozen_until ? Date.parse(afterFreeze.frozen_until) : NaN;
const expectedUntil = freezeAt + CONSTANTS.freeze_days * 86400_000;
check(
  "(h) the freeze decision sets frozen_until ≈ now + freeze_days and adds the \"frozen\" reason",
  freeze.status === 200 &&
    Math.abs(frozenUntil - expectedUntil) < 60_000 &&
    afterFreeze.reasons.includes("frozen") &&
    afterFreeze.limited === true,
  `frozen_until=${afterFreeze.frozen_until} reasons=${JSON.stringify(afterFreeze.reasons)}`,
);
await login(A);
const coldDm = await expectApiError(() =>
  sendDm({ root: A.root, device: A.device, cert: A.cert }, X.account, "cold outreach from a frozen account"),
);
check(
  "(h) A's cold DM to a stranger returns 429 cold_outreach_frozen",
  coldDm?.status === 429 && coldDm?.code === "cold_outreach_frozen",
  `${coldDm?.status ?? "no error"} ${coldDm?.code ?? ""}`,
);
let warmOk = true;
let warmDetail = "";
try {
  await sendDm({ root: A.root, device: A.device, cert: A.cert }, W.account, "replying inside the reciprocal window");
  warmDetail = "W DM'd A before the freeze → reply accepted";
} catch (e) {
  warmOk = false;
  warmDetail = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
}
check("(h) warm paths are unaffected: A's reply into an open reciprocal window succeeds", warmOk, warmDetail);
let postOk = true;
let postDetail = "";
try {
  const p = await post(A, "M7: a frozen account can still post publicly");
  postDetail = `post ${p.id.slice(0, 12)}… accepted`;
} catch (e) {
  postOk = false;
  postDetail = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
}
check("(h) a freeze throttles cold outreach only — A can still post publicly", postOk, postDetail);

// --- (i.2) the forwarded plaintext reaches the operator queue ---------------

// A's forwarded-plaintext report alone can never open an entry (one reporter
// never reaches the cap), so the five fresh reporters join it on F: the queue
// opens for F and its payload must carry A's report verbatim.
for (const s of S) {
  await login(s);
  await submitReport(s.account, s.device, { subject: F.account, reason: "spam" });
}
const queue4 = await admin("/admin/review", { token: ADMIN_TOKEN });
const entryF = queue4.body?.entries?.find((e: any) => e.account === F.account);
const forwarded = entryF?.reports?.find((r: any) => r.author === A.account && r.type === "report");
check(
  "(i) the forwarded plaintext is visible ONLY in the operator queue, as the reporter's signed testimony",
  entryF !== undefined && forwarded !== undefined && forwarded.plaintext === dmBody && forwarded.record === dmId,
  entryF === undefined
    ? "no entry for F"
    : `entry for F carries ${entryF.reports.length} reports; A's names record ${String(forwarded?.record).slice(0, 12)}… with the decrypted body`,
);

// --- (j) reports are never metered ------------------------------------------

const drainTargets = pools.get("R1")!;
await login(Z);
for (let i = 0; i < CONSTANTS.cold_budget_open; i++) await follow(Z, drainTargets[i]!);
const drained = await getBudget();
const exhausted = await expectApiError(async () => {
  await postRecord(buildFollow(Z.account, Z.device, drainTargets[CONSTANTS.cold_budget_open]!.account));
});
check(
  "(j) a fresh account can be drained to 0 cold-outreach tokens",
  near(drained.tokens, 0, 1e-9) && exhausted?.status === 429 && exhausted?.code === "budget_exhausted",
  `tokens=${f(drained.tokens)}, next cold follow → ${exhausted?.status ?? "accepted"} ${exhausted?.code ?? ""}`,
);
let unmeteredOk = true;
let unmeteredDetail = "";
try {
  await submitReport(Z.account, Z.device, { subject: A.account, reason: "other", comment: "still able to report" });
  const stillZero = await getBudget();
  unmeteredOk = near(stillZero.tokens, 0, 1e-9);
  unmeteredDetail = `report accepted with tokens=${f(stillZero.tokens)} (unchanged)`;
} catch (e) {
  unmeteredOk = false;
  unmeteredDetail = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
}
check("(j) reports are never metered: the drained account can still report", unmeteredOk, unmeteredDetail);

// --- (c, teeth) chosen edges survive even a doubly-penalized author ---------
// Z's unmetered report just re-opened A's entry (the five fresh reports are
// still in the window and were never dismissed); upholding stacks the human
// rung on top of the capped automated one, which is the only way effective
// trust for a direct follower falls under the surface threshold.

const upheld = await admin(`/admin/review/${encodeURIComponent(A.account)}`, {
  token: ADMIN_TOKEN,
  method: "POST",
  body: { decision: "uphold" },
});
const afterUphold = await standingOf(A);
const expUpheld = standingFrom(CONSTANTS.report_auto_cap, CONSTANTS.report_uphold_penalty);
check(
  "(c) an upheld decision stacks on the capped automated rung: standing = (1−p_auto)(1−p_adj)",
  upheld.status === 200 &&
    near(afterUphold.standing, expUpheld, 1e-4) &&
    afterUphold.reasons.includes("reports") &&
    afterUphold.reasons.includes("adjudication"),
  `standing=${f(afterUphold.standing)} core=${f(expUpheld)} reasons=${JSON.stringify(afterUphold.reasons)}`,
);
await login(F);
const feedF2 = await getFeed();
const graphF2 = await getGraph2Hop();
const rankedF2 = rankFeed(F.account, feedF2.items, graphF2);
const itemF2 = rankedF2.normal.find((r) => r.id === postA.id);
await login(H);
const rankedH2 = rankFeed(H.account, (await getFeed()).items, await getGraph2Hop());
check(
  "(c) direct-follow override with teeth: F still surfaces A's post at effective trust < threshold, a hop-2 viewer does not",
  itemF2 !== undefined &&
    itemF2!.trust < CONSTANTS.feed_surface_threshold &&
    !rankedH2.normal.some((r) => r.id === postA.id),
  `F: trust=${f(itemF2?.trust ?? NaN)} < ${CONSTANTS.feed_surface_threshold} yet in the normal bucket; ` +
    `H: ${rankedH2.belowThreshold.some((r) => r.id === postA.id) ? "below-threshold" : "absent"}`,
);

// --- decay (math-only; see the note below) ----------------------------------

const halfLife = CONSTANTS.standing_half_life_days;
check(
  "(decay) penalties halve over the half-life: decayPenalty(p, 30) == p/2 (core)",
  near(decayPenalty(CONSTANTS.false_report_burn, halfLife), CONSTANTS.false_report_burn / 2, 1e-12) &&
    near(decayPenalty(CONSTANTS.report_uphold_penalty, halfLife), CONSTANTS.report_uphold_penalty / 2, 1e-12) &&
    near(standingFrom(0, decayPenalty(CONSTANTS.false_report_burn, halfLife)), 0.9, 1e-12),
  `false_report_burn ${CONSTANTS.false_report_burn} → ${f(decayPenalty(CONSTANTS.false_report_burn, halfLife))} after ${halfLife}d ` +
    `(a burned reporter's standing 0.8 → 0.9). A live server cannot be time-travelled from here without touching its db, ` +
    `so the end-to-end half-life is asserted in Go against the same lazy read path with a frozen clock and a backdated ` +
    `decay clock: TestAdminUpholdDecays in server/internal/api/standing_test.go.`,
);

// --- summary -----------------------------------------------------------------

setSessionToken(null);
killAll();
rmSync(workDir, { recursive: true, force: true });

console.log(`\n${assertionCount - failures.length}/${assertionCount} assertions passed`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const line of failures) console.log(`  FAIL ${line}`);
  process.exit(1);
}
