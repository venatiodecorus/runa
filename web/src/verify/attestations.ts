/**
 * Attestation state (docs/protocol.md §8.3): the server's
 * `GET /accounts/{id}/attestations` list is a candidate set, never an
 * authority — every record here is independently re-verified (own signature
 * + device-cert binding) before it counts for anything. Failures are
 * discarded silently, exactly as for posts/DMs (verify-then-render). TOFU
 * everywhere: nothing derived here gates any capability (architecture
 * invariant 6) — it only changes displayed confidence.
 *
 * The viewer's own outbound attestations are additionally cached in the kv
 * store (key `attested:v1`, subject → attestation `created_at`) so
 * AccountLabel badges can render synchronously from an in-memory map
 * hydrated once per page (see ui/attested.tsx), without a network round
 * trip per label — mirrors the verified-name cache pattern in ui/authors.ts.
 *
 * Framework-free: no React imports. kv IO is isolated in the small wrappers
 * at the bottom so the reduction/diff logic above stays unit-testable.
 */
import {
  activeAttestations,
  verifyAttestation,
  verifyDeviceBinding,
  type AttestationRecord,
  type DeviceCert,
  type DeviceRevoke,
  type RunaRecord,
} from "@runa/core";
import { kvGet, kvSet } from "../store/db.js";

/** Shape shared by AttestationsResponse.authors (api/client.ts FeedAuthor). */
export interface AttestationAuthorBundle {
  device_certs: DeviceCert[];
  device_revocations: DeviceRevoke[];
}

/**
 * Verify every candidate attestation record's signature + device binding
 * against the accompanying authors bundle, discard anything that fails, and
 * reduce to the active set (latest-wins per author, minus any revoke —
 * revokes never arrive from this endpoint since the server already excludes
 * superseded attestations, but `activeAttestations` is the same reduction
 * either way and is cheap to re-run as defense in depth).
 */
export function verifyAndReduceAttestations(
  subject: string,
  candidates: RunaRecord[],
  authors: Record<string, AttestationAuthorBundle>,
): AttestationRecord[] {
  const verified: AttestationRecord[] = [];
  for (const rec of candidates) {
    if (rec.type !== "attestation") continue;
    const a = rec as AttestationRecord;
    const bundle = authors[a.author];
    try {
      verifyAttestation(a);
      verifyDeviceBinding(a, bundle?.device_certs ?? [], bundle?.device_revocations ?? []);
      verified.push(a);
    } catch {
      // Unverifiable — never trusted, never rendered, never counted.
    }
  }
  return activeAttestations(subject, verified, []);
}

/** The viewer's own active attestation of `subject`, if any (author === viewer). */
export function findOwn(viewer: string, active: AttestationRecord[]): AttestationRecord | null {
  return active.find((a) => a.author === viewer) ?? null;
}

// --- local cache of the viewer's OWN outbound attestations -------------------

/** subject account id → the viewer's attestation `created_at`. */
export type AttestedCache = Record<string, string>;

const ATTESTED_KEY = "attested:v1";

/**
 * Pure reconciliation: given the current cache, the viewer, a subject, and
 * that subject's freshly-verified active attestation list, compute the next
 * cache state — adds/updates when the viewer has an active attestation of
 * `subject`, removes when they don't (covers withdrawal from another
 * device). Returns the SAME object when nothing changes, so callers can
 * skip a redundant kv write.
 */
export function nextAttestedCache(
  cache: AttestedCache,
  viewer: string,
  subject: string,
  active: AttestationRecord[],
): AttestedCache {
  const own = findOwn(viewer, active);
  if (own) {
    if (cache[subject] === own.created_at) return cache;
    return { ...cache, [subject]: own.created_at };
  }
  if (!(subject in cache)) return cache;
  const next = { ...cache };
  delete next[subject];
  return next;
}

export async function loadAttestedCache(): Promise<AttestedCache> {
  return (await kvGet<AttestedCache>(ATTESTED_KEY)) ?? {};
}

async function saveAttestedCache(cache: AttestedCache): Promise<void> {
  await kvSet(ATTESTED_KEY, cache);
}

/** Record a freshly-published attestation of `subject` in the local cache. */
export async function markAttested(subject: string, createdAt: string): Promise<AttestedCache> {
  const cache = await loadAttestedCache();
  if (cache[subject] === createdAt) return cache;
  const next = { ...cache, [subject]: createdAt };
  await saveAttestedCache(next);
  return next;
}

/** Remove `subject` from the local cache after a withdrawal. */
export async function markUnattested(subject: string): Promise<AttestedCache> {
  const cache = await loadAttestedCache();
  if (!(subject in cache)) return cache;
  const next = { ...cache };
  delete next[subject];
  await saveAttestedCache(next);
  return next;
}

/**
 * Opportunistic reconcile (per protocol §8.3): after fetching + verifying a
 * subject's attestation list (e.g. on the Profile page), fold the result
 * into the local cache in case it had drifted (attested/withdrawn from
 * another device).
 */
export async function reconcileAttestedCache(
  viewer: string,
  subject: string,
  active: AttestationRecord[],
): Promise<AttestedCache> {
  const cache = await loadAttestedCache();
  const next = nextAttestedCache(cache, viewer, subject, active);
  if (next !== cache) await saveAttestedCache(next);
  return next;
}
