export const ACCOUNT_KINDS = [
  "bank",
  "accounts_receivable",
  "current_asset",
  "inventory",
  "prepayment",
  "fixed_asset",
  "non_current_asset",
  "accounts_payable",
  "credit_card",
  "current_liability",
  "non_current_liability",
  "equity",
  "retained_earnings",
  "revenue",
  "other_income",
  "contra_revenue",
  "cost_of_sales",
  "expense",
  "overhead",
  "depreciation",
  "other_expense",
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type AccountClass = "asset" | "liability" | "equity" | "income" | "expense";

export type KindSpec = {
  kind: AccountKind;
  label: string;
  accountClass: AccountClass;
  classLabel: string;
  subtype: string;
  fsLine: string;
  normalBalance: "debit" | "credit";
  codeFrom: number;
  codeTo: number;
};

const asset = "asset" as const;
const liability = "liability" as const;
const equity = "equity" as const;
const income = "income" as const;
const expense = "expense" as const;

export const KIND_SPECS: Record<AccountKind, KindSpec> = {
  bank: spec("bank", "Bank", asset, "Asset", "bank", "current_assets", "debit", 1000, 1499),
  accounts_receivable: spec(
    "accounts_receivable",
    "Accounts receivable",
    asset,
    "Asset",
    "receivable",
    "current_assets",
    "debit",
    1000,
    1499,
  ),
  current_asset: spec(
    "current_asset",
    "Current asset",
    asset,
    "Asset",
    "current_asset",
    "current_assets",
    "debit",
    1000,
    1499,
  ),
  inventory: spec(
    "inventory",
    "Inventory",
    asset,
    "Asset",
    "inventory",
    "current_assets",
    "debit",
    1000,
    1499,
  ),
  prepayment: spec(
    "prepayment",
    "Prepayment",
    asset,
    "Asset",
    "prepayment",
    "current_assets",
    "debit",
    1000,
    1499,
  ),
  fixed_asset: spec(
    "fixed_asset",
    "Fixed asset",
    asset,
    "Asset",
    "fixed",
    "non_current_assets",
    "debit",
    1500,
    1999,
  ),
  non_current_asset: spec(
    "non_current_asset",
    "Non-current asset",
    asset,
    "Asset",
    "non_current_asset",
    "non_current_assets",
    "debit",
    1500,
    1999,
  ),
  accounts_payable: spec(
    "accounts_payable",
    "Accounts payable",
    liability,
    "Liability",
    "payable",
    "current_liabilities",
    "credit",
    2000,
    2499,
  ),
  credit_card: spec(
    "credit_card",
    "Credit card",
    liability,
    "Liability",
    "credit_card",
    "current_liabilities",
    "credit",
    2000,
    2499,
  ),
  current_liability: spec(
    "current_liability",
    "Current liability",
    liability,
    "Liability",
    "current_liability",
    "current_liabilities",
    "credit",
    2000,
    2499,
  ),
  non_current_liability: spec(
    "non_current_liability",
    "Non-current liability",
    liability,
    "Liability",
    "non_current_liability",
    "non_current_liabilities",
    "credit",
    2500,
    2999,
  ),
  equity: spec("equity", "Equity", equity, "Equity", "equity", "equity", "credit", 3000, 3999),
  retained_earnings: spec(
    "retained_earnings",
    "Retained earnings",
    equity,
    "Equity",
    "retained",
    "equity",
    "credit",
    3000,
    3999,
  ),
  revenue: spec("revenue", "Revenue", income, "Revenue", "income", "revenue", "credit", 4000, 4999),
  other_income: spec(
    "other_income",
    "Other income",
    income,
    "Revenue",
    "other",
    "other_income",
    "credit",
    4000,
    4999,
  ),
  contra_revenue: spec(
    "contra_revenue",
    "Contra revenue",
    income,
    "Revenue",
    "contra_revenue",
    "contra_revenue",
    "debit",
    4000,
    4999,
  ),
  cost_of_sales: spec(
    "cost_of_sales",
    "Cost of sales",
    expense,
    "Expense",
    "cogs",
    "cost_of_sales",
    "debit",
    5000,
    5999,
  ),
  expense: spec(
    "expense",
    "Expense",
    expense,
    "Expense",
    "operating_expense",
    "operating_expense",
    "debit",
    6000,
    7999,
  ),
  overhead: spec(
    "overhead",
    "Overhead",
    expense,
    "Expense",
    "operating_expense",
    "operating_expense",
    "debit",
    6000,
    7999,
  ),
  depreciation: spec(
    "depreciation",
    "Depreciation",
    expense,
    "Expense",
    "depreciation",
    "depreciation",
    "debit",
    8000,
    8999,
  ),
  other_expense: spec(
    "other_expense",
    "Other expense",
    expense,
    "Expense",
    "other_expense",
    "other_expense",
    "debit",
    8000,
    8999,
  ),
};

function spec(
  kind: AccountKind,
  label: string,
  accountClass: AccountClass,
  classLabel: string,
  subtype: string,
  fsLine: string,
  normalBalance: "debit" | "credit",
  codeFrom: number,
  codeTo: number,
): KindSpec {
  return {
    kind,
    label,
    accountClass,
    classLabel,
    subtype,
    fsLine,
    normalBalance,
    codeFrom,
    codeTo,
  };
}

export function isAccountKind(value: string): value is AccountKind {
  return Object.prototype.hasOwnProperty.call(KIND_SPECS, value);
}

export function kindSpec(kind: AccountKind): KindSpec {
  return KIND_SPECS[kind];
}

const PLACEMENT_KIND: Record<string, AccountKind> = {
  income_revenue: "revenue",
  income_other: "other_income",
  income_contra: "contra_revenue",
  expense_cogs: "cost_of_sales",
  expense_operating: "expense",
  expense_depreciation: "depreciation",
  expense_other: "other_expense",
  asset_bank: "bank",
  asset_current: "current_asset",
  asset_fixed: "fixed_asset",
  liability_current: "current_liability",
  liability_loan: "non_current_liability",
  equity: "equity",
};

export function accountKindForPlacement(placementId: string): AccountKind | undefined {
  return PLACEMENT_KIND[placementId];
}

export function suggestNextCode(kind: AccountKind, codes: readonly string[]): string {
  const range = KIND_SPECS[kind];
  let highest = range.codeFrom - 10;
  for (const code of codes) {
    if (!/^\d+$/.test(code)) continue;
    const value = Number(code);
    if (value >= range.codeFrom && value <= range.codeTo && value > highest) highest = value;
  }
  const next = highest < range.codeFrom ? range.codeFrom : highest + 10;
  if (next > range.codeTo) return "";
  return String(next);
}
