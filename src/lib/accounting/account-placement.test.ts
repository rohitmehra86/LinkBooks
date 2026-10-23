import { describe, expect, it } from "vitest";
import { ACCOUNT_PLACEMENTS } from "@/lib/accounting/account-placement";
import { balanceSheetSectionFor, profitAndLossSectionFor } from "@/lib/accounting/reporting";

describe("manual account placement", () => {
  it("lands each placement on the report section the ledger already uses", () => {
    for (const placement of ACCOUNT_PLACEMENTS) {
      if (placement.accountType === "income" || placement.accountType === "expense") {
        const section = profitAndLossSectionFor({
          account_type: placement.accountType,
          subtype: placement.subtype,
        });
        if (placement.id === "income_revenue") expect(section).toBe("revenue");
        if (placement.id === "income_other") expect(section).toBe("other");
        if (placement.id === "income_contra") expect(section).toBe("contra_revenue");
        if (placement.id === "expense_cogs") expect(section).toBe("cost_of_sales");
        if (placement.id === "expense_operating") expect(section).toBe("operating_expense");
        if (placement.id === "expense_depreciation" || placement.id === "expense_other") {
          expect(section).toBe("other");
        }
      } else {
        expect(
          balanceSheetSectionFor({
            account_type: placement.accountType,
            subtype: placement.subtype,
          }),
        ).toBe(
          placement.fsLine === "current_assets"
            ? "current_assets"
            : placement.fsLine === "non_current_assets"
              ? "non_current_assets"
              : placement.fsLine === "current_liabilities"
                ? "current_liabilities"
                : placement.fsLine === "non_current_liabilities"
                  ? "non_current_liabilities"
                  : "equity",
        );
      }
    }
  });
});
