/**
 * Signup flow (design §2.3, one flow): generate root + device → recovery-kit
 * screen (key-file download + 24 words + explicit "I saved it") → account
 * created on the server → browsing. Optional passphrase backup afterwards.
 */
import { useState } from "react";
import { encryptBackup, buildKeyFile } from "../crypto/recoverykit.js";
import { putBackup } from "../api/client.js";
import { generateIdentity, registerAccount, defaultDeviceName, type Session } from "./session.js";
import { RecoveryKitPanel } from "./RecoveryKitPanel.js";
import { IconKey } from "./icons.js";

export function Signup({ onDone }: { onDone: (session: Session) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [saved, setSaved] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (session === null) {
    return (
      <section>
        <div className="card">
          <h2>Create an account</h2>
          <p className="muted">
            Your identity is a keypair generated in this browser. No email, no phone, no password —
            the server never sees your keys.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => setSession(generateIdentity(defaultDeviceName()))}
          >
            <IconKey size={14} />
            Generate my keys
          </button>
        </div>
      </section>
    );
  }

  const create = async () => {
    setBusy("Creating account…");
    setError(null);
    try {
      await registerAccount(session);
      if (passphrase.length > 0) {
        setBusy("Encrypting passphrase backup…");
        const blob = await encryptBackup(JSON.stringify(buildKeyFile(session.root)), passphrase);
        await putBackup(blob);
      }
      onDone(session);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="card">
        <h2>Your recovery kit</h2>
        <RecoveryKitPanel root={session.root} />

        <h3>Optional: passphrase backup</h3>
        <p className="muted">
          Stores an encrypted copy of your key on this instance so you can recover with account id +
          passphrase alone. The server cannot read it, but it becomes a brute-force target — for
          high-value accounts, rely on the key file or word list instead. Leave empty to skip.
        </p>
        <input
          className="input"
          type="password"
          placeholder="Backup passphrase (optional)"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />

        <p style={{ marginTop: "1rem" }}>
          <label className="row">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I
            saved my recovery kit (downloaded the key file and/or wrote down the 24 words)
          </label>
        </p>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" disabled={!saved || busy !== null} onClick={create}>
          {busy ?? "Create account"}
        </button>
      </div>
    </section>
  );
}
