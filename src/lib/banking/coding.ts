/**
 * Bank coding plan (BK-06 / BK-14): turn a statement line plus split lines (account, tax code, description)
 * into ONE balanced journal — net to the account(s), tax to the input/output tax account, gross to the bank.
 *
 * Pure: no I/O. Tax maths comes from `computeTaxLine` (src/lib/tax/tax-math.ts, read-only).
 * The server function resolves tax codes/accounts and posts the plan through `postJournal` (the single engine).
 */
import { assertLinesBalance, type JournalLineDraft } from "@/lib/accounting/money";
import { computeTaxLine, taxPostsToControlAccount, type TaxTreatment } from "@/lib/tax/tax-math";

export type CodingSplit = {
  accountId: string;
  description?: string | null;
  /** Positive magnitude. Tax-inclusive or tax-exclusive depending on `treatment`. */
  amountMinor: bigint;
  taxCodeId?: string | null;
};

export type CodingTaxCode = {
  id: string;
  code: string;
  rateBps: number;
  /** tax_rates.treatment: standard | reduced | zero_rated | exempt | outside_scope | no_tax | reverse_charge */
  treatment: string;
  /** tax_codes.tax_account_id (overrides the default input/output account when set). */
  taxAccountId: string | null;
  isRecoverable: boolean;
};

export type CodingPlanInput = {
  /** Signed statement amount: positive = money in, negative = money out. */
  statementAmountMinor: bigint;
  bankGlAccountId: string;
  splits: readonly CodingSplit[];
  /** inclusive: split amounts are gross (sum must equal the statement). exclusive: net, tax is added on top. */
  treatment: TaxTreatment;
  taxCodes: ReadonlyMap<string, CodingTaxCode>;
  /** Control account for tax on money OUT (purchases). */
  inputTaxAccountId: string | null;
  /** Control account for tax on money IN (sales). */
  outputTaxAccountId: string | null;
  memo?: string | null;
};

export type CodingPlan = {
  direction: "in" | "out";
  lines: JournalLineDraft[];
  netMinor: bigint;
  taxMinor: bigint;
  grossMinor: bigint;
  /** Per split result (same order as the input). */
  perSplit: Array<{ netMinor: bigint; taxMinor: bigint; grossMinor: bigint }>;
};

export class CodingPlanError extends Error {}

/** Preview totals for the UI without needing accounts (same maths as the plan). */
export function computeSplitTotals(
  splits: ReadonlyArray<Pick<CodingSplit, "amountMinor" | "taxCodeId">>,
  treatment: TaxTreatment,
  taxCodes: ReadonlyMap<string, CodingTaxCode>,
): { netMinor: bigint; taxMinor: bigint; grossMinor: bigint; perSplit: CodingPlan["perSplit"] } {
  let net = 0n;
  let tax = 0n;
  let gross = 0n;
  const perSplit: CodingPlan["perSplit"] = [];
  for (const s of splits) {
    const code = s.taxCodeId ? taxCodes.get(s.taxCodeId) : undefined;
    if (s.taxCodeId && !code) throw new CodingPlanError("Unknown tax code");
    const r = computeTaxLine({
      quantity: 1,
      unit_price_minor: s.amountMinor,
      tax_rate_bps: code?.rateBps ?? 0,
      treatment,
    });
    perSplit.push({ netMinor: r.net_minor, taxMinor: r.tax_minor, grossMinor: r.gross_minor });
    net += r.net_minor;
    tax += r.tax_minor;
    gross += r.gross_minor;
  }
  return { netMinor: net, taxMinor: tax, grossMinor: gross, perSplit };
}

