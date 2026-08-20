/**
 * Consumes the shared recovery-kit vector (docs/protocol/vectors/) — the
 * cross-implementation contract. Regenerate with: npm run gen:vectors -w web
 */
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { b64url } from "@runa/core";
import vector from "../../docs/protocol/vectors/recovery-kit-01.json";
import { rootFromSeed } from "../src/crypto/keys.js";
import { mnemonicToSeed, seedToMnemonic } from "../src/crypto/recoverykit.js";

describe("recovery-kit-01 vector", () => {
  const seed = hexToBytes(vector.seed_hex);

  it("seed encodes to the expected b64url", () => {
    expect(b64url.encode(seed)).toBe(vector.seed_b64url);
  });

  it("seed → mnemonic matches the vector exactly", () => {
    expect(seedToMnemonic(seed)).toBe(vector.mnemonic);
  });

  it("mnemonic → seed recovers the vector seed", () => {
    expect(mnemonicToSeed(vector.mnemonic)).toEqual(seed);
  });

  it("seed derives the expected account id", () => {
    expect(rootFromSeed(seed).account).toBe(vector.account);
  });
});
