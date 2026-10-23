import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { postJournal } from "@/lib/accounting/posting-engine";
import { toMinorUnits } from "@/lib/accounting/money";
import type { Permission } from "@/lib/permissions";
import { callSalesRpc, requireRpc } from "@/lib/sales/rpc";
import { loadCompanyDefaults } from "@/lib/sales/sales-common";
import { validateAttachmentFile } from "@/lib/purchases/bill-form-helpers";
import type { BankAdjustmentType } from "@/lib/create-new/journal-contracts";

const KINDS = [
  "sales_receipt",
  "customer_refund",
  "supplier_refund",
  "receive_money",
  "bank_deposit",
  "card_payment",
  "bank_adjustment",
] as const;

type MoneyKind = (typeof KINDS)[number];

function permissionFor(kind: MoneyKind): Permission {
  if (kind === "sales_receipt" || kind === "customer_refund") return "sales.payment";
  if (kind === "supplier_refund") return "purchases.payment";
  return "banking.categorise";
}

function isoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  return value;
}

async function audit(
  supabase: Parameters<typeof assertCompanyPermission>[0],
  companyId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
) {
  await (
    supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
    }
  ).rpc("record_audit_event", {
    _company_id: companyId,
    _action: action,
    _entity_type: entityType,
    _entity_id: entityId,
    _details: details,
  });
}

export const saveMoneyDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      kind: MoneyKind;
      documentDate: string;
      idempotencyKey: string;
      currencyCode?: string;
      fxRateToBase?: number;
      contactId?: string;
      projectId?: string;
      bankAccountId?: string;
      counterAccountId?: string;
      settlement?: "bank" | "undeposited";
      amount?: string;
      taxAmount?: string;
      description?: string;
      reference?: string;
      memo?: string;
      adjustmentType?: BankAdjustmentType;
      sourceIds?: string[];
    }) => {
      const kind = input.kind;
      if (!KINDS.includes(kind)) throw new Error("Unknown money document");
      return {
        companyId: assertUuid(input.companyId),
        kind,
        documentDate: isoDate(input.documentDate, "Date"),
        idempotencyKey: (input.idempotencyKey ?? "").trim().slice(0, 80),
        currencyCode: (input.currencyCode ?? "").trim().toUpperCase(),
        fxRateToBase: Number(input.fxRateToBase ?? 1),
        contactId: input.contactId ? assertUuid(input.contactId, "contact") : null,
        projectId: input.projectId ? assertUuid(input.projectId, "project") : null,
        bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId, "bank account") : null,
        counterAccountId: input.counterAccountId
          ? assertUuid(input.counterAccountId, "account")
          : null,
        settlement: input.settlement === "undeposited" ? "undeposited" : "bank",
        amount: input.amount ?? "0",
        taxAmount: input.taxAmount ?? "0",
        description: (input.description ?? "").trim().slice(0, 240) || "Line",
        reference: (input.reference ?? "").trim().slice(0, 80) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        adjustmentType: input.adjustmentType ?? null,
        sourceIds: (input.sourceIds ?? []).map((id) => assertUuid(id, "receipt")),
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    if (!data.idempotencyKey) throw new Error("Idempotency key is required");
    if (!(data.fxRateToBase > 0)) throw new Error("Exchange rate must be positive");
    await assertCompanyPermission(supabase, data.companyId, permissionFor(data.kind));
    await assertCompanyPermission(supabase, data.companyId, "accounting.post");

    const defaults = await loadCompanyDefaults(supabase, data.companyId);
    const currency = data.currencyCode || defaults.baseCurrency;
    const net = toMinorUnits(data.amount, currency);
    const tax = toMinorUnits(data.taxAmount, currency);

    // One transaction in the database: validation, credit consumption (row locks), document, lines,
    // the journal (post_journal) and the link. Nothing is half-written when it fails.
    const rpc = await callSalesRpc<{ id: string; journal_id: string; replayed: boolean }>(
      supabase,
      "post_money_document",
      {
        company_id: data.companyId,
        kind: data.kind,
        document_date: data.documentDate,
        idempotency_key: data.idempotencyKey,
        currency_code: data.currencyCode || null,
        fx_rate_to_base: data.fxRateToBase,
        contact_id: data.contactId,
        project_id: data.projectId,
        bank_account_id: data.bankAccountId,
        counter_account_id: data.counterAccountId,
        settlement: data.settlement,
        net_minor: Number(net),
        tax_minor: Number(tax),
        description: data.description,
        reference: data.reference,
        memo: data.memo,
        adjustment_type: data.adjustmentType,
        source_ids: data.sourceIds,
      },
    );
    const done = requireRpc(rpc, "post_money_document", MONEY_DOC_MIGRATION);
    return { id: done.id, journalId: done.journal_id, replayed: Boolean(done.replayed) };
  });

