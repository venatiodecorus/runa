/**
 * Domain proofs (docs/protocol.md §8.4, Keybase model): the server never
 * proxies or vouches for these — every check happens in the viewing client.
 * The matching/verification logic is split out as pure functions (given an
 * already-fetched document) so it is unit-testable without the network; the
 * one `fetch` call lives in the thin wrapper at the bottom.
 *
 * Framework-free: no React imports.
 */
import {
  recordId,
  verifyDeviceBinding,
  verifyDomainClaim,
  type DeviceCert,
  type DeviceRevoke,
  type DomainClaimRecord,
  type RunaRecord,
} from "@runa/core";

export type DomainCheckResult =
  | { ok: true; claim: DomainClaimRecord }
  | { ok: false; reason: string };

/**
 * Given the parsed `https://<domain>/.well-known/runa.json` document, find a
 * claim inside it that is byte-identical (same content-addressed record id)
 * to `expected` — the domain-claim record the profile itself published to
 * the instance — verify its signature + device-cert binding, and confirm
 * `author` matches the profile being viewed and `domain` matches the host it
 * was fetched from. Never throws: every failure path returns a neutral
 * `{ok:false}`, since an unreachable/mismatched/CORS-blocked file is not an
 * error attributed to the subject (protocol §8.4).
 */
export function checkDomainProof(
  doc: unknown,
  expected: DomainClaimRecord,
  profileAccount: string,
  fetchedHost: string,
  certs: DeviceCert[],
  revocations: DeviceRevoke[],
): DomainCheckResult {
  if (typeof doc !== "object" || doc === null) {
    return { ok: false, reason: "well-known document is not a JSON object" };
  }
  const claims = (doc as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) {
    return { ok: false, reason: "well-known document has no claims array" };
  }
  let expectedId: string;
  try {
    expectedId = recordId(expected as unknown as RunaRecord);
  } catch {
    return { ok: false, reason: "local claim record is malformed" };
  }

  let sawMatchingId = false;
  for (const c of claims) {
    if (typeof c !== "object" || c === null) continue;
    const candidate = c as DomainClaimRecord;
    let candidateId: string;
    try {
      candidateId = recordId(candidate as unknown as RunaRecord);
    } catch {
      continue;
    }
    if (candidateId !== expectedId) continue;
    sawMatchingId = true;
    try {
      verifyDomainClaim(candidate);
      verifyDeviceBinding(candidate, certs, revocations);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (candidate.author !== profileAccount) {
      return { ok: false, reason: "claim author does not match this profile" };
    }
    if (candidate.domain !== fetchedHost) {
      return { ok: false, reason: "claim domain does not match the host it was fetched from" };
    }
    return { ok: true, claim: candidate };
  }
  return {
    ok: false,
    reason: sawMatchingId
      ? "matching claim failed verification"
      : "no matching claim found in the well-known document",
  };
}

/**
 * Fetch `https://<domain>/.well-known/runa.json` and run checkDomainProof
 * against it. Network/parse failures (unreachable, non-2xx, not JSON, and —
 * the common browser case — CORS, since a missing
 * `Access-Control-Allow-Origin: *` header makes the response unreadable
 * rather than absent) all collapse to the same neutral failure; the UI must
 * not distinguish "doesn't allow browser checks" from "proof missing".
 */
export async function fetchAndCheckDomainProof(
  expected: DomainClaimRecord,
  profileAccount: string,
  certs: DeviceCert[],
  revocations: DeviceRevoke[],
  fetchImpl: typeof fetch = fetch,
): Promise<DomainCheckResult> {
  let doc: unknown;
  try {
    const resp = await fetchImpl(`https://${expected.domain}/.well-known/runa.json`);
    if (!resp.ok) return { ok: false, reason: `couldn't verify (HTTP ${resp.status})` };
    doc = await resp.json();
  } catch {
    return { ok: false, reason: "couldn't verify (file missing, or the domain doesn't allow browser checks)" };
  }
  return checkDomainProof(doc, expected, profileAccount, expected.domain, certs, revocations);
}
