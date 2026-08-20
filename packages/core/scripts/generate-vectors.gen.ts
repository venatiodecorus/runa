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
import { hexToBytes } from "@noble/hashes/utils";
import { CONSTANTS } from "../src/constants.js";
import { b64url } from "../src/encoding.js";
import { canonicalize } from "../src/jcs.js";
import { signRecord, signingBytes } from "../src/records.js";
import { subjectiveTrust } from "../src/trust.js";

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
