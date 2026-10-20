/** Industry CoA library types — Level A (core seed) / B (recommended) / C (optional). */

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type NormalBalance = "debit" | "credit";
export type DetailLevel = "simple" | "standard" | "detailed";
export type Recommendation =
  | "core"
  | "recommended"
  | "optional"
  | "system"
  | "feature_dependent";

/** Canonical FS destinations independent of display names. */
export type FsLine =
  | "current_assets"
  | "non_current_assets"
  | "current_liabilities"
  | "non_current_liabilities"
  | "equity"
  | "restricted_net_assets"
  | "revenue"
  | "contra_revenue"
  | "cost_of_sales"
  | "operating_expense"
  | "depreciation"
  | "finance_income"
  | "finance_cost"
  | "other_income"
  | "other_expense"
  | "contribution_income"
  | "program_expense";

export type CashFlowClass = "operating" | "investing" | "financing" | "cash" | "none";

export type LibraryAccount = {
  /** Stable catalog identity — never change once shipped. */
  key: string;
  code: string;
  name: string;
  description: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  subtype: string;
  fsLine: FsLine;
  cashFlowClass: CashFlowClass;
  recommendation: Recommendation;
  /** When true, apply must not create a second control account of this role. */
  controlRole?: "ar" | "ap" | "tax_payable" | "bank" | "retained_earnings";
  whyRecommended?: string;
};

export type IndustryFamily =
  | "professional_services"
  | "ecommerce"
  | "rental_property"
  | "healthcare"
  | "retail_wholesale"
  | "construction"
  | "hospitality_food"
  | "technology"
  | "manufacturing"
  | "transport_logistics"
  | "education"
  | "media_creative"
  | "personal_care"
  | "agriculture"
  | "nonprofit_religious"
  | "other";

export type IndustryDef = {
  code: string;
  name: string;
  family: IndustryFamily;
  description: string;
  /** catalog keys included at each detail level (union with lower levels). */
  simple: string[];
  standard: string[];
  detailed: string[];
  /** Default tracking category names for this industry (e.g. church funds). */
  trackingDefaults?: Array<{ name: string; options: string[] }>;
};

export type ExistingAccount = {
  id?: string;
  code: string;
  name: string;
  account_type: string;
  catalog_key?: string | null;
  is_control?: boolean;
  is_system?: boolean;
};

export type ApplyPreviewItem = {
  key: string;
  code: string;
  name: string;
  accountType: AccountType;
  recommendation: Recommendation;
  action: "create" | "already_present" | "conflict" | "skip_control";
  reason: string;
};

export type ApplyPreview = {
  level: DetailLevel;
  industries: string[];
  toCreate: ApplyPreviewItem[];
  alreadyPresent: ApplyPreviewItem[];
  conflicts: ApplyPreviewItem[];
  skippedControls: ApplyPreviewItem[];
};
