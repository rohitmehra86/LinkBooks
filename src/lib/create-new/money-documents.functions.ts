import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { postJournal, reverseJournal } from "@/lib/accounting/posting-engine";
import { toMinorUnits } from "@/lib/accounting/money";
import type { Permission } from "@/lib/permissions";
import { requireAccountByCode, requireAccountInCompany } from "@/lib/purchases/accounts";
import { resolveOutputTaxAccount } from "@/lib/tax/tax-accounts";
import { validateAttachmentFile } from "@/lib/purchases/bill-form-helpers";
import {
  bankAdjustmentJournal,
  bankDepositJournal,
  cardPaymentJournal,
  customerRefundJournal,
  receiveMoneyJournal,
  salesReceiptJournal,
  supplierRefundJournal,
  type BankAdjustmentType,
} from "@/lib/create-new/journal-contracts";

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
    const { supabase, userId } = context;
    if (!data.idempotencyKey) throw new Error("Idempotency key is required");
    if (!(data.fxRateToBase > 0)) throw new Error("Exchange rate must be positive");
    await assertCompanyPermission(supabase, data.companyId, permissionFor(data.kind));
    await assertCompanyPermission(supabase, data.companyId, "accounting.post");

    const existing = await supabase
      .from("money_documents" as never)
      .select("id, posted_journal_id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("idempotency_key" as never, data.idempotencyKey as never)
      .maybeSingle();
    if (existing.data) {
      const row = existing.data as { id: string; posted_journal_id: string | null };
      if (row.posted_journal_id) {
        return { id: row.id, journalId: row.posted_journal_id, replayed: true };
      }
      // A previous attempt stopped before posting. Remove the half-saved document and retry cleanly.
      await rollbackDocument(supabase, data.companyId, row.id);
    }

    const currency = data.currencyCode || "GBP";
    const net = toMinorUnits(data.amount, currency);
    const tax = toMinorUnits(data.taxAmount, currency);
    const total = net + tax;

    let journalLines;
    let totalMinor = total;
    let depositStatus: string | null = data.settlement === "undeposited" ? "undeposited" : null;
    const sourceUpdates: string[] = [];
    const sourceAmounts = new Map<string, number>();
    let creditUses: CreditUse[] = [];

    if (data.kind === "sales_receipt" || data.kind === "receive_money") {
      if (!data.bankAccountId || !data.counterAccountId)
        throw new Error("Choose the payment account and the income account");
      if (!data.contactId && data.kind === "sales_receipt") throw new Error("Choose a customer");
      await requireAccountInCompany(supabase, data.companyId, data.bankAccountId);
      await requireAccountInCompany(supabase, data.companyId, data.counterAccountId);
      const outputTax = await resolveOutputTaxAccount(supabase, data.companyId);
      const build = data.kind === "sales_receipt" ? salesReceiptJournal : receiveMoneyJournal;
      journalLines = build({
        settlementAccountId: data.bankAccountId,
        outputTaxAccountId: outputTax.id,
        lines: [
          {
            accountId: data.counterAccountId,
            netMinor: net,
            taxMinor: tax,
            description: data.description,
          },
        ],
      });
    } else if (data.kind === "customer_refund" || data.kind === "supplier_refund") {
      if (!data.contactId || !data.bankAccountId)
        throw new Error("Choose the contact and the bank account");
      if (net <= 0n) throw new Error("Refund must be greater than zero");
      await requireAccountInCompany(supabase, data.companyId, data.bankAccountId);
      const plan = await planCreditUses(supabase, data.companyId, data.kind, data.contactId, net);
      const available = plan.available;
      creditUses = plan.uses;
      if (data.kind === "customer_refund") {
        const ar = await requireAccountByCode(supabase, data.companyId, "1100");
        journalLines = customerRefundJournal({
          amountMinor: net,
          availableMinor: available,
          bankAccountId: data.bankAccountId,
          creditBalanceAccountId: ar.id,
        });
      } else {
        const ap = await requireAccountByCode(supabase, data.companyId, "2000");
        journalLines = supplierRefundJournal({
          amountMinor: net,
          availableMinor: available,
          bankAccountId: data.bankAccountId,
          payableAccountId: ap.id,
        });
      }
      totalMinor = net;
      depositStatus = null;
    } else if (data.kind === "bank_deposit") {
      if (!data.bankAccountId) throw new Error("Choose the bank account");
      if (data.sourceIds.length === 0) throw new Error("Select at least one undeposited receipt");
      const { data: sources, error } = await supabase
        .from("money_documents" as never)
        .select("id, bank_account_id, total_minor, deposit_status, kind" as never)
        .eq("company_id" as never, data.companyId as never)
        .in("id" as never, data.sourceIds as never);
      if (error) throw new Error(error.message);
      const rows = (sources ?? []) as Array<{
        id: string;
        bank_account_id: string;
        total_minor: number;
        deposit_status: string | null;
        kind: string;
      }>;
      if (rows.length !== data.sourceIds.length)
        throw new Error("A selected receipt was not found");
      journalLines = bankDepositJournal({
        bankAccountId: data.bankAccountId,
        items: rows.map((row) => ({
          id: row.id,
          undepositedAccountId: row.bank_account_id,
          amountMinor: BigInt(row.total_minor),
          alreadyDeposited: row.deposit_status === "deposited",
        })),
      });
      totalMinor = rows.reduce((sum, row) => sum + BigInt(row.total_minor), 0n);
      depositStatus = null;
      for (const row of rows) sourceAmounts.set(row.id, Number(row.total_minor));
      sourceUpdates.push(...rows.map((row) => row.id));
    } else if (data.kind === "card_payment") {
      if (!data.bankAccountId || !data.counterAccountId)
        throw new Error("Choose the bank and the credit card");
      const types = await accountTypes(supabase, data.companyId, [
        data.bankAccountId,
        data.counterAccountId,
      ]);
      journalLines = cardPaymentJournal({
        amountMinor: net,
        bankAccountId: data.bankAccountId,
        liabilityAccountId: data.counterAccountId,
        bankAccountType: types.get(data.bankAccountId) ?? "",
        liabilityAccountType: types.get(data.counterAccountId) ?? "",
      });
      totalMinor = net;
      depositStatus = null;
    } else {
      if (!data.bankAccountId || !data.counterAccountId || !data.adjustmentType) {
        throw new Error("Choose the bank, the offset account, and the adjustment type");
      }
      await requireAccountInCompany(supabase, data.companyId, data.bankAccountId);
      await requireAccountInCompany(supabase, data.companyId, data.counterAccountId);
      journalLines = bankAdjustmentJournal({
        adjustmentType: data.adjustmentType,
        amountMinor: net,
        bankAccountId: data.bankAccountId,
        counterAccountId: data.counterAccountId,
      });
      totalMinor = net;
      depositStatus = null;
    }

    if (totalMinor <= 0n) throw new Error("Amount must be greater than zero");

    const { data: inserted, error: insertError } = await supabase
      .from("money_documents" as never)
      .insert({
        company_id: data.companyId,
        kind: data.kind,
        contact_id: data.contactId,
        project_id: data.projectId,
        document_date: data.documentDate,
        reference: data.reference,
        memo: data.memo,
        currency_code: currency,
        fx_rate_to_base: data.fxRateToBase,
        bank_account_id: data.bankAccountId,
        counter_account_id: data.counterAccountId,
        settlement: data.settlement,
        total_minor: Number(totalMinor),
        tax_minor: Number(tax),
        status: "posted",
        deposit_status: depositStatus,
        adjustment_type: data.adjustmentType,
        idempotency_key: data.idempotencyKey,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);
    const id = (inserted as { id: string }).id;

    let committed = false;
    try {
      if (data.kind === "sales_receipt" || data.kind === "receive_money") {
        const { error: lineError } = await supabase.from("money_document_lines" as never).insert({
          company_id: data.companyId,
          document_id: id,
          line_no: 1,
          description: data.description,
          account_id: data.counterAccountId,
          net_minor: Number(net),
          tax_minor: Number(tax),
          project_id: data.projectId,
        } as never);
        if (lineError) throw new Error(lineError.message);
      }

      if (data.kind === "bank_deposit") {
        for (const sourceId of sourceUpdates) {
          const { data: claimed, error: claimError } = await supabase
            .from("money_documents" as never)
            .update({ deposit_status: "deposited", deposited_in_id: id } as never)
            .eq("id" as never, sourceId as never)
            .eq("company_id" as never, data.companyId as never)
            .eq("deposit_status" as never, "undeposited" as never)
            .select("id");
          if (claimError) throw new Error(claimError.message);
          if (!claimed || (claimed as unknown[]).length === 0) {
            throw new Error("A selected receipt is already deposited");
          }
          const { error: itemError } = await supabase.from("money_deposit_items" as never).insert({
            company_id: data.companyId,
            deposit_id: id,
            source_document_id: sourceId,
            amount_minor: sourceAmounts.get(sourceId) ?? 0,
          } as never);
          if (itemError) throw new Error(itemError.message);
        }
      }

      await applyCreditUses(supabase, data.companyId, id, creditUses);

      const { journalId } = await postJournal(supabase, {
        company_id: data.companyId,
        journal_date: data.documentDate,
        memo: data.memo ?? data.description,
        currency_code: currency,
        fx_rate_to_base: data.fxRateToBase,
        source_type: "other",
        source_id: id,
        idempotency_key: `money_document:${data.idempotencyKey}`,
        lines: journalLines,
      });

      const { error: linkError } = await supabase
        .from("money_documents" as never)
        .update({ posted_journal_id: journalId } as never)
        .eq("id" as never, id as never)
        .eq("company_id" as never, data.companyId as never);
      if (linkError) {
        // The journal posted but the document could not point at it. Reverse so the ledger stays clean.
        await reverseJournal(
          supabase,
          journalId,
          `money_document:${data.idempotencyKey}:link-failed`,
        ).catch(() => undefined);
        throw new Error(linkError.message);
      }
      committed = true;

      await audit(supabase, data.companyId, `money_document.${data.kind}`, "money_document", id, {
        journal_id: journalId,
        total_minor: Number(totalMinor),
      });
      return { id, journalId, replayed: false };
    } catch (error) {
      if (!committed) await rollbackDocument(supabase, data.companyId, id);
      throw error;
    }
  });

