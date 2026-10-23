import { describe, expect, it } from "vitest";
import { HELP_ARTICLES, searchHelp } from "./articles";

describe("help centre (U-09)", () => {
  it("every article has steps and a unique id", () => {
    const ids = new Set(HELP_ARTICLES.map((a) => a.id));
    expect(ids.size).toBe(HELP_ARTICLES.length);
    for (const a of HELP_ARTICLES) expect(a.steps.length).toBeGreaterThan(0);
  });
  it("search matches title, topic and steps", () => {
    expect(searchHelp("reconcile").some((a) => a.id === "reconcile")).toBe(true);
    expect(searchHelp("ctrl k").some((a) => a.id === "shortcuts")).toBe(true);
    expect(searchHelp("zzzzzz")).toEqual([]);
    expect(searchHelp("")).toHaveLength(HELP_ARTICLES.length);
  });
});
