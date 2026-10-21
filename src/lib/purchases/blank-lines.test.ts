import { describe, expect, it } from "vitest";
import { emptyPurchaseLine } from "@/components/purchases/PurchasesDocumentLines";
import {
  cleanupBlankPurchaseLines,
  incompletePurchaseLines,
  isCompletelyBlankPurchaseLine,
} from "./blank-lines";

describe("blank purchase lines", () => {
  it("detects default empty rows", () => {
    expect(isCompletelyBlankPurchaseLine(emptyPurchaseLine())).toBe(true);
  });

  it("keeps zero-price rows with description", () => {
    const line = emptyPurchaseLine();
    line.description = "Free sample";
    line.accountId = "acc-1";
    line.unitPrice = "0.00";
    expect(isCompletelyBlankPurchaseLine(line)).toBe(false);
  });

  it("strips blanks but keeps one empty when all blank", () => {
    const cleaned = cleanupBlankPurchaseLines([emptyPurchaseLine(), emptyPurchaseLine()]);
    expect(cleaned).toHaveLength(1);
  });

  it("strips blanks among populated lines", () => {
    const a = emptyPurchaseLine();
    a.description = "Rent";
    a.accountId = "a1";
    const cleaned = cleanupBlankPurchaseLines([emptyPurchaseLine(), a, emptyPurchaseLine()]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.description).toBe("Rent");
  });

  it("flags incomplete non-blank rows", () => {
    const line = emptyPurchaseLine();
    line.description = "Partial";
    expect(incompletePurchaseLines([line])).toEqual([0]);
  });
});
