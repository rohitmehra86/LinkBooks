import { describe, expect, it } from "vitest";
import {
  addressLines,
  buildTaxSummary,
  daysOverdue,
  documentFileName,
  documentMark,
  formatQuantity,
  formatRatePercent,
  paymentTermsText,
  readableTextOn,
  safeAccentColor,
  textToLines,
} from "@/lib/documents/helpers";
import {
  mapBranding,
  mapPurchaseBill,
  mapPurchaseCreditNote,
  mapSalesCreditNote,
  mapSalesInvoice,
  mapSalesQuote,
  mapSalesReceipt,
  mapSupplierRemittance,
} from "@/lib/documents/mappers";
import { buildCustomerStatement, type StatementDoc } from "@/lib/sales/statement";

const ctx = { baseCurrency: "GBP", companyTaxNumber: "GB123" };

const lineRows = [
  {
    id: "l2",
    line_order: 2,
    description: "Zero rated",
    quantity: 1,
    unit_price_minor: 5000,
    discount_minor: 0,
    tax_rate_bps: 0,
    net_minor: 5000,
    tax_minor: 0,
    gross_minor: 5000,
  },
  {
    id: "l1",
    line_order: 1,
    description: "Widget",
    quantity: "2.000000",
    unit_price_minor: 10000,
    discount_minor: 0,
    tax_rate_bps: 2000,
    net_minor: 20000,
    tax_minor: 4000,
    gross_minor: 24000,
  },
  {
    id: "l3",
    line_order: 3,
    description: "Gadget",
    quantity: 1,
    unit_price_minor: 3333,
    discount_minor: 0,
    tax_rate_bps: 2000,
    net_minor: 3333,
    tax_minor: 667,
    gross_minor: 4000,
  },
];

describe("document helpers", () => {
  it("validates accent colours", () => {
    expect(safeAccentColor("#abcdef")).toBe("#ABCDEF");
    expect(safeAccentColor("red; background:url(x)")).toBe("#0F766E");
    expect(safeAccentColor(null)).toBe("#0F766E");
  });

  it("picks readable text on the accent", () => {
    expect(readableTextOn("#FFFFFF")).toBe("#000000");
    expect(readableTextOn("#000000")).toBe("#FFFFFF");
    expect(readableTextOn("#0F766E")).toBe("#FFFFFF");
  });

  it("groups the tax summary by rate and keeps totals exact", () => {
    const rows = buildTaxSummary(
      lineRows.map((l) => ({
        taxRateBps: l.tax_rate_bps,
        netMinor: l.net_minor,
        taxMinor: l.tax_minor,
      })),
    );
    expect(rows).toEqual([
      { rateBps: 2000, netMinor: 23333, taxMinor: 4667 },
      { rateBps: 0, netMinor: 5000, taxMinor: 0 },
    ]);
    expect(rows.reduce((s, r) => s + r.taxMinor, 0)).toBe(4667);
  });

  it("formats percentages and quantities", () => {
    expect(formatRatePercent(2000)).toBe("20%");
    expect(formatRatePercent(1250)).toBe("12.5%");
    expect(formatRatePercent(0)).toBe("0%");
    expect(formatQuantity("2.000000")).toBe("2");
    expect(formatQuantity(1.5)).toBe("1.5");
  });

  it("builds address lines", () => {
    expect(
      addressLines({
        line1: "1 High St",
        city: "Leeds",
        region: "WY",
        postal: "LS1 1AA",
        country: "UK",
      }),
    ).toEqual(["1 High St", "Leeds, WY LS1 1AA", "UK"]);
    expect(addressLines({})).toEqual([]);
    expect(textToLines(" a \n\n b ")).toEqual(["a", "b"]);
  });

  it("chooses the corner mark", () => {
    expect(
      documentMark({
        kind: "sales_invoice",
        status: "void",
        outstandingMinor: null,
        totalMinor: 100,
      }),
    ).toBe("VOID");
    expect(
      documentMark({
        kind: "sales_invoice",
        status: "draft",
        outstandingMinor: null,
        totalMinor: 100,
      }),
    ).toBe("DRAFT");
    expect(
      documentMark({ kind: "sales_invoice", status: "paid", outstandingMinor: 0, totalMinor: 100 }),
    ).toBe("PAID");
    expect(
      documentMark({
        kind: "sales_invoice",
        status: "authorised",
        outstandingMinor: 0,
        totalMinor: 100,
      }),
    ).toBe("PAID");
    expect(
      documentMark({
        kind: "sales_invoice",
        status: "authorised",
        outstandingMinor: 50,
        totalMinor: 100,
      }),
    ).toBeNull();
    expect(
      documentMark({
        kind: "sales_quote",
        status: "accepted",
        outstandingMinor: null,
        totalMinor: 100,
      }),
    ).toBeNull();
    expect(
      documentMark({
        kind: "sales_credit_note",
        status: "paid",
        outstandingMinor: null,
        totalMinor: 100,
      }),
    ).toBeNull();
  });

  it("derives payment terms and overdue days", () => {
    expect(paymentTermsText("2026-10-01", "2026-10-31")).toBe(
      "Payment terms: 30 days from the invoice date",
    );
    expect(paymentTermsText("2026-10-01", "2026-10-01")).toBe("Due on receipt");
    expect(paymentTermsText("2026-10-01", null)).toBeNull();
    expect(daysOverdue("2026-10-01", "2026-10-11")).toBe(10);
    expect(daysOverdue("2026-10-11", "2026-10-01")).toBe(0);
  });

  it("makes safe file names", () => {
    expect(documentFileName("Invoice", "INV/001 ", "abcdef12-0000")).toBe("Invoice-INV-001");
    expect(documentFileName("Quote", null, "abcdef12-0000")).toBe("Quote-abcdef12");
  });
});

