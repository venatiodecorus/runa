/**
 * Verified display names (design §17 imageboard mode; protocol §6 "the
 * `authors` bundle is a convenience, not an authority"). A display name is
 * non-unique metadata and must never render unless its profile record's own
 * signature and device-cert chain verify — exactly the same discipline as
 * post content (verify-before-render).
 */
import { verifyAuthoredRecord, type DeviceCert, type DeviceRevoke, type RunaRecord } from "@runa/core";

/** Shape shared by FeedAuthor, AccountInfo, and RecordResponse.author. */
export interface AuthorBundle {
  device_certs: DeviceCert[];
  device_revocations: DeviceRevoke[];
  profile: RunaRecord | null;
}

const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * Null in imageboard mode (design §17: no profiles, ids only), when there is
 * no profile, when the profile isn't actually a verified `profile` record
 * authored by `account`, or when `display_name` is missing/empty/non-string.
 * Otherwise the trimmed name, capped to 40 chars.
 */
export function verifiedDisplayName(
  account: string,
  bundle: AuthorBundle | undefined,
  imageboard: boolean,
): string | null {
  if (imageboard) return null;
  if (bundle === undefined || bundle.profile === null) return null;
  const profile = bundle.profile;
  if (profile.type !== "profile" || profile.author !== account) return null;
  try {
    verifyAuthoredRecord(profile, bundle.device_certs, bundle.device_revocations);
  } catch {
    return null;
  }
  const name = profile.display_name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}
