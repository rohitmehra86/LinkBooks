/**
 * Customer statement builder (AR-09). Pure.
 *
 * A statement is an activity ledger per currency:
 *   opening balance (everything before `from`) + activity in [from, to] = closing balance.
 * Invoices debit, receipts and credit notes credit. A void shows as its own reversing line on the
 * void date, so a statement for a period never rewrites the balance brought forward.
 * A legacy void with no recorded void date was reversed on the document date and is omitted.
 */

export type StatementDoc = {
  kind: "invoice" | "receipt" | "credit_note";
  id: string;
  date: string;
  currencyCode: string;
  amountMinor: number;
  reference: string | null;
  status: string;
  voidDate: string | null;
  dueDate?: string | null;
};

export type StatementLine = {
  date: string;
  type: "invoice" | "receipt" | "credit_note" | "void";
  id: string;
  reference: string | null;
  description: string;
  debit_minor: number;
  credit_minor: number;
  balance_minor: number;
  due_date?: string | null;
  status: string;
};

export type StatementCurrency = {
  currency_code: string;
  opening_balance_minor: number;
  lines: StatementLine[];
  closing_balance_minor: number;
  total_debits_minor: number;
  total_credits_minor: number;
};

type Event = Omit<StatementLine, "balance_minor"> & { currency: string; order: number };

const TYPE_ORDER: Record<string, number> = { invoice: 0, credit_note: 1, receipt: 2, void: 3 };

function eventsFor(doc: StatementDoc): Event[] {
  if (doc.status === "draft") return [];
  const sign = doc.kind === "invoice" ? 1 : -1; // + increases what the customer owes
  const noun = doc.kind === "invoice" ? "Invoice" : doc.kind === "receipt" ? "Payment received" : "Credit note";
  const isVoid = doc.status === "void";
  if (isVoid && !doc.voidDate) return [];
  const mk = (
    type: Event["type"],
    date: string,
    signed: number,
    description: string,
  ): Event => ({
    date,
    type,
    id: doc.id,
    reference: doc.reference,
    description,
    debit_minor: signed > 0 ? signed : 0,
    credit_minor: signed < 0 ? -signed : 0,
    due_date: doc.dueDate ?? null,
    status: doc.status,
    currency: doc.currencyCode,
    order: TYPE_ORDER[type] ?? 9,
  });
  const out = [mk(doc.kind, doc.date, sign * doc.amountMinor, noun)];
  if (isVoid && doc.voidDate) {
    out.push(mk("void", doc.voidDate, -sign * doc.amountMinor, `${noun} voided`));
  }
  return out;
}

export function buildCustomerStatement(
  docs: StatementDoc[],
  range: { from: string | null; to: string | null },
): StatementCurrency[] {
  const byCurrency = new Map<string, Event[]>();
  for (const d of docs) {
    for (const e of eventsFor(d)) {
      const arr = byCurrency.get(e.currency);
      if (arr) arr.push(e);
      else byCurrency.set(e.currency, [e]);
    }
  }

  const result: StatementCurrency[] = [];
  for (const [currency, events] of byCurrency) {
    events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.id.localeCompare(b.id));
    let opening = 0;
    const inRange: Event[] = [];
    for (const e of events) {
      if (range.to && e.date > range.to) continue;
      if (range.from && e.date < range.from) {
        opening += e.debit_minor - e.credit_minor;
      } else {
        inRange.push(e);
      }
    }
    let running = opening;
    let debits = 0;
    let credits = 0;
    const lines: StatementLine[] = inRange.map((e) => {
      running += e.debit_minor - e.credit_minor;
      debits += e.debit_minor;
      credits += e.credit_minor;
      const { currency: _c, order: _o, ...rest } = e;
      void _c;
      void _o;
      return { ...rest, balance_minor: running };
    });
    if (opening === 0 && lines.length === 0) continue;
    result.push({
      currency_code: currency,
      opening_balance_minor: opening,
      lines,
      closing_balance_minor: running,
      total_debits_minor: debits,
      total_credits_minor: credits,
    });
  }
  return result.sort((a, b) => a.currency_code.localeCompare(b.currency_code));
}
