/**
 * Loads database rows for a document and shapes them with the pure mappers.
 * Runs on the server with the signed-in user's client, so row-level security still applies.
 * No environment access here.
 */
import {
  mapBranding,
  mapPurchaseBill,
  mapPurchaseCreditNote,
  mapPurchaseOrder,
  mapSalesCreditNote,
  mapSalesInvoice,
  mapSalesQuote,
  mapSalesReceipt,
  mapSupplierRemittance,
  type MapContext,
} from "@/lib/documents/mappers";
import type { DocumentBranding, DocumentKind, PrintDocument } from "@/lib/documents/types";
import { todayInTimezone } from "@/lib/sales/dates";
import type { SalesClient } from "@/lib/sales/rpc";
import type { Permission } from "@/lib/permissions";

type Row = Record<string, unknown>;
type Db = SalesClient;

const LOGO_BUCKET = "org-logos";

/** Permission needed to view a document kind. */
export function viewPermissionFor(kind: DocumentKind): Permission {
  return kind.startsWith("purchase_") || kind === "supplier_remittance"
    ? "purchases.view"
    : "sales.view";
}

/** Permission needed to send / share a document kind. */
export function sendPermissionFor(kind: DocumentKind): Permission {
  return kind.startsWith("purchase_") || kind === "supplier_remittance"
    ? "purchases.draft"
    : "sales.draft";
}

export type CompanyDocContext = {
  company: Row;
  branding: DocumentBranding;
  rawBranding: Row | null;
  locale: string;
  dateFormat: string | null;
  baseCurrency: string;
  timezone: string;
  today: string;
  isDemo: boolean;
};

async function one(
  db: Db,
  table: string,
  select: string,
  filters: Record<string, string>,
): Promise<Row | null> {
  let q = (db.from(table as never) as unknown as { select: (c: string) => unknown }).select(
    select,
  ) as {
    eq: (c: string, v: string) => unknown;
    maybeSingle: () => PromiseLike<{
      data: unknown;
      error: { message: string; code?: string } | null;
    }>;
  };
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v) as typeof q;
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Row | null) ?? null;
}

async function many(
  db: Db,
  table: string,
  select: string,
  filters: Record<string, string>,
): Promise<{ rows: Row[]; errorCode?: string | undefined; errorMessage?: string | undefined }> {
  let q = (db.from(table as never) as unknown as { select: (c: string) => unknown }).select(
    select,
  ) as {
    eq: (c: string, v: string) => unknown;
  } & PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v) as typeof q;
  const { data, error } = await q;
  if (error) return { rows: [], errorCode: error.code, errorMessage: error.message };
  return { rows: (data as Row[] | null) ?? [] };
}

