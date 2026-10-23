import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import {
  coerceMapping,
  contentKey,
  findLikelyDuplicates,
  sha256Hex,
  type ImportMapping,
  type KeyedBankRow,
} from "@/lib/banking/csv-mapping";
import { chunk, fetchAllPages } from "@/lib/banking/fetch-all";
import { isMissingSchema } from "@/lib/banking/rpc";
import { loadBankAccount, type AnyClient } from "@/lib/banking/server-helpers";

const MAX_IMPORT_ROWS = 20000;
const INSERT_CHUNK = 500;

export type ImportRowInput = {
  rowNumber: number;
  txnDate: string;
  amountMinor: number;
  description: string;
  reference: string | null;
  payee: string | null;
  externalId: string;
  /** Import a row that looks like a duplicate anyway (confirmed by the user). */
  force?: boolean;
};

function validateRows(rows: unknown): ImportRowInput[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("There are no rows to import");
  if (rows.length > MAX_IMPORT_ROWS)
    throw new Error(`At most ${MAX_IMPORT_ROWS} rows can be imported at once`);
  return rows.map((raw, i) => {
    const r = raw as Partial<ImportRowInput>;
    if (typeof r.txnDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.txnDate)) {
      throw new Error(`Row ${i + 1}: invalid date`);
    }
    const amount = Number(r.amountMinor);
    if (!Number.isSafeInteger(amount) || amount === 0)
      throw new Error(`Row ${i + 1}: invalid amount`);
    if (typeof r.externalId !== "string" || !r.externalId)
      throw new Error(`Row ${i + 1}: missing id`);
    return {
      rowNumber: Number.isInteger(r.rowNumber) ? Number(r.rowNumber) : i + 1,
      txnDate: r.txnDate,
      amountMinor: amount,
      description: String(r.description ?? "").slice(0, 500),
      reference: r.reference ? String(r.reference).slice(0, 120) : null,
      payee: r.payee ? String(r.payee).slice(0, 200) : null,
      externalId: r.externalId.slice(0, 200),
      force: r.force === true,
    };
  });
}

/** Saved column mapping for this bank account (null when none, or when the table is not installed yet). */
export const getBankImportMapping = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId: string }) => ({
    companyId: assertUuid(input.companyId),
    bankAccountId: assertUuid(input.bankAccountId),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const { data: row, error } = await supabase
      .from("bank_import_mappings" as never)
      .select("mapping" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("bank_account_id" as never, data.bankAccountId as never)
      .maybeSingle();
    if (error) {
      if (isMissingSchema(error))
        return { mapping: null as ImportMapping | null, available: false };
      throw new Error(error.message);
    }
    const mapping = row ? coerceMapping((row as unknown as { mapping: unknown }).mapping) : null;
    return { mapping, available: true };
  });

export const saveBankImportMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId: string; mapping: ImportMapping }) => {
    const mapping = coerceMapping(input.mapping);
    if (!mapping) throw new Error("Invalid column mapping");
    return {
      companyId: assertUuid(input.companyId),
      bankAccountId: assertUuid(input.bankAccountId),
      mapping,
    };
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.import");
    await loadBankAccount(supabase, data.companyId, data.bankAccountId);
    const { error } = await supabase.from("bank_import_mappings" as never).upsert(
      {
        company_id: data.companyId,
        bank_account_id: data.bankAccountId,
        mapping: data.mapping,
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "company_id,bank_account_id" },
    );
    if (error) {
      // Table not installed yet: the browser keeps the mapping in localStorage instead.
      if (isMissingSchema(error)) return { saved: false, reason: "unavailable" as const };
      throw new Error(error.message);
    }
    return { saved: true as const, reason: null };
  });

