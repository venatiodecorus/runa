/**
 * Session assembly: glue between crypto/, store/ and api/ used by the views.
 * A "session" is the in-memory working set: root key (working copy), device
 * keys, and the device's cert. The bearer token itself lives in api/client.
 */
import type { DeviceCert } from "@runa/core";
import {
  buildDeviceCert,
  generateDeviceKeys,
  generateRootSeed,
  rootFromSeed,
  signAuthChallenge,
  type DeviceKeys,
  type RootKey,
} from "../crypto/keys.js";
import {
  ApiError,
  authenticate,
  createAccount,
  postRecord,
  setSessionToken,
} from "../api/client.js";
import {
  clearAll,
  deviceFromStored,
  loadAccount,
  loadDevice,
  rootFromStored,
  saveAccount,
  saveDevice,
} from "../store/db.js";

export interface Session {
  root: RootKey;
  device: DeviceKeys;
  cert: DeviceCert;
}

/** Restore the working set from IndexedDB, if this browser has one. */
export async function restoreSession(): Promise<Session | null> {
  const [account, device] = await Promise.all([loadAccount(), loadDevice()]);
  if (!account || !device) return null;
  return {
    root: rootFromStored(account),
    device: deviceFromStored(device),
    cert: device.cert,
  };
}

/** Challenge-auth against the instance; token kept in memory (api/client). */
export async function login(session: Session): Promise<void> {
  await authenticate(session.root.account, session.device.deviceId, (challenge) =>
    signAuthChallenge(session.device.signSeed, challenge),
  );
}

/** Generate a brand-new root + first device + root-signed cert (nothing sent yet). */
export function generateIdentity(deviceName?: string): Session {
  const root = rootFromSeed(generateRootSeed());
  const device = generateDeviceKeys();
  const cert = buildDeviceCert(root, device, deviceName);
  return { root, device, cert };
}

/** Signup leg: POST /accounts with the first cert, persist, authenticate. */
export async function registerAccount(session: Session): Promise<void> {
  await createAccount(session.root.account, session.cert);
  await saveAccount(session.root);
  await saveDevice(session.device, session.cert);
  await login(session);
}

/**
 * Recovery leg: root already exists (imported) → sign a fresh device-cert and
 * post it. If this instance has never seen the account (identity is
 * instance-independent, design §15), fall back to open signup with the same
 * cert. Then persist and authenticate.
 */
export async function enrollDevice(root: RootKey, deviceName?: string): Promise<Session> {
  const device = generateDeviceKeys();
  const cert = buildDeviceCert(root, device, deviceName);
  try {
    await postRecord(cert);
  } catch (e) {
    // Server signals an account it has never seen as 400 unknown_account
    // (404 kept for robustness against other implementations).
    if (e instanceof ApiError && (e.code === "unknown_account" || e.status === 404)) {
      await createAccount(root.account, cert);
    } else {
      throw e;
    }
  }
  const session: Session = { root, device, cert };
  await saveAccount(root);
  await saveDevice(device, cert);
  await login(session);
  return session;
}

/** Forget this browser: wipe IndexedDB + drop the in-memory token. */
export async function forgetThisBrowser(): Promise<void> {
  setSessionToken(null);
  await clearAll();
}

export function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "device";
  const ua = navigator.userAgent;
  const browser =
    ua.includes("Firefox") ? "Firefox" : ua.includes("Chrome") ? "Chrome" : ua.includes("Safari") ? "Safari" : "Browser";
  return `${browser} (${new Date().toISOString().slice(0, 10)})`;
}
