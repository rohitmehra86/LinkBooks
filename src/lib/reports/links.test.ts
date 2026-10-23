import { describe, expect, it } from "vitest";
import { sourceLabel, sourceTarget } from "./links";

describe("source document links", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("maps document-backed sources and ignores the rest", () => {
    expect(sourceTarget("sales_invoice", id)).toEqual({ kind: "sales_invoice", id });
    expect(sourceTarget("manual", id)).toBeNull();
    expect(sourceTarget("sales_invoice", "free text")).toBeNull();
    expect(sourceTarget("sales_invoice", null)).toBeNull();
  });
  it("labels", () => {
    expect(sourceLabel("bank_transfer")).toBe("Bank transfer");
    expect(sourceLabel(null)).toBe("—");
  });
});