/** Which rows of this file look like they were already imported (same id, or same date+amount+description). */
export const previewBankImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; bankAccountId: string; rows: ImportRowInput[] }) => ({
      companyId: assertUuid(input.companyId),
      bankAccountId: assertUuid(input.bankAccountId),
      rows: validateRows(input.rows),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.import");
    await loadBankAccount(supabase, data.companyId, data.bankAccountId);

    const existingIds = new Set<string>();
    for (const part of chunk(
      data.rows.map((r) => r.externalId),
      150,
    )) {
      const { data: found, error } = await supabase
        .from("bank_transactions" as never)
        .select("external_id" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("bank_account_id" as never, data.bankAccountId as never)
        .in("external_id" as never, part as never);
      if (error) throw new Error(error.message);
      for (const r of (found ?? []) as unknown as Array<{ external_id: string }>)
        existingIds.add(r.external_id);
    }

    const dates = data.rows.map((r) => r.txnDate).sort();
    const from = dates[0]!;
    const to = dates[dates.length - 1]!;
    const existing = await fetchAllPages<{
      txn_date: string;
      amount_minor: number;
      description: string | null;
    }>(
      (a, b) =>
        supabase
          .from("bank_transactions" as never)
          .select("id, txn_date, amount_minor, description" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("bank_account_id" as never, data.bankAccountId as never)
          .gte("txn_date" as never, from as never)
          .lte("txn_date" as never, to as never)
          .order("txn_date" as never)
          .order("id" as never)
          .range(a, b) as never,
    );
    const contentCounts = new Map<string, number>();
    for (const e of existing) {
      const key = contentKey(e.txn_date, e.amount_minor, e.description ?? "");
      contentCounts.set(key, (contentCounts.get(key) ?? 0) + 1);
    }

    const keyed: KeyedBankRow[] = data.rows.map((r) => ({
      rowNumber: r.rowNumber,
      txnDate: r.txnDate,
      amountMinor: BigInt(r.amountMinor),
      description: r.description,
      reference: r.reference,
      payee: r.payee,
      bankId: null,
      balanceMinor: null,
      groupKey: "",
      ordinal: 0,
      externalId: r.externalId,
    }));
    const duplicates = findLikelyDuplicates(keyed, { externalIds: existingIds, contentCounts });
    return { duplicates, existingInRange: existing.length };
  });

export const importBankStatement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankAccountId: string;
      filename: string;
      rows: ImportRowInput[];
      /** Rows the browser could not parse (kept for the import record). */
      parseErrorCount?: number;
      parseErrorSummary?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      bankAccountId: assertUuid(input.bankAccountId),
      filename: (input.filename ?? "statement.csv").trim().slice(0, 200) || "statement.csv",
      rows: validateRows(input.rows),
      parseErrorCount: Math.max(
        0,
        Math.min(1_000_000, Math.round(Number(input.parseErrorCount ?? 0)) || 0),
      ),
      parseErrorSummary: String(input.parseErrorSummary ?? "").slice(0, 1500),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.import");
    await loadBankAccount(supabase, data.companyId, data.bankAccountId);

    // 1. Import record first, so a failure half-way leaves an auditable "partial" import.
    const { data: imp, error: impErr } = await supabase
      .from("bank_statement_imports" as never)
      .insert({
        company_id: data.companyId,
        bank_account_id: data.bankAccountId,
        filename: data.filename,
        row_count: data.rows.length + data.parseErrorCount,
        imported_count: 0,
        duplicate_count: 0,
        error_count: data.parseErrorCount,
        status: "partial",
        error_summary: "Import in progress",
        created_by: context.userId,
      } as never)
      .select("id" as never)
      .single();
    if (impErr) throw new Error(impErr.message);
    const importId = (imp as unknown as { id: string }).id;

    let imported = 0;
    let duplicates = 0;
    const errors: string[] = [];
    let withExtras = true;

    // 2. Rows in chunks. Duplicates (same external id) are skipped by the unique key.
    for (const part of chunk(data.rows, INSERT_CHUNK)) {
      const salted = new Map<number, string>();
      for (const r of part) {
        if (r.force) {
          salted.set(
            r.rowNumber,
            `${r.externalId}_f${(await sha256Hex(`${importId}|${r.rowNumber}`)).slice(0, 12)}`,
          );
        }
      }
      const build = (extras: boolean) =>
        part.map((r) => ({
          company_id: data.companyId,
          bank_account_id: data.bankAccountId,
          txn_date: r.txnDate,
          amount_minor: r.amountMinor,
          description: r.description,
          external_id: salted.get(r.rowNumber) ?? r.externalId,
          status: "uncategorised",
          ...(extras ? { reference: r.reference, payee: r.payee, import_id: importId } : {}),
        }));

      const run = (extras: boolean) =>
        supabase
          .from("bank_transactions" as never)
          .upsert(build(extras) as never, {
            onConflict: "company_id,bank_account_id,external_id",
            ignoreDuplicates: true,
          })
          .select("id" as never);

      let res = await run(withExtras);
      if (res.error && withExtras && isMissingSchema(res.error)) {
        // reference / payee / import_id columns not installed yet: import the essentials.
        withExtras = false;
        res = await run(false);
      }
      if (res.error) {
        errors.push(
          `Rows ${part[0]!.rowNumber}-${part[part.length - 1]!.rowNumber}: ${res.error.message}`,
        );
        continue;
      }
      const inserted = (res.data ?? []).length;
      imported += inserted;
      duplicates += part.length - inserted;
    }

    // 3. Finalise the record (needs the UPDATE policy; if it is missing the record simply stays "partial").
    const errorCount = data.parseErrorCount + errors.length;
    const status =
      errors.length > 0
        ? imported > 0
          ? "partial"
          : "failed"
        : data.parseErrorCount > 0
          ? "partial"
          : "completed";
    const summary =
      [data.parseErrorSummary, ...errors].filter(Boolean).join("; ").slice(0, 2000) || null;
    const { error: finErr } = await supabase
      .from("bank_statement_imports" as never)
      .update({
        imported_count: imported,
        duplicate_count: duplicates,
        error_count: errorCount,
        status,
        error_summary: summary,
      } as never)
      .eq("id" as never, importId as never)
      .eq("company_id" as never, data.companyId as never);
    if (finErr) console.error("bank import finalise failed", finErr.message);

    return {
      importId,
      imported,
      duplicates,
      parseErrors: data.parseErrorCount,
      insertErrors: errors.length,
      status,
    };
  });