type CreditUse = {
  kind: "sales_credit_note" | "purchase_credit_note" | "sales_receipt";
  id: string;
  amount: bigint;
};

type DbClient = Parameters<typeof assertCompanyPermission>[0];

/**
 * Works out which credits a refund consumes (oldest first). The refund uses the
 * credit up, so the same credit cannot also be applied to an invoice or bill.
 */
async function planCreditUses(
  supabase: DbClient,
  companyId: string,
  kind: "customer_refund" | "supplier_refund",
  contactId: string,
  amount: bigint,
): Promise<{ available: bigint; uses: CreditUse[] }> {
  const creditTable = kind === "customer_refund" ? "sales_credit_notes" : "purchase_credit_notes";
  const { data: credits, error } = await supabase
    .from(creditTable as never)
    .select("id, total_minor, amount_allocated_minor, credit_date" as never)
    .eq("company_id" as never, companyId as never)
    .eq("contact_id" as never, contactId as never)
    .eq("status" as never, "authorised" as never)
    .order("credit_date" as never, { ascending: true });
  if (error) throw new Error(error.message);
  const pools: Array<{ kind: CreditUse["kind"]; id: string; remaining: bigint }> = [];
  for (const row of (credits ?? []) as Array<{
    id: string;
    total_minor: number;
    amount_allocated_minor: number;
  }>) {
    const remaining = BigInt(row.total_minor) - BigInt(row.amount_allocated_minor);
    if (remaining > 0n) {
      pools.push({
        kind: kind === "customer_refund" ? "sales_credit_note" : "purchase_credit_note",
        id: row.id,
        remaining,
      });
    }
  }
  if (kind === "customer_refund") {
    const { data: receipts, error: receiptError } = await supabase
      .from("sales_receipts" as never)
      .select("id, unallocated_minor, receipt_date" as never)
      .eq("company_id" as never, companyId as never)
      .eq("contact_id" as never, contactId as never)
      .eq("status" as never, "posted" as never)
      .gt("unallocated_minor" as never, 0 as never)
      .order("receipt_date" as never, { ascending: true });
    if (receiptError) throw new Error(receiptError.message);
    for (const row of (receipts ?? []) as Array<{ id: string; unallocated_minor: number }>) {
      pools.push({ kind: "sales_receipt", id: row.id, remaining: BigInt(row.unallocated_minor) });
    }
  }
  const available = pools.reduce((sum, pool) => sum + pool.remaining, 0n);
  const uses: CreditUse[] = [];
  let left = amount;
  for (const pool of pools) {
    if (left <= 0n) break;
    const take = pool.remaining < left ? pool.remaining : left;
    uses.push({ kind: pool.kind, id: pool.id, amount: take });
    left -= take;
  }
  return { available, uses };
}