export function planBankCoding(input: CodingPlanInput): CodingPlan {
  if (input.statementAmountMinor === 0n) throw new CodingPlanError("Bank amount cannot be zero");
  if (input.splits.length === 0) throw new CodingPlanError("Add at least one coding line");
  const direction: "in" | "out" = input.statementAmountMinor > 0n ? "in" : "out";
  const statementAbs =
    input.statementAmountMinor < 0n ? -input.statementAmountMinor : input.statementAmountMinor;

  for (const [i, s] of input.splits.entries()) {
    if (!s.accountId) throw new CodingPlanError(`Line ${i + 1}: choose an account`);
    if (s.amountMinor <= 0n)
      throw new CodingPlanError(`Line ${i + 1}: amount must be greater than zero`);
  }

  const totals = computeSplitTotals(input.splits, input.treatment, input.taxCodes);
  if (totals.grossMinor !== statementAbs) {
    const diff = statementAbs - totals.grossMinor;
    throw new CodingPlanError(
      `Coding lines total ${totals.grossMinor} but the statement line is ${statementAbs} (difference ${diff}, minor units)`,
    );
  }

  const taxByAccount = new Map<string, bigint>();
  const accountLines: JournalLineDraft[] = [];

  for (const [i, s] of input.splits.entries()) {
    const code = s.taxCodeId ? input.taxCodes.get(s.taxCodeId) : undefined;
    const r = totals.perSplit[i]!;
    if (code?.treatment === "reverse_charge") {
      throw new CodingPlanError(
        `Reverse-charge tax code ${code.code} is not supported for bank coding`,
      );
    }
    const description = s.description?.trim() || input.memo?.trim() || undefined;

    // Tax that is not recoverable, or that does not belong on a tax control account, is part of the cost.
    const postsToControl = code
      ? taxPostsToControlAccount(code.treatment, r.taxMinor) && code.isRecoverable
      : false;
    let accountAmount = r.netMinor;
    if (r.taxMinor !== 0n) {
      if (postsToControl && code) {
        const taxAccountId =
          code.taxAccountId ??
          (direction === "out" ? input.inputTaxAccountId : input.outputTaxAccountId);
        if (!taxAccountId) {
          throw new CodingPlanError(
            `No ${direction === "out" ? "input" : "output"} tax account is configured for tax code ${code.code}`,
          );
        }
        taxByAccount.set(taxAccountId, (taxByAccount.get(taxAccountId) ?? 0n) + r.taxMinor);
      } else {
        accountAmount += r.taxMinor;
      }
    }
    if (accountAmount <= 0n)
      throw new CodingPlanError(`Line ${i + 1}: net amount must be greater than zero`);

    accountLines.push({
      account_id: s.accountId,
      ...(description ? { description } : {}),
      debit_minor: direction === "out" ? accountAmount : 0n,
      credit_minor: direction === "in" ? accountAmount : 0n,
    });
  }

  const taxLines: JournalLineDraft[] = [...taxByAccount.entries()]
    .filter(([, v]) => v !== 0n)
    .map(([accountId, v]) => ({
      account_id: accountId,
      description: "Tax",
      debit_minor: direction === "out" ? v : 0n,
      credit_minor: direction === "in" ? v : 0n,
    }));

  const bankLine: JournalLineDraft = {
    account_id: input.bankGlAccountId,
    ...(input.memo?.trim() ? { description: input.memo.trim() } : {}),
    debit_minor: direction === "in" ? statementAbs : 0n,
    credit_minor: direction === "out" ? statementAbs : 0n,
  };

  const lines =
    direction === "in"
      ? [bankLine, ...accountLines, ...taxLines]
      : [...accountLines, ...taxLines, bankLine];
  assertLinesBalance(lines);
  return {
    direction,
    lines,
    netMinor: totals.netMinor,
    taxMinor: totals.taxMinor,
    grossMinor: totals.grossMinor,
    perSplit: totals.perSplit,
  };
}

/**
 * Idempotency key for a bank-line coding journal. `postJournal` returns the EXISTING journal for a repeated key,
 * so after an unmatch (which reverses the journal) re-coding must use a new key or it would silently re-link the
 * reversed journal. `reversedCount` = number of already-reversed bank-transaction journals for this line.
 */
export function codingIdempotencyKey(bankTransactionId: string, reversedCount: number): string {
  const base = `bank_transaction:${bankTransactionId}:categorise`;
  return reversedCount > 0 ? `${base}:${reversedCount}` : base;
}
