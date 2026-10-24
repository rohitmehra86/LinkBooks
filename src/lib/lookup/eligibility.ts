import {
  isBankOrCashAccount,
  NOT_A_BANK_ACCOUNT_MESSAGE,
  type AccountCandidate,
} from "@/lib/purchases/bank-account-rules";
import { productAccountProblem, type ProductAccountRole } from "@/lib/products/product-rules";
import { RATE_STATUS_LABEL, rateStatus, type RateDates } from "@/lib/tax/rate-status";
import { formatLookupLabel } from "@/lib/lookup/search";
import type { LookupOption } from "@/lib/lookup/types";

export type AccountLookupRecord = {
  id: string;
  code: string;
  name: string;
  account_type?: string | null;
  accountType?: string | null;
  is_active?: boolean;
  isActive?: boolean;
  is_postable?: boolean;
  isPostable?: boolean;
  archived_at?: string | null;
  account_kind?: string | null;
  subtype?: string | null;
  is_payment_enabled?: boolean | null;
  company_id?: string | null;
  companyId?: string | null;
};

export type AccountLookupPurpose = "posting" | "parent" | "bank" | "income" | "expense";

function accountTypeOf(row: AccountLookupRecord): string | null {
  return row.account_type ?? row.accountType ?? null;
}

function accountActive(row: AccountLookupRecord): boolean {
  const active = row.is_active ?? row.isActive;
  if (active === false) return false;
  if (row.archived_at) return false;
  return true;
}

function accountPostable(row: AccountLookupRecord): boolean {
  const postable = row.is_postable ?? row.isPostable;
  return postable !== false;
}

export function accountSelectionProblem(
  row: AccountLookupRecord,
  purpose: AccountLookupPurpose,
  extras?: { bankGlIds?: ReadonlySet<string> | undefined; productKind?: string | undefined },
): string | null {
  if (!accountActive(row)) return "Account is inactive";
  if (purpose === "parent") return null;
  if (!accountPostable(row)) return "Account is not postable";
  if (purpose === "bank" && accountTypeOf(row)) {
    const candidate: AccountCandidate = {
      id: row.id,
      account_type: accountTypeOf(row) ?? "",
      is_active: true,
      is_postable: true,
      ...(row.archived_at != null ? { archived_at: row.archived_at } : {}),
      ...(row.account_kind != null ? { account_kind: row.account_kind } : {}),
      ...(row.subtype != null ? { subtype: row.subtype } : {}),
      ...(row.is_payment_enabled != null ? { is_payment_enabled: row.is_payment_enabled } : {}),
    };
    if (!isBankOrCashAccount(candidate, extras?.bankGlIds ?? new Set())) {
      return NOT_A_BANK_ACCOUNT_MESSAGE;
    }
  }
  if (purpose === "income" || purpose === "expense") {
    return productAccountProblem(
      purpose as ProductAccountRole,
      accountTypeOf(row),
      extras?.productKind ?? (purpose === "expense" ? "service" : "service"),
    );
  }
  return null;
}

export function toAccountLookupOption(
  row: AccountLookupRecord,
  purpose: AccountLookupPurpose = "posting",
  extras?: { bankGlIds?: ReadonlySet<string> | undefined; productKind?: string | undefined },
): LookupOption {
  const problem = accountSelectionProblem(row, purpose, extras);
  const typeName = accountTypeOf(row);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    label: formatLookupLabel({ label: row.name, code: row.code, name: row.name }),
    group: typeName ? typeName.charAt(0).toUpperCase() + typeName.slice(1) : null,
    keywords: `${row.code} ${row.name} ${row.account_kind ?? ""} ${row.subtype ?? ""}`,
    status: problem,
    disabled: Boolean(problem),
    disabledReason: problem,
    companyId: row.company_id ?? row.companyId ?? null,
  };
}

export type ContactLookupRecord = {
  id: string;
  name: string;
  code?: string | null;
  contact_code?: string | null;
  kind?: string | null;
  contact_type?: string | null;
  is_active?: boolean;
  isActive?: boolean;
  company_id?: string | null;
  companyId?: string | null;
};

const CONTACT_GROUP: Record<string, string> = {
  customer: "Customers",
  supplier: "Suppliers",
  both: "Customers & suppliers",
  employee: "Employees",
};

export function toContactLookupOption(row: ContactLookupRecord): LookupOption {
  const kind = (row.kind ?? row.contact_type ?? "").toLowerCase();
  const inactive = row.is_active === false || row.isActive === false;
  const code = row.code ?? row.contact_code ?? null;
  return {
    id: row.id,
    code,
    name: row.name,
    label: formatLookupLabel({ label: row.name, code, name: row.name }),
    group: CONTACT_GROUP[kind] ?? (kind ? kind : null),
    keywords: `${code ?? ""} ${row.name} ${kind}`,
    status: inactive ? "Inactive" : null,
    disabled: inactive,
    disabledReason: inactive ? "Contact is inactive" : null,
    companyId: row.company_id ?? row.companyId ?? null,
  };
}

