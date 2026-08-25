/**
 * Small shared UI helpers. All visual styling lives in theme.css (design
 * tokens + class vocabulary) — see that file for the light/dark palettes.
 */

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** Trigger a client-side file download (used for the key file export). */
export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
