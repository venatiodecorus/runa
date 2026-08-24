/**
 * Shared "verified by you" badge state (protocol §8.3 confidence display),
 * threaded to AccountLabel call sites the way ui/authors.ts's verified-name
 * cache is threaded — hydrated once per page from the kv-backed cache
 * (verify/attestations.ts), then read synchronously so a label never needs a
 * network call to decide whether to show the checkmark.
 */
import { useCallback, useEffect, useState } from "react";
import { loadAttestedCache, type AttestedCache } from "../verify/attestations.js";

export function useAttestedCache(): { attested: AttestedCache; refreshAttested: () => void } {
  const [attested, setAttested] = useState<AttestedCache>({});
  const refreshAttested = useCallback(() => {
    loadAttestedCache().then(setAttested, () => {});
  }, []);
  useEffect(() => {
    refreshAttested();
  }, [refreshAttested]);
  return { attested, refreshAttested };
}

/** Small checkmark suffix for AccountLabel — pass as `suffix` when attested[id] is set. */
export function VerifiedBadge({ since }: { since?: string }) {
  return (
    <span
      title={since ? `Verified by you since ${since}` : "Verified by you"}
      style={{ color: "#1a7f37", fontWeight: 600 }}
    >
      ✓
    </span>
  );
}
