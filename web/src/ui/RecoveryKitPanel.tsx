/**
 * Recovery-kit display (protocol §7): key-file download + 24-word phrase.
 * Used at signup (export-at-birth, design §2.3) and for re-export from the
 * device-management screen.
 */
import { buildKeyFile, seedToMnemonic } from "../crypto/recoverykit.js";
import type { RootKey } from "../crypto/keys.js";
import { downloadJson, shortId } from "./theme.js";
import { IconDownload } from "./icons.js";

export function RecoveryKitPanel({ root }: { root: RootKey }) {
  const words = seedToMnemonic(root.seed).split(" ");
  return (
    <div>
      <p className="muted">
        Account <span className="mono">{shortId(root.account)}</span>. This kit is the ONLY
        way back into this account — the server cannot reset it. Save both forms somewhere safe.
      </p>
      <p>
        <button
          className="btn"
          onClick={() =>
            downloadJson(`runa-root-key-${root.account.slice(0, 8)}.json`, buildKeyFile(root))
          }
        >
          <IconDownload size={14} />
          Download key file
        </button>
      </p>
      <div className="word-grid">
        {words.map((w, i) => (
          <span key={i}>
            <span className="word-index">{i + 1}.</span> {w}
          </span>
        ))}
      </div>
    </div>
  );
}
