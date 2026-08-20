/**
 * Device management (design §2.2): list device certs/revocations, revoke a
 * device (root-signed device-revoke — losing/dropping a device is a
 * non-event), and re-export the recovery kit.
 */
import { useEffect, useState } from "react";
import type { DeviceCert } from "@runa/core";
import { getAccount, postRecord, type AccountInfo } from "../api/client.js";
import { buildDeviceRevoke } from "../crypto/keys.js";
import { RecoveryKitPanel } from "./RecoveryKitPanel.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

export function Devices({ session }: { session: Session }) {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [showKit, setShowKit] = useState(false);

  const load = () =>
    getAccount(session.root.account).then(setInfo, (e) => setError(String(e)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revoke = async (cert: DeviceCert) => {
    setBusyDevice(cert.device_sign_pub);
    setError(null);
    try {
      await postRecord(buildDeviceRevoke(session.root, cert.device_sign_pub));
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyDevice(null);
    }
  };

  if (error && info === null) return <p style={{ color: "crimson" }}>{error}</p>;
  if (info === null) return <p style={styles.muted}>Loading…</p>;

  const revokedIds = new Set(info.device_revocations.map((r) => r.device_sign_pub));

  return (
    <section>
      <h2>Devices</h2>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {info.device_certs.map((cert) => {
        const revoked = revokedIds.has(cert.device_sign_pub);
        const isCurrent = cert.device_sign_pub === session.device.deviceId;
        return (
          <div key={cert.device_sign_pub} style={styles.card}>
            <strong>{cert.name !== undefined ? String(cert.name) : "Unnamed device"}</strong>
            {isCurrent && <span style={styles.muted}> — this device</span>}
            {revoked && <span style={{ color: "crimson" }}> — revoked</span>}
            <div style={{ ...styles.mono, ...styles.muted }}>{shortId(cert.device_sign_pub)}</div>
            <div style={styles.muted}>certified {cert.created_at}</div>
            {!revoked && !isCurrent && (
              <button
                style={{ ...styles.button, marginTop: "0.5rem" }}
                disabled={busyDevice !== null}
                onClick={() => revoke(cert)}
              >
                {busyDevice === cert.device_sign_pub ? "Revoking…" : "Revoke"}
              </button>
            )}
          </div>
        );
      })}
      <p style={styles.muted}>
        To add a device: open Runa there and use “Recover” with your word list or key file — it
        signs itself a fresh certificate. (QR handoff comes later.)
      </p>

      <h2>Recovery kit</h2>
      {showKit ? (
        <RecoveryKitPanel root={session.root} />
      ) : (
        <button style={styles.button} onClick={() => setShowKit(true)}>
          Re-export recovery kit
        </button>
      )}
    </section>
  );
}
