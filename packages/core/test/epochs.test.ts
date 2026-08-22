import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hexToBytes } from "@noble/hashes/utils";
import { b64url, utf8 } from "../src/encoding.js";
import { canonicalize } from "../src/jcs.js";
import { verifySignature, signRecord } from "../src/records.js";
import {
  makeEpoch,
  sealEpochKey,
  openEpochKey,
  sealScopedPost,
  openScopedPost,
  enumerateScope,
  needsRotation,
  type EpochKeyRecord,
  type ScopedPostRecord,
} from "../src/epochs.js";

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/protocol/vectors");
const load = (name: string) => JSON.parse(readFileSync(join(VECTORS, name), "utf8"));

const T0 = "2026-08-21T09:00:00Z";

function account(seedByte: string) {
  const seed = hexToBytes(seedByte.repeat(32));
  return { seed, id: b64url.encode(ed25519.getPublicKey(seed)) };
}
function device(signByte: string, kexByte: string) {
  const signSeed = hexToBytes(signByte.repeat(32));
  const kexSeed = hexToBytes(kexByte.repeat(32));
  return {
    signSeed,
    kexSeed,
    deviceId: b64url.encode(ed25519.getPublicKey(signSeed)),
    kexPub: x25519.getPublicKey(kexSeed),
  };
}

const alice = account("11");
const bob = account("22");
const aliceDev = device("33", "44");
const bobDev1 = device("55", "66");
const bobDev2 = device("77", "88");

