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
import { shortId } from "./theme.js";
import { IconDevices, IconDownload, Loading } from "./icons.js";
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

  if (error && info === null) return <p className="error-text">{error}</p>;
  if (info === null) return <Loading label="Loading…" />;

  const revokedIds = new Set(info.device_revocations.map((r) => r.device_sign_pub));

  return (
    <section>
      <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <IconDevices size={18} />
        Devices
      </h2>
      {error && <p className="error-text">{error}</p>}
      {info.device_certs.map((cert) => {
        const revoked = revokedIds.has(cert.device_sign_pub);
        const isCurrent = cert.device_sign_pub === session.device.deviceId;
        return (
          <div key={cert.device_sign_pub} className="card">
            <div className="card-head">
              <strong>{cert.name !== undefined ? String(cert.name) : "Unnamed device"}</strong>
              {isCurrent && <span className="badge badge-ok">this device</span>}
              {revoked && <span className="error-text">— revoked</span>}
            </div>
            <div className="mono muted">{shortId(cert.device_sign_pub)}</div>
            <div className="muted">certified {cert.created_at}</div>
            {!revoked && !isCurrent && (
              <button
                className="btn btn-danger btn-sm"
                style={{ marginTop: "0.5rem" }}
                disabled={busyDevice !== null}
                onClick={() => revoke(cert)}
              >
                {busyDevice === cert.device_sign_pub ? "Revoking…" : "Revoke"}
              </button>
            )}
          </div>
        );
      })}
      <p className="muted">
        To add a device: open Runa there and use “Recover” with your word list or key file — it
        signs itself a fresh certificate. (QR handoff comes later.)
      </p>

      <h2>Recovery kit</h2>
      {showKit ? (
        <RecoveryKitPanel root={session.root} />
      ) : (
        <button className="btn" onClick={() => setShowKit(true)}>
          <IconDownload size={14} />
          Re-export recovery kit
        </button>
      )}
    </section>
  );
}