describe("document mappers", () => {
  const customer = {
    name: "Acme Ltd",
    email: "ap@acme.test",
    tax_number: "GB999",
    billing_address_line1: "1 Road",
    billing_city: "Leeds",
  };

  it("maps an authorised, part-paid invoice", () => {
    const doc = mapSalesInvoice(
      {
        id: "i1",
        invoice_number: "INV-0001",
        invoice_date: "2026-10-01",
        due_date: "2026-10-31",
        currency_code: "EUR",
        fx_rate_to_base: 0.85,
        status: "partly_paid",
        subtotal_minor: 28333,
        tax_minor: 4667,
        total_minor: 33000,
        amount_paid_minor: 10000,
        amount_credited_minor: 3000,
        contact_id: "c1",
        memo: "Thanks",
      },
      lineRows,
      customer,
      ctx,
    );
    expect(doc.title).toBe("Tax invoice");
    expect(doc.lines.map((l) => l.description)).toEqual(["Widget", "Zero rated", "Gadget"]);
    expect(doc.lines[0]!.quantity).toBe(2);
    expect(doc.totals.dueMinor).toBe(20000);
    expect(doc.mark).toBeNull();
    expect(doc.fxRateToBase).toBe(0.85);
    expect(doc.party.addressLines).toEqual(["1 Road", "Leeds"]);
    expect(doc.taxSummary).toHaveLength(2);
    expect(doc.paymentTermsText).toBe("Payment terms: 30 days from the invoice date");
    expect(doc.showPaymentDetails).toBe(true);
  });

  it("titles an invoice plainly when the company has no tax number, hides FX for base currency", () => {
    const doc = mapSalesInvoice(
      {
        id: "i",
        invoice_number: null,
        invoice_date: "2026-10-01",
        due_date: "2026-10-31",
        currency_code: "GBP",
        fx_rate_to_base: 1,
        status: "draft",
        subtotal_minor: 0,
        tax_minor: 0,
        total_minor: 0,
        contact_id: "c",
      },
      [],
      customer,
      { baseCurrency: "GBP", companyTaxNumber: null },
    );
    expect(doc.title).toBe("Invoice");
    expect(doc.mark).toBe("DRAFT");
    expect(doc.fxRateToBase).toBeNull();
    expect(doc.totals.dueMinor).toBeNull();
  });

  it("marks a settled invoice PAID and a void one VOID", () => {
    const row = {
      id: "i",
      invoice_number: "INV-2",
      invoice_date: "2026-10-01",
      due_date: "2026-10-31",
      currency_code: "GBP",
      subtotal_minor: 100,
      tax_minor: 20,
      total_minor: 120,
      amount_paid_minor: 120,
      amount_credited_minor: 0,
      contact_id: "c",
    };
    expect(mapSalesInvoice({ ...row, status: "paid" }, [], customer, ctx).mark).toBe("PAID");
    expect(
      mapSalesInvoice({ ...row, status: "void", amount_paid_minor: 0 }, [], customer, ctx).mark,
    ).toBe("VOID");
  });

  it("maps credit note remaining credit", () => {
    const doc = mapSalesCreditNote(
      {
        id: "c",
        credit_number: "SCN-1",
        credit_date: "2026-10-02",
        currency_code: "GBP",
        status: "partly_paid",
        subtotal_minor: 1000,
        tax_minor: 200,
        total_minor: 1200,
        amount_allocated_minor: 400,
        contact_id: "c",
      },
      [],
      customer,
      ctx,
    );
    expect(doc.extraMeta).toEqual([{ label: "Credit remaining", amountMinor: 800 }]);
    expect(doc.totals.creditedMinor).toBe(400);
    expect(doc.showPaymentDetails).toBe(false);
  });

  it("maps a quote with an expiry", () => {
    const doc = mapSalesQuote(
      {
        id: "q",
        quote_number: "QU-1",
        quote_date: "2026-10-02",
        expiry_date: "2026-11-02",
        currency_code: "GBP",
        status: "sent",
        subtotal_minor: 100,
        tax_minor: 0,
        total_minor: 100,
        contact_id: "c",
      },
      lineRows,
      customer,
      ctx,
    );
    expect(doc.expiryDate).toBe("2026-11-02");
    expect(doc.totals.dueMinor).toBeNull();
    expect(doc.mark).toBeNull();
  });

  it("maps receipts and remittances with allocations", () => {
    const r = mapSalesReceipt(
      {
        id: "r",
        receipt_date: "2026-10-05",
        currency_code: "GBP",
        amount_minor: 5000,
        unallocated_minor: 1000,
        reference: "BACS-1",
        status: "posted",
        contact_id: "c",
      },
      [{ invoiceNumber: "INV-1", invoiceDate: "2026-10-01", amountMinor: 4000 }],
      customer,
      "Current account",
      ctx,
    );
    expect(r.showLines).toBe(false);
    expect(r.allocations).toEqual([
      { label: "Invoice INV-1", date: "2026-10-01", amountMinor: 4000 },
    ]);
    expect(r.extraMeta).toContainEqual({
      label: "Not yet applied to an invoice",
      amountMinor: 1000,
    });
    expect(r.paymentAmountMinor).toBe(5000);

    const rem = mapSupplierRemittance(
      {
        id: "p",
        payment_date: "2026-10-06",
        currency_code: "GBP",
        amount_minor: 7000,
        reference: "PAY-1",
        status: "authorised",
        contact_id: "s",
      },
      [
        {
          billNumber: "BILL-1",
          supplierInvoiceNumber: "S-77",
          billDate: "2026-09-20",
          amountMinor: 7000,
        },
      ],
      { name: "Supplier Co" },
      "Bank",
      ctx,
    );
    expect(rem.allocations[0]!.label).toBe("Your invoice S-77");
    expect(rem.party.roleLabel).toBe("Paid to");
  });

  it("maps purchase documents, using the bill's own supplier address first", () => {
    const bill = mapPurchaseBill(
      {
        id: "b",
        bill_number: "BILL-1",
        supplier_invoice_number: "S-1",
        bill_date: "2026-10-01",
        due_date: "2026-10-30",
        currency_code: "GBP",
        status: "authorised",
        subtotal_minor: 100,
        tax_minor: 20,
        total_minor: 120,
        amount_paid_minor: 0,
        amount_credited_minor: 0,
        supplier_address_line1: "9 Supplier Way",
        contact_id: "s",
      },
      [
        {
          line_no: 1,
          description: "Parts",
          quantity: 1,
          unit_price_minor: 100,
          discount_minor: 0,
          tax_rate_bps: 2000,
          net_minor: 100,
          tax_minor: 20,
        },
      ],
      { name: "Supplier Co", billing_address_line1: "Other" },
      ctx,
    );
    expect(bill.party.addressLines).toEqual(["9 Supplier Way"]);
    expect(bill.lines[0]!.grossMinor).toBe(120);
    expect(bill.totals.dueMinor).toBe(120);
    expect(bill.showPaymentDetails).toBe(false);
    expect(bill.reference).toBe("S-1");

    const credit = mapPurchaseCreditNote(
      {
        id: "pc",
        credit_number: "SC-1",
        credit_date: "2026-10-01",
        currency_code: "GBP",
        status: "authorised",
        subtotal_minor: 1000,
        tax_minor: 200,
        total_minor: 1200,
        amount_allocated_minor: 0,
        contact_id: "s",
      },
      [{ line_no: 1, description: "Return", net_minor: 1000, tax_minor: 200 }],
      { name: "Supplier Co" },
      ctx,
    );
    expect(credit.lines[0]!.taxRateBps).toBe(2000);
    expect(credit.taxSummary).toEqual([{ rateBps: 2000, netMinor: 1000, taxMinor: 200 }]);
  });

  it("maps branding with a safe accent and optional fields", () => {
    const b = mapBranding(
      { name: "Co", legal_name: "Co Ltd", document_theme_color: "bad", invoice_footer: "Reg 123" },
      {
        trading_name: "Brand",
        address_text: "1 St\nTown",
        tax_number: "VAT1",
        bank_details: "IBAN X",
      },
      "https://x/logo.png",
    );
    expect(b.displayName).toBe("Brand");
    expect(b.legalName).toBe("Co Ltd");
    expect(b.addressLines).toEqual(["1 St", "Town"]);
    expect(b.accentColor).toBe("#0F766E");
    expect(b.footerText).toBe("Reg 123");
    expect(b.bankDetails).toBe("IBAN X");
    expect(mapBranding(null, null, null).displayName).toBe("Your company");
  });
});

