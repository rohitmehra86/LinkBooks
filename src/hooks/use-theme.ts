import { useCallback, useSyncExternalStore } from "react";
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveTheme,
  type ThemePreference,
} from "@/lib/theme";

const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(v) ? v : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(pref: ThemePreference) {
  document.documentElement.classList.toggle(
    "dark",
    resolveTheme(pref, systemPrefersDark()) === "dark",
  );
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => {
    if (readPreference() === "system") apply("system");
    cb();
  };
  mq.addEventListener("change", onSystem);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener("change", onSystem);
  };
}

/** Theme preference (light/dark/system) with the resolved mode; persists and applies instantly. */
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  const systemDark = useSyncExternalStore(subscribe, systemPrefersDark, () => false);
  const setPreference = useCallback((pref: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref);
    } catch {
      /* storage unavailable: still apply for this session */
    }
    apply(pref);
    listeners.forEach((l) => l());
  }, []);
  return { preference, resolved: resolveTheme(preference, systemDark), setPreference };
}
