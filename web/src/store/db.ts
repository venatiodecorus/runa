/**
 * IndexedDB persistence (design §2.3): browser storage is DISPOSABLE. Losing
 * this database must be a non-event — the recovery kit is the durable copy of
 * the root; device keys are simply re-issued via a fresh device-cert.
 *
 * Stored here: the current account (id + working copy of the root seed),
 * the current device keys (+ its cert record), and a small key-value store.
 * The session token is deliberately NOT stored — memory only (api/client.ts).
 *
 * Framework-free: no React imports.
 */
import { openDB, type IDBPDatabase } from "idb";
import { b64url, type DeviceCert } from "@runa/core";
import { deviceFromSeeds, rootFromSeed, type DeviceKeys, type RootKey } from "../crypto/keys.js";

const DB_NAME = "runa";
const DB_VERSION = 1;

/** Serialized forms: seeds kept as b64url strings for easy inspection/export. */
export interface StoredAccount {
  account: string;
  rootSeed: string; // b64url 32 bytes — working copy; recovery kit is the real custody
}

export interface StoredDevice {
  deviceId: string;
  signSeed: string; // b64url
  kexSeed: string; // b64url
  cert: DeviceCert;
}

type Db = IDBPDatabase<unknown>;
let dbPromise: Promise<Db> | null = null;

function db(): Promise<Db> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      d.createObjectStore("account");
      d.createObjectStore("device");
      d.createObjectStore("kv");
    },
  });
  return dbPromise;
}

const CURRENT = "current";

// --- account ----------------------------------------------------------------

export async function loadAccount(): Promise<StoredAccount | undefined> {
  return (await db()).get("account", CURRENT);
}

export async function saveAccount(root: RootKey): Promise<void> {
  const stored: StoredAccount = { account: root.account, rootSeed: b64url.encode(root.seed) };
  await (await db()).put("account", stored, CURRENT);
}

export function rootFromStored(stored: StoredAccount): RootKey {
  return rootFromSeed(b64url.decode(stored.rootSeed));
}

// --- device -----------------------------------------------------------------

export async function loadDevice(): Promise<StoredDevice | undefined> {
  return (await db()).get("device", CURRENT);
}

export async function saveDevice(device: DeviceKeys, cert: DeviceCert): Promise<void> {
  const stored: StoredDevice = {
    deviceId: device.deviceId,
    signSeed: b64url.encode(device.signSeed),
    kexSeed: b64url.encode(device.kexSeed),
    cert,
  };
  await (await db()).put("device", stored, CURRENT);
}

export function deviceFromStored(stored: StoredDevice): DeviceKeys {
  return deviceFromSeeds(b64url.decode(stored.signSeed), b64url.decode(stored.kexSeed));
}

// --- key-value --------------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db()).get("kv", key);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put("kv", value, key);
}

export async function kvDelete(key: string): Promise<void> {
  await (await db()).delete("kv", key);
}

/** Forget everything in this browser (the identity survives via the kit). */
export async function clearAll(): Promise<void> {
  const d = await db();
  const tx = d.transaction(["account", "device", "kv"], "readwrite");
  await Promise.all([
    tx.objectStore("account").clear(),
    tx.objectStore("device").clear(),
    tx.objectStore("kv").clear(),
    tx.done,
  ]);
}
