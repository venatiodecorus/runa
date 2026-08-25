/**
 * Light/dark mode. Default follows the OS (prefers-color-scheme); an explicit
 * choice is stored in localStorage (a pure device-local UI preference — never
 * sent anywhere) and applied as data-theme on <html>. index.html applies the
 * stored value inline before React mounts so there is no flash.
 */
import { useEffect, useState } from "react";

const KEY = "runa.theme";

export type ThemeMode = "light" | "dark";

function stored(): ThemeMode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): ThemeMode {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function effectiveTheme(): ThemeMode {
  return stored() ?? systemTheme();
}

function apply(mode: ThemeMode | null) {
  const root = document.documentElement;
  if (mode === null) delete root.dataset.theme;
  else root.dataset.theme = mode;
}

/** Current effective theme + a toggle. Follows OS changes until first toggle. */
export function useTheme(): [ThemeMode, () => void] {
  const [theme, setTheme] = useState<ThemeMode>(effectiveTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (stored() === null) setTheme(systemTheme());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = () => {
    const next: ThemeMode = effectiveTheme() === "dark" ? "light" : "dark";
    try {
      // Choosing the system's own theme returns to "follow the OS".
      if (next === systemTheme()) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // storage unavailable — still apply for this page's lifetime
    }
    apply(stored());
    setTheme(next);
  };

  return [theme, toggle];
}
