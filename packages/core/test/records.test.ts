import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { x25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import { b64url } from "../src/encoding.js";
import { signRecord, verifySignature, recordId, nowTimestamp, type RunaRecord } from "../src/records.js";
import { verifyAuthoredRecord, type DeviceCert, type DeviceRevoke } from "../src/certs.js";

const ROOT_SEED = hexToBytes("11".repeat(32));
const DEVICE_SEED = hexToBytes("22".repeat(32));
const KEX_SEED = hexToBytes("33".repeat(32));
const T0 = "2026-08-20T12:00:00Z";

const rootPub = b64url.encode(ed25519.getPublicKey(ROOT_SEED));
const devicePub = b64url.encode(ed25519.getPublicKey(DEVICE_SEED));
const kexPub = b64url.encode(x25519.getPublicKey(KEX_SEED));

function makeCert(created = T0): DeviceCert {
  return signRecord(
    {
      v: 1,
      type: "device-cert",
      author: rootPub,
      created_at: created,
      device_sign_pub: devicePub,
      device_kex_pub: kexPub,
    },
    ROOT_SEED,
  ) as DeviceCert;
}

function makePost(body = "hello world", created = T0): RunaRecord {
  return signRecord(
    { v: 1, type: "post", author: rootPub, device: devicePub, created_at: created, body },
    DEVICE_SEED,
  );
}

describe("record signing & verification", () => {
  it("round-trips a device-signed post through the full chain", () => {
    const cert = makeCert();
    const post = makePost();
    expect(() => verifyAuthoredRecord(post, [cert])).not.toThrow();
    expect(recordId(post)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a tampered body", () => {
    const post = makePost();
    const tampered = { ...post, body: "evil" };
    expect(() => verifySignature(tampered)).toThrow(/signature/);
  });

  it("rejects a post from an uncertified device", () => {
    const post = makePost();
    expect(() => verifyAuthoredRecord(post, [])).toThrow(/no device-cert/);
  });

  it("rejects a post signed after device revocation, accepts one before", () => {
    const cert = makeCert();
    const revocation = signRecord(
      { v: 1, type: "device-revoke", author: rootPub, created_at: "2026-08-21T00:00:00Z", device_sign_pub: devicePub },
      ROOT_SEED,
    ) as DeviceRevoke;
    const before = makePost("pre-revocation", "2026-08-20T23:59:59Z");
    const after = makePost("post-revocation", "2026-08-21T00:00:01Z");
    expect(() => verifyAuthoredRecord(before, [cert], [revocation])).not.toThrow();
    expect(() => verifyAuthoredRecord(after, [cert], [revocation])).toThrow(/revoked/);
  });

  it("rejects root-signed types carrying a device field", () => {
    const bad = signRecord(
      {
        v: 1,
        type: "device-cert",
        author: rootPub,
        device: devicePub,
        created_at: T0,
        device_sign_pub: devicePub,
        device_kex_pub: kexPub,
      },
      ROOT_SEED,
    );
    expect(() => verifySignature(bad)).toThrow(/root-signed/);
  });

  it("rejects floats and malformed timestamps", () => {
    const cert = makeCert();
    expect(cert).toBeTruthy();
    // signRecord itself refuses floats…
    expect(() =>
      signRecord({ v: 1, type: "post", author: rootPub, device: devicePub, created_at: T0, score: 0.5 }, DEVICE_SEED),
    ).toThrow(/non-integer/);
    // …and verification refuses one smuggled in after signing
    const floaty = { ...makePost(), score: 0.5 };
    expect(() => verifySignature(floaty)).toThrow(/non-integer/);
    expect(() =>
      signRecord(
        { v: 1, type: "post", author: rootPub, device: devicePub, created_at: "2026-08-20T12:00:00.123Z", body: "x" },
        DEVICE_SEED,
      ),
    ).not.toThrow(); // signing is mechanical…
    expect(() =>
      verifySignature(makeBadTimestamp()),
    ).toThrow(/created_at/); // …but verification enforces shape
  });

  it("nowTimestamp emits second-precision RFC 3339 UTC", () => {
    expect(nowTimestamp(new Date("2026-08-20T12:00:00.500Z"))).toBe("2026-08-20T12:00:00Z");
  });
});

function makeBadTimestamp(): RunaRecord {
  return signRecord(
    { v: 1, type: "post", author: rootPub, device: devicePub, created_at: "2026-08-20T12:00:00.123Z", body: "x" },
    DEVICE_SEED,
  );
}