function creditUseTable(kind: CreditUse["kind"]) {
  if (kind === "sales_credit_note")
    return { table: "sales_credit_notes", column: "amount_allocated_minor", sign: 1 };
  if (kind === "purchase_credit_note")
    return { table: "purchase_credit_notes", column: "amount_allocated_minor", sign: 1 };
  return { table: "sales_receipts", column: "unallocated_minor", sign: -1 };
}

/** Adjust a credit balance only if nobody changed it since we read it. */
async function adjustCreditBalance(
  supabase: DbClient,
  companyId: string,
  use: { kind: CreditUse["kind"]; id: string; amount: bigint },
  direction: 1 | -1,
) {
  const target = creditUseTable(use.kind);
  const { data: row, error } = await supabase
    .from(target.table as never)
    .select(target.column as never)
    .eq("id" as never, use.id as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("A credit used by this refund no longer exists");
  const current = BigInt((row as unknown as Record<string, number>)[target.column] ?? 0);
  const next = current + BigInt(target.sign * direction) * use.amount;
  if (next < 0n) throw new Error("The customer or supplier credit has already been used");
  const { data: updated, error: updateError } = await supabase
    .from(target.table as never)
    .update({ [target.column]: Number(next) } as never)
    .eq("id" as never, use.id as never)
    .eq("company_id" as never, companyId as never)
    .eq(target.column as never, Number(current) as never)
    .select("id");
  if (updateError) throw new Error(updateError.message);
  if (!updated || (updated as unknown[]).length === 0) {
    throw new Error("The credit balance changed while saving. Try again.");
  }
}

async function applyCreditUses(
  supabase: DbClient,
  companyId: string,
  documentId: string,
  uses: CreditUse[],
) {
  for (const use of uses) {
    await adjustCreditBalance(supabase, companyId, use, 1);
    const { error } = await supabase.from("money_document_credit_uses" as never).insert({
      company_id: companyId,
      document_id: documentId,
      source_kind: use.kind,
      source_id: use.id,
      amount_minor: Number(use.amount),
    } as never);
    if (error) throw new Error(error.message);
  }
}

async function restoreCreditUses(supabase: DbClient, companyId: string, documentId: string) {
  const { data, error } = await supabase
    .from("money_document_credit_uses" as never)
    .select("id, source_kind, source_id, amount_minor" as never)
    .eq("company_id" as never, companyId as never)
    .eq("document_id" as never, documentId as never);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{
    id: string;
    source_kind: CreditUse["kind"];
    source_id: string;
    amount_minor: number;
  }>) {
    await adjustCreditBalance(
      supabase,
      companyId,
      { kind: row.source_kind, id: row.source_id, amount: BigInt(row.amount_minor) },
      -1,
    );
    await supabase
      .from("money_document_credit_uses" as never)
      .delete()
      .eq("id" as never, row.id as never)
      .eq("company_id" as never, companyId as never);
  }
}

