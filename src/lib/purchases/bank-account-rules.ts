/**
 * Which ledger accounts may be used as the "paid from" account for supplier payments,
 * direct expenses and claim reimbursements (P-05).
 *
 * An account qualifies when it is an active, postable asset AND at least one of:
 *  - it is the GL account of a Banking bank account (`bank_accounts.gl_account_id`) - the
 *    canonical link, since older charts do not carry a bank flag;
 *  - the chart marks it as a bank / cash account (`account_kind` or `subtype` of bank or cash);
 *  - it is flagged payment-enabled.
 * Receivables, VAT, inventory, fixed assets etc. never qualify.
 */

export type AccountCandidate = {
  id: string;
  account_type: string;
  is_active: boolean;
  is_postable: boolean;
  archived_at?: string | null;
  account_kind?: string | null;
  subtype?: string | null;
  is_payment_enabled?: boolean | null;
};

const BANK_KINDS = new Set(["bank", "cash", "cash_and_bank", "petty_cash"]);

export function isBankOrCashAccount(
  account: AccountCandidate,
  bankGlAccountIds: ReadonlySet<string>,
): boolean {
  if (account.account_type !== "asset") return false;
  if (!account.is_active || account.archived_at || !account.is_postable) return false;
  if (bankGlAccountIds.has(account.id)) return true;
  if (account.is_payment_enabled) return true;
  const kind = (account.account_kind ?? "").toLowerCase();
  const subtype = (account.subtype ?? "").toLowerCase();
  return BANK_KINDS.has(kind) || BANK_KINDS.has(subtype);
}

export const NOT_A_BANK_ACCOUNT_MESSAGE =
  "Choose a bank or cash account. Receivables, tax, inventory and other ledger accounts cannot be used to pay from.";
