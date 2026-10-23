import type { AccountKind } from "@/lib/accounting/account-kinds";

export type StarterAccount = {
  code: string;
  name: string;
  accountKind: AccountKind;
  description: string;
};

export type StarterChart = {
  id: string;
  label: string;
  detail: string;
  accounts: readonly StarterAccount[];
};

const shared: readonly StarterAccount[] = [
  { code: "1000", name: "Bank", accountKind: "bank", description: "Main operating bank account" },
  {
    code: "1100",
    name: "Accounts receivable",
    accountKind: "accounts_receivable",
    description: "Amounts owed by customers",
  },
  { code: "1200", name: "Inventory", accountKind: "inventory", description: "Goods held for sale" },
  {
    code: "1500",
    name: "Equipment",
    accountKind: "fixed_asset",
    description: "Office and operating equipment",
  },
  {
    code: "2000",
    name: "Accounts payable",
    accountKind: "accounts_payable",
    description: "Amounts owed to suppliers",
  },
  {
    code: "2100",
    name: "Tax payable",
    accountKind: "current_liability",
    description: "Indirect tax collected and owing",
  },
  {
    code: "2500",
    name: "Bank loan",
    accountKind: "non_current_liability",
    description: "Borrowing due after one year",
  },
  { code: "3000", name: "Owner equity", accountKind: "equity", description: "Owner capital" },
  {
    code: "4000",
    name: "Sales",
    accountKind: "revenue",
    description: "Income from ordinary sales",
  },
  {
    code: "4900",
    name: "Sales discounts",
    accountKind: "contra_revenue",
    description: "Discounts that reduce sales",
  },
  {
    code: "5000",
    name: "Cost of sales",
    accountKind: "cost_of_sales",
    description: "Direct cost of goods or services",
  },
  {
    code: "6000",
    name: "Operating expenses",
    accountKind: "expense",
    description: "Day-to-day running costs",
  },
  { code: "6100", name: "Rent", accountKind: "expense", description: "Premises rent" },
  {
    code: "8000",
    name: "Depreciation",
    accountKind: "depreciation",
    description: "Depreciation charge",
  },
];

export const STARTER_CHARTS: readonly StarterChart[] = [
  {
    id: "generic",
    label: "Small business",
    detail: "A short starter chart for a new organisation.",
    accounts: shared,
  },
  {
    id: "us",
    label: "United States",
    detail: "Starter names for a US small business. This is not a complete GAAP chart.",
    accounts: shared.map((account) =>
      account.code === "2100" ? { ...account, name: "Sales tax payable" } : account,
    ),
  },
  {
    id: "uk",
    label: "United Kingdom",
    detail: "Starter names for a UK small business. This is not a complete statutory chart.",
    accounts: shared.map((account) =>
      account.code === "2100" ? { ...account, name: "VAT payable" } : account,
    ),
  },
  {
    id: "au",
    label: "Australia",
    detail:
      "Starter names for an Australian small business. This is not a complete statutory chart.",
    accounts: shared.map((account) =>
      account.code === "2100" ? { ...account, name: "GST payable" } : account,
    ),
  },
  {
    id: "nz",
    label: "New Zealand",
    detail:
      "Starter names for a New Zealand small business. This is not a complete statutory chart.",
    accounts: shared.map((account) =>
      account.code === "2100" ? { ...account, name: "GST payable" } : account,
    ),
  },
];