/** Best-effort cleanup of a document that never reached the ledger. Never touches posted journals. */
async function rollbackDocument(supabase: DbClient, companyId: string, documentId: string) {
  try {
    await restoreCreditUses(supabase, companyId, documentId);
    await supabase
      .from("money_documents" as never)
      .update({ deposit_status: "undeposited", deposited_in_id: null } as never)
      .eq("company_id" as never, companyId as never)
      .eq("deposited_in_id" as never, documentId as never);
    await supabase
      .from("money_deposit_items" as never)
      .delete()
      .eq("company_id" as never, companyId as never)
      .eq("deposit_id" as never, documentId as never);
    await supabase
      .from("money_document_lines" as never)
      .delete()
      .eq("company_id" as never, companyId as never)
      .eq("document_id" as never, documentId as never);
    await supabase
      .from("money_documents" as never)
      .delete()
      .eq("company_id" as never, companyId as never)
      .eq("id" as never, documentId as never)
      .is("posted_journal_id" as never, null as never);
  } catch {
    // Cleanup is best-effort. A leftover unposted document is removed on the next retry.
  }
}

async function accountTypes(
  supabase: Parameters<typeof assertCompanyPermission>[0],
  companyId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("accounts" as never)
    .select("id, account_type" as never)
    .eq("company_id" as never, companyId as never)
    .in("id" as never, ids as never);
  if (error) throw new Error(error.message);
  return new Map(
    ((data ?? []) as Array<{ id: string; account_type: string }>).map((row) => [
      row.id,
      row.account_type,
    ]),
  );
}

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
    const { data: template, error } = await supabase
      .from("recurring_journal_templates" as never)
      .select("id, name, next_date, end_date, is_active, lines" as never)
      .eq("id" as never, data.templateId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!template) throw new Error("Recurring journal not found");
    const row = template as {
      name: string;
      next_date: string;
      end_date: string | null;
      is_active: boolean;
      lines: Array<{
        accountId: string;
        description?: string;
        debitMinor: number;
        creditMinor: number;
      }>;
    };
    if (!row.is_active) throw new Error("This recurring journal is paused");
    if (row.end_date && row.next_date > row.end_date) throw new Error("This schedule has ended");
    const key = `recurring_journal:${data.templateId}:${row.next_date}`;
    const { journalId } = await postJournal(supabase, {
      company_id: data.companyId,
      journal_date: row.next_date,
      memo: row.name,
      source_type: "manual",
      source_id: data.templateId,
      idempotency_key: key,
      lines: row.lines.map((line) => ({
        account_id: line.accountId,
        description: line.description ?? row.name,
        debit_minor: BigInt(line.debitMinor),
        credit_minor: BigInt(line.creditMinor),
      })),
    });
    const { error: occError } = await supabase
      .from("recurring_journal_occurrences" as never)
      .insert({
        company_id: data.companyId,
        template_id: data.templateId,
        occurrence_date: row.next_date,
        journal_id: journalId,
      } as never);
    if (occError && !occError.message.toLowerCase().includes("duplicate"))
      throw new Error(occError.message);
    const next = addMonths(row.next_date, 1);
    await supabase
      .from("recurring_journal_templates" as never)
      .update({ next_date: next, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, data.templateId as never)
      .eq("company_id" as never, data.companyId as never);
    return { journalId, occurrenceDate: row.next_date };
  });

