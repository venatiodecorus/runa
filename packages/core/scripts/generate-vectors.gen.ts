/**
 * Regenerates the shared protocol vectors in docs/protocol/vectors/ from the
 * TS reference implementation. Run via: npm run gen:vectors -w packages/core
 *
 * Vectors are generated from one implementation and verified by both (the Go
 * suite consumes the same files), plus reviewed by hand — a format change
 * without a vector change is rejected in review (protocol §8).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { CONSTANTS } from "../src/constants.js";
import { b64url } from "../src/encoding.js";
import { canonicalize } from "../src/jcs.js";
import { signRecord, signingBytes } from "../src/records.js";
import { subjectiveTrust } from "../src/trust.js";
import { dailyBudget, isColdInitiation } from "../src/budgets.js";
import { sealDm, openDm } from "../src/envelope.js";
import {
  makeEpoch,
  sealEpochKey,
  openEpochKey,
  sealScopedPost,
  openScopedPost,
  enumerateScope,
} from "../src/epochs.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/protocol/vectors");

const ROOT_SEED = "11".repeat(32);
const DEVICE_SEED = "22".repeat(32);
const KEX_SEED = "33".repeat(32);
const T0 = "2026-08-20T12:00:00Z";

it("regenerates protocol vectors", () => {
  mkdirSync(OUT, { recursive: true });

  // --- jcs-01: canonicalization cases -------------------------------------
  const jcsCases = [
    { name: "sorted keys", input: { b: 1, a: 2 }, canonical: '{"a":2,"b":1}' },
    { name: "utf16 code unit order", input: { "é": 1, z: 2 }, canonical: '{"z":2,"é":1}' },
    {
      name: "nesting and arrays",
      input: { a: [3, 1, { c: null, b: true }] },
      canonical: '{"a":[3,1,{"b":true,"c":null}]}',
    },
    { name: "string escapes", input: { s: 'a"b\n' }, canonical: '{"s":"a\\"b\\n\\u0007"}' },
    { name: "integers", input: { zero: 0, big: 9007199254740991, neg: -42 }, canonical: '{"big":9007199254740991,"neg":-42,"zero":0}' },
    { name: "empty containers", input: { a: {}, b: [] }, canonical: '{"a":{},"b":[]}' },
  ];
  for (const c of jcsCases) {
    if (canonicalize(c.input) !== c.canonical) throw new Error(`jcs self-check failed: ${c.name}`);
  }
  write("jcs-01.json", {
    description: "RFC 8785 canonicalization cases. Both implementations must produce `canonical` from `input`.",
    cases: jcsCases,
  });

  // --- records-01: signed records, valid and invalid ----------------------
  const rootPriv = hexToBytes(ROOT_SEED);
  const devicePriv = hexToBytes(DEVICE_SEED);
  const rootPub = b64url.encode(ed25519.getPublicKey(rootPriv));
  const devicePub = b64url.encode(ed25519.getPublicKey(devicePriv));
  const kexPub = b64url.encode(x25519.getPublicKey(hexToBytes(KEX_SEED)));

  const cert = signRecord(
    { v: 1, type: "device-cert", author: rootPub, created_at: T0, device_sign_pub: devicePub, device_kex_pub: kexPub },
    rootPriv,
  );
  const revocation = signRecord(
    { v: 1, type: "device-revoke", author: rootPub, created_at: "2026-08-21T00:00:00Z", device_sign_pub: devicePub },
    rootPriv,
  );
  const post = signRecord(
    { v: 1, type: "post", author: rootPub, device: devicePub, created_at: T0, body: "hello runa" },
    devicePriv,
  );
  const postAfterRevocation = signRecord(
    { v: 1, type: "post", author: rootPub, device: devicePub, created_at: "2026-08-21T00:00:01Z", body: "too late" },
    devicePriv,
  );

  write("records-01.json", {
    description:
      "Signed-record verification cases. Keys are derived from the given hex seeds (test keys only). " +
      "`certs`/`revocations` are context for chain verification. Each case: verify record; expect `valid`; " +
      "for valid device-signed records also expect signing_bytes and (where given) record chain acceptance.",
    seeds: { root_ed25519: ROOT_SEED, device_ed25519: DEVICE_SEED, device_x25519: KEX_SEED },
    keys: { account_id: rootPub, device_id: devicePub, device_kex_pub: kexPub },
    certs: [cert],
    revocations: [revocation],
    cases: [
      { name: "valid device-cert (root-signed)", record: cert, valid: true, check: "signature" },
      { name: "valid post with cert chain, pre-revocation", record: post, valid: true, check: "chain", signing_bytes_utf8: new TextDecoder().decode(signingBytes(post)) },
      { name: "tampered body", record: { ...post, body: "evil" }, valid: false, check: "signature", reason: "signature must fail after tamper" },
      { name: "post created after device revocation", record: postAfterRevocation, valid: false, check: "chain", reason: "revocation predates record" },
      { name: "float smuggled into signed record", record: { ...post, score: 0.5 }, valid: false, check: "signature", reason: "ADR-0005: no non-integer numbers in signed records" },
      { name: "millisecond timestamp rejected", record: { ...post, created_at: "2026-08-20T12:00:00.123Z" }, valid: false, check: "signature", reason: "created_at must be second-precision Z" },
    ],
  });

  // --- trust-graph-01: subjective trust over fixture graphs ---------------
  const trustCases = [
    { name: "direct follow", graph: { follows: { V: ["A"] } }, viewer: "V", author: "A", trust: 1.0 },
    { name: "single 2-hop path", graph: { follows: { V: ["A"], A: ["B"] } }, viewer: "V", author: "B", trust: 0.35 },
    { name: "beyond hop cap", graph: { follows: { V: ["A"], A: ["B"], B: ["C"] } }, viewer: "V", author: "C", trust: 0 },
    {
      name: "paths sum: direct + two vouches",
      graph: { follows: { V: ["A", "M1", "M2"], M1: ["A"], M2: ["A"] } },
      viewer: "V", author: "A", trust: 1.7,
    },
    {
      name: "sum caps at 2.0",
      graph: { follows: { V: ["A", "M1", "M2", "M3", "M4"], M1: ["A"], M2: ["A"], M3: ["A"], M4: ["A"] } },
      viewer: "V", author: "A", trust: 2.0,
    },
    {
      name: "muted author is hard zero",
      graph: { follows: { V: ["A", "M"], M: ["A"] }, mutes: ["A"] },
      viewer: "V", author: "A", trust: 0,
    },
    {
      name: "mute prunes propagation",
      graph: { follows: { V: ["M", "A"], M: ["B"], A: ["B"] }, mutes: ["M"] },
      viewer: "V", author: "B", trust: 0.35,
    },
    {
      name: "mixed graph, hop-1 plus vouch",
      graph: { follows: { V: ["A", "B", "M"], A: ["B", "C"], B: ["C"], M: ["C"] }, mutes: ["M"] },
      viewer: "V", author: "B", trust: 1.35,
    },
  ];
  for (const c of trustCases) {
    const got = subjectiveTrust(c.viewer, c.author, c.graph);
    if (Math.abs(got - c.trust) > 1e-9) throw new Error(`trust self-check failed: ${c.name}: ${got}`);
  }
  write("trust-graph-01.json", {
    description:
      "Subjective trust cases (docs/trust-and-reach.md §1), reference constants (decay 0.35, cap 2.0). " +
      "Implementations must produce `trust` within 1e-9 for (viewer, author) over `graph`.",
    cases: trustCases,
  });

  // --- envelope-v1-01: tier-2 DM seal/open with all keys given ------------
  {
    const senderRoot = hexToBytes("aa".repeat(32));
    const senderDevSign = hexToBytes("bb".repeat(32));
    const recipRoot = hexToBytes("cc".repeat(32));
    const recipDevKex = hexToBytes("dd".repeat(32));
    const recipDevSign = hexToBytes("ee".repeat(32));
    const senderId = b64url.encode(ed25519.getPublicKey(senderRoot));
    const recipId = b64url.encode(ed25519.getPublicKey(recipRoot));
    const recipDevId = b64url.encode(ed25519.getPublicKey(recipDevSign));
    let ctr = 0;
    const fakeRandom = (n: number) => new Uint8Array(n).map((_, i) => (i + ++ctr) % 256);
    const dm = sealDm({
      body: "vector message",
      participants: [senderId, recipId],
      to: recipId,
      author: senderId,
      device: b64url.encode(ed25519.getPublicKey(senderDevSign)),
      deviceSignSeed: senderDevSign,
      createdAt: T0,
      recipients: [{ device: recipDevId, kexPub: x25519.getPublicKey(recipDevKex) }],
      random: fakeRandom,
    });
    // self-check
    const opened = openDm(dm, { deviceId: recipDevId, kexSeed: recipDevKex });
    if (opened.body !== "vector message") throw new Error("envelope self-check failed");
    write("envelope-v1-01.json", {
      description:
        "Tier-2 envelope v1 (protocol §4). All private keys are test keys (hex seeds). Implementations must: " +
        "verify the record signature; open as the recipient device and obtain `plaintext`; fail on any of the " +
        "tamper mutations. Servers verify signatures/structure only — they cannot and must not decrypt.",
      seeds: {
        sender_device_ed25519: "bb".repeat(32),
        recipient_device_x25519: "dd".repeat(32),
        recipient_device_ed25519: "ee".repeat(32),
      },
      envelope: dm,
      plaintext: opened,
      tamper_mutations: [
        { field: "to", value: senderId, expect: "decryption failure (AAD binding)" },
        { field: "ciphertext", value: "AAAA" + dm.ciphertext.slice(4), expect: "decryption failure" },
      ],
    });
  }

  // --- epoch-v1-01: tier-3 epoch/epoch-key/scoped-post, all keys given -----
  {
    const authorRoot = hexToBytes("a1".repeat(32));
    const authorDev1Sign = hexToBytes("a2".repeat(32)); // author's posting device (ed25519 only — never receives a wrap in this vector)
    const authorDev2Sign = hexToBytes("a3".repeat(32));
    const authorDev2Kex = hexToBytes("a4".repeat(32)); // author's second device — receives the self-grant
    const recipRoot = hexToBytes("b1".repeat(32));
    const recipDevSign = hexToBytes("b2".repeat(32));
    const recipDevKex = hexToBytes("b3".repeat(32));

    const authorId = b64url.encode(ed25519.getPublicKey(authorRoot));
    const authorDev1Id = b64url.encode(ed25519.getPublicKey(authorDev1Sign));
    const authorDev2Id = b64url.encode(ed25519.getPublicKey(authorDev2Sign));
    const authorDev2KexPub = x25519.getPublicKey(authorDev2Kex);
    const recipId = b64url.encode(ed25519.getPublicKey(recipRoot));
    const recipDevId = b64url.encode(ed25519.getPublicKey(recipDevSign));
    const recipDevKexPub = x25519.getPublicKey(recipDevKex);

    let ctr = 0;
    const fakeRandom = (n: number) => new Uint8Array(n).map((_, i) => (i + ++ctr) % 256);

    const { record: epoch, epochId } = makeEpoch({
      source: "follows",
      author: authorId,
      device: authorDev1Id,
      deviceSignSeed: authorDev1Sign,
      createdAt: T0,
    });
    // A second, otherwise-unrelated epoch — used only to supply a genuinely
    // different (but valid-looking) epoch id for the wrap-replay tamper case.
    const { epochId: otherEpochId } = makeEpoch({
      source: "web",
      author: authorId,
      device: authorDev1Id,
      deviceSignSeed: authorDev1Sign,
      createdAt: T0,
    });

    const epochKey = hexToBytes("c1".repeat(32));

    const epochKeyToRecipient = sealEpochKey({
      epochId,
      epochKey,
      to: recipId,
      author: authorId,
      device: authorDev1Id,
      deviceSignSeed: authorDev1Sign,
      createdAt: T0,
      recipients: [{ device: recipDevId, kexPub: recipDevKexPub }],
      random: fakeRandom,
    });
    const epochKeySelfGrant = sealEpochKey({
      epochId,
      epochKey,
      to: authorId,
      author: authorId,
      device: authorDev1Id,
      deviceSignSeed: authorDev1Sign,
      createdAt: T0,
      recipients: [{ device: authorDev2Id, kexPub: authorDev2KexPub }],
      random: fakeRandom,
    });
    const scopedPost = sealScopedPost({
      body: "hello, web scope",
      epochId,
      epochKey,
      author: authorId,
      device: authorDev1Id,
      deviceSignSeed: authorDev1Sign,
      createdAt: T0,
      random: fakeRandom,
    });

    // self-checks
    const unwrappedForRecipient = openEpochKey(epochKeyToRecipient, { deviceId: recipDevId, kexSeed: recipDevKex });
    const unwrappedForSelf = openEpochKey(epochKeySelfGrant, { deviceId: authorDev2Id, kexSeed: authorDev2Kex });
    if (b64url.encode(unwrappedForRecipient) !== b64url.encode(epochKey)) {
      throw new Error("epoch-key self-check failed: recipient unwrap mismatch");
    }
    if (b64url.encode(unwrappedForSelf) !== b64url.encode(epochKey)) {
      throw new Error("epoch-key self-check failed: self-grant unwrap mismatch");
    }
    const openedPost = openScopedPost(scopedPost, epochKey);
    if (openedPost.body !== "hello, web scope") throw new Error("scoped-post self-check failed");

    // tamper case (b) must actually fail here too, not just in the consuming suite.
    let wrongEpochThrew = false;
    try {
      openEpochKey({ ...epochKeyToRecipient, epoch: otherEpochId }, { deviceId: recipDevId, kexSeed: recipDevKex });
    } catch {
      wrongEpochThrew = true;
    }
    if (!wrongEpochThrew) throw new Error("epoch-key tamper self-check failed: wrong-epoch unwrap should have failed");

    write("epoch-v1-01.json", {
      description:
        "Tier-3 epoch/epoch-key/scoped-post (protocol §5). All private keys are test keys (hex seeds). " +
        "Implementations must: verify each record's signature; unwrap `epoch_key_hex` from both " +
        "`epoch_key_to_recipient` (as the recipient device) and `epoch_key_self_grant` (as the author's second " +
        "device) and check it matches byte-for-byte; open `scoped_post` with that key and obtain `plaintext`; " +
        "fail on every case in `tamper_cases`. Servers verify signatures/structure only — they never hold `K_e`.",
      seeds: {
        author_root_ed25519: "a1".repeat(32),
        author_device1_ed25519: "a2".repeat(32),
        author_device2_ed25519: "a3".repeat(32),
        author_device2_x25519: "a4".repeat(32),
        recipient_root_ed25519: "b1".repeat(32),
        recipient_device_ed25519: "b2".repeat(32),
        recipient_device_x25519: "b3".repeat(32),
      },
      keys: {
        author: authorId,
        author_device1: authorDev1Id,
        author_device2: authorDev2Id,
        recipient: recipId,
        recipient_device: recipDevId,
      },
      epoch,
      epoch_id: epochId,
      other_epoch_id: otherEpochId,
      epoch_key_hex: bytesToHex(epochKey),
      epoch_key_to_recipient: epochKeyToRecipient,
      epoch_key_self_grant: epochKeySelfGrant,
      scoped_post: scopedPost,
      plaintext: openedPost,
      tamper_cases: [
        {
          name: "flipped bit in scoped-post ciphertext",
          record: "scoped_post",
          mutation: { field: "ciphertext", op: "flip first byte" },
          expect: "AEAD authentication failure on open",
        },
        {
          name: "epoch-key epoch field swapped to a different epoch",
          record: "epoch_key_to_recipient",
          mutation: { field: "epoch", value: otherEpochId },
          expect: "unwrap fails: HKDF info is bound to the ORIGINAL epoch id, not the record's (tampered) epoch field",
        },
        {
          name: "scoped-post author swapped (AAD transplant)",
          record: "scoped_post",
          mutation: { field: "author", value: recipId },
          expect: "AEAD authentication failure on open: AAD binds author",
        },
        {
          name: "scoped-post nonce tampered without re-signing",
          record: "scoped_post",
          mutation: { field: "nonce", value: b64url.encode(new Uint8Array(24)) },
          expect: "signature verification fails (record was mutated post-signing)",
        },
      ],
    });
  }

  // --- scope-01: scope enumeration over a graph fixture --------------------
  {
    const scopeGraph = {
      follows: { V: ["A", "B", "M"], A: ["C"], B: ["C"], M: ["E"] },
      mutes: ["M"],
    };
    const viewer = "V";
    const followMembers = enumerateScope(scopeGraph, viewer, "follows");
    const webMembers = enumerateScope(scopeGraph, viewer, "web");
    if (JSON.stringify(followMembers) !== JSON.stringify(["A", "B"])) {
      throw new Error(`scope self-check failed: follows = ${JSON.stringify(followMembers)}`);
    }
    if (JSON.stringify(webMembers) !== JSON.stringify(["A", "B", "C"])) {
      throw new Error(`scope self-check failed: web = ${JSON.stringify(webMembers)}`);
    }
    let rosterThrew = false;
    try {
      enumerateScope(scopeGraph, viewer, "roster");
    } catch {
      rosterThrew = true;
    }
    if (!rosterThrew) throw new Error("scope self-check failed: reserved source 'roster' should be rejected");

    write("scope-01.json", {
      description:
        "Scope enumeration (protocol §5.1) over a graph fixture (GraphView shape, as trust-graph-01). " +
        "`follows` = the viewer's hop-1 follow list MINUS any account the viewer currently mutes (design §7.1: " +
        "a mute is a membership-removal event, so a muted-but-followed account is excluded from BOTH scopes). " +
        "`web` = every account within the hop cap whose trust from the viewer's vantage clears " +
        "`feed_surface_threshold`, via trustMap. V follows A, B, and M but mutes M: M is excluded from the " +
        "`follows` scope despite being followed, and — because trustMap also prunes propagation through a muted " +
        "account — M contributes nothing to `web` either, pruning hop-2 account E (reachable only through M) out " +
        "of the web scope entirely (its trust drops to 0, below threshold). " +
        "Implementations must reproduce `expected_members` for each case and reject the reserved `roster` source.",
      graph: scopeGraph,
      constants: {
        hop_cap: CONSTANTS.hop_cap,
        per_hop_decay: CONSTANTS.per_hop_decay,
        multi_path_sum_cap: CONSTANTS.multi_path_sum_cap,
        feed_surface_threshold: CONSTANTS.feed_surface_threshold,
      },
      viewer,
      cases: [
        { name: "follows scope = hop-1 follow list minus mutes (muted-but-followed M excluded)", source: "follows", expected_members: followMembers },
        { name: "web scope = trust-threshold reachable set; mute prunes hop-2 account E", source: "web", expected_members: webMembers },
        { name: "reserved scope source is rejected", source: "roster", error: true },
      ],
    });
  }

  // --- budgets-01: cold-outreach budget formula ---------------------------
  const budgetCases = [
    { name: "no followers = base", base: 5, inbound_trust: 0, k: 4, standing: 1, budget: 5 },
    { name: "ten followers ≈ 3× base", base: 5, inbound_trust: 10, k: 4, standing: 1, budget: 5 + 4 * Math.log(11) },
    { name: "flat late: 1000 followers", base: 5, inbound_trust: 1000, k: 4, standing: 1, budget: 5 + 4 * Math.log(1001) },
    { name: "standing halves the budget", base: 5, inbound_trust: 10, k: 4, standing: 0.5, budget: (5 + 4 * Math.log(11)) / 2 },
    { name: "invite base", base: 15, inbound_trust: 0, k: 4, standing: 1, budget: 15 },
  ];
  for (const c of budgetCases) {
    const got = dailyBudget(c.base, c.inbound_trust, c.k, c.standing);
    if (Math.abs(got - c.budget) > 1e-9) throw new Error(`budget self-check failed: ${c.name}`);
  }
  write("budgets-01.json", {
    description:
      "budget = (base + k×log(1+Σ inbound_trust)) × standing (trust-and-reach §3). Natural log. Tolerance 1e-9.",
    cases: budgetCases,
  });

  // --- cold-01: cold-initiation classification (recipient vantage) --------
  const coldCases = [
    { name: "stranger is cold", graph: { follows: {} }, recipient: "R", sender: "S", cold: true },
    { name: "direct followee is warm", graph: { follows: { R: ["S"] } }, recipient: "R", sender: "S", cold: false },
    { name: "hop-2 at decay 0.35 ≥ threshold 0.3 is warm", graph: { follows: { R: ["M"], M: ["S"] } }, recipient: "R", sender: "S", cold: false },
    { name: "sender following recipient does NOT warm (recipient vantage)", graph: { follows: { S: ["R"] } }, recipient: "R", sender: "S", cold: true },
    { name: "muted sender is cold despite path", graph: { follows: { R: ["S"] }, mutes: ["S"] }, recipient: "R", sender: "S", cold: true },
    { name: "hop-3 is cold", graph: { follows: { R: ["A"], A: ["B"], B: ["S"] } }, recipient: "R", sender: "S", cold: true },
  ];
  for (const c of coldCases) {
    if (isColdInitiation(c.recipient, c.sender, c.graph) !== c.cold) {
      throw new Error(`cold self-check failed: ${c.name}`);
    }
  }
  write("cold-01.json", {
    description:
      "Cold-initiation classification (trust-and-reach §3): cold iff recipient's effective trust in sender " +
      "< feed_surface_threshold, computed from the RECIPIENT's vantage. Reference constants.",
    cases: coldCases,
  });

  // --- constants-01: cross-implementation constants agreement -------------
  write("constants-01.json", {
    description:
      "Published reference constants. Go (trust.Constants()), TS (CONSTANTS), and docs/trust-and-reach.md §6 must all match.",
    constants: CONSTANTS,
  });
});

function write(name: string, value: unknown): void {
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote ${name}`);
}
