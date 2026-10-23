/**
 * VAT / GST return maths (TX-01). Pure and deterministic: the server turns document tax lines
 * into `TaxFact`s (already in the company base currency), this file totals them into boxes.
 *
 * Boxes follow the UK VAT100 layout. Other countries use the same totals with generic labels.
 * The return is built from document tax lines grouped by tax code. It is never built from
 * journal movements, so a settlement or adjustment journal cannot change a later return.
 */

import type { PostJournalInput } from "@/lib/accounting/posting-engine";

export type TaxSide = "sales" | "purchases";

export type TaxFact = {
  side: TaxSide;
  /** +1 for invoices, bills and expenses; -1 for credit notes. */
  sign: 1 | -1;
  /** Treatment of the tax code, or null when the line has no code. */
  treatment: string | null;
  /** Whether input tax on this line can be reclaimed (purchases only). */
  recoverable: boolean;
  netBase: bigint;
  taxBase: bigint;
  /** False when the line had no tax code and was classified from its amounts. */
  coded: boolean;
  /**
   * Reverse-charge purchase the buyer accounts for: `taxBase` is notional tax that counts as
   * output tax (box 1) and, when recoverable, input tax (box 4) at the same time.
   */
  selfAssessed?: boolean;
};

export type BoxKey = "box1" | "box2" | "box3" | "box4" | "box5" | "box6" | "box7" | "box8" | "box9";

export type ReturnTotals = {
  /** Output tax due on sales, net of credit notes. */
  outputTax: bigint;
  /** Recoverable input tax on purchases, net of credit notes. */
  inputTax: bigint;
  /** Sales excluding tax, including zero-rated and exempt, excluding out-of-scope. */
  salesNet: bigint;
  /** Purchases excluding tax, excluding out-of-scope. */
  purchasesNet: bigint;
  /** Purchase tax that is a cost because it cannot be reclaimed. Not in any box. */
  nonRecoverableTax: bigint;
  /** Positive: payable to the authority. Negative: refundable. */
  netTax: bigint;
  /** Lines counted / skipped, for the warnings on screen. */
  counts: {
    lines: number;
    uncoded: number;
    outOfScope: number;
    reverseCharge: number;
    /** Reverse-charge lines whose tax was self-assessed into boxes 1 and 4. */
    selfAssessed: number;
  };
};

const OUT_OF_SCOPE = new Set(["outside_scope", "no_tax"]);

export function computeReturnTotals(facts: TaxFact[]): ReturnTotals {
  let outputTax = 0n;
  let inputTax = 0n;
  let salesNet = 0n;
  let purchasesNet = 0n;
  let nonRecoverableTax = 0n;
  const counts = { lines: 0, uncoded: 0, outOfScope: 0, reverseCharge: 0, selfAssessed: 0 };

  for (const f of facts) {
    counts.lines += 1;
    if (!f.coded) counts.uncoded += 1;
    if (f.treatment && OUT_OF_SCOPE.has(f.treatment)) {
      counts.outOfScope += 1;
      continue;
    }
    if (f.treatment === "reverse_charge") counts.reverseCharge += 1;
    const sign = BigInt(f.sign);
    const net = sign * f.netBase;
    const tax = sign * f.taxBase;
    if (f.side === "sales") {
      salesNet += net;
      outputTax += tax;
    } else {
      purchasesNet += net;
      if (f.selfAssessed) {
        counts.selfAssessed += 1;
        outputTax += tax;
      }
      if (f.recoverable) inputTax += tax;
      else nonRecoverableTax += tax;
    }
  }
  return {
    outputTax,
    inputTax,
    salesNet,
    purchasesNet,
    nonRecoverableTax,
    netTax: outputTax - inputTax,
    counts,
  };
}

export type TreatmentRow = {
  side: TaxSide;
  treatment: string;
  /** Net of credit notes. */
  netBase: bigint;
  taxBase: bigint;
  lines: number;
  selfAssessed: boolean;
};

/** Totals per side and tax treatment, for the Tax Summary report. Uses the same facts as the return. */
export function summariseByTreatment(facts: TaxFact[]): TreatmentRow[] {
  const map = new Map<string, TreatmentRow>();
  for (const f of facts) {
    const treatment = f.treatment ?? "uncoded";
    const selfAssessed = Boolean(f.selfAssessed);
    const key = `${f.side}|${treatment}|${selfAssessed ? "rc" : ""}`;
    const row = map.get(key) ?? {
      side: f.side,
      treatment,
      netBase: 0n,
      taxBase: 0n,
      lines: 0,
      selfAssessed,
    };
    const sign = BigInt(f.sign);
    row.netBase += sign * f.netBase;
    row.taxBase += sign * f.taxBase;
    row.lines += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) =>
    a.side === b.side ? a.treatment.localeCompare(b.treatment) : a.side === "sales" ? -1 : 1,
  );
}

export type BoxLine = {
  box_key: BoxKey;
  label: string;
  amount_minor: number;
  sort_order: number;
};

const UK_LABELS: Record<BoxKey, string> = {
  box1: "VAT due in this period on sales and other outputs",
  box2: "VAT due in this period on acquisitions from other EU member states",
  box3: "Total VAT due (the sum of boxes 1 and 2)",
  box4: "VAT reclaimed in this period on purchases and other inputs",
  box5: "Net VAT to be paid to HMRC or reclaimed by you (difference of boxes 3 and 4)",
  box6: "Total value of sales and all other outputs excluding any VAT",
  box7: "Total value of purchases and all other inputs excluding any VAT",
  box8: "Total value of all supplies of goods and related costs to other EU member states",
  box9: "Total value of all acquisitions of goods and related costs from other EU member states",
};

