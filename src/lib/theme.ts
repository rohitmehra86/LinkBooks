/**
 * Light / dark / system theme. The choice is stored in localStorage and applied as a `dark`
 * class on <html>. `THEME_INIT_SCRIPT` runs inline in <head> so there is no flash on load.
 */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "linkbooks-theme";

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

/** Resolve a preference to the concrete mode to render. */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): "light" | "dark" {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var p=localStorage.getItem(k);if(p!=='light'&&p!=='dark')p='system';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
