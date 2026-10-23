/**
 * One filter definition shared by the transaction list, the "select all matching" bulk coding and the counts,
 * so "all N matching this filter" means exactly the rows the user sees.
 */
export type TxnFilter = {
  bankAccountId: string | null;
  status: string | null;
  /** unreconciled = uncategorised + matched; posted = matched + reconciled */
  statusGroup: string | null;
  q: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  direction: "in" | "out" | null;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function normaliseTxnFilter(input: {
  bankAccountId?: string | null;
  status?: string | null;
  statusGroup?: string | null;
  q?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  direction?: string | null;
}): TxnFilter {
  const clean = (s: string | null | undefined) => (s ?? "").trim() || null;
  const date = (s: string | null | undefined) => {
    const v = clean(s);
    if (!v) return null;
    if (!ISO.test(v)) throw new Error("Dates must be YYYY-MM-DD");
    return v;
  };
  const dateFrom = date(input.dateFrom);
  const dateTo = date(input.dateTo);
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error("'From' date is after 'To' date");
  return {
    bankAccountId: clean(input.bankAccountId),
    status: clean(input.status),
    statusGroup: clean(input.statusGroup),
    q: clean(input.q)?.slice(0, 120) ?? null,
    dateFrom,
    dateTo,
    direction: input.direction === "in" || input.direction === "out" ? input.direction : null,
  };
}

/** Escape `%`, `_` and `\` so user text is matched literally inside ILIKE. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Minimal builder surface used here (the Supabase builder satisfies it structurally). */
interface FilterChain {
  eq(column: never, value: never): FilterChain;
  in(column: never, values: never): FilterChain;
  gte(column: never, value: never): FilterChain;
  lte(column: never, value: never): FilterChain;
  gt(column: never, value: never): FilterChain;
  lt(column: never, value: never): FilterChain;
  or(filters: string): FilterChain;
}

/** `extras: false` searches the description only (reference/payee columns not installed yet). */
export function applyTxnFilter<Q>(query: Q, f: TxnFilter, extras = true): Q {
  let q = query as unknown as FilterChain;
  if (f.bankAccountId) q = q.eq("bank_account_id" as never, f.bankAccountId as never);
  if (f.statusGroup === "unreconciled")
    q = q.in("status" as never, ["uncategorised", "matched"] as never);
  else if (f.statusGroup === "posted")
    q = q.in("status" as never, ["matched", "reconciled"] as never);
  else if (f.status) q = q.eq("status" as never, f.status as never);
  if (f.dateFrom) q = q.gte("txn_date" as never, f.dateFrom as never);
  if (f.dateTo) q = q.lte("txn_date" as never, f.dateTo as never);
  if (f.direction === "in") q = q.gt("amount_minor" as never, 0 as never);
  if (f.direction === "out") q = q.lt("amount_minor" as never, 0 as never);
  if (f.q) {
    const like = `%${escapeLike(f.q).replace(/[,()]/g, " ")}%`;
    q = q.or(
      extras
        ? `description.ilike.${like},reference.ilike.${like},payee.ilike.${like}`
        : `description.ilike.${like}`,
    );
  }
  return q as unknown as Q;
}
