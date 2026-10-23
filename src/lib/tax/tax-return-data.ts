/**
 * Loads document tax lines for a return period and turns them into `TaxFact`s (TX-01).
 *
 * Source of truth is the document lines (net + tax per line, grouped by tax code), never the
 * journals, so settlement journals and manual tax adjustments cannot leak into a later return.
 * Only authorised, partly paid and paid documents count; drafts, voids and documents awaiting
 * approval are left out. Foreign-currency documents convert at the rate of their posted journal.
 */

import { fetchAllPages } from "@/lib/accounting/fetch-all";
import { convertMinorToBase } from "@/lib/accounting/fx";
import type { Sb } from "@/lib/accounting/ledger-data";
import { isSelfAssessedReverseCharge, reverseChargeTaxMinor } from "@/lib/tax/reverse-charge";
import { scaleByFraction, type TaxFact, type TaxSide } from "@/lib/tax/vat-return";

type Row = Record<string, unknown>;
type PageResult = { data: Row[] | null; error: { message: string; code?: string } | null };
type Qb = {
  select: (columns: string) => Qb;
  eq: (column: string, value: unknown) => Qb;
  in: (column: string, values: unknown[]) => Qb;
  gte: (column: string, value: unknown) => Qb;
  lte: (column: string, value: unknown) => Qb;
  order: (column: string) => Qb;
  range: (from: number, to: number) => PromiseLike<PageResult>;
};

function table(sb: Sb, name: string): Qb {
  return (sb as unknown as { from: (t: string) => Qb }).from(name);
}

const CHUNK = 100;
const LIVE_STATUSES = ["authorised", "partly_paid", "paid"];

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function big(row: Row, key: string): bigint {
  const v = row[key];
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

type Source = {
  kind: string;
  side: TaxSide;
  sign: 1 | -1;
  header: string;
  dateCol: string;
  /** Header carries net/tax itself (no line table). */
  headerOnly?: boolean;
  lines?: { table: string; fk: string; hasCode: boolean; hasRate?: boolean };
  /** Cash basis: payments applied to the document, with the payment date. */
  allocations?: {
    table: string;
    docFk: string;
    parentFk: string;
    parentTable: string;
    parentDate: string;
    /** Parent statuses to ignore. */
    skipStatuses: string[];
  };
};

const SOURCES: Source[] = [
  {
    kind: "sales_invoice",
    side: "sales",
    sign: 1,
    header: "sales_invoices",
    dateCol: "invoice_date",
    lines: { table: "sales_invoice_lines", fk: "invoice_id", hasCode: true },
    allocations: {
      table: "sales_receipt_allocations",
      docFk: "invoice_id",
      parentFk: "receipt_id",
      parentTable: "sales_receipts",
      parentDate: "receipt_date",
      skipStatuses: ["void", "voided", "draft"],
    },
  },
  {
    kind: "sales_credit_note",
    side: "sales",
    sign: -1,
    header: "sales_credit_notes",
    dateCol: "credit_date",
    lines: { table: "sales_credit_note_lines", fk: "credit_note_id", hasCode: false },
  },
  {
    kind: "purchase_bill",
    side: "purchases",
    sign: 1,
    header: "purchase_bills",
    dateCol: "bill_date",
    lines: { table: "purchase_bill_lines", fk: "bill_id", hasCode: true, hasRate: true },
    allocations: {
      table: "supplier_payment_allocations",
      docFk: "bill_id",
      parentFk: "payment_id",
      parentTable: "supplier_payments",
      parentDate: "payment_date",
      skipStatuses: ["void", "draft", "awaiting_approval"],
    },
  },
  {
    kind: "purchase_credit_note",
    side: "purchases",
    sign: -1,
    header: "purchase_credit_notes",
    dateCol: "credit_date",
    lines: { table: "purchase_credit_note_lines", fk: "credit_note_id", hasCode: false },
  },
  {
    kind: "purchase_expense",
    side: "purchases",
    sign: 1,
    header: "purchase_expenses",
    dateCol: "expense_date",
    headerOnly: true,
  },
];

export type TaxFactsResult = {
  facts: TaxFact[];
  documents: number;
  /** Foreign-currency documents with no usable posted-journal rate. They are left out. */
  skippedNoRate: number;
};

type CodeInfo = { treatment: string; recoverable: boolean };

async function loadCodes(sb: Sb, companyId: string): Promise<Map<string, CodeInfo>> {
  const rows = await fetchAllPages<Row>((from, to) =>
    table(sb, "tax_codes")
      .select("id, treatment, is_recoverable")
      .eq("company_id", companyId)
      .order("id")
      .range(from, to),
  );
  const map = new Map<string, CodeInfo>();
  for (const r of rows) {
    map.set(str(r, "id"), {
      treatment: str(r, "treatment") || "standard",
      recoverable: r["is_recoverable"] !== false,
    });
  }
  return map;
}

async function loadJournalRates(
  sb: Sb,
  companyId: string,
  journalIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const ids of chunks(journalIds, CHUNK)) {
    const rows = await fetchAllPages<Row>((from, to) =>
      table(sb, "journals")
        .select("id, fx_rate_to_base")
        .eq("company_id", companyId)
        .in("id", ids)
        .order("id")
        .range(from, to),
    );
    for (const r of rows) {
      const rate = r["fx_rate_to_base"];
      if (typeof rate === "number" || typeof rate === "string") map.set(str(r, "id"), String(rate));
    }
  }
  return map;
}