function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1 + months, 1));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const clamped = Math.min(day!, last);
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), clamped));
  return result.toISOString().slice(0, 10);
}

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
  .inputValidator((input: { companyId: string; documentId: string; reason: string }) => {
    const reason = (input.reason ?? "").trim().slice(0, 300);
    if (!reason) throw new Error("A reason is required to void a document");
    return {
      companyId: assertUuid(input.companyId),
      documentId: assertUuid(input.documentId, "document"),
      reason,
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: doc, error } = await supabase
      .from("money_documents" as never)
      .select("id, kind, status, deposit_status, posted_journal_id" as never)
      .eq("id" as never, data.documentId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!doc) throw new Error("Document not found");
    const row = doc as {
      id: string;
      kind: MoneyKind;
      status: string;
      deposit_status: string | null;
      posted_journal_id: string | null;
    };
    await assertCompanyPermission(supabase, data.companyId, permissionFor(row.kind));
    await assertCompanyPermission(supabase, data.companyId, "accounting.post");
    if (row.status === "void") throw new Error("This document is already void");
    if (!row.posted_journal_id) throw new Error("This document was never posted");
    if (row.deposit_status === "deposited") {
      throw new Error("This receipt has been banked. Void the bank deposit first.");
    }

    // Reverse the ledger first. A locked period rejects here and nothing else changes.
    const { journalId: voidJournalId } = await reverseJournal(
      supabase,
      row.posted_journal_id,
      `money_document:${row.id}:void`,
    );

    if (row.kind === "bank_deposit") {
      const { error: unclaimError } = await supabase
        .from("money_documents" as never)
        .update({ deposit_status: "undeposited", deposited_in_id: null } as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("deposited_in_id" as never, row.id as never);
      if (unclaimError) throw new Error(unclaimError.message);
      await supabase
        .from("money_deposit_items" as never)
        .delete()
        .eq("company_id" as never, data.companyId as never)
        .eq("deposit_id" as never, row.id as never);
    }
    if (row.kind === "customer_refund" || row.kind === "supplier_refund") {
      await restoreCreditUses(supabase, data.companyId, row.id);
    }

    const { error: updateError } = await supabase
      .from("money_documents" as never)
      .update({
        status: "void",
        deposit_status:
          row.kind === "sales_receipt" || row.kind === "receive_money" ? null : undefined,
        void_journal_id: voidJournalId,
        voided_at: new Date().toISOString(),
        voided_by: userId,
        void_reason: data.reason,
      } as never)
      .eq("id" as never, row.id as never)
      .eq("company_id" as never, data.companyId as never);
    if (updateError) throw new Error(updateError.message);
    await audit(
      supabase,
      data.companyId,
      `money_document.${row.kind}.void`,
      "money_document",
      row.id,
      {
        void_journal_id: voidJournalId,
        reason: data.reason,
      },
    );
    return { id: row.id, voidJournalId };
  });