export type ProductLookupRecord = {
  id: string;
  name: string;
  code?: string | null;
  sku?: string | null;
  description?: string | null;
  unit?: string | null;
  sales_price_minor?: number | null;
  purchase_price_minor?: number | null;
  priceLabel?: string | null;
  taxLabel?: string | null;
  stockLabel?: string | null;
  is_active?: boolean;
  company_id?: string | null;
  companyId?: string | null;
};

export function toProductLookupOption(row: ProductLookupRecord): LookupOption {
  const code = row.sku ?? row.code ?? null;
  const inactive = row.is_active === false;
  const meta = [row.priceLabel, row.unit, row.stockLabel].filter(Boolean).join(" · ");
  return {
    id: row.id,
    code,
    name: row.name,
    label: formatLookupLabel({ label: row.name, code, name: row.name }),
    description: row.description,
    meta: meta || null,
    keywords: `${code ?? ""} ${row.name} ${row.description ?? ""} ${row.taxLabel ?? ""} ${row.unit ?? ""}`,
    status: inactive ? "Inactive" : row.taxLabel,
    disabled: inactive,
    disabledReason: inactive ? "Product is inactive" : null,
    companyId: row.company_id ?? row.companyId ?? null,
  };
}

export type TaxLookupRecord = RateDates & {
  id: string;
  code?: string | null;
  name: string;
  rateLabel?: string | null;
  jurisdiction?: string | null;
  appliesTo?: string | null;
  company_id?: string | null;
  companyId?: string | null;
};

export function taxSelectionProblem(
  row: TaxLookupRecord,
  today: string,
  usage?: "sales" | "purchases" | "both",
): string | null {
  const status = rateStatus(row, today);
  if (status !== "current") return RATE_STATUS_LABEL[status];
  const applies = (row.appliesTo ?? "both").toLowerCase();
  if (usage && usage !== "both" && applies !== "both" && applies !== usage) {
    return applies === "sales" ? "Sales tax only" : "Purchase tax only";
  }
  return null;
}

export function toTaxLookupOption(
  row: TaxLookupRecord,
  today: string,
  usage?: "sales" | "purchases" | "both",
): LookupOption {
  const problem = taxSelectionProblem(row, today, usage);
  const code = row.code ?? null;
  return {
    id: row.id,
    code,
    name: row.name,
    label: formatLookupLabel({ label: row.name, code, name: row.name }),
    description: [row.rateLabel, row.jurisdiction, row.effective_from].filter(Boolean).join(" · "),
    group: row.jurisdiction ?? null,
    keywords: `${code ?? ""} ${row.name} ${row.rateLabel ?? ""} ${row.jurisdiction ?? ""}`,
    meta: row.rateLabel,
    status: problem,
    disabled: Boolean(problem),
    disabledReason: problem,
    companyId: row.company_id ?? row.companyId ?? null,
  };
}

export type TrackingLookupRecord = {
  id: string;
  name: string;
  code?: string | null;
  category?: string | null;
  is_active?: boolean;
  company_id?: string | null;
  companyId?: string | null;
};

export function toTrackingLookupOption(row: TrackingLookupRecord): LookupOption {
  const inactive = row.is_active === false;
  const code = row.code ?? null;
  return {
    id: row.id,
    code,
    name: row.name,
    label: formatLookupLabel({ label: row.name, code, name: row.name }),
    group: row.category ?? null,
    keywords: `${code ?? ""} ${row.name} ${row.category ?? ""}`,
    status: inactive ? "Inactive" : null,
    disabled: inactive,
    disabledReason: inactive ? "Tracking option is inactive" : null,
    companyId: row.company_id ?? row.companyId ?? null,
  };
}

export type BankLookupRecord = {
  id: string;
  name: string;
  code?: string | null;
  currency_code?: string | null;
  currency?: string | null;
  is_active?: boolean;
  company_id?: string | null;
  companyId?: string | null;
};

export function bankSelectionProblem(
  row: BankLookupRecord,
  extras?: { excludeId?: string | undefined; requiredCurrency?: string | null | undefined },
): string | null {
  if (row.is_active === false) return "Account is inactive";
  if (extras?.excludeId && row.id === extras.excludeId) return "Choose a different account";
  const currency = row.currency_code ?? row.currency ?? null;
  if (extras?.requiredCurrency && currency && currency !== extras.requiredCurrency) {
    return `Currency must be ${extras.requiredCurrency}`;
  }
  return null;
}

export function toBankLookupOption(
  row: BankLookupRecord,
  extras?: { excludeId?: string | undefined; requiredCurrency?: string | null | undefined },
): LookupOption {
  const problem = bankSelectionProblem(row, extras);
  const currency = row.currency_code ?? row.currency ?? null;
  const code = row.code ?? null;
  return {
    id: row.id,
    code,
    name: row.name,
    label: formatLookupLabel({ label: row.name, code, name: row.name }),
    group: currency,
    meta: currency,
    keywords: `${code ?? ""} ${row.name} ${currency ?? ""}`,
    status: problem,
    disabled: Boolean(problem),
    disabledReason: problem,
    companyId: row.company_id ?? row.companyId ?? null,
  };
}
