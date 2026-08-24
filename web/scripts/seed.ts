/**
 * Dev seeding script: populates a running runad instance with the persona
 * cast in seed-fixture.json, acting as N real clients — every record goes
 * through the web client's own crypto + API modules and the server's normal
 * ingest verification. Never touches the database directly.
 *
 *   make seed          (from the repo root; server must be running)
 *   VITE_API_BASE=http://127.0.0.1:8080 npm run seed -w web
 *
 * Root seeds are derived deterministically from each handle, so account ids
 * are stable across every reseed. Recovery word lists land in
 * testKeys/seed-personas.json (gitignored) — paste one into the web app's
 * "recover from words" flow to act as that persona in a browser.
 *
 * To start over: stop the server, `make reset`, restart, `make seed`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { nowTimestamp, signRecord, utf8, type DeviceCert } from "@runa/core";
import {
  API_BASE,
  ApiError,
  authenticate,
  createAccount,
  postRecord,
  setSessionToken,
} from "../src/api/client.js";
import {
  buildDeviceCert,
  deviceFromSeeds,
  rootFromSeed,
  signAuthChallenge,
  type DeviceKeys,
  type RootKey,
} from "../src/crypto/keys.js";
import { buildFollow } from "../src/crypto/graph.js";
import { seedToMnemonic } from "../src/crypto/recoverykit.js";
import { sendDm } from "../src/dm/dm.js";

interface PersonaSpec {
  handle: string;
  display_name: string;
  bio: string;
  follows: string[];
  posts: string[];
}

interface Fixture {
  personas: PersonaSpec[];
  /** Replies to `to`'s Nth post (0-based), posted after all top-level posts. */
  replies: Array<{ from: string; to: string; post: number; body: string }>;
  dms: Array<{ from: string; to: string; body: string }>;
}

interface Persona extends PersonaSpec {
  root: RootKey;
  device: DeviceKeys;
  cert: DeviceCert;
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(scriptsDir, "seed-fixture.json"), "utf8")) as Fixture;

if (API_BASE === "") {
  console.error("VITE_API_BASE is not set — run via `make seed`, or set it to the instance URL.");
  process.exit(2);
}

/** Deterministic 32-byte seed per (handle, role) — stable account ids across reseeds. */
function derivedSeed(handle: string, role: string): Uint8Array {
  return sha256(utf8(`runa-seed-fixture:v1:${handle}:${role}`));
}

function makePersona(spec: PersonaSpec): Persona {
  const root = rootFromSeed(derivedSeed(spec.handle, "root"));
  const device = deviceFromSeeds(
    derivedSeed(spec.handle, "device-sign"),
    derivedSeed(spec.handle, "device-kex"),
  );
  return { ...spec, root, device, cert: buildDeviceCert(root, device, "seed-script") };
}

function minutesAgo(min: number): string {
  return nowTimestamp(new Date(Date.now() - min * 60_000));
}

async function login(p: Persona): Promise<void> {
  await authenticate(p.root.account, p.device.deviceId, (c) =>
    signAuthChallenge(p.device.signSeed, c),
  );
}

const personas = fixture.personas.map(makePersona);
const byHandle = new Map(personas.map((p) => [p.handle, p]));

function resolve(handle: string): Persona {
  const p = byHandle.get(handle);
  if (p === undefined) throw new Error(`fixture references unknown handle: ${handle}`);
  return p;
}

// 1. Accounts (open signup, no auth). A 409 means the DB already holds this
//    cast — seeding is meant for a fresh DB, so bail with the reset recipe.
for (const p of personas) {
  try {
    await createAccount(p.root.account, p.cert);
  } catch (e) {
    if (e instanceof ApiError && e.code === "account_exists") {
      console.error(
        `account for '${p.handle}' already exists — already seeded. ` +
          "To start fresh: stop the server, run `make reset`, restart, then `make seed`.",
      );
      process.exit(1);
    }
    throw e;
  }
}
console.log(`created ${personas.length} accounts`);

