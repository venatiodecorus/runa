import { useEffect, useState } from "react";
import { fetchMeta, type InstanceMeta } from "../api/client.js";

export function App() {
  const [meta, setMeta] = useState<InstanceMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMeta().then(setMeta, (e) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Runa</h1>
      {error && <p style={{ color: "crimson" }}>Instance unreachable: {error}</p>}
      {meta && (
        <p>
          Connected to instance <strong>{meta.name}</strong> (protocol v{meta.protocol_version}).
        </p>
      )}
    </main>
  );
}
