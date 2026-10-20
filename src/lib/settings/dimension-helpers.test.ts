import { describe, expect, it } from "vitest";
import {
  clampFiscalYearEndDay,
  formatDocumentNumberPreview,
  maxFiscalYearEndDay,
  wouldCreateOptionCycle,
} from "./dimension-helpers";

describe("dimension-helpers", () => {
  it("allows 29 Feb as FY end day", () => {
    expect(maxFiscalYearEndDay(2)).toBe(29);
    expect(clampFiscalYearEndDay(2, 31)).toBe(29);
    expect(clampFiscalYearEndDay(4, 31)).toBe(30);
  });

  it("formats document number preview", () => {
    expect(formatDocumentNumberPreview("INV-", 12, 4)).toBe("INV-0012");
  });

  it("detects option parent cycles", () => {
    const parents = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
    expect(wouldCreateOptionCycle("a", "c", parents)).toBe(true);
    expect(wouldCreateOptionCycle("c", "a", parents)).toBe(false);
  });
});
