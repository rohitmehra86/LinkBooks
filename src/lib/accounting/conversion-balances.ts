/**
 * Conversion date + opening balances (AC-02). Pure rules shared by the screen, the server function and
 * the unit tests. The database function `post_conversion_balances` re-validates everything; these rules
 * exist so the user sees the difference and every problem BEFORE posting.
 *
 * Model: the opening journal is dated the day before the conversion date. The trial balance grid holds
 * every account except the receivables / payables control accounts, which come from opening invoices and
 * bills per contact. The journal must balance (debits = credits, in base-currency equivalents).
 */

import { convertMinorToBase } from "@/lib/accounting/fx";

export type TbEntry = {
  accountId: string;
  debitMinor: bigint;
  creditMinor: bigint;
};

export type OpeningDoc = {
  contactId: string;
  reference: string;
  /** YYYY-MM-DD, must be before the conversion date. */
  documentDate: string;
  /** YYYY-MM-DD, defaults to the document date. */
  dueDate?: string | undefined;
  currencyCode: string;
  /** Units of base currency per 1 unit of the document currency (conversion-date rate). */
  fxRate?: string | undefined;
  /** Outstanding gross amount in the document currency, minor units. */
  amountMinor: bigint;
};

export type ConversionInput = {
  conversionDate: string;
  baseCurrency: string;
  tb: TbEntry[];
  invoices: OpeningDoc[];
  bills: OpeningDoc[];
  /** Explicitly accept a difference by posting it to Opening Balance Equity. */
  acceptDifference: boolean;
};

export type ConversionSummary = {
  openingDate: string | null;
  tbDebit: bigint;
  tbCredit: bigint;
  /** Opening receivables / payables in base currency (foreign amounts at the conversion rate). */
  receivablesBase: bigint;
  payablesBase: bigint;
  debits: bigint;
  credits: bigint;
  /** debits - credits. Zero means the opening journal balances. */
  difference: bigint;
  balanced: boolean;
  /** Amount that would be posted to Opening Balance Equity (only when acceptDifference). */
  plugMinor: bigint;
  tbLineCount: number;
  invoiceCount: number;
  billCount: number;
};

