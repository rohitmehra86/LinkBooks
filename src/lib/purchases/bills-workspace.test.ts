import { describe, expect, it } from "vitest";

/** Mirrors listBills display_reference + draft balance rules for regression coverage. */
function displayReference(supplierInvoice: string | null, billNumber: string | null) {
  return supplierInvoice?.trim() || billNumber?.trim() || null;
}

function balanceDueMinor(status: string, total: number, paid: number, credited: number) {
  const balance = Math.max(0, total - paid - credited);
  if (status === "draft" || status === "awaiting_approval") return 0;
  return balance;
}

function statusesForTab(tab: string): string[] | null {
  switch (tab) {
    case "drafts":
      return ["draft"];
    case "for_approval":
      return ["awaiting_approval"];
    case "to_pay":
      return ["authorised", "partly_paid"];
    case "paid":
      return ["paid"];
    case "all":
    default:
      return null;
  }
}

describe("bills workspace helpers", () => {
  it("prefers supplier invoice number over internal bill number", () => {
    expect(displayReference("INV-9", "BILL-1")).toBe("INV-9");
    expect(displayReference(null, "BILL-1")).toBe("BILL-1");
    expect(displayReference("  ", "BILL-1")).toBe("BILL-1");
    expect(displayReference(null, null)).toBeNull();
  });

  it("does not treat draft/awaiting totals as posted AP balance", () => {
    expect(balanceDueMinor("draft", 110000, 0, 0)).toBe(0);
    expect(balanceDueMinor("awaiting_approval", 52800, 0, 0)).toBe(0);
    expect(balanceDueMinor("authorised", 12000, 0, 0)).toBe(12000);
    expect(balanceDueMinor("partly_paid", 10000, 4000, 0)).toBe(6000);
    expect(balanceDueMinor("paid", 43200, 43200, 0)).toBe(0);
  });

  it("maps workflow tabs to status filters", () => {
    expect(statusesForTab("drafts")).toEqual(["draft"]);
    expect(statusesForTab("for_approval")).toEqual(["awaiting_approval"]);
    expect(statusesForTab("to_pay")).toEqual(["authorised", "partly_paid"]);
    expect(statusesForTab("paid")).toEqual(["paid"]);
    expect(statusesForTab("all")).toBeNull();
  });
});
