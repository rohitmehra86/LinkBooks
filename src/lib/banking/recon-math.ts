/**
 * Pure reconciliation arithmetic (BK-03). Mirrors `complete_reconciliation_session` so the UI can
 * show "opening + ticked = statement closing; difference" before anything is submitted.
 * All amounts are signed integer minor units (bigint); positive = money in.
 */

export type StatementLink = { bankTransactionId: string; journalLineId: string };

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export type StatementGroup = {
  /** Stable key (smallest transaction id in the group). */
  key: string;
  bankTransactionIds: string[];
  journalLineIds: string[];
  statementTotal: bigint;
  ledgerTotal: bigint;
  /** Ledger and statement totals differ (or a link is missing). Such a group must not be ticked. */
  inconsistent: boolean;
};

/**
 * Group matched statement lines that share ledger lines (1:N and N:1 matches) so they are ticked together.
 * Statement lines with no links produce an `inconsistent` single-line group (e.g. legacy demo data).
 */
export function buildStatementGroups(
  transactions: ReadonlyArray<{ id: string; amountMinor: number | bigint }>,
  links: readonly StatementLink[],
  ledgerAmountByLine: ReadonlyMap<string, number | bigint>,
): StatementGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  const txnAmount = new Map<string, bigint>();
  for (const t of transactions) {
    txnAmount.set(t.id, BigInt(t.amountMinor));
    parent.set(t.id, t.id);
  }
  const linesByTxn = new Map<string, string[]>();
  const txnsByLine = new Map<string, string[]>();
  for (const l of links) {
    if (!txnAmount.has(l.bankTransactionId)) continue;
    pushTo(linesByTxn, l.bankTransactionId, l.journalLineId);
    pushTo(txnsByLine, l.journalLineId, l.bankTransactionId);
  }
  for (const txns of txnsByLine.values()) {
    for (let i = 1; i < txns.length; i++) union(txns[0]!, txns[i]!);
  }
  // A statement line linked to several lines that are also linked elsewhere is merged via shared lines above;
  // lines of one statement line are merged through the txn itself.
  const members = new Map<string, string[]>();
  for (const t of transactions) {
    const r = find(t.id);
    pushTo(members, r, t.id);
  }

  const groups: StatementGroup[] = [];
  for (const ids of members.values()) {
    ids.sort();
    const lineIds = [...new Set(ids.flatMap((id) => linesByTxn.get(id) ?? []))].sort();
    const statementTotal = ids.reduce((acc, id) => acc + txnAmount.get(id)!, 0n);
    let ledgerTotal = 0n;
    let missing = lineIds.length === 0;
    for (const lineId of lineIds) {
      const amt = ledgerAmountByLine.get(lineId);
      if (amt === undefined) missing = true;
      else ledgerTotal += BigInt(amt);
    }
    groups.push({
      key: ids[0]!,
      bankTransactionIds: ids,
      journalLineIds: lineIds,
      statementTotal,
      ledgerTotal,
      inconsistent: missing || ledgerTotal !== statementTotal,
    });
  }
  groups.sort((a, b) => (a.key < b.key ? -1 : 1));
  return groups;
}

export type ReconciliationSummary = {
  opening: bigint;
  cleared: bigint;
  closing: bigint;
  /** closing − opening − cleared. Zero means the reconciliation balances. */
  difference: bigint;
  balanced: boolean;
};

/** opening + cleared (ticked) = statement closing. */
export function summariseReconciliation(args: {
  openingMinor: bigint;
  closingMinor: bigint;
  /** Ledger amounts of everything ticked (matched groups use their ledger total). */
  tickedAmountsMinor: ReadonlyArray<bigint | number>;
}): ReconciliationSummary {
  let cleared = 0n;
  for (const a of args.tickedAmountsMinor) cleared += BigInt(a);
  const difference = args.closingMinor - args.openingMinor - cleared;
  return {
    opening: args.openingMinor,
    cleared,
    closing: args.closingMinor,
    difference,
    balanced: difference === 0n,
  };
}

export type OutstandingItem = { amountMinor: number | bigint };

/**
 * Bank reconciliation report arithmetic:
 *   statement balance + outstanding receipts − outstanding payments = expected book balance,
 * compared with the actual ledger balance. A non-zero `unexplainedDifference` flags an opening-balance
 * problem or ledger activity that is neither ticked nor listed as outstanding.
 */
export function bankReconciliationReport(args: {
  statementBalanceMinor: bigint | number;
  /** Ledger items on the bank account NOT cleared by this reconciliation (signed). */
  outstandingMinor: ReadonlyArray<OutstandingItem>;
  bookBalanceMinor: bigint | number;
}) {
  let receipts = 0n;
  let payments = 0n;
  for (const o of args.outstandingMinor) {
    const v = BigInt(o.amountMinor);
    if (v >= 0n) receipts += v;
    else payments += v; // negative
  }
  const statement = BigInt(args.statementBalanceMinor);
  const expectedBook = statement + receipts + payments;
  const book = BigInt(args.bookBalanceMinor);
  return {
    statementBalance: statement,
    outstandingReceipts: receipts,
    /** Negative number (money out not yet on the statement). */
    outstandingPayments: payments,
    expectedBookBalance: expectedBook,
    bookBalance: book,
    unexplainedDifference: book - expectedBook,
  };
}

/** Opening balance proposal: the last completed session's closing balance, else null (entered once). */
export function proposeOpeningBalance(
  sessions: ReadonlyArray<{
    status: string;
    statement_date: string;
    created_at?: string;
    statement_balance_minor: number | bigint;
  }>,
): bigint | null {
  const completed = sessions
    .filter((s) => s.status === "completed")
    .sort((a, b) =>
      a.statement_date === b.statement_date
        ? (b.created_at ?? "").localeCompare(a.created_at ?? "")
        : a.statement_date < b.statement_date
          ? 1
          : -1,
    );
  return completed.length ? BigInt(completed[0]!.statement_balance_minor) : null;
}
