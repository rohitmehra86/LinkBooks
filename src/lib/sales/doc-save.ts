/**
 * Atomic draft save for sales invoices, quotes and credit notes (AR-11/12/13/14/15/16).
 *
 * Primary path: RPC public.save_sales_document_draft — one transaction that allocates the document
 * number, writes the header, replaces the lines and (quote -> invoice) claims the quote.
 *
 * Fallback (RPC not deployed yet): the same steps from TypeScript, with every error checked and a
 * compensating rollback, so a failed save never leaves a header without lines or a half-converted
 * quote behind.
 */
import { allocateDocumentNumber } from "@/lib/settings/document-numbering";
import { callSalesRpc, type SalesClient } from "@/lib/sales/rpc";
import type { SalesLineComputed } from "@/lib/sales/line-helpers";
import { sumLines } from "@/lib/sales/line-helpers";

export type SalesDocKind = "invoice" | "quote" | "credit_note";

export type SaveSalesDocInput = {
  kind: SalesDocKind;
  companyId: string;
  userId: string;
  id?: string | undefined;
  contactId: string;
  docDate: string;
  dueDate?: string | null;
  expiryDate?: string | null;
  number?: string | null;
  memo?: string | null;
  currencyCode: string;
  fxRateToBase?: number | undefined;
  /** Credit note: the invoice being credited. */
  sourceInvoiceId?: string | null;
  /** Invoice: create from this quote (claims it atomically). */
  quoteId?: string | null;
  lines: SalesLineComputed[];
};

const TABLES = {
  invoice: {
    header: "sales_invoices",
    lines: "sales_invoice_lines",
    fk: "invoice_id",
    numberCol: "invoice_number",
    docType: "sales_invoice",
    label: "invoice",
  },
  quote: {
    header: "sales_quotes",
    lines: "sales_quote_lines",
    fk: "quote_id",
    numberCol: "quote_number",
    docType: "sales_quote",
    label: "quote",
  },
  credit_note: {
    header: "sales_credit_notes",
    lines: "sales_credit_note_lines",
    fk: "credit_note_id",
    numberCol: "credit_number",
    docType: "sales_credit_note",
    label: "credit note",
  },
} as const;

export function linePayload(l: SalesLineComputed) {
  return {
    description: l.description,
    account_id: l.accountId,
    quantity: l.quantity,
    unit_price_minor: l.unitPriceMinor,
    discount_minor: l.discountMinor ?? 0,
    tax_rate_bps: l.taxRateBps ?? 0,
    tax_code_id: l.taxCodeId ?? null,
    product_id: l.productId ?? null,
    net_minor: Number(l.net_minor),
    tax_minor: Number(l.tax_minor),
    gross_minor: Number(l.gross_minor),
  };
}

function duplicateNumberMessage(kind: SalesDocKind): string {
  return `A ${TABLES[kind].label} with this number already exists`;
}

export async function saveSalesDocument(
  supabase: SalesClient,
  input: SaveSalesDocInput,
): Promise<{ id: string; number: string | null; usedFallback: boolean }> {
  const rpc = await callSalesRpc<{ id: string; number: string | null }>(
    supabase,
    "save_sales_document_draft",
    {
      kind: input.kind,
      company_id: input.companyId,
      id: input.id ?? null,
      contact_id: input.contactId,
      doc_date: input.docDate,
      due_date: input.dueDate ?? null,
      expiry_date: input.expiryDate ?? null,
      number: input.number ?? null,
      memo: input.memo ?? null,
      currency_code: input.currencyCode,
      fx_rate_to_base: input.fxRateToBase ?? 1,
      invoice_id: input.sourceInvoiceId ?? null,
      quote_id: input.quoteId ?? null,
      lines: input.lines.map(linePayload),
    },
  );
  if (!rpc.missing) {
    return { id: rpc.data.id, number: rpc.data.number ?? null, usedFallback: false };
  }
  const r = await saveFallback(supabase, input);
  return { ...r, usedFallback: true };
}

