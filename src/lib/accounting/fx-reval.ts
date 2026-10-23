/**
 * Foreign-currency gains and losses: pure rules shared by the screens and the unit tests. The database
 * functions (`fx_realise_allocation`, `post_fx_revaluation`) apply the same arithmetic; these helpers
 * let the UI show exactly what will be posted and let tests pin the sign conventions.
 *
 * All amounts are integer minor units. Rates are MANUAL: entered by the user or stored in
 * `exchange_rates`. There is no rate feed, so a missing rate is an error, never a guess.
 */

import { convertMinorToBase } from "@/lib/accounting/fx";

export type SettlementKind = "sales" | "purchases";

export type RealisedFx = {
  /** >0 gain, <0 loss, in base-currency minor units. */
  gainLossBaseMinor: bigint;
  documentBase: bigint;
  settlementBase: bigint;
};

/**
 * Realised FX on settling `settledMinor` of a document booked at `documentRate` with a receipt / payment
 * posted at `settlementRate`. Receipts: receiving more base than was booked is a gain. Payments: paying
 * less base than was booked is a gain.
 */
export function realisedFx(
  kind: SettlementKind,
  settledMinor: bigint | number,
  documentRate: number | string,
  settlementRate: number | string,
  currency: string,
  baseCurrency: string,
): RealisedFx {
  const documentBase = convertMinorToBase(settledMinor, documentRate, currency, baseCurrency);
  const settlementBase = convertMinorToBase(settledMinor, settlementRate, currency, baseCurrency);
  const gainLossBaseMinor =
    kind === "sales" ? settlementBase - documentBase : documentBase - settlementBase;
  return { gainLossBaseMinor, documentBase, settlementBase };
}

export type JournalLineSpec = { accountId: string; debitMinor: bigint; creditMinor: bigint };

/** The two lines of a realised FX journal: control account against the gain / loss account. */
export function realisedFxLines(
  gainLossBaseMinor: bigint,
  controlAccountId: string,
  gainAccountId: string,
  lossAccountId: string,
): JournalLineSpec[] {
  if (gainLossBaseMinor === 0n) return [];
  if (gainLossBaseMinor > 0n) {
    return [
      { accountId: controlAccountId, debitMinor: gainLossBaseMinor, creditMinor: 0n },
      { accountId: gainAccountId, debitMinor: 0n, creditMinor: gainLossBaseMinor },
    ];
  }
  const loss = -gainLossBaseMinor;
  return [
    { accountId: lossAccountId, debitMinor: loss, creditMinor: 0n },
    { accountId: controlAccountId, debitMinor: 0n, creditMinor: loss },
  ];
}

export type OpenForeignBalanceInput = {
  accountId: string;
  currencyCode: string;
  /** Debit minus credit in the foreign currency (AR positive, AP negative). */
  txnNetMinor: bigint;
  /** Base-currency value currently booked for that balance (debit minus credit). */
  bookedBaseMinor: bigint;
  /** Units of base currency per unit of foreign currency, as at the revaluation date. */
  rate: string | undefined;
};

export type RevaluationLine = {
  accountId: string;
  currencyCode: string;
  closingBaseMinor: bigint;
  /** Signed: >0 debit the account (gain), <0 credit it (loss). */
  adjustmentMinor: bigint;
};

export type RevaluationResult = {
  /** Currencies that still need a manual rate. */
  missingRates: string[];
  lines: RevaluationLine[];
  /** Per currency: the journal lines to post (account lines plus the balancing gain/loss line). */
  journals: Array<{
    currencyCode: string;
    lines: JournalLineSpec[];
    gainMinor: bigint;
    lossMinor: bigint;
  }>;
  totalGainMinor: bigint;
  totalLossMinor: bigint;
};

export function isPositiveRate(rate: string | undefined): boolean {
  if (rate === undefined) return false;
  const r = rate.trim();
  return /^\d+(\.\d+)?$/.test(r) && Number(r) > 0;
}

/**
 * Revalue open foreign balances. One journal per currency; each balances through the unrealised gain /
 * loss account. Balances with no valid rate are listed in `missingRates` and not revalued.
 */
export function computeRevaluation(
  balances: OpenForeignBalanceInput[],
  baseCurrency: string,
  gainAccountId: string,
  lossAccountId: string,
): RevaluationResult {
  const missing = new Set<string>();
  const lines: RevaluationLine[] = [];
  for (const b of balances) {
    const ccy = b.currencyCode.toUpperCase();
    if (ccy === baseCurrency.toUpperCase()) continue;
    if (!isPositiveRate(b.rate)) {
      missing.add(ccy);
      continue;
    }
    const closing = convertMinorToBase(b.txnNetMinor, b.rate!, ccy, baseCurrency);
    lines.push({
      accountId: b.accountId,
      currencyCode: ccy,
      closingBaseMinor: closing,
      adjustmentMinor: closing - b.bookedBaseMinor,
    });
  }

  const journals: RevaluationResult["journals"] = [];
  let totalGain = 0n;
  let totalLoss = 0n;
  const ccys = [
    ...new Set(lines.filter((l) => l.adjustmentMinor !== 0n).map((l) => l.currencyCode)),
  ].sort();
  for (const ccy of ccys) {
    const specs: JournalLineSpec[] = [];
    let debits = 0n;
    let credits = 0n;
    for (const l of lines.filter((x) => x.currencyCode === ccy && x.adjustmentMinor !== 0n)) {
      if (l.adjustmentMinor > 0n) {
        specs.push({ accountId: l.accountId, debitMinor: l.adjustmentMinor, creditMinor: 0n });
        debits += l.adjustmentMinor;
      } else {
        specs.push({ accountId: l.accountId, debitMinor: 0n, creditMinor: -l.adjustmentMinor });
        credits += -l.adjustmentMinor;
      }
    }
    let gain = 0n;
    let loss = 0n;
    if (debits > credits) {
      gain = debits - credits;
      specs.push({ accountId: gainAccountId, debitMinor: 0n, creditMinor: gain });
    } else if (credits > debits) {
      loss = credits - debits;
      specs.push({ accountId: lossAccountId, debitMinor: loss, creditMinor: 0n });
    }
    totalGain += gain;
    totalLoss += loss;
    journals.push({ currencyCode: ccy, lines: specs, gainMinor: gain, lossMinor: loss });
  }
  return {
    missingRates: [...missing].sort(),
    lines,
    journals,
    totalGainMinor: totalGain,
    totalLossMinor: totalLoss,
  };
}

/** The day after an ISO date (revaluation journals reverse on as-at + 1). */
export function nextDay(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** An auto-reversal must be dated after the journal it reverses. Returns an error message or null. */
export function validateAutoReverseDate(
  journalDate: string,
  reverseOn: string | null | undefined,
): string | null {
  if (!reverseOn) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reverseOn)) return "Choose a valid reversal date.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(journalDate)) return "Choose a valid posting date first.";
  if (reverseOn <= journalDate) return "The reversal date must be after the journal date.";
  return null;
}
