/**
 * Import/recovery flow (protocol §7): any of the three recovery-kit forms →
 * root in memory → fresh device-cert signed and posted → session live.
 * Target: ~30 seconds (design §2.3 — device loss is a non-event).
 */
import { useState } from "react";
import { decryptBackup, mnemonicToSeed, parseKeyFile } from "../crypto/recoverykit.js";
import { rootFromSeed, type RootKey } from "../crypto/keys.js";
import { getBackup } from "../api/client.js";
import { enrollDevice, defaultDeviceName, type Session } from "./session.js";
import { styles } from "./theme.js";

type Method = "words" | "file" | "passphrase";

export function Recover({ onDone }: { onDone: (session: Session) => void }) {
  const [method, setMethod] = useState<Method>("words");
  const [words, setWords] = useState("");
  const [fileJson, setFileJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recover = async () => {
    setError(null);
    try {
      let root: RootKey;
      if (method === "words") {
        root = rootFromSeed(mnemonicToSeed(words));
      } else if (method === "file") {
        if (fileJson === null) throw new Error("choose a key file first");
        root = parseKeyFile(fileJson);
      } else {
        setBusy("Fetching backup…");
        const { blob } = await getBackup(account.trim());
        setBusy("Decrypting (Argon2id — a few seconds)…");
        root = await decryptBackup(blob, passphrase);
      }
      setBusy("Enrolling this device…");
      const session = await enrollDevice(root, defaultDeviceName());
      onDone(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const tab = (m: Method, label: string) => (
    <button
      style={{
        ...styles.button,
        ...(method === m ? { background: "#1a5fb4", color: "#fff", borderColor: "#1a5fb4" } : {}),
      }}
      onClick={() => {
        setMethod(m);
        setError(null);
      }}
    >
      {label}
    </button>
  );

  return (
    <section>
      <h2>Recover your account</h2>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        {tab("words", "24 words")}
        {tab("file", "Key file")}
        {tab("passphrase", "Passphrase backup")}
      </div>

      {method === "words" && (
        <textarea
          style={{ ...styles.textarea, fontFamily: "ui-monospace, monospace" }}
          rows={4}
          placeholder="paste your 24 words, separated by spaces"
          value={words}
          onChange={(e) => setWords(e.target.value)}
        />
      )}

      {method === "file" && (
        <p>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              f.text().then(setFileJson, (err) => setError(String(err)));
            }}
          />
          {fileName && <span style={styles.muted}> loaded: {fileName}</span>}
        </p>
      )}

      {method === "passphrase" && (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          <input
            style={styles.input}
            placeholder="Account id"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Backup passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </div>
      )}

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <p>
        <button style={styles.primaryButton} disabled={busy !== null} onClick={recover}>
          {busy ?? "Recover"}
        </button>
      </p>
      <p style={styles.muted}>
        Recovery signs a fresh device certificate with your root key — your old devices keep
        working until you revoke them.
      </p>
    </section>
  );
}
