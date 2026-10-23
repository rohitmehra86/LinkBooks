import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentSheet } from "@/components/documents/DocumentSheet";
import type { DocumentBranding, PrintDocument } from "@/lib/documents/types";

const branding: DocumentBranding = {
  displayName: "Acme Trading",
  legalName: "Acme Ltd",
  addressLines: ["1 High Street", "London"],
  taxNumber: "GB123",
  email: "billing@acme.test",
  phone: null,
  logoUrl: "https://example.test/logo.png",
  accentColor: "#0F766E",
  footerText: "Thank you for your business",
  bankDetails: "Sort 00-00-00 Acc 12345678",
  paymentInstructions: null,
  defaultNotes: null,
  letterheadLine: null,
};

const doc: PrintDocument = {
  kind: "sales_invoice",
  id: "i1",
  title: "Tax invoice",
  number: "INV-7",
  status: "paid",
  mark: "PAID",
  currency: "EUR",
  fxRateToBase: 0.85,
  baseCurrency: "GBP",
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  expiryDate: null,
  reference: null,
  party: {
    roleLabel: "Bill to",
    name: "Customer <script>",
    addressLines: [],
    email: null,
    phone: null,
    taxNumber: null,
  },
  lines: [
    {
      description: "Widget",
      quantity: 2,
      unitPriceMinor: 5000,
      discountMinor: 0,
      taxRateBps: 2000,
      netMinor: 10000,
      taxMinor: 2000,
      grossMinor: 12000,
    },
  ],
  showLines: true,
  taxSummary: [{ rateBps: 2000, netMinor: 10000, taxMinor: 2000 }],
  totals: {
    subtotalMinor: 10000,
    taxMinor: 2000,
    totalMinor: 12000,
    paidMinor: 12000,
    creditedMinor: 0,
    dueMinor: 0,
  },
  allocations: [],
  allocationsTitle: null,
  paymentAmountMinor: null,
  extraMeta: [],
  notes: "Net 30",
  showPaymentDetails: true,
  paymentTermsText: "Payment due within 30 days",
  partyEmail: null,
  partyId: null,
};

function render(d: PrintDocument = doc, b: DocumentBranding = branding) {
  return renderToStaticMarkup(
    createElement(DocumentSheet, {
      document: d,
      branding: b,
      locale: "en-GB",
      dateFormat: "DD/MM/YYYY",
    }),
  );
}

describe("DocumentSheet", () => {
  it("prints branding, mark, tax summary and payment details", () => {
    const html = render();
    expect(html).toContain("Acme Trading");
    expect(html).toContain("https://example.test/logo.png");
    expect(html).toContain("PAID");
    expect(html).toContain("Tax summary");
    expect(html).toContain("Sort 00-00-00 Acc 12345678");
    expect(html).toContain("Thank you for your business");
    expect(html).toContain("01/10/2026");
  });

  it("formats multi-currency amounts in the document currency and shows the rate", () => {
    const html = render();
    expect(html).toContain("€120.00");
    expect(html).toContain("1 EUR = 0.85 GBP");
  });

  it("escapes party names", () => {
    const html = render();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits payment details on documents that should not show them", () => {
    const html = render({ ...doc, showPaymentDetails: false, mark: null });
    expect(html).not.toContain("Payment details");
    expect(html).not.toContain(">PAID<");
  });

  it("shows DRAFT and VOID marks", () => {
    expect(render({ ...doc, mark: "DRAFT" })).toContain("DRAFT");
    expect(render({ ...doc, mark: "VOID" })).toContain("VOID");
  });
});