const MONEY_DOC_MIGRATION = "20261025300100_ops_money_documents_rpcs.sql";

export const listUndepositedReceipts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "banking.view");
    const { data: rows, error } = await context.supabase
      .from("money_documents" as never)
      .select("id, kind, document_date, reference, total_minor, memo" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("deposit_status" as never, "undeposited" as never)
      .order("document_date" as never, { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const createProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      code: string;
      name: string;
      contactId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      description?: string;
      budget?: string;
      currencyCode?: string;
    }) => {
      const code = input.code.trim().slice(0, 40);
      const name = input.name.trim().slice(0, 160);
      if (!code || !name) throw new Error("Project code and name are required");
      const status = input.status ?? "active";
      if (!["draft", "active", "on_hold", "completed", "archived"].includes(status)) {
        throw new Error("Invalid project status");
      }
      return {
        companyId: assertUuid(input.companyId),
        code,
        name,
        contactId: input.contactId ? assertUuid(input.contactId, "customer") : null,
        status,
        startDate: input.startDate ? isoDate(input.startDate, "Start date") : null,
        endDate: input.endDate ? isoDate(input.endDate, "End date") : null,
        description: (input.description ?? "").trim().slice(0, 1000) || null,
        budgetMinor: input.budget
          ? Number(toMinorUnits(input.budget, input.currencyCode || "GBP"))
          : null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const { data: row, error } = await context.supabase
      .from("projects" as never)
      .insert({
        company_id: data.companyId,
        contact_id: data.contactId,
        code: data.code,
        name: data.name,
        status: data.status,
        start_date: data.startDate,
        end_date: data.endDate,
        description: data.description,
        budget_minor: data.budgetMinor,
        created_by: context.userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    await audit(context.supabase, data.companyId, "project.create", "project", id, {
      code: data.code,
    });
    return { id };
  });

export const uploadInboxDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      fileName: string;
      contentType?: string;
      contentBase64: string;
      sizeBytes: number;
      note?: string;
    }) => {
      const fileName = input.fileName.trim().slice(0, 255);
      const sizeBytes = Math.floor(Number(input.sizeBytes) || 0);
      const check = validateAttachmentFile({
        fileName,
        sizeBytes,
        contentType: input.contentType ?? null,
      });
      if (!check.ok) throw new Error(check.error);
      const contentBase64 = input.contentBase64.replace(/\s/g, "");
      if (!contentBase64) throw new Error("File content is required");
      return {
        companyId: assertUuid(input.companyId),
        fileName,
        contentType: (input.contentType ?? "").slice(0, 120) || null,
        contentBase64,
        sizeBytes,
        note: (input.note ?? "").trim().slice(0, 500) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "purchases.draft");
    const { data: inbox, error } = await supabase
      .from("inbox_documents" as never)
      .insert({
        company_id: data.companyId,
        file_name: data.fileName,
        content_type: data.contentType,
        size_bytes: data.sizeBytes,
        status: "inbox",
        scan_status: "not_scanned",
        note: data.note,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (inbox as { id: string }).id;
    const { error: fileError } = await supabase.from("document_attachments" as never).insert({
      company_id: data.companyId,
      entity_type: "inbox_document",
      entity_id: id,
      file_name: data.fileName,
      storage_path: `inline:${id}`,
      content_type: data.contentType,
      size_bytes: data.sizeBytes,
      content_base64: data.contentBase64,
      uploaded_by: userId,
    } as never);
    if (fileError) throw new Error(fileError.message);
    await audit(supabase, data.companyId, "inbox.upload", "inbox_document", id, {
      file_name: data.fileName,
      scan_status: "not_scanned",
    });
    return { id, scanStatus: "not_scanned" as const };
  });

export const saveRecurringJournalTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      name: string;
      startDate: string;
      endDate?: string;
      intervalMonths?: number;
      maxOccurrences?: number | null;
      memo?: string;
      lines: Array<{
        accountId: string;
        description?: string;
        debitMinor: number;
        creditMinor: number;
      }>;
    }) => {
      const name = input.name.trim().slice(0, 160);
      if (!name) throw new Error("Name is required");
      if (input.lines.length < 2) throw new Error("A journal needs at least two lines");
      return {
        companyId: assertUuid(input.companyId),
        name,
        startDate: isoDate(input.startDate, "Start date"),
        endDate: input.endDate ? isoDate(input.endDate, "End date") : null,
        intervalMonths: Math.min(12, Math.max(1, Math.floor(Number(input.intervalMonths) || 1))),
        maxOccurrences:
          input.maxOccurrences && Number(input.maxOccurrences) > 0
            ? Math.floor(Number(input.maxOccurrences))
            : null,
        memo: (input.memo ?? "").trim().slice(0, 240) || null,
        lines: input.lines.map((line) => ({
          accountId: assertUuid(line.accountId, "account"),
          description: (line.description ?? "").trim().slice(0, 240),
          debitMinor: Math.floor(Number(line.debitMinor) || 0),
          creditMinor: Math.floor(Number(line.creditMinor) || 0),
        })),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "journals.manual");
    const { assertLinesBalance } = await import("@/lib/accounting/money");
    assertLinesBalance(
      data.lines.map((line) => ({
        account_id: line.accountId,
        debit_minor: BigInt(line.debitMinor),
        credit_minor: BigInt(line.creditMinor),
        description: line.description,
      })),
    );
    const { data: row, error } = await context.supabase
      .from("recurring_journal_templates" as never)
      .insert({
        company_id: data.companyId,
        name: data.name,
        start_date: data.startDate,
        end_date: data.endDate,
        interval_months: data.intervalMonths,
        max_occurrences: data.maxOccurrences,
        memo: data.memo,
        next_date: data.startDate,
        is_active: true,
        lines: data.lines,
        created_by: context.userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    await audit(
      context.supabase,
      data.companyId,
      "recurring_journal.save",
      "recurring_journal",
      id,
      {
        posted: false,
      },
    );
    return { id, posted: false };
  });

export const generateRecurringJournal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; templateId: string }) => ({
    companyId: assertUuid(input.companyId),
    templateId: assertUuid(input.templateId, "template"),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "journals.manual");
    await assertCompanyPermission(supabase, data.companyId, "accounting.post");
    const rpc = await callSalesRpc<{ last_date: string | null }>(
      supabase,
      "post_recurring_journal_now",
      { company_id: data.companyId, template_id: data.templateId },
    );
    const done = requireRpc(rpc, "post_recurring_journal_now", RECURRING_JOURNAL_MIGRATION);
    return { occurrenceDate: done.last_date ?? "" };
  });

