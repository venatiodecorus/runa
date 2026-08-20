/**
 * Recovery kit (docs/protocol.md §7): three interchangeable encodings of the
 * 32-byte root seed —
 *   1. key file JSON  {"v":1,"kind":"runa-root-key","account","seed","created_at"}
 *   2. BIP39 24-word English phrase
 *   3. passphrase backup blob: Argon2id + XChaCha20-Poly1305 over the key file
 *
 * Framework-free; Argon2id via hash-wasm (WASM, works in browser and node).
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { argon2id } from "hash-wasm";
import { b64url, utf8, nowTimestamp } from "@runa/core";
import { rootFromSeed, type RootKey } from "./keys.js";

export interface KeyFile {
  v: 1;
  kind: "runa-root-key";
  account: string;
  seed: string; // b64url, 32 bytes
  created_at: string;
}

/** Argon2id parameters. `m` is memory in KiB (spec default 64 MiB = 65536). */
export interface KdfParams {
  m: number;
  t: number;
  p: number;
}

/** Spec values (protocol §7). Tests may pass reduced params explicitly. */
export const DEFAULT_KDF_PARAMS: KdfParams = { m: 65536, t: 3, p: 1 };

export interface PassphraseBackup {
  v: 1;
  salt: string; // b64url, 16 bytes
  params: KdfParams;
  nonce: string; // b64url, 24 bytes
  ciphertext: string; // b64url
}

// --- key file ---------------------------------------------------------------

export function buildKeyFile(root: RootKey, createdAt: string = nowTimestamp()): KeyFile {
  return {
    v: 1,
    kind: "runa-root-key",
    account: root.account,
    seed: b64url.encode(root.seed),
    created_at: createdAt,
  };
}

/**
 * Parse + validate a key file JSON string. Recomputes the account id from the
 * seed and rejects a mismatch (a corrupted or tampered file must not silently
 * yield a different identity than it claims).
 */
export function parseKeyFile(json: string): RootKey {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("not valid JSON");
  }
  const kf = obj as Partial<KeyFile>;
  if (kf.v !== 1) throw new Error(`unknown key file version: ${String(kf.v)}`);
  if (kf.kind !== "runa-root-key") throw new Error("not a runa root key file");
  if (typeof kf.seed !== "string") throw new Error("key file missing seed");
  let seed: Uint8Array;
  try {
    seed = b64url.decode(kf.seed);
  } catch {
    throw new Error("seed is not valid base64url");
  }
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const root = rootFromSeed(seed);
  if (typeof kf.account === "string" && kf.account !== root.account) {
    throw new Error("key file account does not match its seed");
  }
  return root;
}

// --- BIP39 words ------------------------------------------------------------

/** 32-byte seed → 24 English words. */
export function seedToMnemonic(seed: Uint8Array): string {
  if (seed.length !== 32) throw new Error("root seed must be 32 bytes");
  return entropyToMnemonic(seed, wordlist);
}

/** 24 English words → 32-byte seed. Tolerates case and extra whitespace. */
export function mnemonicToSeed(words: string): Uint8Array {
  const normalized = words.trim().toLowerCase().split(/\s+/).join(" ");
  if (normalized.split(" ").length !== 24) throw new Error("expected 24 words");
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(normalized, wordlist);
  } catch {
    throw new Error("invalid word list (typo, or wrong word order?)");
  }
  if (entropy.length !== 32) throw new Error("word list does not encode a 32-byte seed");
  return entropy;
}

// --- passphrase backup ------------------------------------------------------

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  return argon2id({
    password: passphrase,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m, // KiB
    hashLength: 32,
    outputType: "binary",
  });
}

/**
 * Encrypt the key-file JSON under a passphrase (protocol §7): Argon2id
 * (random 16-byte salt) → 32-byte key → XChaCha20-Poly1305 (random 24-byte
 * nonce). The resulting blob is safe to store server-side blind — but it is a
 * brute-force target; the UI must say so.
 */
export async function encryptBackup(
  keyFileJson: string,
  passphrase: string,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<PassphraseBackup> {
  if (passphrase.length === 0) throw new Error("empty passphrase");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const key = await deriveKey(passphrase, salt, params);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(utf8(keyFileJson));
  return {
    v: 1,
    salt: b64url.encode(salt),
    params: { ...params },
    nonce: b64url.encode(nonce),
    ciphertext: b64url.encode(ciphertext),
  };
}

/**
 * Decrypt a passphrase backup blob back to a RootKey. Uses the params stored
 * in the blob (they were chosen at encryption time). A wrong passphrase fails
 * AEAD authentication and throws.
 */
export async function decryptBackup(
  blob: PassphraseBackup,
  passphrase: string,
): Promise<RootKey> {
  if (blob.v !== 1) throw new Error(`unknown backup version: ${String(blob.v)}`);
  const { m, t, p } = blob.params ?? ({} as KdfParams);
  if (
    !Number.isInteger(m) || !Number.isInteger(t) || !Number.isInteger(p) ||
    m <= 0 || t <= 0 || p <= 0
  ) {
    throw new Error("backup blob has invalid KDF params");
  }
  const salt = b64url.decode(blob.salt);
  const nonce = b64url.decode(blob.nonce);
  const ciphertext = b64url.decode(blob.ciphertext);
  const key = await deriveKey(passphrase, salt, { m, t, p });
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    throw new Error("decryption failed — wrong passphrase or corrupted backup");
  }
  return parseKeyFile(new TextDecoder().decode(plaintext));
}