export type ConversionValidation = {
  errors: string[];
  summary: ConversionSummary;
  /** True when it can be posted: no errors and (balanced or the difference is accepted). */
  canPost: boolean;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: string | null | undefined): v is string {
  if (!v || !ISO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The day before the conversion date: the date the opening journal carries. */
export function openingDateFor(conversionDate: string): string | null {
  if (!isIsoDate(conversionDate)) return null;
  const d = new Date(`${conversionDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isPositiveRate(rate: string | undefined): boolean {
  if (rate === undefined) return false;
  const r = rate.trim();
  return /^\d+(\.\d+)?$/.test(r) && Number(r) > 0;
}

export function validateConversion(input: ConversionInput): ConversionValidation {
  const errors: string[] = [];
  const base = input.baseCurrency.toUpperCase();
  const openingDate = openingDateFor(input.conversionDate);
  if (!openingDate) errors.push("Choose a valid conversion date.");

  // ---- trial balance ----
  let tbDebit = 0n;
  let tbCredit = 0n;
  let tbLineCount = 0;
  const seen = new Set<string>();
  for (const e of input.tb) {
    if (e.debitMinor < 0n || e.creditMinor < 0n) {
      errors.push("Trial balance amounts cannot be negative.");
      continue;
    }
    if (e.debitMinor > 0n && e.creditMinor > 0n) {
      errors.push("A trial balance line cannot have both a debit and a credit.");
      continue;
    }
    if (e.debitMinor === 0n && e.creditMinor === 0n) continue;
    if (seen.has(e.accountId)) {
      errors.push("An account appears twice in the trial balance.");
      continue;
    }
    seen.add(e.accountId);
    tbDebit += e.debitMinor;
    tbCredit += e.creditMinor;
    tbLineCount += 1;
  }

  // ---- opening documents ----
  const rateByCurrency = new Map<string, string>();
  const totals = {
    invoices: new Map<string, bigint>(),
    bills: new Map<string, bigint>(),
  };
  const checkDocs = (docs: OpeningDoc[], kind: "invoices" | "bills") => {
    const label = kind === "invoices" ? "invoice" : "bill";
    const refs = new Set<string>();
    for (const d of docs) {
      const ref = d.reference.trim();
      if (!d.contactId) errors.push(`Every opening ${label} needs a contact.`);
      if (!ref) {
        errors.push(`Every opening ${label} needs a reference number.`);
        continue;
      }
      if (!isIsoDate(d.documentDate)) {
        errors.push(`Opening ${label} ${ref} needs a document date.`);
        continue;
      }
      if (isIsoDate(input.conversionDate) && d.documentDate >= input.conversionDate) {
        errors.push(
          `Opening ${label} ${ref} must be dated before the conversion date ${input.conversionDate}.`,
        );
      }
      if (d.dueDate && (!isIsoDate(d.dueDate) || d.dueDate < d.documentDate)) {
        errors.push(`Opening ${label} ${ref} has a due date before its document date.`);
      }
      if (d.amountMinor <= 0n) {
        errors.push(`Opening ${label} ${ref} needs an outstanding amount above zero.`);
        continue;
      }
      const key = `${d.contactId}|${ref.toLowerCase()}`;
      if (refs.has(key)) errors.push(`Reference ${ref} is used twice for the same contact.`);
      refs.add(key);

      const ccy = (d.currencyCode || base).toUpperCase();
      if (ccy !== base) {
        if (!isPositiveRate(d.fxRate)) {
          errors.push(`Enter the conversion-date exchange rate for ${ccy} (${label} ${ref}).`);
          continue;
        }
        const rate = d.fxRate!.trim();
        const known = rateByCurrency.get(ccy);
        if (known !== undefined && Number(known) !== Number(rate)) {
          errors.push(
            `Use one conversion-date exchange rate per currency (${ccy} has more than one).`,
          );
        } else {
          rateByCurrency.set(ccy, rate);
        }
      }
      const bucket = totals[kind];
      bucket.set(ccy, (bucket.get(ccy) ?? 0n) + d.amountMinor);
    }
  };
  checkDocs(input.invoices, "invoices");
  checkDocs(input.bills, "bills");

  const toBase = (byCcy: Map<string, bigint>): bigint => {
    let sum = 0n;
    for (const [ccy, minor] of byCcy) {
      if (ccy === base) sum += minor;
      else {
        const rate = rateByCurrency.get(ccy);
        // Same single-rounding conversion the ledger applies to the currency journal.
        if (rate) sum += convertMinorToBase(minor, rate, ccy, base);
      }
    }
    return sum;
  };
  const receivablesBase = toBase(totals.invoices);
  const payablesBase = toBase(totals.bills);

  const debits = tbDebit + receivablesBase;
  const credits = tbCredit + payablesBase;
  const difference = debits - credits;
  const balanced = difference === 0n;
  if (debits === 0n && credits === 0n) errors.push("Enter at least one opening balance.");
  if (!balanced && !input.acceptDifference) {
    errors.push(
      `Opening balances do not balance: debits ${debits} and credits ${credits} differ by ${difference < 0n ? -difference : difference} (minor units).`,
    );
  }

  const summary: ConversionSummary = {
    openingDate,
    tbDebit,
    tbCredit,
    receivablesBase,
    payablesBase,
    debits,
    credits,
    difference,
    balanced,
    plugMinor:
      !balanced && input.acceptDifference ? (difference < 0n ? -difference : difference) : 0n,
    tbLineCount,
    invoiceCount: input.invoices.length,
    billCount: input.bills.length,
  };
  return { errors, summary, canPost: errors.length === 0 };
}

/** Payload for the `post_conversion_balances` RPC (amounts as numbers; minor units are safe integers). */
export function buildConversionPayload(companyId: string, input: ConversionInput, note?: string) {
  const num = (v: bigint): number => {
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large to post");
    return Number(v);
  };
  const doc = (d: OpeningDoc) => ({
    contact_id: d.contactId,
    reference: d.reference.trim(),
    document_date: d.documentDate,
    due_date: d.dueDate || d.documentDate,
    currency_code: (d.currencyCode || input.baseCurrency).toUpperCase(),
    ...(d.currencyCode.toUpperCase() !== input.baseCurrency.toUpperCase() && d.fxRate
      ? { fx_rate_to_base: d.fxRate.trim() }
      : {}),
    amount_minor: num(d.amountMinor),
  });
  return {
    company_id: companyId,
    conversion_date: input.conversionDate,
    post_difference_to_opening_equity: input.acceptDifference,
    ...(note ? { note } : {}),
    tb_lines: input.tb
      .filter((e) => e.debitMinor > 0n || e.creditMinor > 0n)
      .map((e) => ({
        account_id: e.accountId,
        debit_minor: num(e.debitMinor),
        credit_minor: num(e.creditMinor),
      })),
    invoices: input.invoices.map(doc),
    bills: input.bills.map(doc),
  };
}

/** Accounts that must not be entered in the trial balance grid (their balance comes from documents). */
export function isDocumentControlAccount(a: {
  account_kind?: string | null;
  system_key?: string | null;
  code?: string | null;
}): boolean {
  return (
    a.account_kind === "accounts_receivable" ||
    a.account_kind === "accounts_payable" ||
    a.system_key === "ar" ||
    a.system_key === "ap"
  );
}
