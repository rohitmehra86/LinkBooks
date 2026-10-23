import { describe, expect, it } from "vitest";
import { loadTaxFacts } from "./tax-return-data";
import { computeReturnTotals } from "./vat-return";

type Row = Record<string, unknown>;

/** Minimal in-memory stand-in for the query builder used by loadTaxFacts. */
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(name: string) {
      let rows = [...(tables[name] ?? [])];
      const qb = {
        select: () => qb,
        eq: (c: string, v: unknown) => {
          rows = rows.filter((r) => r[c] === v);
          return qb;
        },
        in: (c: string, vs: unknown[]) => {
          rows = rows.filter((r) => vs.includes(r[c]));
          return qb;
        },
        gte: (c: string, v: unknown) => {
          rows = rows.filter((r) => String(r[c]) >= String(v));
          return qb;
        },
        lte: (c: string, v: unknown) => {
          rows = rows.filter((r) => String(r[c]) <= String(v));
          return qb;
        },
        order: () => qb,
        range: async (from: number, to: number) => ({
          data: rows.slice(from, to + 1),
          error: null,
        }),
      };
      return qb;
    },
  } as never;
}

const C = "co";
const baseTables = (): Record<string, Row[]> => ({
  tax_codes: [
    { id: "std", company_id: C, treatment: "standard", is_recoverable: true },
    { id: "rc", company_id: C, treatment: "reverse_charge", is_recoverable: true },
  ],
  sales_invoices: [
    {
      id: "inv1",
      company_id: C,
      invoice_date: "2026-09-10",
      currency_code: "GBP",
      status: "paid",
      posted_journal_id: "j1",
      total_minor: 12000,
    },
  ],
  sales_invoice_lines: [
    {
      id: "l1",
      company_id: C,
      invoice_id: "inv1",
      net_minor: 10000,
      tax_minor: 2000,
      tax_code_id: "std",
    },
  ],
  sales_receipts: [{ id: "r1", company_id: C, status: "posted", receipt_date: "2026-10-05" }],
  sales_receipt_allocations: [
    { id: "a1", company_id: C, invoice_id: "inv1", receipt_id: "r1", amount_minor: 12000 },
  ],
  purchase_bills: [
    {
      id: "b1",
      company_id: C,
      bill_date: "2026-10-02",
      currency_code: "GBP",
      status: "authorised",
      posted_journal_id: "j2",
      total_minor: 10000,
    },
  ],
  purchase_bill_lines: [
    {
      id: "bl1",
      company_id: C,
      bill_id: "b1",
      net_minor: 10000,
      tax_minor: 0,
      tax_code_id: "rc",
      tax_rate_bps: 2000,
    },
  ],
});

describe("loadTaxFacts", () => {
  it("self-assesses reverse charge on bills into output and input tax", async () => {
    const r = await loadTaxFacts(fakeDb(baseTables()), {
      companyId: C,
      from: "2026-10-01",
      to: "2026-10-31",
      basis: "accrual",
      baseCurrency: "GBP",
    });
    const totals = computeReturnTotals(r.facts);
    // The September invoice is outside an accrual October return.
    expect(totals.outputTax).toBe(2000n);
    expect(totals.inputTax).toBe(2000n);
    expect(totals.netTax).toBe(0n);
    expect(totals.counts.selfAssessed).toBe(1);
  });

  it("cash basis takes the invoice in the month it is paid", async () => {
    const accrual = await loadTaxFacts(fakeDb(baseTables()), {
      companyId: C,
      from: "2026-09-01",
      to: "2026-09-30",
      basis: "accrual",
      baseCurrency: "GBP",
    });
    expect(computeReturnTotals(accrual.facts).outputTax).toBe(2000n);

    const cashSep = await loadTaxFacts(fakeDb(baseTables()), {
      companyId: C,
      from: "2026-09-01",
      to: "2026-09-30",
      basis: "cash",
      baseCurrency: "GBP",
    });
    expect(computeReturnTotals(cashSep.facts).outputTax).toBe(0n);

    const cashOct = await loadTaxFacts(fakeDb(baseTables()), {
      companyId: C,
      from: "2026-10-01",
      to: "2026-10-31",
      basis: "cash",
      baseCurrency: "GBP",
    });
    const t = computeReturnTotals(cashOct.facts);
    // Invoice VAT 2000 (paid in October) + reverse charge 2000 (bill has no payment yet,
    // so on cash basis it is not counted until paid).
    expect(t.outputTax).toBe(2000n);
    expect(t.inputTax).toBe(0n);
  });

  it("legacy reverse-charge bills that carry tax stay input-only", async () => {
    const t = baseTables();
    t["purchase_bill_lines"] = [
      {
        id: "bl1",
        company_id: C,
        bill_id: "b1",
        net_minor: 10000,
        tax_minor: 2000,
        tax_code_id: "rc",
        tax_rate_bps: 2000,
      },
    ];
    const r = await loadTaxFacts(fakeDb(t), {
      companyId: C,
      from: "2026-10-01",
      to: "2026-10-31",
      basis: "accrual",
      baseCurrency: "GBP",
    });
    const totals = computeReturnTotals(r.facts);
    expect(totals.outputTax).toBe(0n + 0n);
    expect(totals.inputTax).toBe(2000n);
  });
});
