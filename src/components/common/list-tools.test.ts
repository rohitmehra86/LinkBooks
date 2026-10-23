import { describe, expect, it } from "vitest";
import { matchesQuery } from "./ListTools";

describe("matchesQuery", () => {
  it("matches everything for an empty query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });

  it("requires every word and ignores case", () => {
    expect(matchesQuery("2026-10-01 Acme Ltd paid", "acme PAID")).toBe(true);
    expect(matchesQuery("2026-10-01 Acme Ltd paid", "acme draft")).toBe(false);
  });
});