/** Cash basis: per-document amount allocated by payments dated inside the period. */
async function loadAllocatedInPeriod(
  sb: Sb,
  companyId: string,
  a: NonNullable<Source["allocations"]>,
  from: string,
  to: string,
): Promise<Map<string, bigint>> {
  const parents = await fetchAllPages<Row>((f, t) =>
    table(sb, a.parentTable)
      .select(`id, status, ${a.parentDate}`)
      .eq("company_id", companyId)
      .gte(a.parentDate, from)
      .lte(a.parentDate, to)
      .order("id")
      .range(f, t),
  );
  const okParents = parents
    .filter((p) => !a.skipStatuses.includes(str(p, "status")))
    .map((p) => str(p, "id"));
  const byDoc = new Map<string, bigint>();
  for (const ids of chunks(okParents, CHUNK)) {
    const rows = await fetchAllPages<Row>((f, t) =>
      table(sb, a.table)
        .select(`${a.docFk}, amount_minor`)
        .eq("company_id", companyId)
        .in(a.parentFk, ids)
        .order("id")
        .range(f, t),
    );
    for (const r of rows) {
      const doc = str(r, a.docFk);
      byDoc.set(doc, (byDoc.get(doc) ?? 0n) + big(r, "amount_minor"));
    }
  }
  return byDoc;
}

