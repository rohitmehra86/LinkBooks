import { describe, expect, it } from "vitest";
import { DEFAULT_TABLE_PREFS, parseTablePrefs, toggleColumn } from "./table-prefs";

describe("table prefs", () => {
  it("defaults when nothing or garbage is stored", () => {
    expect(parseTablePrefs(null, ["a"])).toEqual(DEFAULT_TABLE_PREFS);
    expect(parseTablePrefs("{nope", ["a"])).toEqual(DEFAULT_TABLE_PREFS);
  });
  it("keeps valid density and only known hidden columns", () => {
    const raw = JSON.stringify({ density: "compact", hidden: ["a", "zzz", 3] });
    expect(parseTablePrefs(raw, ["a", "b"])).toEqual({ density: "compact", hidden: ["a"] });
  });
  it("toggles a column", () => {
    expect(toggleColumn([], "a")).toEqual(["a"]);
    expect(toggleColumn(["a", "b"], "a")).toEqual(["b"]);
  });
});
