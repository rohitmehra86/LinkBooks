import { describe, expect, it } from "vitest";
import { filterTaxAccountPicker, isAccountTypeAllowedForTaxRole } from "./account-pickers";

const accounts = [
  { id: "1", code: "1000", name: "Bank", account_type: "asset" },
  { id: "2", code: "1200", name: "VAT recoverable", account_type: "asset" },
  { id: "3", code: "2100", name: "VAT payable", account_type: "liability" },
  { id: "4", code: "4000", name: "Sales", account_type: "income" },
  { id: "5", code: "7000", name: "Irrecoverable VAT", account_type: "expense" },
  { id: "6", code: "2999", name: "Old", account_type: "liability", is_active: false },
  { id: "7", code: "2000", name: "Header", account_type: "liability", is_postable: false },
];

describe("TX-06 tax account pickers are filtered by type", () => {
  it("output tax only offers active postable liabilities", () => {
    expect(filterTaxAccountPicker(accounts, "output").map((a) => a.id)).toEqual(["3"]);
  });
  it("input tax offers assets and liabilities, never income or expense", () => {
    expect(filterTaxAccountPicker(accounts, "input").map((a) => a.id)).toEqual(["1", "2", "3"]);
  });
  it("non-recoverable tax offers expense", () => {
    expect(filterTaxAccountPicker(accounts, "non_recoverable").map((a) => a.id)).toContain("5");
    expect(filterTaxAccountPicker(accounts, "non_recoverable").map((a) => a.id)).not.toContain("4");
  });
  it("type guard", () => {
    expect(isAccountTypeAllowedForTaxRole("output", "income")).toBe(false);
    expect(isAccountTypeAllowedForTaxRole("output", "liability")).toBe(true);
  });
});
