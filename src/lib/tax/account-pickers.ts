/** Which chart-account types make sense for each tax account role (TX-06). */
export type TaxAccountRole =
  "output" | "input" | "non_recoverable" | "code_account" | "adjustment_offset";

export type PickerAccount = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_active?: boolean;
  is_postable?: boolean;
};

const ALLOWED: Record<TaxAccountRole, readonly string[]> = {
  // Tax collected on sales is owed to the tax authority.
  output: ["liability"],
  // Recoverable input tax is a receivable (asset) in most charts, but some record it as a liability.
  input: ["asset", "liability"],
  // Tax you cannot reclaim is a cost.
  non_recoverable: ["expense", "asset"],
  code_account: ["liability", "asset"],
  // A true-up can hit P&L, equity or another balance-sheet account.
  adjustment_offset: ["expense", "income", "asset", "liability", "equity"],
};

export function isAccountTypeAllowedForTaxRole(role: TaxAccountRole, accountType: string): boolean {
  return ALLOWED[role].includes(accountType);
}

export function filterTaxAccountPicker<T extends PickerAccount>(
  accounts: T[],
  role: TaxAccountRole,
): T[] {
  return accounts.filter(
    (a) =>
      a.is_active !== false &&
      a.is_postable !== false &&
      isAccountTypeAllowedForTaxRole(role, a.account_type),
  );
}

export function describeAllowedTypes(role: TaxAccountRole): string {
  return ALLOWED[role].join(" or ");
}
