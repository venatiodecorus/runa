/**
 * Recovery-kit display (protocol §7): key-file download + 24-word phrase.
 * Used at signup (export-at-birth, design §2.3) and for re-export from the
 * device-management screen.
 */
import { buildKeyFile, seedToMnemonic } from "../crypto/recoverykit.js";
import type { RootKey } from "../crypto/keys.js";
import { downloadJson, shortId, styles } from "./theme.js";

export function RecoveryKitPanel({ root }: { root: RootKey }) {
  const words = seedToMnemonic(root.seed).split(" ");
  return (
    <div>
      <p style={styles.muted}>
        Account <span style={styles.mono}>{shortId(root.account)}</span>. This kit is the ONLY
        way back into this account — the server cannot reset it. Save both forms somewhere safe.
      </p>
      <p>
        <button
          style={styles.primaryButton}
          onClick={() =>
            downloadJson(`runa-root-key-${root.account.slice(0, 8)}.json`, buildKeyFile(root))
          }
        >
          Download key file
        </button>
      </p>
      <div style={styles.wordGrid}>
        {words.map((w, i) => (
          <span key={i}>
            <span style={{ color: "#999" }}>{i + 1}.</span> {w}
          </span>
        ))}
      </div>
    </div>
  );
}
