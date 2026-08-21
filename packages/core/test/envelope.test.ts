import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import { b64url } from "../src/encoding.js";
import { verifySignature } from "../src/records.js";
import { conversationId, openDm, sealDm, type DmRecord } from "../src/envelope.js";

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

function seal(body = "hi bob", to = bob.id): DmRecord {
  return sealDm({
    body,
    participants: [alice.id, bob.id],
    to,
    author: alice.id,
    device: aliceDev.deviceId,
    deviceSignSeed: aliceDev.signSeed,
    createdAt: T0,
    recipients: [
      { device: bobDev1.deviceId, kexPub: bobDev1.kexPub },
      { device: bobDev2.deviceId, kexPub: bobDev2.kexPub },
      { device: aliceDev.deviceId, kexPub: x25519.getPublicKey(aliceDev.kexSeed) },
    ],
  });
}

describe("tier-2 envelope v1", () => {
  it("all recipient devices (both participants) can open; plaintext is bound to the conversation", () => {
    const dm = seal();
    verifySignature(dm);
    for (const d of [bobDev1, bobDev2, aliceDev]) {
      const p = openDm(dm, d);
      expect(p.body).toBe("hi bob");
      expect(p.conversation).toBe(conversationId([bob.id, alice.id]));
    }
  });

  it("a non-recipient device cannot open", () => {
    const stranger = device("99", "aa");
    expect(() => openDm(seal(), stranger)).toThrow(/not a recipient/);
  });

  it("a recipient with the wrong kex key fails at unwrap", () => {
    const dm = seal();
    expect(() => openDm(dm, { deviceId: bobDev1.deviceId, kexSeed: bobDev2.kexSeed })).toThrow();
  });

  it("tampering with the routing header breaks decryption (AAD binding)", () => {
    const dm = seal();
    const tampered = { ...dm, to: alice.id } as DmRecord;
    expect(() => openDm(tampered, bobDev1)).toThrow();
  });

  it("tampering with ciphertext breaks decryption", () => {
    const dm = seal();
    const bytes = b64url.decode(dm.ciphertext);
    bytes[0]! ^= 0xff;
    expect(() => openDm({ ...dm, ciphertext: b64url.encode(bytes) } as DmRecord, bobDev1)).toThrow();
  });

  it("ciphertext replayed into another envelope fails (nonce/header mismatch)", () => {
    const dm1 = seal("secret one");
    const dm2 = seal("secret two");
    const franken = { ...dm2, ciphertext: dm1.ciphertext } as DmRecord;
    expect(() => openDm(franken, bobDev1)).toThrow();
  });

  it("rejects unknown version/alg instead of guessing", () => {
    const dm = seal();
    expect(() => openDm({ ...dm, alg: "rot13" } as unknown as DmRecord, bobDev1)).toThrow(/unsupported/);
  });

  it("deterministic under an injected RNG (vector-ready)", () => {
    let counter = 0;
    const fakeRandom = (n: number) => new Uint8Array(n).map((_, i) => (i + ++counter) % 256);
    const make = () => {
      counter = 0;
      return sealDm({
        body: "deterministic",
        participants: [alice.id, bob.id],
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
