import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { requireAccountInCompany } from "@/lib/purchases/accounts";
import { categoriseBankTransaction } from "@/lib/accounting/posting-engine";
import { postBankTransfer, voidPostedDocument } from "@/lib/sales/posting";
import { parseBankCsv, applyBankRule } from "@/lib/banking/csv-import";
import {
  directionFromAmount,
  normalizePayee,
  rankCodingSuggestions,
} from "@/lib/banking/suggestions";

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export const listBankAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("bank_accounts" as never)
      .select("id, name, currency_code, gl_account_id, is_active, created_at, accounts(code, name)" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never);
    if (error) throw new Error(error.message);

    const { data: feeds } = await context.supabase
      .from("bank_feed_connections" as never)
      .select("bank_account_id, provider, status, last_sync_at, last_error" as never)
      .eq("company_id" as never, data.companyId as never);

    const feedMap = new Map(
      ((feeds ?? []) as Array<{ bank_account_id: string; status: string }>).map((f) => [
        f.bank_account_id,
        f,
      ]),
    );

    return ((rows ?? []) as Array<{
      id: string;
      name: string;
      currency_code: string;
      gl_account_id: string;
      is_active: boolean;
      created_at: string;
      accounts: { code: string; name: string } | null;
    }>).map((r) => ({
      ...r,
      feed: feedMap.get(r.id) ?? { status: "disconnected", provider: null },
    }));
  });

export const createBankAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; name: string; currencyCode: string; glAccountId: string }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Account name is required");
      return {
        companyId: assertUuid(input.companyId),
        name,
        currencyCode: (input.currencyCode ?? "").toUpperCase().slice(0, 3),
        glAccountId: assertUuid(input.glAccountId, "GL account"),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "banking.feeds.manage");
    await requireAccountInCompany(context.supabase, data.companyId, data.glAccountId);
    const { data: row, error } = await context.supabase
      .from("bank_accounts" as never)
      .insert({
        company_id: data.companyId,
        name: data.name,
        currency_code: data.currencyCode,
        gl_account_id: data.glAccountId,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("This GL account is already linked to a bank account");
      throw new Error(error.message);
    }
    return { id: (row as { id: string }).id };
  });

export const listBankTransactions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankAccountId?: string;
      status?: string;
      /** unreconciled = uncategorised + matched; all = no status filter */
      statusGroup?: string;
      q?: string;
      page?: number;
      pageSize?: number;
    }) => ({
      companyId: assertUuid(input.companyId),
      bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
      status: (input.status ?? "").trim() || null,
      statusGroup: (input.statusGroup ?? "").trim() || null,
      q: (input.q ?? "").trim().slice(0, 120) || null,
      page: Math.max(0, Number(input.page ?? 0) || 0),
      pageSize: Math.min(200, Math.max(10, Number(input.pageSize ?? 50) || 50)),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const pageSize = data.pageSize;
    let q = context.supabase
      .from("bank_transactions" as never)
      .select(
        "id, bank_account_id, txn_date, amount_minor, description, external_id, status, created_at, exclude_reason, excluded_at, payee_normalized" as never,
        { count: "exact" },
      )
      .eq("company_id" as never, data.companyId as never)
      .order("txn_date" as never, { ascending: false })
      .range(data.page * pageSize, data.page * pageSize + pageSize - 1);
    if (data.bankAccountId) q = q.eq("bank_account_id" as never, data.bankAccountId as never);
    if (data.statusGroup === "unreconciled") {
      q = q.in("status" as never, ["uncategorised", "matched"] as never);
    } else if (data.statusGroup === "posted") {
      q = q.in("status" as never, ["matched", "reconciled"] as never);
    } else if (data.status) {
      q = q.eq("status" as never, data.status as never);
    }
    if (data.q) q = q.ilike("description" as never, `%${data.q}%` as never);
    const { data: rows, error, count } = await q;
    if (error) throw new Error(error.message);

    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    const linkMap = new Map<
      string,
      { journal_line_id: string; journal_id: string | null; journal_number: number | null }
    >();
    if (ids.length) {
      const { data: links } = await context.supabase
        .from("reconciliation_links" as never)
        .select("bank_transaction_id, journal_line_id" as never)
        .eq("company_id" as never, data.companyId as never)
        .in("bank_transaction_id" as never, ids as never);
      const lineIds = ((links ?? []) as Array<{ journal_line_id: string }>).map((l) => l.journal_line_id);
      const lineToJournal = new Map<string, { journal_id: string; journal_number: number | null }>();
      if (lineIds.length) {
        const { data: lines } = await context.supabase
          .from("journal_lines" as never)
          .select("id, journal_id" as never)
          .in("id" as never, lineIds as never);
        const journalIds = [
          ...new Set(((lines ?? []) as Array<{ journal_id: string }>).map((l) => l.journal_id)),
        ];
        const journalNums = new Map<string, number>();
        if (journalIds.length) {
          const { data: journals } = await context.supabase
            .from("journals" as never)
            .select("id, journal_number" as never)
            .in("id" as never, journalIds as never);
          for (const j of (journals ?? []) as Array<{ id: string; journal_number: number }>) {
            journalNums.set(j.id, j.journal_number);
          }
        }
        for (const line of (lines ?? []) as Array<{ id: string; journal_id: string }>) {
          lineToJournal.set(line.id, {
            journal_id: line.journal_id,
            journal_number: journalNums.get(line.journal_id) ?? null,
          });
        }
      }
      for (const l of (links ?? []) as Array<{ bank_transaction_id: string; journal_line_id: string }>) {
        const j = lineToJournal.get(l.journal_line_id);
        linkMap.set(l.bank_transaction_id, {
          journal_line_id: l.journal_line_id,
          journal_id: j?.journal_id ?? null,
          journal_number: j?.journal_number ?? null,
        });
      }
    }

    return {
      rows: ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        link: linkMap.get(String(r["id"])) ?? null,
      })),
      total: count ?? 0,
      page: data.page,
      pageSize,
    };
  });