const GENERIC_LABELS: Record<BoxKey, string> = {
  box1: "Output tax due on sales",
  box2: "Tax due on other acquisitions (not calculated)",
  box3: "Total tax due",
  box4: "Input tax reclaimed on purchases",
  box5: "Net tax payable (or refundable if negative)",
  box6: "Total sales excluding tax",
  box7: "Total purchases excluding tax",
  box8: "Supplies to other regions (not calculated)",
  box9: "Acquisitions from other regions (not calculated)",
};

export function isUkReturn(jurisdictionCode: string | null | undefined): boolean {
  const code = (jurisdictionCode ?? "").trim().toUpperCase();
  return code === "GB" || code === "UK";
}

/** Boxes with labels for the jurisdiction. Box 5 is stored signed; the screen words it. */
export function buildReturnLines(totals: ReturnTotals, jurisdictionCode: string | null): BoxLine[] {
  const labels = isUkReturn(jurisdictionCode) ? UK_LABELS : GENERIC_LABELS;
  const value: Record<BoxKey, bigint> = {
    box1: totals.outputTax,
    box2: 0n,
    box3: totals.outputTax,
    box4: totals.inputTax,
    box5: totals.netTax,
    box6: totals.salesNet,
    box7: totals.purchasesNet,
    box8: 0n,
    box9: 0n,
  };
  const keys: BoxKey[] = ["box1", "box2", "box3", "box4", "box5", "box6", "box7", "box8", "box9"];
  return keys.map((k, i) => {
    const v = value[k];
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Return amount is too large to store");
    }
    return { box_key: k, label: labels[k], amount_minor: Number(v), sort_order: i + 1 };
  });
}

/**
 * HMRC takes boxes 6 to 9 in whole pounds (no pence). Returns the amount to key into the
 * HMRC form: truncated toward zero to a whole unit for those boxes, exact otherwise.
 */
export function filingAmountMinor(
  boxKey: BoxKey,
  amountMinor: number,
  currencyDecimals: number,
  jurisdictionCode: string | null,
): number {
  const wholeUnitsOnly =
    isUkReturn(jurisdictionCode) &&
    (boxKey === "box6" || boxKey === "box7" || boxKey === "box8" || boxKey === "box9");
  if (!wholeUnitsOnly) return amountMinor;
  const unit = 10 ** currencyDecimals;
  return Math.trunc(amountMinor / unit) * unit;
}

/* -------------------------------------------------------------------------- */
/* Cash basis                                                                  */
/* -------------------------------------------------------------------------- */

/** amount * numerator / denominator, rounded half away from zero, rounded once. */
export function scaleByFraction(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  if (numerator <= 0n) return 0n;
  if (numerator >= denominator) return amount;
  const n = amount * numerator;
  const half = denominator / 2n;
  return n >= 0n ? (n + half) / denominator : -((-n + half) / denominator);
}

/* -------------------------------------------------------------------------- */
/* Settlement journal                                                          */
/* -------------------------------------------------------------------------- */

export type SettlementArgs = {
  companyId: string;
  returnId: string;
  journalDate: string;
  periodEnd: string;
  outputAccountId: string;
  inputAccountId: string;
  /** Where the balance goes: the account the authority payment or refund runs through. */
  settlementAccountId: string;
  outputTaxMinor: bigint;
  inputTaxMinor: bigint;
  currencyCode: string;
};

/**
 * Journal that clears the output and input tax accounts for a filed return:
 *   Dr output tax, Cr input tax, and the difference to the settlement account
 *   (credit when tax is payable, debit when refundable).
 * Posted only after the user confirms. `source_id` is the real return id (a UUID).
 */
export function buildTaxReturnSettlementJournal(args: SettlementArgs): PostJournalInput {
  if (args.outputAccountId === args.inputAccountId) {
    throw new Error(
      "Output and input tax use the same account, so there is nothing to clear. Map separate accounts to settle.",
    );
  }
  if (
    args.settlementAccountId === args.outputAccountId ||
    args.settlementAccountId === args.inputAccountId
  ) {
    throw new Error("Choose a settlement account that is different from the tax accounts.");
  }
  if (args.outputTaxMinor < 0n || args.inputTaxMinor < 0n) {
    throw new Error("Settlement needs positive output and input tax totals.");
  }
  const net = args.outputTaxMinor - args.inputTaxMinor;
  if (args.outputTaxMinor === 0n && args.inputTaxMinor === 0n) {
    throw new Error("There is no tax to settle for this return.");
  }
  const memo = `Tax return settlement ${args.periodEnd}`;
  const lines: PostJournalInput["lines"] = [];
  if (args.outputTaxMinor > 0n) {
    lines.push({
      account_id: args.outputAccountId,
      description: "Clear output tax",
      debit_minor: args.outputTaxMinor,
      credit_minor: 0n,
    });
  }
  if (args.inputTaxMinor > 0n) {
    lines.push({
      account_id: args.inputAccountId,
      description: "Clear input tax",
      debit_minor: 0n,
      credit_minor: args.inputTaxMinor,
    });
  }
  if (net > 0n) {
    lines.push({
      account_id: args.settlementAccountId,
      description: "Tax payable to the authority",
      debit_minor: 0n,
      credit_minor: net,
    });
  } else if (net < 0n) {
    lines.push({
      account_id: args.settlementAccountId,
      description: "Tax refundable from the authority",
      debit_minor: -net,
      credit_minor: 0n,
    });
  }
  return {
    company_id: args.companyId,
    journal_date: args.journalDate,
    ...(args.currencyCode ? { currency_code: args.currencyCode } : {}),
    source_type: "tax_adjustment",
    source_id: args.returnId,
    idempotency_key: `tax_return_settlement:${args.returnId}`,
    memo,
    lines,
  };
}