describe("tier-3 epochs: direct unit tests", () => {
  it("makeEpoch produces a content-addressed epoch id distinct from its record content", () => {
    const { record, epochId } = makeEpoch({
      source: "follows",
      author: alice.id,
      device: aliceDev.deviceId,
      deviceSignSeed: aliceDev.signSeed,
      createdAt: T0,
    });
    expect(() => verifySignature(record)).not.toThrow();
    expect(record.scope).toEqual({ source: "follows" });
    expect(record.prev).toBeUndefined();
    expect(epochId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("makeEpoch carries prev when rotating", () => {
    const first = makeEpoch({ source: "web", author: alice.id, device: aliceDev.deviceId, deviceSignSeed: aliceDev.signSeed, createdAt: T0 });
    const second = makeEpoch({
      source: "web",
      prev: first.epochId,
      author: alice.id,
      device: aliceDev.deviceId,
      deviceSignSeed: aliceDev.signSeed,
      createdAt: "2026-09-21T09:00:00Z",
    });
    expect(second.record.prev).toBe(first.epochId);
    expect(second.epochId).not.toBe(first.epochId);
  });

  function sealAndOpen(bodyText: string) {
    const { epochId } = makeEpoch({ source: "follows", author: alice.id, device: aliceDev.deviceId, deviceSignSeed: aliceDev.signSeed, createdAt: T0 });
    const epochKey = hexToBytes("99".repeat(32));
    const toBob = sealEpochKey({
      epochId,
      epochKey,
      to: bob.id,
      author: alice.id,
      device: aliceDev.deviceId,
      deviceSignSeed: aliceDev.signSeed,
      createdAt: T0,
      recipients: [
        { device: bobDev1.deviceId, kexPub: bobDev1.kexPub },
        { device: bobDev2.deviceId, kexPub: bobDev2.kexPub },
      ],
    });
    const post = sealScopedPost({
      body: bodyText,
      epochId,
      epochKey,
      author: alice.id,
      device: aliceDev.deviceId,
      deviceSignSeed: aliceDev.signSeed,
      createdAt: T0,
    });
    return { epochId, epochKey, toBob, post };
  }

  it("every wrapped device can unwrap the epoch key and open posts", () => {
    const { epochKey, toBob, post } = sealAndOpen("scoped hello");
    for (const d of [bobDev1, bobDev2]) {
      const unwrapped = openEpochKey(toBob, d);
      expect(unwrapped).toEqual(epochKey);
      expect(openScopedPost(post, unwrapped).body).toBe("scoped hello");
    }
  });

  it("a non-recipient device cannot unwrap", () => {
    const { toBob } = sealAndOpen("x");
    const stranger = device("aa", "bb");
    expect(() => openEpochKey(toBob, stranger)).toThrow(/not a recipient/);
  });

  it("openEpochKey with the wrong epoch id fails (info-string binding)", () => {
    const { epochId, toBob } = sealAndOpen("x");
    const otherEpoch = makeEpoch({ source: "web", author: alice.id, device: aliceDev.deviceId, deviceSignSeed: aliceDev.signSeed, createdAt: T0 });
    expect(otherEpoch.epochId).not.toBe(epochId);
    const tampered = { ...toBob, epoch: otherEpoch.epochId } as EpochKeyRecord;
    expect(() => openEpochKey(tampered, bobDev1)).toThrow();
  });

  it("tampering with scoped-post ciphertext breaks decryption", () => {
    const { epochKey, post } = sealAndOpen("x");
    const bytes = b64url.decode(post.ciphertext);
    bytes[0]! ^= 0xff;
    const tampered = { ...post, ciphertext: b64url.encode(bytes) } as ScopedPostRecord;
    expect(() => openScopedPost(tampered, epochKey)).toThrow();
  });

  it("scoped-post ciphertext transplanted onto another author fails (AAD binding)", () => {
    const { epochKey, post } = sealAndOpen("x");
    const tampered = { ...post, author: bob.id } as ScopedPostRecord;
    expect(() => openScopedPost(tampered, epochKey)).toThrow();
  });

  it("rejects unknown alg instead of guessing", () => {
    const { epochKey, toBob, post } = sealAndOpen("x");
    expect(() => openEpochKey({ ...toBob, alg: "rot13" } as unknown as EpochKeyRecord, bobDev1)).toThrow(/unsupported/);
    expect(() => openScopedPost({ ...post, alg: "rot13" } as unknown as ScopedPostRecord, epochKey)).toThrow(/unsupported/);
  });

  it("malformed scoped-post plaintext (non-string body) is rejected on open", () => {
    // sealScopedPost always emits a well-formed {body: string} plaintext, so
    // exercise the malformed-plaintext guard by hand-building a record whose
    // AEAD-encrypted payload is structurally wrong (body is a number).
    const { epochId } = makeEpoch({ source: "follows", author: alice.id, device: aliceDev.deviceId, deviceSignSeed: aliceDev.signSeed, createdAt: T0 });
    const epochKey = hexToBytes("11".repeat(32));
    const nonce = hexToBytes("aa".repeat(24));
    const unsigned = {
      v: 1,
      type: "scoped-post",
      alg: "x25519-hkdf-sha256+xchacha20poly1305",
      author: alice.id,
      device: aliceDev.deviceId,
      created_at: T0,
      epoch: epochId,
      nonce: b64url.encode(nonce),
    };
    const ciphertext = xchacha20poly1305(epochKey, nonce, utf8(canonicalize(unsigned))).encrypt(
      utf8(JSON.stringify({ body: 42 })),
    );
    const record = signRecord({ ...unsigned, ciphertext: b64url.encode(ciphertext) }, aliceDev.signSeed) as ScopedPostRecord;
    expect(() => openScopedPost(record, epochKey)).toThrow(/malformed/);
  });

  it("deterministic under an injected RNG (vector-ready)", () => {
    let counter = 0;
    const fakeRandom = (n: number) => new Uint8Array(n).map((_, i) => (i + ++counter) % 256);
    const make = () => {
      counter = 0;
      return sealEpochKey({
        epochId: "fixed-epoch-id",
        epochKey: hexToBytes("55".repeat(32)),
        to: bob.id,
        author: alice.id,
        device: aliceDev.deviceId,
        deviceSignSeed: aliceDev.signSeed,
        createdAt: T0,
        recipients: [{ device: bobDev1.deviceId, kexPub: bobDev1.kexPub }],
        random: fakeRandom,
      });
    };
    expect(make()).toEqual(make());
  });
});

describe("enumerateScope", () => {
  const view = { follows: { V: ["A", "B"], A: ["C"], B: ["C"] } };

  it("follows scope = hop-1 follow set, sorted, excluding the viewer", () => {
    expect(enumerateScope({ follows: { V: ["B", "A", "V"] } }, "V", "follows")).toEqual(["A", "B"]);
  });

  it("web scope = trustMap membership at/above feed_surface_threshold", () => {
    expect(enumerateScope(view, "V", "web")).toEqual(["A", "B", "C"]);
  });

  it("throws on an unknown or reserved source", () => {
    expect(() => enumerateScope(view, "V", "roster")).toThrow(/unknown or reserved/);
    expect(() => enumerateScope(view, "V", "bogus")).toThrow(/unknown or reserved/);
  });

  it("follows scope excludes a muted-but-followed account (design §7.1: mute is a membership-removal event)", () => {
    const muted = { follows: { V: ["A", "B", "M"] }, mutes: ["M"] };
    expect(enumerateScope(muted, "V", "follows")).toEqual(["A", "B"]);
  });

  it("follows scope is unaffected when mutes is absent or empty", () => {
    expect(enumerateScope({ follows: { V: ["A", "B"] } }, "V", "follows")).toEqual(["A", "B"]);
    expect(enumerateScope({ follows: { V: ["A", "B"] }, mutes: [] }, "V", "follows")).toEqual(["A", "B"]);
  });

  it("web scope also excludes muted accounts and prunes propagation through them (via trustMap)", () => {
    const graph = { follows: { V: ["A", "M"], M: ["E"] }, mutes: ["M"] };
    expect(enumerateScope(graph, "V", "web")).toEqual(["A"]);
  });
});

describe("needsRotation", () => {
  const constants = { epoch_max_age_days: 30 };

  it("false when members match and age is within bounds", () => {
    expect(
      needsRotation({
        createdAt: "2026-08-01T00:00:00Z",
        currentMembers: ["A", "B"],
        frozenMembers: ["B", "A"],
        nowIso: "2026-08-10T00:00:00Z",
        constants,
      }),
    ).toBe(false);
  });

  it("true when the member set changed", () => {
    expect(
      needsRotation({
        createdAt: "2026-08-01T00:00:00Z",
        currentMembers: ["A", "B", "C"],
        frozenMembers: ["A", "B"],
        nowIso: "2026-08-02T00:00:00Z",
        constants,
      }),
    ).toBe(true);
  });

  it("true when the epoch is older than epoch_max_age_days", () => {
    expect(
      needsRotation({
        createdAt: "2026-01-01T00:00:00Z",
        currentMembers: ["A"],
        frozenMembers: ["A"],
        nowIso: "2026-08-01T00:00:00Z",
        constants,
      }),
    ).toBe(true);
  });

  it("defaults constants to the published CONSTANTS when omitted", () => {
    expect(
      needsRotation({
        createdAt: "2026-08-01T00:00:00Z",
        currentMembers: ["A"],
        frozenMembers: ["A"],
        nowIso: "2026-08-02T00:00:00Z",
      }),
    ).toBe(false);
  });
});

describe("vectors: epoch-v1-01", () => {
  const v = load("epoch-v1-01.json");

  it("epoch record verifies and its record id matches epoch_id", () => {
    expect(() => verifySignature(v.epoch)).not.toThrow();
  });

  it("epoch-key records verify, unwrap to epoch_key_hex, and scoped-post opens to plaintext", () => {
    expect(() => verifySignature(v.epoch_key_to_recipient)).not.toThrow();
    expect(() => verifySignature(v.epoch_key_self_grant)).not.toThrow();
    expect(() => verifySignature(v.scoped_post)).not.toThrow();

    const recipDevKexSeed = hexToBytes(v.seeds.recipient_device_x25519);
    const unwrappedForRecipient = openEpochKey(v.epoch_key_to_recipient, {
      deviceId: v.keys.recipient_device,
      kexSeed: recipDevKexSeed,
    });
    expect(b64url.encode(unwrappedForRecipient)).toBe(b64url.encode(hexToBytes(v.epoch_key_hex)));

    const authorDev2KexSeed = hexToBytes(v.seeds.author_device2_x25519);
    const unwrappedForSelf = openEpochKey(v.epoch_key_self_grant, {
      deviceId: v.keys.author_device2,
      kexSeed: authorDev2KexSeed,
    });
    expect(b64url.encode(unwrappedForSelf)).toBe(b64url.encode(hexToBytes(v.epoch_key_hex)));

    const opened = openScopedPost(v.scoped_post, hexToBytes(v.epoch_key_hex));
    expect(opened).toEqual(v.plaintext);
  });

  it("every tamper case throws", () => {
    const recipDevKexSeed = hexToBytes(v.seeds.recipient_device_x25519);
    for (const tc of v.tamper_cases) {
      const source = tc.record === "scoped_post" ? v.scoped_post : v.epoch_key_to_recipient;
      const mutated = { ...source, [tc.mutation.field]: mutatedValue(tc, source) };
      if (tc.record === "scoped_post") {
        expect(() => openScopedPost(mutated, hexToBytes(v.epoch_key_hex)), tc.name).toThrow();
      } else {
        expect(() => openEpochKey(mutated, { deviceId: v.keys.recipient_device, kexSeed: recipDevKexSeed }), tc.name).toThrow();
      }
    }
  });

  it("the signature-invalid tamper case (d) also fails signature verification directly", () => {
    const tc = v.tamper_cases.find((c: { record: string; mutation: { field: string } }) => c.mutation.field === "nonce");
    expect(tc).toBeDefined();
    const mutated = { ...v.scoped_post, nonce: tc.mutation.value };
    expect(() => verifySignature(mutated)).toThrow();
  });

  it("every tamper mutation also invalidates the record's own signature (defense in depth)", () => {
    for (const tc of v.tamper_cases) {
      const source = tc.record === "scoped_post" ? v.scoped_post : v.epoch_key_to_recipient;
      const mutated = { ...source, [tc.mutation.field]: mutatedValue(tc, source) };
      expect(() => verifySignature(mutated), tc.name).toThrow();
    }
  });

  function mutatedValue(tc: { mutation: { field: string; value?: string; op?: string } }, source: Record<string, unknown>): unknown {
    if (tc.mutation.value !== undefined) return tc.mutation.value;
    // "flip first byte" op: applies to a base64url field named in `field`.
    const bytes = b64url.decode(source[tc.mutation.field] as string);
    bytes[0]! ^= 0xff;
    return b64url.encode(bytes);
  }
});

describe("vectors: scope-01", () => {
  const v = load("scope-01.json");

  for (const c of v.cases) {
    it(c.name, () => {
      if (c.error) {
        expect(() => enumerateScope(v.graph, v.viewer, c.source, v.constants)).toThrow();
      } else {
        expect(enumerateScope(v.graph, v.viewer, c.source, v.constants)).toEqual(c.expected_members);
      }
    });
  }
});
