/**
 * Graph records (docs/protocol.md §3.1): device-signed `follow` / `unfollow` /
 * `mute` / `unmute`, each carrying a `subject` (the target account id).
 * Latest `created_at` wins per (author, subject) pair; the server materializes
 * edges on ingest. Mutes are private to their author (design §8) — the server
 * stores them but never serves them to anyone else.
 *
 * Framework-free: no React, no DOM.
 */
import { b64url, nowTimestamp, signRecord, type RunaRecord } from "@runa/core";
import type { DeviceKeys } from "./keys.js";

export type GraphRecordType = "follow" | "unfollow" | "mute" | "unmute";

export interface GraphRecord extends RunaRecord {
  type: GraphRecordType;
  subject: string; // target account id = b64url(root pubkey)
}

type SigningDevice = Pick<DeviceKeys, "deviceId" | "signSeed">;

/** Build + device-sign one graph record. `author` is the signer's account id. */
export function buildGraphRecord(
  type: GraphRecordType,
  author: string,
  device: SigningDevice,
  subject: string,
  createdAt: string = nowTimestamp(),
): GraphRecord {
  let subjectBytes: Uint8Array;
  try {
    subjectBytes = b64url.decode(subject);
  } catch {
    throw new Error("subject is not valid base64url");
  }
  if (subjectBytes.length !== 32) throw new Error("subject must be an account id (32 bytes b64url)");
  return signRecord(
    {
      v: 1,
      type,
      author,
      device: device.deviceId,
      created_at: createdAt,
      subject,
    },
    device.signSeed,
  ) as GraphRecord;
}

export function buildFollow(
  author: string,
  device: SigningDevice,
  subject: string,
  createdAt?: string,
): GraphRecord {
  return buildGraphRecord("follow", author, device, subject, createdAt);
}

export function buildUnfollow(
  author: string,
  device: SigningDevice,
  subject: string,
  createdAt?: string,
): GraphRecord {
  return buildGraphRecord("unfollow", author, device, subject, createdAt);
}

export function buildMute(
  author: string,
  device: SigningDevice,
  subject: string,
  createdAt?: string,
): GraphRecord {
  return buildGraphRecord("mute", author, device, subject, createdAt);
}

export function buildUnmute(
  author: string,
  device: SigningDevice,
  subject: string,
  createdAt?: string,
): GraphRecord {
  return buildGraphRecord("unmute", author, device, subject, createdAt);
}