// 2. Profiles + posts. Posts are round-robin interleaved across personas and
//    backdated a few minutes apart so the feed shows a varied, recent history.
const postSlots: Array<{ p: Persona; body: string }> = [];
for (let i = 0; ; i++) {
  const round = personas.filter((p) => i < p.posts.length).map((p) => ({ p, body: p.posts[i] }));
  if (round.length === 0) break;
  postSlots.push(...round);
}
let posted = 0;
/** handle → record id of each top-level post, in fixture order (reply targets). */
const postIds = new Map<string, string[]>();
for (const p of personas) {
  await login(p);
  if (p.display_name !== "" || p.bio !== "") {
    await postRecord(
      signRecord(
        {
          v: 1,
          type: "profile",
          author: p.root.account,
          device: p.device.deviceId,
          created_at: minutesAgo(postSlots.length * 7 + 5),
          ...(p.display_name !== "" ? { display_name: p.display_name } : {}),
          ...(p.bio !== "" ? { bio: p.bio } : {}),
        },
        p.device.signSeed,
      ),
    );
  }
  for (const [slot, entry] of postSlots.entries()) {
    if (entry.p !== p) continue;
    const { id } = await postRecord(
      signRecord(
        {
          v: 1,
          type: "post",
          author: p.root.account,
          device: p.device.deviceId,
          created_at: minutesAgo((postSlots.length - slot) * 7),
          body: entry.body,
        },
        p.device.signSeed,
      ),
    );
    postIds.set(p.handle, [...(postIds.get(p.handle) ?? []), id]);
    posted++;
  }
}
console.log(`posted profiles and ${posted} posts`);

// 2b. Replies (protocol §6 "Replies & threads"): plain posts carrying
//     `reply_to`, landing after every top-level post, a minute apart.
for (const [i, reply] of (fixture.replies ?? []).entries()) {
  const sender = resolve(reply.from);
  const parentId = postIds.get(reply.to)?.[reply.post];
  if (parentId === undefined) {
    throw new Error(`replies[${i}]: ${reply.to} has no post #${reply.post}`);
  }
  await login(sender);
  await postRecord(
    signRecord(
      {
        v: 1,
        type: "post",
        author: sender.root.account,
        device: sender.device.deviceId,
        created_at: minutesAgo(fixture.replies.length - i),
        body: reply.body,
        reply_to: parentId,
      },
      sender.device.signSeed,
    ),
  );
}
console.log(`posted ${fixture.replies?.length ?? 0} replies`);

// 3. Follow graph.
let followed = 0;
for (const p of personas) {
  if (p.follows.length === 0) continue;
  await login(p);
  for (const target of p.follows) {
    await postRecord(buildFollow(p.root.account, p.device, resolve(target).root.account));
    followed++;
  }
}
console.log(`created ${followed} follow edges`);

// 4. DMs, in fixture order (replies must land after the message they answer).
for (const dm of fixture.dms) {
  const sender = resolve(dm.from);
  await login(sender);
  await sendDm(
    { root: sender.root, device: sender.device, cert: sender.cert },
    resolve(dm.to).root.account,
    dm.body,
  );
}
console.log(`sent ${fixture.dms.length} dms`);
setSessionToken(null);

// 5. Recovery info: word lists go to a gitignored file, ids to the console.
const outDir = join(scriptsDir, "..", "..", "testKeys");
const outPath = join(outDir, "seed-personas.json");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generated_at: nowTimestamp(),
      api_base: API_BASE,
      personas: personas.map((p) => ({
        handle: p.handle,
        account: p.root.account,
        mnemonic: seedToMnemonic(p.root.seed),
      })),
    },
    null,
    2,
  ) + "\n",
);

console.log(`\nseeded ${API_BASE} with:`);
for (const p of personas) {
  console.log(`  ${p.handle.padEnd(8)} ${p.root.account}`);
}
console.log(`\nrecovery word lists: ${outPath}`);
console.log('to act as a persona in a browser, use "Recover" with its word list.');
