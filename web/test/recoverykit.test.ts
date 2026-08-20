import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { b64url } from "@runa/core";
import { generateRootSeed, rootFromSeed } from "../src/crypto/keys.js";
import {
  DEFAULT_KDF_PARAMS,
  buildKeyFile,
  decryptBackup,
  encryptBackup,
  mnemonicToSeed,
  parseKeyFile,
  seedToMnemonic,
  type KdfParams,
} from "../src/crypto/recoverykit.js";

// Reduced Argon2id params for fast tests; production callers use
// DEFAULT_KDF_PARAMS (spec: m=64 MiB, t=3, p=1 — asserted below).
const TEST_KDF: KdfParams = { m: 64, t: 1, p: 1 };

describe("BIP39 words", () => {
  it("round-trips seed → 24 words → seed", () => {
    const seed = generateRootSeed();
    const words = seedToMnemonic(seed);
    expect(words.split(" ")).toHaveLength(24);
    expect(mnemonicToSeed(words)).toEqual(seed);
  });

  it("is deterministic for a fixed seed", () => {
    const seed = hexToBytes("11".repeat(32));
    expect(seedToMnemonic(seed)).toBe(seedToMnemonic(hexToBytes("11".repeat(32))));
  });

  it("tolerates case and irregular whitespace on import", () => {
    const seed = hexToBytes("11".repeat(32));
    const words = seedToMnemonic(seed);
    const messy = `  ${words.toUpperCase().split(" ").join("   \n")}  `;
    expect(mnemonicToSeed(messy)).toEqual(seed);
  });

  it("rejects wrong word counts and invalid words", () => {
    expect(() => mnemonicToSeed("abandon abandon abandon")).toThrow(/24 words/);
    const seed = hexToBytes("11".repeat(32));
    const bad = seedToMnemonic(seed).split(" ");
    bad[0] = "notaword";
    expect(() => mnemonicToSeed(bad.join(" "))).toThrow(/invalid word list/);
    // valid words but broken checksum (swap two distinct words)
    const words = seedToMnemonic(hexToBytes("42".repeat(32))).split(" ");
    const swapped = [...words];
    swapped[0] = words[23]!;
    swapped[23] = words[0]!;
    expect(() => mnemonicToSeed(swapped.join(" "))).toThrow();
  });

  it("rejects non-32-byte seeds", () => {
    expect(() => seedToMnemonic(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe("key file", () => {
  const root = rootFromSeed(hexToBytes("11".repeat(32)));

  it("round-trips build → JSON → parse", () => {
    const kf = buildKeyFile(root, "2026-08-20T12:00:00Z");
    expect(kf).toMatchObject({ v: 1, kind: "runa-root-key", account: root.account });
    expect(b64url.decode(kf.seed)).toEqual(root.seed);
    const parsed = parseKeyFile(JSON.stringify(kf));
    expect(parsed.account).toBe(root.account);
    expect(parsed.seed).toEqual(root.seed);
  });

  it("rejects invalid JSON, wrong kind, wrong version, bad seed", () => {
    const kf = buildKeyFile(root);
    expect(() => parseKeyFile("not json")).toThrow(/JSON/);
    expect(() => parseKeyFile(JSON.stringify({ ...kf, kind: "other" }))).toThrow(/root key file/);
    expect(() => parseKeyFile(JSON.stringify({ ...kf, v: 2 }))).toThrow(/version/);
    expect(() => parseKeyFile(JSON.stringify({ ...kf, seed: "AAAA" }))).toThrow(/32 bytes/);
  });

  it("rejects an account id that does not match the seed", () => {
    const kf = buildKeyFile(root);
    const other = rootFromSeed(hexToBytes("22".repeat(32)));
    expect(() => parseKeyFile(JSON.stringify({ ...kf, account: other.account }))).toThrow(
      /does not match/,
    );
  });
});

describe("passphrase backup", () => {
  const root = rootFromSeed(hexToBytes("11".repeat(32)));

  it("defaults to the spec KDF parameters", () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({ m: 65536, t: 3, p: 1 }); // 64 MiB, t=3, p=1
  });

  it("encrypt → decrypt round-trips and blob shape is per protocol §7", async () => {
    const json = JSON.stringify(buildKeyFile(root, "2026-08-20T12:00:00Z"));
    const blob = await encryptBackup(json, "correct horse", TEST_KDF);
    expect(blob.v).toBe(1);
    expect(blob.params).toEqual(TEST_KDF);
    expect(b64url.decode(blob.salt)).toHaveLength(16);
    expect(b64url.decode(blob.nonce)).toHaveLength(24);
    expect(b64url.decode(blob.ciphertext).length).toBeGreaterThan(16); // has AEAD tag
    const recovered = await decryptBackup(blob, "correct horse");
    expect(recovered.account).toBe(root.account);
    expect(recovered.seed).toEqual(root.seed);
  });

  it("fails with the wrong passphrase", async () => {
    const json = JSON.stringify(buildKeyFile(root));
    const blob = await encryptBackup(json, "right", TEST_KDF);
    await expect(decryptBackup(blob, "wrong")).rejects.toThrow(/wrong passphrase|decryption/i);
  });

  it("fails on tampered ciphertext", async () => {
    const json = JSON.stringify(buildKeyFile(root));
    const blob = await encryptBackup(json, "pw", TEST_KDF);
    const ct = b64url.decode(blob.ciphertext);
    ct[0]! ^= 0xff;
    await expect(
      decryptBackup({ ...blob, ciphertext: b64url.encode(ct) }, "pw"),
    ).rejects.toThrow();
  });

  it("uses fresh random salt and nonce per encryption", async () => {
    const json = JSON.stringify(buildKeyFile(root));
    const a = await encryptBackup(json, "pw", TEST_KDF);
    const b = await encryptBackup(json, "pw", TEST_KDF);
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects unknown versions and invalid params", async () => {
    const json = JSON.stringify(buildKeyFile(root));
    const blob = await encryptBackup(json, "pw", TEST_KDF);
    await expect(decryptBackup({ ...blob, v: 2 as 1 }, "pw")).rejects.toThrow(/version/);
    await expect(
      decryptBackup({ ...blob, params: { m: 0.5, t: 1, p: 1 } }, "pw"),
    ).rejects.toThrow(/params/);
    await expect(encryptBackup(json, "", TEST_KDF)).rejects.toThrow(/passphrase/);
  });
});