describe("statement running balance", () => {
  it("running balance equals opening + debits - credits and ends at the closing balance", () => {
    const docs: StatementDoc[] = [
      {
        kind: "invoice",
        id: "a",
        date: "2026-09-01",
        currencyCode: "GBP",
        amountMinor: 10000,
        reference: "INV-1",
        status: "authorised",
        voidDate: null,
      },
      {
        kind: "invoice",
        id: "b",
        date: "2026-10-02",
        currencyCode: "GBP",
        amountMinor: 5000,
        reference: "INV-2",
        status: "authorised",
        voidDate: null,
      },
      {
        kind: "receipt",
        id: "c",
        date: "2026-10-05",
        currencyCode: "GBP",
        amountMinor: 4000,
        reference: "R-1",
        status: "posted",
        voidDate: null,
      },
      {
        kind: "credit_note",
        id: "d",
        date: "2026-10-06",
        currencyCode: "GBP",
        amountMinor: 1000,
        reference: "CN-1",
        status: "authorised",
        voidDate: null,
      },
    ];
    const [gbp] = buildCustomerStatement(docs, { from: "2026-10-01", to: "2026-10-31" });
    expect(gbp!.opening_balance_minor).toBe(10000);
    let running = gbp!.opening_balance_minor;
    for (const l of gbp!.lines) {
      running += l.debit_minor - l.credit_minor;
      expect(l.balance_minor).toBe(running);
    }
    expect(gbp!.closing_balance_minor).toBe(10000 + 5000 - 4000 - 1000);
    expect(gbp!.closing_balance_minor).toBe(
      gbp!.opening_balance_minor + gbp!.total_debits_minor - gbp!.total_credits_minor,
    );
  });
});