export async function loadTaxFacts(
  sb: Sb,
  args: {
    companyId: string;
    from: string;
    to: string;
    basis: "accrual" | "cash";
    baseCurrency: string;
  },
): Promise<TaxFactsResult> {
  const { companyId, from, to, basis, baseCurrency } = args;
  const codes = await loadCodes(sb, companyId);
  const facts: TaxFact[] = [];
  let documents = 0;
  let skippedNoRate = 0;

  for (const src of SOURCES) {
    // Cash basis applies to invoices and bills that are paid by allocation. Credit notes and
    // expenses are always taken on their own date.
    const useCash = basis === "cash" && Boolean(src.allocations);
    const allocated = useCash
      ? await loadAllocatedInPeriod(sb, companyId, src.allocations!, from, to)
      : null;

    const columns = [
      "id",
      src.dateCol,
      "currency_code",
      "status",
      "posted_journal_id",
      src.headerOnly ? "net_minor, tax_minor" : "total_minor",
    ].join(", ");

    let headers: Row[] = [];
    if (allocated) {
      for (const ids of chunks([...allocated.keys()], CHUNK)) {
        headers = headers.concat(
          await fetchAllPages<Row>((f, t) =>
            table(sb, src.header)
              .select(columns)
              .eq("company_id", companyId)
              .in("id", ids)
              .in("status", LIVE_STATUSES)
              .order("id")
              .range(f, t),
          ),
        );
      }
    } else {
      headers = await fetchAllPages<Row>((f, t) =>
        table(sb, src.header)
          .select(columns)
          .eq("company_id", companyId)
          .in("status", LIVE_STATUSES)
          .gte(src.dateCol, from)
          .lte(src.dateCol, to)
          .order("id")
          .range(f, t),
      );
    }
    if (headers.length === 0) continue;

    const foreignJournalIds = headers
      .filter((h) => str(h, "currency_code").toUpperCase() !== baseCurrency.toUpperCase())
      .map((h) => str(h, "posted_journal_id"))
      .filter(Boolean);
    const rates = await loadJournalRates(sb, companyId, [...new Set(foreignJournalIds)]);

    type Doc = {
      id: string;
      currency: string;
      rate: string | null;
      fraction: [bigint, bigint] | null;
    };
    const docs = new Map<string, Doc>();
    for (const h of headers) {
      const currency = str(h, "currency_code").toUpperCase() || baseCurrency;
      const foreign = currency !== baseCurrency.toUpperCase();
      const rate = foreign ? (rates.get(str(h, "posted_journal_id")) ?? null) : null;
      if (foreign && rate === null) {
        skippedNoRate += 1;
        continue;
      }
      const id = str(h, "id");
      const paid = allocated?.get(id) ?? 0n;
      const total = big(h, "total_minor");
      docs.set(id, {
        id,
        currency,
        rate,
        fraction: allocated ? [paid, total] : null,
      });
    }
    documents += docs.size;

    const toBase = (d: Doc, minor: bigint): bigint =>
      d.rate === null ? minor : convertMinorToBase(minor, d.rate, d.currency, baseCurrency);
    const scale = (d: Doc, base: bigint): bigint =>
      d.fraction ? scaleByFraction(base, d.fraction[0], d.fraction[1]) : base;

    if (src.headerOnly) {
      for (const h of headers) {
        const d = docs.get(str(h, "id"));
        if (!d) continue;
        const tax = big(h, "tax_minor");
        facts.push({
          side: src.side,
          sign: src.sign,
          treatment: null,
          recoverable: true,
          netBase: scale(d, toBase(d, big(h, "net_minor"))),
          taxBase: scale(d, toBase(d, tax)),
          coded: false,
        });
      }
      continue;
    }

    const lineSpec = src.lines!;
    const lineColumns = `id, ${lineSpec.fk}, net_minor, tax_minor${lineSpec.hasCode ? ", tax_code_id" : ""}${lineSpec.hasRate ? ", tax_rate_bps" : ""}`;
    for (const ids of chunks([...docs.keys()], CHUNK)) {
      const lines = await fetchAllPages<Row>((f, t) =>
        table(sb, lineSpec.table)
          .select(lineColumns)
          .eq("company_id", companyId)
          .in(lineSpec.fk, ids)
          .order("id")
          .range(f, t),
      );
      for (const line of lines) {
        const d = docs.get(str(line, lineSpec.fk));
        if (!d) continue;
        const codeId = lineSpec.hasCode ? str(line, "tax_code_id") : "";
        const code = codeId ? codes.get(codeId) : undefined;
        const netMinor = big(line, "net_minor");
        let taxMinor = big(line, "tax_minor");
        // Reverse charge on a bill: the supplier charged no tax, so the buyer works it out from
        // the net amount and the code's rate. It counts as output and input tax (TX-04).
        const selfAssessed =
          Boolean(lineSpec.hasRate) && isSelfAssessedReverseCharge(code?.treatment, taxMinor);
        if (selfAssessed) {
          taxMinor = reverseChargeTaxMinor(netMinor, Number(big(line, "tax_rate_bps")));
        }
        facts.push({
          side: src.side,
          sign: src.sign,
          treatment: code?.treatment ?? null,
          recoverable: code ? code.recoverable : true,
          netBase: scale(d, toBase(d, netMinor)),
          taxBase: scale(d, toBase(d, taxMinor)),
          coded: Boolean(code),
          ...(selfAssessed ? { selfAssessed: true } : {}),
        });
      }
    }
  }
  return { facts, documents, skippedNoRate };
}
