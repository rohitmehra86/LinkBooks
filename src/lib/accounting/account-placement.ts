import type {
  AccountType,
  CashFlowClass,
  FsLine,
  NormalBalance,
} from "@/lib/accounting/coa-library/types";

/** Report placement for a manually created postable account. */
export type AccountPlacementId =
  | "income_revenue"
  | "income_other"
  | "income_contra"
  | "expense_cogs"
  | "expense_operating"
  | "expense_depreciation"
  | "expense_other"
  | "asset_current"
  | "asset_bank"
  | "asset_fixed"
  | "liability_current"
  | "liability_loan"
  | "equity";

export type AccountPlacement = {
  id: AccountPlacementId;
  label: string;
  detail: string;
  accountType: AccountType;
  subtype: string;
  fsLine: FsLine;
  cashFlowClass: CashFlowClass;
  normalBalance: NormalBalance;
};

export const ACCOUNT_PLACEMENTS: readonly AccountPlacement[] = [
  {
    id: "income_revenue",
    label: "Revenue",
    detail: "Sales and fees",
    accountType: "income",
    subtype: "income",
    fsLine: "revenue",
    cashFlowClass: "operating",
    normalBalance: "credit",
  },
  {
    id: "income_other",
    label: "Other income",
    detail: "Income outside ordinary sales",
    accountType: "income",
    subtype: "other",
    fsLine: "other_income",
    cashFlowClass: "operating",
    normalBalance: "credit",
  },
  {
    id: "income_contra",
    label: "Returns and discounts",
    detail: "Reduces revenue",
    accountType: "income",
    subtype: "contra_revenue",
    fsLine: "contra_revenue",
    cashFlowClass: "operating",
    normalBalance: "debit",
  },
  {
    id: "expense_cogs",
    label: "Cost of sales",
    detail: "Direct cost of goods or services sold",
    accountType: "expense",
    subtype: "cogs",
    fsLine: "cost_of_sales",
    cashFlowClass: "operating",
    normalBalance: "debit",
  },
  {
    id: "expense_operating",
    label: "Operating expenses",
    detail: "Day-to-day running costs",
    accountType: "expense",
    subtype: "operating_expense",
    fsLine: "operating_expense",
    cashFlowClass: "operating",
    normalBalance: "debit",
  },
  {
    id: "expense_depreciation",
    label: "Depreciation",
    detail: "Reported with other income and expense",
    accountType: "expense",
    subtype: "depreciation",
    fsLine: "depreciation",
    cashFlowClass: "operating",
    normalBalance: "debit",
  },
  {
    id: "expense_other",
    label: "Other expenses",
    detail: "Costs outside ordinary operations",
    accountType: "expense",
    subtype: "other_expense",
    fsLine: "other_expense",
    cashFlowClass: "operating",
    normalBalance: "debit",
  },
  {
    id: "asset_bank",
    label: "Bank",
    detail: "Cash and bank balances",
    accountType: "asset",
    subtype: "bank",
    fsLine: "current_assets",
    cashFlowClass: "cash",
    normalBalance: "debit",
  },
  {
    id: "asset_current",
    label: "Current asset",
    detail: "Receivables, inventory and other short-term assets",
    accountType: "asset",
    subtype: "current_asset",
    fsLine: "current_assets",
    cashFlowClass: "operating",
    normalBalance: "debit",
  },
  {
    id: "asset_fixed",
    label: "Fixed asset",
    detail: "Long-term assets",
    accountType: "asset",
    subtype: "fixed",
    fsLine: "non_current_assets",
    cashFlowClass: "investing",
    normalBalance: "debit",
  },
  {
    id: "liability_current",
    label: "Current liability",
    detail: "Amounts due within a year",
    accountType: "liability",
    subtype: "current_liability",
    fsLine: "current_liabilities",
    cashFlowClass: "operating",
    normalBalance: "credit",
  },
  {
    id: "liability_loan",
    label: "Loan",
    detail: "Longer-term borrowing",
    accountType: "liability",
    subtype: "loan",
    fsLine: "non_current_liabilities",
    cashFlowClass: "financing",
    normalBalance: "credit",
  },
  {
    id: "equity",
    label: "Equity",
    detail: "Capital and reserves",
    accountType: "equity",
    subtype: "equity",
    fsLine: "equity",
    cashFlowClass: "financing",
    normalBalance: "credit",
  },
];

export function accountPlacementById(id: string): AccountPlacement | undefined {
  return ACCOUNT_PLACEMENTS.find((placement) => placement.id === id);
}