const RECURRING_JOURNAL_MIGRATION = "20261025300300_ops_recurring_journals.sql";

export const listMoneyDocuments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; kind?: string; limit?: number }) => ({
    companyId: assertUuid(input.companyId),
    kind: input.kind && (KINDS as readonly string[]).includes(input.kind) ? input.kind : null,
    limit: Math.min(500, Math.max(1, Math.floor(input.limit ?? 200))),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "banking.view");
    let query = context.supabase
      .from("money_documents" as never)
      .select(
        "id, kind, document_date, reference, memo, currency_code, total_minor, tax_minor, status, deposit_status, adjustment_type, posted_journal_id, void_journal_id, void_reason, contacts(name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("document_date" as never, { ascending: false })
      .order("created_at" as never, { ascending: false })
      .limit(data.limit);
    if (data.kind) query = query.eq("kind" as never, data.kind as never);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const voidMoneyDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; documentId: string; reason: string; voidDate?: string }) => {
      const reason = (input.reason ?? "").trim().slice(0, 300);
      if (!reason) throw new Error("A reason is required to void a document");
      return {
        companyId: assertUuid(input.companyId),
        documentId: assertUuid(input.documentId, "document"),
        reason,
        voidDate: input.voidDate ? isoDate(input.voidDate, "Void date") : null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const rpc = await callSalesRpc<{ id: string; void_journal_id: string }>(
      context.supabase,
      "void_money_document",
      {
        company_id: data.companyId,
        document_id: data.documentId,
        reason: data.reason,
        void_date: data.voidDate,
      },
    );
    const done = requireRpc(rpc, "void_money_document", MONEY_DOC_MIGRATION);
    return { id: done.id, voidJournalId: done.void_journal_id };
  });