/** Company, branding (with a signed logo URL) and locale settings. */
export async function loadCompanyDocContext(db: Db, companyId: string): Promise<CompanyDocContext> {
  const company = await one(
    db,
    "companies",
    "name, legal_name, base_currency, timezone, locale, date_format, invoice_footer, document_theme_color, is_demo",
    { id: companyId },
  );
  if (!company) throw new Error("Organisation not found");
  const branding = await one(db, "company_branding", "*", { company_id: companyId });

  let logoUrl: string | null = null;
  const logoPath =
    typeof branding?.["logo_path"] === "string" ? (branding["logo_path"] as string) : null;
  if (logoPath && logoPath.startsWith(`${companyId}/`)) {
    const { data } = await db.storage.from(LOGO_BUCKET).createSignedUrl(logoPath, 3600);
    logoUrl = data?.signedUrl ?? null;
  }
  const external =
    typeof branding?.["logo_url"] === "string" ? (branding["logo_url"] as string).trim() : "";
  if (!logoUrl && /^https:\/\/[^\s"'<>]+$/i.test(external)) logoUrl = external;

  const timezone = String(company["timezone"] ?? "UTC");
  return {
    company,
    branding: mapBranding(company, branding, logoUrl),
    rawBranding: branding,
    locale: String(company["locale"] ?? "en-GB"),
    dateFormat:
      typeof company["date_format"] === "string" ? (company["date_format"] as string) : null,
    baseCurrency: String(company["base_currency"] ?? "GBP").toUpperCase(),
    timezone,
    today: todayInTimezone(timezone),
    isDemo: Boolean(company["is_demo"]),
  };
}

export function mapContextFrom(ctx: CompanyDocContext): MapContext {
  return { baseCurrency: ctx.baseCurrency, companyTaxNumber: ctx.branding.taxNumber };
}

/** Load one document and map it. Throws "… not found" when it is not in the company. */
export async function loadPrintDocument(
  db: Db,
  companyId: string,
  kind: DocumentKind,
  id: string,
  ctx: CompanyDocContext,
): Promise<PrintDocument> {
  const mapCtx = mapContextFrom(ctx);
  const f = { id, company_id: companyId };
  const notFound = () => new Error("Document not found");

  switch (kind) {
    case "sales_invoice": {
      const row = await one(db, "sales_invoices", "*, contacts(*), sales_invoice_lines(*)", f);
      if (!row) throw notFound();
      return mapSalesInvoice(
        row,
        (row["sales_invoice_lines"] as Row[]) ?? [],
        (row["contacts"] as Row) ?? null,
        mapCtx,
      );
    }
    case "sales_credit_note": {
      const row = await one(
        db,
        "sales_credit_notes",
        "*, contacts(*), sales_credit_note_lines(*)",
        f,
      );
      if (!row) throw notFound();
      return mapSalesCreditNote(
        row,
        (row["sales_credit_note_lines"] as Row[]) ?? [],
        (row["contacts"] as Row) ?? null,
        mapCtx,
      );
    }
    case "sales_quote": {
      const row = await one(db, "sales_quotes", "*, contacts(*), sales_quote_lines(*)", f);
      if (!row) throw notFound();
      return mapSalesQuote(
        row,
        (row["sales_quote_lines"] as Row[]) ?? [],
        (row["contacts"] as Row) ?? null,
        mapCtx,
      );
    }
    case "sales_receipt": {
      const row = await one(
        db,
        "sales_receipts",
        "*, contacts(*), accounts:bank_account_id(name)",
        f,
      );
      if (!row) throw notFound();
      const rich = "amount_minor, reversed_on, sales_invoices(invoice_number, invoice_date)";
      const basic = "amount_minor, sales_invoices(invoice_number, invoice_date)";
      let alloc = await many(db, "sales_receipt_allocations", rich, {
        company_id: companyId,
        receipt_id: id,
      });
      if (alloc.errorCode === "42703") {
        alloc = await many(db, "sales_receipt_allocations", basic, {
          company_id: companyId,
          receipt_id: id,
        });
      }
      if (alloc.errorMessage) throw new Error(alloc.errorMessage);
      const allocations = alloc.rows
        .filter((a) => !a["reversed_on"])
        .map((a) => {
          const inv = (a["sales_invoices"] as Row | null) ?? null;
          return {
            invoiceNumber: (inv?.["invoice_number"] as string | null) ?? null,
            invoiceDate: (inv?.["invoice_date"] as string | null) ?? null,
            amountMinor: Number(a["amount_minor"] ?? 0),
          };
        });
      return mapSalesReceipt(
        row,
        allocations,
        (row["contacts"] as Row) ?? null,
        ((row["accounts"] as Row | null)?.["name"] as string | undefined) ?? null,
        mapCtx,
      );
    }
    case "purchase_bill": {
      const row = await one(db, "purchase_bills", "*, contacts(*), purchase_bill_lines(*)", f);
      if (!row) throw notFound();
      return mapPurchaseBill(
        row,
        (row["purchase_bill_lines"] as Row[]) ?? [],
        (row["contacts"] as Row) ?? null,
        mapCtx,
      );
    }
    case "purchase_order": {
      const row = await one(db, "purchase_orders", "*, contacts(*), purchase_order_lines(*)", f);
      if (!row) throw notFound();
      return mapPurchaseOrder(
        row,
        (row["purchase_order_lines"] as Row[]) ?? [],
        (row["contacts"] as Row) ?? null,
        mapCtx,
      );
    }
    case "purchase_credit_note": {
      const row = await one(
        db,
        "purchase_credit_notes",
        "*, contacts(*), purchase_credit_note_lines(*)",
        f,
      );
      if (!row) throw notFound();
      return mapPurchaseCreditNote(
        row,
        (row["purchase_credit_note_lines"] as Row[]) ?? [],
        (row["contacts"] as Row) ?? null,
        mapCtx,
      );
    }
    case "supplier_remittance": {
      const row = await one(
        db,
        "supplier_payments",
        "*, contacts(*), accounts:bank_account_id(name)",
        f,
      );
      if (!row) throw notFound();
      const alloc = await many(
        db,
        "supplier_payment_allocations",
        "amount_minor, purchase_bills(bill_number, supplier_invoice_number, bill_date)",
        { company_id: companyId, payment_id: id },
      );
      if (alloc.errorMessage) throw new Error(alloc.errorMessage);
      return mapSupplierRemittance(
        row,
        alloc.rows.map((a) => {
          const b = (a["purchase_bills"] as Row | null) ?? null;
          return {
            billNumber: (b?.["bill_number"] as string | null) ?? null,
            supplierInvoiceNumber: (b?.["supplier_invoice_number"] as string | null) ?? null,
            billDate: (b?.["bill_date"] as string | null) ?? null,
            amountMinor: Number(a["amount_minor"] ?? 0),
          };
        }),
        (row["contacts"] as Row) ?? null,
        ((row["accounts"] as Row | null)?.["name"] as string | undefined) ?? null,
        mapCtx,
      );
    }
  }
}