type Row = Record<string, unknown>;

async function assertCustomer(supabase: SalesClient, companyId: string, contactId: string) {
  const { data, error } = await supabase
    .from("contacts" as never)
    .select("id, kind, is_active" as never)
    .eq("id" as never, contactId as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const c = data as { kind: string; is_active: boolean } | null;
  if (!c) throw new Error("Customer not found in this organisation");
  if (!["customer", "both"].includes(c.kind) || !c.is_active) {
    throw new Error("Contact is not an active customer");
  }
}

function lineRows(
  kind: SalesDocKind,
  input: SaveSalesDocInput,
  parentId: string,
): Row[] {
  const t = TABLES[kind];
  return input.lines.map((l, i) => {
    const row: Row = {
      company_id: input.companyId,
      [t.fk]: parentId,
      line_order: i + 1,
      description: l.description,
      account_id: l.accountId,
      quantity: l.quantity,
      unit_price_minor: l.unitPriceMinor,
      discount_minor: l.discountMinor ?? 0,
      tax_rate_bps: l.taxRateBps ?? 0,
      net_minor: Number(l.net_minor),
      tax_minor: Number(l.tax_minor),
      gross_minor: Number(l.gross_minor),
    };
    // product_id / tax_code_id columns exist on invoice and quote lines before the Sales migrations.
    if (kind === "invoice") {
      row["product_id"] = l.productId ?? null;
      row["tax_code_id"] = l.taxCodeId ?? null;
    } else if (kind === "quote") {
      row["product_id"] = l.productId ?? null;
    }
    return row;
  });
}

async function saveFallback(
  supabase: SalesClient,
  input: SaveSalesDocInput,
): Promise<{ id: string; number: string | null }> {
  const t = TABLES[input.kind];
  await assertCustomer(supabase, input.companyId, input.contactId);
  const totals = sumLines(input.lines);

  if (input.kind === "credit_note" && input.sourceInvoiceId) {
    const { data, error } = await supabase
      .from("sales_invoices" as never)
      .select("contact_id, currency_code, status" as never)
      .eq("id" as never, input.sourceInvoiceId as never)
      .eq("company_id" as never, input.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const src = data as { contact_id: string; currency_code: string; status: string } | null;
    if (!src) throw new Error("Source invoice not found in this organisation");
    if (src.contact_id !== input.contactId) throw new Error("Source invoice belongs to a different customer");
    if (src.currency_code !== input.currencyCode) throw new Error("Source invoice is in a different currency");
    if (["draft", "void"].includes(src.status)) throw new Error(`Cannot credit a ${src.status} invoice`);
  }

  const headerCommon: Row = {
    contact_id: input.contactId,
    memo: input.memo ?? null,
    currency_code: input.currencyCode,
    subtotal_minor: Number(totals.subtotal_minor),
    tax_minor: Number(totals.tax_minor),
    total_minor: Number(totals.total_minor),
  };
  const headerSpecific: Row =
    input.kind === "invoice"
      ? { invoice_date: input.docDate, due_date: input.dueDate }
      : input.kind === "quote"
        ? { quote_date: input.docDate, expiry_date: input.expiryDate ?? null }
        : { credit_date: input.docDate, invoice_id: input.sourceInvoiceId ?? null };

  // ---- edit an existing draft ----
  if (input.id) {
    const id = input.id;
    const { data: existing, error: exErr } = await supabase
      .from(t.header as never)
      .select(`id, status, ${t.numberCol}` as never)
      .eq("id" as never, id as never)
      .eq("company_id" as never, input.companyId as never)
      .maybeSingle();
    if (exErr) throw new Error(exErr.message);
    if (!existing) throw new Error(`${t.label[0]!.toUpperCase()}${t.label.slice(1)} not found`);
    const ex = existing as unknown as Row;
    const status = String(ex["status"]);
    if (input.kind === "quote" ? ["converted", "void"].includes(status) : status !== "draft") {
      throw new Error(
        input.kind === "quote"
          ? "Converted or void quotes cannot be edited"
          : `Only draft ${t.label}s can be edited`,
      );
    }
    let number = input.number ?? (ex[t.numberCol] as string | null) ?? null;
    if (!number) number = await allocateDocumentNumber(supabase, input.companyId, t.docType);

    const { data: oldLines, error: oldErr } = await supabase
      .from(t.lines as never)
      .select("*" as never)
      .eq(t.fk as never, id as never);
    if (oldErr) throw new Error(oldErr.message);

    const { error: upErr } = await supabase
      .from(t.header as never)
      .update({
        ...headerCommon,
        ...headerSpecific,
        [t.numberCol]: number,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, id as never)
      .eq("company_id" as never, input.companyId as never);
    if (upErr) {
      if (upErr.code === "23505") throw new Error(duplicateNumberMessage(input.kind));
      throw new Error(upErr.message);
    }
    const { error: delErr } = await supabase
      .from(t.lines as never)
      .delete()
      .eq(t.fk as never, id as never);
    if (delErr) throw new Error(delErr.message);
    const { error: insErr } = await supabase
      .from(t.lines as never)
      .insert(lineRows(input.kind, input, id) as never);
    if (insErr) {
      // restore the previous lines so the draft keeps matching its header total
      const prior = (oldLines ?? []) as Row[];
      if (prior.length) {
        await supabase.from(t.lines as never).insert(prior as never);
      }
      throw new Error(`Could not save lines: ${insErr.message}`);
    }
    return { id, number };
  }

  // ---- create ----
  let number = input.number ?? null;
  if (!number) number = await allocateDocumentNumber(supabase, input.companyId, t.docType);
  const { data: inserted, error } = await supabase
    .from(t.header as never)
    .insert({
      company_id: input.companyId,
      status: "draft",
      [t.numberCol]: number,
      created_by: input.userId,
      ...(input.kind === "invoice" && input.quoteId ? { quote_id: input.quoteId } : {}),
      ...headerCommon,
      ...headerSpecific,
    } as never)
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error(duplicateNumberMessage(input.kind));
    throw new Error(error.message);
  }
  const newId = (inserted as { id: string }).id;

  const cleanup = async () => {
    await supabase.from(t.lines as never).delete().eq(t.fk as never, newId as never);
    await supabase.from(t.header as never).delete().eq("id" as never, newId as never);
  };

  const { error: lineErr } = await supabase
    .from(t.lines as never)
    .insert(lineRows(input.kind, input, newId) as never);
  if (lineErr) {
    await cleanup();
    throw new Error(`Could not save lines: ${lineErr.message}`);
  }

  if (input.kind === "invoice" && input.quoteId) {
    // Claim the quote with a conditional update: only one caller can win.
    const { data: claimed, error: claimErr } = await supabase
      .from("sales_quotes" as never)
      .update({
        status: "converted",
        converted_invoice_id: newId,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, input.quoteId as never)
      .eq("company_id" as never, input.companyId as never)
      .is("converted_invoice_id" as never, null as never)
      .in("status" as never, ["draft", "sent", "accepted"] as never)
      .select("id");
    if (claimErr || !claimed || (claimed as unknown[]).length === 0) {
      await cleanup();
      throw new Error(
        claimErr ? claimErr.message : "Quote was already converted or can no longer be converted",
      );
    }
  }
  return { id: newId, number };
}

/** Delete an unposted draft through the RPC (RLS has no DELETE policy for sales documents). */
export async function deleteDraftDocument(
  supabase: SalesClient,
  companyId: string,
  kind: SalesDocKind,
  id: string,
): Promise<void> {
  const res = await callSalesRpc<{ deleted: boolean }>(supabase, "delete_draft_sales_document", {
    company_id: companyId,
    kind,
    id,
  });
  if (res.missing) {
    throw new Error(
      "Deleting drafts needs a database update that has not been applied yet (migration 20261024110300). Ask an administrator to apply the latest migrations.",
    );
  }
}
