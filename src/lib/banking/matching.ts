/**
 * Pure matching logic (BK-02). The database RPCs `match_bank_transaction` and
 * `match_bank_transactions_to_journal_line` re-validate everything; this module drives
 * suggestions, the running difference and the "can I submit?" state in the UI.
 * All amounts are signed integer minor units (positive = money in = bank debit).
 */

export const DEFAULT_MATCH_WINDOW_DAYS = 7;
export const MAX_MATCH_LINES = 50;

const DAY_MS = 86_400_000;

function toUtcDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Invalid date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

/** Whole days between two YYYY-MM-DD dates (always >= 0). */
export function dayDistance(a: string, b: string): number {
  return Math.abs(toUtcDay(a) - toUtcDay(b));
}

export type MatchCandidate = {
  lineId: string;
  date: string;
  amountMinor: number;
};

export type RankedCandidate<T extends MatchCandidate> = T & {
  dayDistance: number;
  exact: boolean;
};

/**
 * Candidates inside ±windowDays of the statement line, exact-amount matches first,
 * then by closeness in days, then newest first. Candidates outside the window are dropped.
 */
export function rankCandidates<T extends MatchCandidate>(
  statement: { txnDate: string; amountMinor: number },
  candidates: readonly T[],
  windowDays: number = DEFAULT_MATCH_WINDOW_DAYS,
): Array<RankedCandidate<T>> {
  const out: Array<RankedCandidate<T>> = [];
  for (const c of candidates) {
    const d = dayDistance(statement.txnDate, c.date);
    if (d > windowDays) continue;
    out.push({ ...c, dayDistance: d, exact: c.amountMinor === statement.amountMinor });
  }
  out.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.dayDistance !== b.dayDistance) return a.dayDistance - b.dayDistance;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.lineId < b.lineId ? -1 : 1;
  });
  return out;
}

export type MatchSumCheck = {
  /** Sum of the selected side. */
  total: bigint;
  /** target − total. Zero means the selection matches exactly. */
  difference: bigint;
  ok: boolean;
  reason: string | null;
};

/** One statement line vs several ledger lines (or the mirror image). Sum must be exactly equal. */
export function validateMatchSum(
  targetMinor: number | bigint,
  selectedMinor: ReadonlyArray<number | bigint>,
): MatchSumCheck {
  const target = BigInt(targetMinor);
  let total = 0n;
  for (const v of selectedMinor) total += BigInt(v);
  const difference = target - total;
  if (selectedMinor.length === 0) {
    return { total, difference, ok: false, reason: "Select at least one line" };
  }
  if (selectedMinor.length > MAX_MATCH_LINES) {
    return { total, difference, ok: false, reason: `Select at most ${MAX_MATCH_LINES} lines` };
  }
  if (difference !== 0n) {
    return { total, difference, ok: false, reason: "Selected lines do not add up to the amount" };
  }
  return { total, difference, ok: true, reason: null };
}

/**
 * Suggest a small combination of candidate lines that adds up exactly to the target
 * (bounded search so the browser never stalls: at most `maxCandidates` lines, `maxSize` per set).
 * Returns the ids of the first combination found, preferring fewer lines.
 */
export function findExactCombination(
  targetMinor: number | bigint,
  candidates: ReadonlyArray<{ lineId: string; amountMinor: number }>,
  opts: { maxSize?: number; maxCandidates?: number } = {},
): string[] | null {
  const maxSize = opts.maxSize ?? 4;
  const pool = candidates.slice(0, opts.maxCandidates ?? 24);
  const target = BigInt(targetMinor);
  const amounts = pool.map((c) => BigInt(c.amountMinor));

  const search = (size: number, start: number, acc: bigint, pick: number[]): number[] | null => {
    if (pick.length === size) return acc === target ? [...pick] : null;
    for (let i = start; i < pool.length; i++) {
      pick.push(i);
      const r = search(size, i + 1, acc + amounts[i]!, pick);
      pick.pop();
      if (r) return r;
    }
    return null;
  };

  for (let size = 1; size <= Math.min(maxSize, pool.length); size++) {
    const found = search(size, 0, 0n, []);
    if (found) return found.map((i) => pool[i]!.lineId);
  }
  return null;
}
