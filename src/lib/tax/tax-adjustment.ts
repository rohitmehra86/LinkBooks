import type { PostJournalInput } from "@/lib/accounting/posting-engine";

export type TaxAdjustmentArgs = {
  companyId: string;
  journalDate: string;
  taxAccountId: string;
  offsetAccountId: string;
  amountMinor: number | bigint;
  direction: "increase_payable" | "decrease_payable";
  memo: string | null;
  adjustmentKey: string;
  currencyCode: string;
};

/**
 * Journal for a period-end tax adjustment (TX-03).
 * `source_id` is a UUID column: free text must never go there. The caller's key lives in
 * `idempotency_key` only; `source_id` stays unset (or a real tax-return id once one exists).
 */
export function buildTaxAdjustmentJournal(
  args: TaxAdjustmentArgs,
  sourceId?: string,
): PostJournalInput {
  const amount = BigInt(args.amountMinor);
  if (amount <= 0n) throw new Error("Adjustment amount must be positive");
  if (args.taxAccountId === args.offsetAccountId)
    throw new Error("Tax and offset accounts must differ");
  const taxIsCredit = args.direction === "increase_payable";
  const memo = args.memo ?? undefined;
  return {
    company_id: args.companyId,
    journal_date: args.journalDate,
    ...(args.currencyCode ? { currency_code: args.currencyCode } : {}),
    source_type: "tax_adjustment",
    ...(sourceId ? { source_id: sourceId } : {}),
    idempotency_key: `tax_adjustment:${args.companyId}:${args.adjustmentKey}`,
    ...(memo ? { memo } : {}),
    lines: taxIsCredit
      ? [
          {
            account_id: args.offsetAccountId,
            description: memo ?? "Tax adjustment",
            debit_minor: amount,
            credit_minor: 0n,
          },
          {
            account_id: args.taxAccountId,
            description: memo ?? "Tax payable",
            debit_minor: 0n,
            credit_minor: amount,
          },
        ]
      : [
          {
            account_id: args.taxAccountId,
            description: memo ?? "Tax payable",
            debit_minor: amount,
            credit_minor: 0n,
          },
          {
            account_id: args.offsetAccountId,
            description: memo ?? "Tax adjustment",
            debit_minor: 0n,
            credit_minor: amount,
          },
        ],
  };
}
