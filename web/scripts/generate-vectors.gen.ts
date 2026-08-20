/**
 * Regenerates the recovery-kit protocol vector in docs/protocol/vectors/
 * from the web reference implementation. Run via: npm run gen:vectors -w web
 *
 * Same contract as packages/core/scripts/generate-vectors.gen.ts: vectors are
 * generated from one implementation, verified by all, reviewed by hand.
 *
 * Deliberately NO Argon2id cases: the spec parameters (64 MiB, t=3) are too
 * heavy for a fixture that every suite runs; the KDF is covered by unit tests
 * with reduced parameters instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { b64url } from "@runa/core";
import { rootFromSeed } from "../src/crypto/keys.js";
import { mnemonicToSeed, seedToMnemonic } from "../src/crypto/recoverykit.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../docs/protocol/vectors");

const SEED_HEX = "44".repeat(32);

it("regenerates recovery-kit vectors", () => {
  mkdirSync(OUT, { recursive: true });

  const seed = hexToBytes(SEED_HEX);
  const mnemonic = seedToMnemonic(seed);

  // Self-check both directions before writing.
  const back = mnemonicToSeed(mnemonic);
  if (b64url.encode(back) !== b64url.encode(seed)) {
    throw new Error("mnemonic round-trip self-check failed");
  }

  const vector = {
    description:
      "Recovery-kit seed encodings (protocol §7). All values derive from the 32-byte seed " +
      "given as seed_hex (a test seed, never a real one): seed_b64url is its base64url (no " +
      "padding); mnemonic is its exact BIP39 24-word English encoding (entropy → words); " +
      "account is base64url(Ed25519 pubkey derived from the seed). Implementations must " +
      "reproduce mnemonic from the seed AND recover the seed from the mnemonic. Argon2id " +
      "passphrase-backup cases are deliberately absent (spec params too heavy for a fixture).",
    seed_hex: SEED_HEX,
    seed_b64url: b64url.encode(seed),
    mnemonic,
    account: rootFromSeed(seed).account,
  };

  writeFileSync(join(OUT, "recovery-kit-01.json"), JSON.stringify(vector, null, 2) + "\n");
  console.log("wrote recovery-kit-01.json");
});