export const importBankCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; bankAccountId: string; filename: string; csvText: string }) => {
      const csvText = input.csvText ?? "";
      if (csvText.length > 2_000_000) throw new Error("CSV file is too large (max 2MB)");
      if (!csvText.trim()) throw new Error("CSV content is empty");
      return {
        companyId: assertUuid(input.companyId),
        bankAccountId: assertUuid(input.bankAccountId),
        filename: (input.filename ?? "statement.csv").trim().slice(0, 200),
        csvText,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.import");

    const { data: account, error: aErr } = await supabase
      .from("bank_accounts" as never)
      .select("id" as never)
      .eq("id" as never, data.bankAccountId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (aErr) throw new Error(aErr.message);
    if (!account) throw new Error("Bank account not found");

    const parsed = parseBankCsv(data.csvText);
    let imported = 0;
    let duplicates = 0;
    const insertErrors: string[] = [];

    for (const row of parsed.rows) {
      const { error } = await supabase.from("bank_transactions" as never).insert({
        company_id: data.companyId,
        bank_account_id: data.bankAccountId,
        txn_date: row.txn_date,
        amount_minor: Number(row.amount_minor),
        description: row.description,
        external_id: row.external_id,
        status: "uncategorised",
      } as never);
      if (error) {
        if (error.code === "23505") {
          duplicates += 1;
        } else {
          insertErrors.push(`Row ${row.row_number}: ${error.message}`);
        }
      } else {
        imported += 1;
      }
    }

    const status =
      insertErrors.length > 0 || parsed.errors.length > 0
        ? imported > 0
          ? "partial"
          : "failed"
        : "completed";

    const { data: imp, error: impErr } = await supabase
      .from("bank_statement_imports" as never)
      .insert({
        company_id: data.companyId,
        bank_account_id: data.bankAccountId,
        filename: data.filename,
        row_count: parsed.rows.length + parsed.errors.length,
        imported_count: imported,
        duplicate_count: duplicates,
        error_count: parsed.errors.length + insertErrors.length,
        status,
        error_summary: [...parsed.errors.map((e) => `Row ${e.row_number}: ${e.message}`), ...insertErrors]
          .slice(0, 20)
          .join("; ")
          .slice(0, 2000),
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (impErr) throw new Error(impErr.message);

    return {
      importId: (imp as { id: string }).id,
      imported,
      duplicates,
      parseErrors: parsed.errors.length,
      insertErrors: insertErrors.length,
      status,
    };
  });

export const categoriseTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankTransactionId: string;
      offsetAccountId: string;
      description?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      bankTransactionId: assertUuid(input.bankTransactionId),
      offsetAccountId: assertUuid(input.offsetAccountId),
      description: (input.description ?? "").trim().slice(0, 500) || undefined,
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    await requireAccountInCompany(supabase, data.companyId, data.offsetAccountId);

    const { data: txn, error } = await supabase
      .from("bank_transactions" as never)
      .select("id, status, amount_minor, txn_date, description, bank_account_id" as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!txn) throw new Error("Transaction not found");
    const t = txn as {
      status: string;
      amount_minor: number;
      txn_date: string;
      description: string | null;
      bank_account_id: string;
    };
    if (t.status === "matched" || t.status === "reconciled") {
      throw new Error("Transaction is already matched");
    }
    if (t.status === "excluded") {
      throw new Error("Restore this excluded transaction before categorising");
    }

    const { data: bankAcc, error: bErr } = await supabase
      .from("bank_accounts" as never)
      .select("gl_account_id" as never)
      .eq("id" as never, t.bank_account_id as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (bErr) throw new Error(bErr.message);
    if (!bankAcc) throw new Error("Bank account not found");
    const glId = (bankAcc as { gl_account_id: string }).gl_account_id;

    const description = data.description || t.description || null;
    const result = await categoriseBankTransaction(supabase, {
      company_id: data.companyId,
      bank_transaction_id: data.bankTransactionId,
      bank_gl_account_id: glId,
      offset_account_id: data.offsetAccountId,
      journal_date: t.txn_date,
      amount_minor: t.amount_minor,
      idempotency_key: `bank_transaction:${data.bankTransactionId}:categorise`,
      ...(description ? { description } : {}),
    });

    // Persist org-local coding history for future suggestions (tenant-scoped)
    const payee = normalizePayee(description);
    if (payee) {
      const direction = directionFromAmount(t.amount_minor);
      const { data: existing } = await supabase
        .from("bank_coding_history" as never)
        .select("id, times_used" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("payee_normalized" as never, payee as never)
        .eq("offset_account_id" as never, data.offsetAccountId as never)
        .eq("direction" as never, direction as never)
        .maybeSingle();
      if (existing) {
        await supabase
          .from("bank_coding_history" as never)
          .update({
            times_used: ((existing as { times_used: number }).times_used ?? 1) + 1,
            last_used_at: new Date().toISOString(),
            description_sample: description,
          } as never)
          .eq("id" as never, (existing as { id: string }).id as never);
      } else {
        await supabase.from("bank_coding_history" as never).insert({
          company_id: data.companyId,
          payee_normalized: payee,
          description_sample: description,
          offset_account_id: data.offsetAccountId,
          direction,
          times_used: 1,
        } as never);
      }
      await supabase
        .from("bank_transactions" as never)
        .update({ payee_normalized: payee } as never)
        .eq("id" as never, data.bankTransactionId as never);
    }

    return result;
  });

/**
 * Match a bank transaction to an existing journal line (same GL, same absolute amount).
 * Does not create a second journal — only a reconciliation link.
 */
export const matchBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; bankTransactionId: string; journalLineId: string }) => ({
      companyId: assertUuid(input.companyId),
      bankTransactionId: assertUuid(input.bankTransactionId),
      journalLineId: assertUuid(input.journalLineId),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.reconcile");

    const { data: txn, error } = await supabase
      .from("bank_transactions" as never)
      .select("id, status, amount_minor, bank_account_id" as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!txn) throw new Error("Transaction not found");
    const t = txn as { status: string; amount_minor: number; bank_account_id: string };
    if (t.status === "matched" || t.status === "reconciled") {
      throw new Error("Transaction is already matched");
    }

    const { data: bankAcc } = await supabase
      .from("bank_accounts" as never)
      .select("gl_account_id" as never)
      .eq("id" as never, t.bank_account_id as never)
      .maybeSingle();
    const glId = (bankAcc as { gl_account_id: string } | null)?.gl_account_id;
    if (!glId) throw new Error("Bank GL account missing");

    const { data: line, error: lErr } = await supabase
      .from("journal_lines" as never)
      .select("id, account_id, debit_minor, credit_minor, company_id" as never)
      .eq("id" as never, data.journalLineId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (lErr) throw new Error(lErr.message);
    if (!line) throw new Error("Journal line not found");
    const jl = line as {
      account_id: string;
      debit_minor: number;
      credit_minor: number;
    };
    if (jl.account_id !== glId) {
      throw new Error("Journal line is not on this bank account's GL");
    }

    const lineSigned = jl.debit_minor - jl.credit_minor;
    if (lineSigned !== t.amount_minor) {
      throw new Error(
        "Amounts do not match. Split matching is not supported — amounts must be equal.",
      );
    }

    const { data: existing } = await supabase
      .from("reconciliation_links" as never)
      .select("id" as never)
      .eq("journal_line_id" as never, data.journalLineId as never)
      .maybeSingle();
    if (existing) throw new Error("Journal line is already matched to another bank transaction");

    const { data: link, error: linkErr } = await supabase
      .from("reconciliation_links" as never)
      .insert({
        company_id: data.companyId,
        bank_transaction_id: data.bankTransactionId,
        journal_line_id: data.journalLineId,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (linkErr) {
      if (linkErr.code === "23505") throw new Error("This bank transaction is already linked");
      throw new Error(linkErr.message);
    }

    await supabase
      .from("bank_transactions" as never)
      .update({ status: "matched" } as never)
      .eq("id" as never, data.bankTransactionId as never);

    return { linkId: (link as { id: string }).id };
  });

export const createTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      fromBankAccountId: string;
      toBankAccountId: string;
      transferDate: string;
      amountMinor: number;
      currencyCode: string;
      memo?: string;
    }) => {
      if (!isIsoDate(input.transferDate)) throw new Error("Transfer date must be YYYY-MM-DD");
      const amount = Math.round(Number(input.amountMinor));
      if (!(amount > 0)) throw new Error("Transfer amount must be positive");
      return {
        companyId: assertUuid(input.companyId),
        fromBankAccountId: assertUuid(input.fromBankAccountId),
        toBankAccountId: assertUuid(input.toBankAccountId),
        transferDate: input.transferDate,
        amountMinor: amount,
        currencyCode: (input.currencyCode ?? "").toUpperCase(),
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    if (data.fromBankAccountId === data.toBankAccountId) {
      throw new Error("Source and destination accounts must differ");
    }

    const load = async (id: string) => {
      const { data: row, error } = await supabase
        .from("bank_accounts" as never)
        .select("id, gl_account_id, currency_code" as never)
        .eq("id" as never, id as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) throw new Error("Bank account not found");
      return row as { id: string; gl_account_id: string; currency_code: string };
    };
    const from = await load(data.fromBankAccountId);
    const to = await load(data.toBankAccountId);
    if (from.currency_code !== to.currency_code || from.currency_code !== data.currencyCode) {
      throw new Error("Currency mismatch between accounts and transfer");
    }

    const { data: inserted, error } = await supabase
      .from("bank_transfers" as never)
      .insert({
        company_id: data.companyId,
        from_bank_account_id: data.fromBankAccountId,
        to_bank_account_id: data.toBankAccountId,
        transfer_date: data.transferDate,
        amount_minor: data.amountMinor,
        currency_code: data.currencyCode,
        memo: data.memo,
        status: "posted",
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const transferId = (inserted as { id: string }).id;

    const journalId = await postBankTransfer(supabase, {
      company_id: data.companyId,
      transfer_id: transferId,
      transfer_date: data.transferDate,
      currency_code: data.currencyCode,
      from_gl_account_id: from.gl_account_id,
      to_gl_account_id: to.gl_account_id,
      amount_minor: data.amountMinor,
      ...(data.memo ? { memo: data.memo } : {}),
    });

    await supabase
      .from("bank_transfers" as never)
      .update({ posted_journal_id: journalId } as never)
      .eq("id" as never, transferId as never);

    return { id: transferId, journalId };
  });

export const listBankRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("bank_rules" as never)
      .select(
        "id, name, match_field, match_pattern, match_type, offset_account_id, priority, is_active, accounts:offset_account_id(code, name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("priority" as never);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const saveBankRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      id?: string;
      name: string;
      matchField: string;
      matchPattern: string;
      matchType: string;
      offsetAccountId: string;
      priority?: number;
      isActive?: boolean;
    }) => {
      const name = (input.name ?? "").trim();
      const pattern = (input.matchPattern ?? "").trim();
      if (!name) throw new Error("Rule name is required");
      if (!pattern) throw new Error("Match pattern is required");
      if (!["description", "reference", "payee"].includes(input.matchField)) {
        throw new Error("Invalid match field");
      }
      if (!["contains", "equals", "starts_with"].includes(input.matchType)) {
        throw new Error("Invalid match type");
      }
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        name,
        matchField: input.matchField,
        matchPattern: pattern.slice(0, 200),
        matchType: input.matchType,
        offsetAccountId: assertUuid(input.offsetAccountId),
        priority: Math.max(1, Number(input.priority ?? 100) || 100),
        isActive: input.isActive !== false,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    await requireAccountInCompany(supabase, data.companyId, data.offsetAccountId);
    if (data.id) {
      const { error } = await supabase
        .from("bank_rules" as never)
        .update({
          name: data.name,
          match_field: data.matchField,
          match_pattern: data.matchPattern,
          match_type: data.matchType,
          offset_account_id: data.offsetAccountId,
          priority: data.priority,
          is_active: data.isActive,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await supabase
      .from("bank_rules" as never)
      .insert({
        company_id: data.companyId,
        name: data.name,
        match_field: data.matchField,
        match_pattern: data.matchPattern,
        match_type: data.matchType,
        offset_account_id: data.offsetAccountId,
        priority: data.priority,
        is_active: data.isActive,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

export const applyRulesToUncategorised = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId?: string; limit?: number }) => ({
    companyId: assertUuid(input.companyId),
    bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
    limit: Math.min(100, Math.max(1, Number(input.limit ?? 50) || 50)),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");

    const { data: rules, error: rErr } = await supabase
      .from("bank_rules" as never)
      .select("id, match_field, match_pattern, match_type, offset_account_id, priority" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .order("priority" as never);
    if (rErr) throw new Error(rErr.message);
    const ruleList = (rules ?? []) as Array<{
      match_field: string;
      match_pattern: string;
      match_type: string;
      offset_account_id: string;
    }>;
    if (!ruleList.length) return { applied: 0, skipped: 0 };

    let q = supabase
      .from("bank_transactions" as never)
      .select("id, description, amount_minor, txn_date, bank_account_id, status" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("status" as never, "uncategorised" as never)
      .limit(data.limit);
    if (data.bankAccountId) q = q.eq("bank_account_id" as never, data.bankAccountId as never);
    const { data: txns, error } = await q;
    if (error) throw new Error(error.message);

    let applied = 0;
    let skipped = 0;
    for (const txn of (txns ?? []) as Array<{
      id: string;
      description: string | null;
      amount_minor: number;
      txn_date: string;
      bank_account_id: string;
    }>) {
      const match = ruleList.find((rule) =>
        applyBankRule(txn.description ?? "", null, rule),
      );
      if (!match) {
        skipped += 1;
        continue;
      }
      try {
        const { data: bankAcc } = await supabase
          .from("bank_accounts" as never)
          .select("gl_account_id" as never)
          .eq("id" as never, txn.bank_account_id as never)
          .maybeSingle();
        const glId = (bankAcc as { gl_account_id: string } | null)?.gl_account_id;
        if (!glId) {
          skipped += 1;
          continue;
        }
        await categoriseBankTransaction(supabase, {
          company_id: data.companyId,
          bank_transaction_id: txn.id,
          bank_gl_account_id: glId,
          offset_account_id: match.offset_account_id,
          journal_date: txn.txn_date,
          amount_minor: txn.amount_minor,
          idempotency_key: `bank_transaction:${txn.id}:categorise`,
          ...(txn.description ? { description: txn.description } : {}),
        });
        applied += 1;
      } catch {
        skipped += 1;
      }
    }
    return { applied, skipped };
  });

export const listReconciliationSessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId?: string }) => ({
    companyId: assertUuid(input.companyId),
    bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("reconciliation_sessions" as never)
      .select(
        "id, bank_account_id, statement_date, statement_balance_minor, reconciled_balance_minor, status, completed_at, notes, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("statement_date" as never, { ascending: false })
      .limit(50);
    if (data.bankAccountId) q = q.eq("bank_account_id" as never, data.bankAccountId as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const completeReconciliation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankAccountId: string;
      statementDate: string;
      statementBalanceMinor: number;
      notes?: string;
    }) => {
      if (!isIsoDate(input.statementDate)) throw new Error("Statement date must be YYYY-MM-DD");
      return {
        companyId: assertUuid(input.companyId),
        bankAccountId: assertUuid(input.bankAccountId),
        statementDate: input.statementDate,
        statementBalanceMinor: Math.round(Number(input.statementBalanceMinor)),
        notes: (input.notes ?? "").trim().slice(0, 500) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.reconcile");

    const { data: bankAcc, error: aErr } = await supabase
      .from("bank_accounts" as never)
      .select("id, gl_account_id" as never)
      .eq("id" as never, data.bankAccountId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (aErr) throw new Error(aErr.message);
    if (!bankAcc) throw new Error("Bank account not found");
    const glId = (bankAcc as { gl_account_id: string }).gl_account_id;

    // Ledger balance from journal lines up to statement date
    const { data: lines, error: lErr } = await supabase
      .from("journal_lines" as never)
      .select("debit_minor, credit_minor, journals!inner(journal_date, status, company_id)" as never)
      .eq("account_id" as never, glId as never)
      .eq("company_id" as never, data.companyId as never);
    if (lErr) throw new Error(lErr.message);

    let ledgerBalance = 0n;
    for (const row of (lines ?? []) as Array<{
      debit_minor: number;
      credit_minor: number;
      journals: { journal_date: string; status: string; company_id: string };
    }>) {
      if (row.journals.status !== "posted") continue;
      if (row.journals.journal_date > data.statementDate) continue;
      ledgerBalance += BigInt(row.debit_minor) - BigInt(row.credit_minor);
    }

    const { count: uncatCount } = await supabase
      .from("bank_transactions" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never)
      .eq("bank_account_id" as never, data.bankAccountId as never)
      .eq("status" as never, "uncategorised" as never)
      .lte("txn_date" as never, data.statementDate as never);

    if ((uncatCount ?? 0) > 0) {
      throw new Error(
        `Cannot complete reconciliation: ${uncatCount} uncategorised transaction(s) on or before the statement date`,
      );
    }

    const reconciled = Number(ledgerBalance);
    if (reconciled !== data.statementBalanceMinor) {
      throw new Error(
        `Statement balance (${data.statementBalanceMinor}) does not match ledger balance (${reconciled}) as of ${data.statementDate}`,
      );
    }

    // Mark matched txns as reconciled
    await supabase
      .from("bank_transactions" as never)
      .update({ status: "reconciled" } as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("bank_account_id" as never, data.bankAccountId as never)
      .eq("status" as never, "matched" as never)
      .lte("txn_date" as never, data.statementDate as never);

    const { data: session, error: sErr } = await supabase
      .from("reconciliation_sessions" as never)
      .insert({
        company_id: data.companyId,
        bank_account_id: data.bankAccountId,
        statement_date: data.statementDate,
        statement_balance_minor: data.statementBalanceMinor,
        reconciled_balance_minor: reconciled,
        status: "completed",
        completed_at: new Date().toISOString(),
        completed_by: userId,
        notes: data.notes,
        created_by: userId,
      } as never)
      .select("id")
      .single();
    if (sErr) throw new Error(sErr.message);

    return {
      sessionId: (session as { id: string }).id,
      ledgerBalanceMinor: reconciled,
    };
  });

export const listStatementImports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("bank_statement_imports" as never)
      .select(
        "id, filename, row_count, imported_count, duplicate_count, error_count, status, error_summary, created_at, bank_account_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("created_at" as never, { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const voidTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; transferId: string }) => ({
    companyId: assertUuid(input.companyId),
    transferId: assertUuid(input.transferId),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.reconcile");
    const { data: t, error } = await supabase
      .from("bank_transfers" as never)
      .select("id, status, posted_journal_id" as never)
      .eq("id" as never, data.transferId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!t) throw new Error("Transfer not found");
    const tr = t as { status: string; posted_journal_id: string | null };
    if (tr.status === "void") throw new Error("Transfer already void");
    if (!tr.posted_journal_id) throw new Error("Transfer has no journal");
    const journalId = await voidPostedDocument(
      supabase,
      tr.posted_journal_id,
      `bank_transfer:${data.transferId}:void`,
    );
    await supabase
      .from("bank_transfers" as never)
      .update({ status: "void", void_journal_id: journalId } as never)
      .eq("id" as never, data.transferId as never);
    return { journalId };
  });

export const getBankingWorkspaceCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankAccountId?: string }) => ({
    companyId: assertUuid(input.companyId),
    bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const statuses = ["uncategorised", "matched", "reconciled", "excluded"] as const;
    const base = { uncategorised: 0, matched: 0, reconciled: 0, excluded: 0 };
    for (const status of statuses) {
      let q = context.supabase
        .from("bank_transactions" as never)
        .select("id" as never, { count: "exact", head: true })
        .eq("company_id" as never, data.companyId as never)
        .eq("status" as never, status as never);
      if (data.bankAccountId) q = q.eq("bank_account_id" as never, data.bankAccountId as never);
      const { count } = await q;
      base[status] = count ?? 0;
    }
    return {
      ...base,
      unreconciled: base.uncategorised + base.matched,
      posted: base.matched + base.reconciled,
      all: base.uncategorised + base.matched + base.reconciled + base.excluded,
    };
  });

export const excludeBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string; reason?: string }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
    reason: (input.reason ?? "").trim().slice(0, 500) || null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "banking.categorise");
    const { data: txn, error } = await context.supabase
      .from("bank_transactions" as never)
      .select("id, status" as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!txn) throw new Error("Transaction not found");
    const status = (txn as { status: string }).status;
    if (status === "matched" || status === "reconciled") {
      throw new Error("Cannot exclude a matched or reconciled transaction — reverse the posting first");
    }
    if (status === "excluded") return { ok: true as const, already: true };
    const { error: uErr } = await context.supabase
      .from("bank_transactions" as never)
      .update({
        status: "excluded",
        exclude_reason: data.reason,
        excluded_at: new Date().toISOString(),
        excluded_by: context.userId,
      } as never)
      .eq("id" as never, data.bankTransactionId as never);
    if (uErr) throw new Error(uErr.message);
    await context.supabase.from("audit_events" as never).insert({
      company_id: data.companyId,
      actor_user_id: context.userId,
      action: "bank_transaction.exclude",
      entity_type: "bank_transaction",
      entity_id: data.bankTransactionId,
      details: { reason: data.reason },
    } as never);
    return { ok: true as const, already: false };
  });

export const restoreBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "banking.categorise");
    const { data: txn, error } = await context.supabase
      .from("bank_transactions" as never)
      .select("id, status" as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!txn) throw new Error("Transaction not found");
    if ((txn as { status: string }).status !== "excluded") {
      throw new Error("Only excluded transactions can be restored");
    }
    // Ensure no reconciliation link exists (should not for excluded)
    const { count } = await context.supabase
      .from("reconciliation_links" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("bank_transaction_id" as never, data.bankTransactionId as never);
    if ((count ?? 0) > 0) {
      throw new Error("Cannot restore: a journal link already exists for this statement line");
    }
    const { error: uErr } = await context.supabase
      .from("bank_transactions" as never)
      .update({
        status: "uncategorised",
        exclude_reason: null,
        excluded_at: null,
        excluded_by: null,
      } as never)
      .eq("id" as never, data.bankTransactionId as never);
    if (uErr) throw new Error(uErr.message);
    await context.supabase.from("audit_events" as never).insert({
      company_id: data.companyId,
      actor_user_id: context.userId,
      action: "bank_transaction.restore",
      entity_type: "bank_transaction",
      entity_id: data.bankTransactionId,
      details: {},
    } as never);
    return { ok: true as const };
  });

export const bulkCategoriseTransactions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    companyId: string;
    bankTransactionIds: string[];
    offsetAccountId: string;
  }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionIds: [...new Set((input.bankTransactionIds ?? []).map((id) => assertUuid(id)))].slice(0, 100),
    offsetAccountId: assertUuid(input.offsetAccountId),
  }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    if (!data.bankTransactionIds.length) throw new Error("Select at least one transaction");
    await requireAccountInCompany(supabase, data.companyId, data.offsetAccountId);

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of data.bankTransactionIds) {
      try {
        const { data: txn, error } = await supabase
          .from("bank_transactions" as never)
          .select("id, status, amount_minor, txn_date, description, bank_account_id" as never)
          .eq("id" as never, id as never)
          .eq("company_id" as never, data.companyId as never)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!txn) throw new Error("Not found");
        const t = txn as {
          status: string;
          amount_minor: number;
          txn_date: string;
          description: string | null;
          bank_account_id: string;
        };
        if (t.status !== "uncategorised") throw new Error(`Status is ${t.status}`);
        const { data: bankAcc } = await supabase
          .from("bank_accounts" as never)
          .select("gl_account_id" as never)
          .eq("id" as never, t.bank_account_id as never)
          .maybeSingle();
        if (!bankAcc) throw new Error("Bank account missing");
        await categoriseBankTransaction(supabase, {
          company_id: data.companyId,
          bank_transaction_id: id,
          bank_gl_account_id: (bankAcc as { gl_account_id: string }).gl_account_id,
          offset_account_id: data.offsetAccountId,
          journal_date: t.txn_date,
          amount_minor: t.amount_minor,
          idempotency_key: `bank_transaction:${id}:categorise`,
          ...(t.description ? { description: t.description } : {}),
        });
        const payee = normalizePayee(t.description);
        if (payee) {
          await supabase.from("bank_coding_history" as never).upsert(
            {
              company_id: data.companyId,
              payee_normalized: payee,
              description_sample: t.description,
              offset_account_id: data.offsetAccountId,
              direction: directionFromAmount(t.amount_minor),
              times_used: 1,
              last_used_at: new Date().toISOString(),
            } as never,
            { onConflict: "company_id,payee_normalized,offset_account_id,direction" } as never,
          );
        }
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : "Failed" });
      }
    }
    return {
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });

export const suggestBankCoding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; bankTransactionId: string }) => ({
    companyId: assertUuid(input.companyId),
    bankTransactionId: assertUuid(input.bankTransactionId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: txn, error } = await context.supabase
      .from("bank_transactions" as never)
      .select("id, description, amount_minor, status" as never)
      .eq("id" as never, data.bankTransactionId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!txn) throw new Error("Transaction not found");
    const t = txn as { description: string | null; amount_minor: number; status: string };

    const { data: history } = await context.supabase
      .from("bank_coding_history" as never)
      .select("payee_normalized, offset_account_id, direction, times_used, accounts(code, name)" as never)
      .eq("company_id" as never, data.companyId as never)
      .limit(100);
    const { data: rules } = await context.supabase
      .from("bank_rules" as never)
      .select(
        "id, name, match_field, match_pattern, match_type, offset_account_id, priority, is_active, accounts(code, name)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never);

    const suggestions = rankCodingSuggestions({
      description: t.description,
      amountMinor: t.amount_minor,
      history: ((history ?? []) as Array<{
        payee_normalized: string;
        offset_account_id: string;
        direction: "in" | "out";
        times_used: number;
        accounts: { code: string; name: string } | null;
      }>).map((h) => ({
        payee_normalized: h.payee_normalized,
        offset_account_id: h.offset_account_id,
        direction: h.direction,
        times_used: h.times_used,
        account_code: h.accounts?.code ?? null,
        account_name: h.accounts?.name ?? null,
      })),
      rules: ((rules ?? []) as Array<{
        id: string;
        name: string;
        match_field: string;
        match_pattern: string;
        match_type: string;
        offset_account_id: string;
        priority: number;
        is_active: boolean;
        accounts: { code: string; name: string } | null;
      }>).map((r) => ({
        id: r.id,
        name: r.name,
        match_field: r.match_field,
        match_pattern: r.match_pattern,
        match_type: r.match_type,
        offset_account_id: r.offset_account_id,
        priority: r.priority,
        is_active: r.is_active,
        account_code: r.accounts?.code ?? null,
        account_name: r.accounts?.name ?? null,
      })),
    });

    return {
      status: t.status,
      payeeNormalized: normalizePayee(t.description),
      externalResearchAvailable: false,
      externalResearchNote:
        "No external search/AI provider is configured. Suggestions use this organisation’s coding history and bank rules only.",
      suggestions,
    };
  });

export const listBankTransfers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("bank_transfers" as never)
      .select(
        "id, transfer_date, amount_minor, memo, status, posted_journal_id, from_bank_account_id, to_bank_account_id, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("transfer_date" as never, { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
