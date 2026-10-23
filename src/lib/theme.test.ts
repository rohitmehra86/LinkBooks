import { describe, expect, it } from "vitest";
import { isThemePreference, resolveTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "./theme";

describe("theme", () => {
  it("resolves explicit choices regardless of the system setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("follows the system when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
  it("validates stored values", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("blue")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
  it("init script reads the same storage key", () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
  });
});
