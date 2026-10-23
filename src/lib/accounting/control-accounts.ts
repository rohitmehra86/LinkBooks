/**
 * Control-account lookup by role, never by hard-coded code (RP-12 / P-31).
 * Order of preference: system_key → account_kind / subtype → (only if nothing keyed exists) the
 * default seed codes. Pure so it can be unit tested with any chart of accounts.
 */

export type ControlAccountCandidate = {
  id: string;
  code: string;
  account_type: string;
  account_kind?: string | null;
  subtype?: string | null;
  system_key?: string | null;
  is_control?: boolean | null;
  is_active?: boolean | null;
};

export type ControlRole = "ar" | "ap" | "bank" | "tax" | "retained_earnings" | "opening_balance";

const KEY_BY_ROLE: Record<ControlRole, string[]> = {
  ar: ["ar", "accounts_receivable"],
  ap: ["ap", "accounts_payable"],
  bank: ["bank"],
  tax: ["tax", "vat", "gst", "sales_tax", "tax_payable"],
  retained_earnings: ["retained_earnings"],
  opening_balance: ["opening_balance"],
};

const KIND_BY_ROLE: Record<ControlRole, string[]> = {
  ar: ["accounts_receivable"],
  ap: ["accounts_payable"],
  bank: ["bank"],
  tax: [],
  retained_earnings: ["retained_earnings"],
  opening_balance: [],
};

const SUBTYPE_BY_ROLE: Record<ControlRole, string[]> = {
  ar: ["receivable"],
  ap: ["payable"],
  bank: ["bank"],
  tax: ["tax"],
  retained_earnings: ["retained"],
  opening_balance: ["opening"],
};

/** Seed-chart codes: used ONLY when the chart has no keyed account for the role. */
const FALLBACK_CODES: Record<ControlRole, string[]> = {
  ar: ["1100"],
  ap: ["2000"],
  bank: ["1000"],
  tax: ["2100", "1200"],
  retained_earnings: ["3200"],
  opening_balance: ["3100"],
};

export function findControlAccounts<T extends ControlAccountCandidate>(
  accounts: T[],
  role: ControlRole,
): T[] {
  const active = accounts.filter((a) => a.is_active !== false);
  const keys = KEY_BY_ROLE[role];
  const byKey = active.filter((a) => a.system_key && keys.includes(a.system_key.toLowerCase()));
  if (byKey.length) return byKey;
  const kinds = KIND_BY_ROLE[role];
  const byKind = active.filter((a) => a.account_kind && kinds.includes(a.account_kind));
  if (byKind.length) return byKind;
  const subtypes = SUBTYPE_BY_ROLE[role];
  const bySubtype = active.filter(
    (a) => a.subtype && subtypes.includes(a.subtype.toLowerCase()) && a.is_control !== false,
  );
  if (bySubtype.length) return bySubtype;
  const codes = FALLBACK_CODES[role];
  return active.filter((a) => codes.includes(a.code));
}

export function findControlAccountIds<T extends ControlAccountCandidate>(
  accounts: T[],
  role: ControlRole,
): string[] {
  return findControlAccounts(accounts, role).map((a) => a.id);
}

/** Tax control accounts: explicit company_tax_settings ids win, then role lookup. */
export function resolveTaxAccountIds<T extends ControlAccountCandidate>(
  accounts: T[],
  settings: { output_tax_account_id?: string | null; input_tax_account_id?: string | null } | null,
): string[] {
  const configured = [settings?.output_tax_account_id, settings?.input_tax_account_id].filter(
    (v): v is string => Boolean(v),
  );
  if (configured.length) return [...new Set(configured)];
  return findControlAccountIds(accounts, "tax");
}
