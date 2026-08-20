/** Tiny shared inline-style vocabulary — system-ui, no CSS framework. */
import type { CSSProperties } from "react";

export const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: "0.75rem 1rem",
    marginBottom: "0.75rem",
    background: "#fff",
  },
  errorCard: {
    border: "1px solid crimson",
    borderRadius: 8,
    padding: "0.75rem 1rem",
    marginBottom: "0.75rem",
    background: "#fff5f5",
    color: "crimson",
  },
  mono: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.85em",
    wordBreak: "break-all",
  },
  muted: { color: "#666", fontSize: "0.85em" },
  button: {
    padding: "0.4rem 0.9rem",
    borderRadius: 6,
    border: "1px solid #888",
    background: "#f5f5f5",
    cursor: "pointer",
    font: "inherit",
  },
  primaryButton: {
    padding: "0.4rem 0.9rem",
    borderRadius: 6,
    border: "1px solid #1a5fb4",
    background: "#1a5fb4",
    color: "#fff",
    cursor: "pointer",
    font: "inherit",
  },
  input: {
    padding: "0.4rem 0.6rem",
    borderRadius: 6,
    border: "1px solid #bbb",
    font: "inherit",
    width: "100%",
    boxSizing: "border-box",
  },
  textarea: {
    padding: "0.5rem 0.6rem",
    borderRadius: 6,
    border: "1px solid #bbb",
    font: "inherit",
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
  },
  wordGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "0.35rem 0.9rem",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.9em",
    padding: "0.75rem",
    border: "1px dashed #888",
    borderRadius: 8,
    background: "#fafafa",
  },
};

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
