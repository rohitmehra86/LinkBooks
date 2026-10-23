import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { isAccountKind, type AccountClass, type AccountKind } from "@/lib/accounting/account-kinds";
import { importAccountsSchema, saveAccountSchema } from "@/lib/accounting/account-schema";
import {
  archiveDecision,
  lockedFieldChanges,
  mergeAllowed,
  mergeJournalLines,
} from "@/lib/accounting/account-rules";
import {
  misclassificationFlags,
  nearDuplicateNames,
  suggestAccountFromDescription,
} from "@/lib/accounting/account-suggest";
import { postJournal } from "@/lib/accounting/posting-engine";
import { fiscalYearContaining, todayIso } from "@/lib/accounting/fiscal-year";
import { fetchLedgerBalances, loadCompanyMeta, type Sb } from "@/lib/accounting/ledger-data";

export type ChartAccount = {
  id: string;
  code: string;
  name: string;
  description: string;
  accountType: AccountClass;
  accountKind: AccountKind | null;
  subtype: string;
  normalBalance: "debit" | "credit";
  parentId: string | null;
  isHeader: boolean;
  isSystem: boolean;
  isPostable: boolean;
  isControl: boolean;
  isActive: boolean;
  isLocked: boolean;
  defaultTaxCodeId: string | null;
  currencyCode: string;
  isPaymentEnabled: boolean;
  showOnDashboardWatchlist: boolean;
  showInExpenseClaims: boolean;
  bankName: string;
  accountNumberMasked: string;
  detailType: string;
  systemKey: string;
  debitMinor: number;
  creditMinor: number;
  ytdDebitMinor: number;
  ytdCreditMinor: number;
  transactionCount: number;
};

const ACCOUNT_COLUMNS =
  "id, code, name, description, account_type, account_kind, subtype, normal_balance, parent_id, is_header, is_system, is_postable, is_control, is_active, is_locked, default_tax_code_id, currency_code, is_payment_enabled, show_on_dashboard_watchlist, show_in_expense_claims, bank_name, account_number_masked, detail_type, system_key";

export const listChartAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: accountRows, error } = await context.supabase
      .from("accounts" as never)
      .select(ACCOUNT_COLUMNS as never)
      .eq("company_id" as never, data.companyId as never)
      .order("code" as never);
    if (error) throw new Error(error.message);

    const { totals, fy } = await chartTotals(context.supabase, data.companyId);

    const accounts = records(accountRows).map((row) =>
      toChartAccount(row, totals.get(text(row, "id"))),
    );
    return {
      accounts,
      balanceLabel: `Financial year to date (${fy.start} to ${fy.end})`,
      fiscalYear: { start: fy.start, end: fy.end },
      review: {
        misclassified: misclassificationFlags(
          accounts.map((account) => ({
            id: account.id,
            name: account.name,
            kind: account.accountKind,
          })),
        ),
        duplicates: nearDuplicateNames(
          accounts.map((account) => ({ id: account.id, name: account.name })),
        ),
      },
    };
  });

export const saveChartAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const parsed = saveAccountSchema.safeParse(input);
    if (!parsed.success)
      throw new Error(parsed.error.issues[0]?.message ?? "Check the account details.");
    return parsed.data;
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    if (data.currencyCode && !/^[A-Za-z]{3}$/.test(data.currencyCode)) {
      throw new Error("Currency must be a 3-letter code.");
    }
    if (data.id) {
      const existing = await loadAccount(context.supabase, data.companyId, data.id);
      const blocked = lockedFieldChanges(
        {
          isSystem: existing.isSystem,
          isControl: existing.isControl,
          isLocked: existing.isLocked,
          code: existing.code,
          accountKind: existing.accountKind,
          isHeader: existing.isHeader,
        },
        { code: data.code, accountKind: data.accountKind, isHeader: data.isHeader },
      );
      if (blocked.length > 0) {
        throw new Error(
          `This is a system account. You cannot change its ${blocked.join(", ")}. You can still rename it and edit its description.`,
        );
      }
      if (
        existing.accountKind !== data.accountKind &&
        (await postedCount(context.supabase, data.id)) > 0
      ) {
        throw new Error(
          "Type locked: this account has posted transactions. Merge it into another account instead.",
        );
      }
    }
    const payload = {
      company_id: data.companyId,
      code: data.code,
      name: data.name,
      description: data.description || null,
      account_kind: data.accountKind,
      detail_type: data.detailType || null,
      parent_id: data.parentId,
      default_tax_code_id: data.defaultTaxCodeId,
      currency_code: data.currencyCode ? data.currencyCode.toUpperCase() : null,
      is_header: data.isHeader,
      is_payment_enabled: data.isPaymentEnabled,
      show_on_dashboard_watchlist: data.showOnDashboardWatchlist,
      show_in_expense_claims: data.showInExpenseClaims,
      bank_name: data.bankName || null,
      account_number_masked: data.accountNumberMasked || null,
      updated_by: context.userId,
    };
    const query = context.supabase.from("accounts" as never);
    const result = data.id
      ? await query
          .update(payload as never)
          .eq("id" as never, data.id as never)
          .eq("company_id" as never, data.companyId as never)
          .select("id" as never)
          .single()
      : await query
          .insert({
            ...payload,
            // AC-03: flags are only ever set on insert. Sending them on update tried to clear
            // the system flag of system accounts and was rejected by the database.
            is_system: false,
            is_control: false,
            source: "manual",
            is_postable: !data.isHeader,
            is_active: true,
            created_by: context.userId,
          } as never)
          .select("id" as never)
          .single();
    if (result.error) throw new Error(accountWriteError(result.error.message));
    const id = text(record(result.data), "id");
    if (!id) throw new Error("The account could not be saved.");
    return { id };
  });

export const archiveChartAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; accountId: string }) => ({
    companyId: assertUuid(input.companyId),
    accountId: assertUuid(input.accountId, "account"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const account = await loadAccount(context.supabase, data.companyId, data.accountId);
    const facts = await archiveFacts(context.supabase, data.companyId, account);
    const decision = archiveDecision(facts);
    if (!decision.ok) throw new Error(decision.reason);
    const { error } = await context.supabase
      .from("accounts" as never)
      .update({ is_active: false, archived_by: context.userId } as never)
      .eq("id" as never, data.accountId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const mergeChartAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; sourceId: string; targetId: string }) => ({
    companyId: assertUuid(input.companyId),
    sourceId: assertUuid(input.sourceId, "account"),
    targetId: assertUuid(input.targetId, "account"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const source = await loadAccount(context.supabase, data.companyId, data.sourceId);
    const target = await loadAccount(context.supabase, data.companyId, data.targetId);
    const allowed = mergeAllowed({
      sourceClass: source.accountType,
      targetClass: target.accountType,
      sourceSystem: source.isSystem || source.isControl || source.isLocked,
      sourceCurrency: source.currencyCode || null,
      targetCurrency: target.currencyCode || null,
    });
    if (!allowed.ok) throw new Error(allowed.reason);
    const net = source.debitMinor - source.creditMinor;
    const lines = mergeJournalLines({ sourceId: source.id, targetId: target.id, netMinor: net });
    if (!Array.isArray(lines)) throw new Error(lines.error);
    let journalId: string | null = null;
    if (lines.length > 0) {
      const posted = await postJournal(context.supabase, {
        company_id: data.companyId,
        journal_date: new Date().toISOString().slice(0, 10),
        memo: `Merge ${source.code} into ${target.code}`,
        source_type: "manual",
        idempotency_key: `merge:${source.id}:${target.id}`,
        lines: lines.map((line) => ({
          account_id: line.accountId,
          description: line.description,
          debit_minor: line.debitMinor,
          credit_minor: line.creditMinor,
        })),
      });
      journalId = posted.journalId;
    }
    const { error: parentError } = await context.supabase
      .from("accounts" as never)
      .update({ parent_id: target.id } as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("parent_id" as never, source.id as never);
    if (parentError) throw new Error(parentError.message);
    const { error } = await context.supabase
      .from("accounts" as never)
      .update({ is_active: false, archived_by: context.userId } as never)
      .eq("id" as never, source.id as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    return { journalId };
  });

export const importChartAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const parsed = importAccountsSchema.safeParse(input);
    if (!parsed.success)
      throw new Error(parsed.error.issues[0]?.message ?? "Check the import file.");
    return parsed.data;
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const { data: existing, error } = await context.supabase
      .from("accounts" as never)
      .select("code, name" as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    const codes = new Set(records(existing).map((row) => text(row, "code").toLowerCase()));
    const names = new Set(records(existing).map((row) => text(row, "name").toLowerCase()));
    const ready = data.rows.filter(
      (row) => !codes.has(row.code.toLowerCase()) && !names.has(row.name.toLowerCase()),
    );
    const skipped = data.rows.length - ready.length;
    if (!data.commit) return { imported: 0, skipped, preview: ready };
    if (ready.length === 0) return { imported: 0, skipped, preview: [] };
    const { data: result, error: importError } = await context.supabase.rpc(
      "import_chart_accounts" as never,
      {
        _company_id: data.companyId,
        _rows: ready.map((row) => ({
          code: row.code,
          name: row.name,
          account_kind: row.accountKind,
          description: row.description,
          parent_code: row.parentCode,
          detail_type: row.detailType,
          is_header: row.isHeader,
          currency_code: row.currencyCode.toUpperCase(),
        })),
      } as never,
    );
    if (importError) throw new Error(importError.message);
    const imported = number(record(result), "imported");
    return { imported, skipped, preview: ready };
  });

export const copyChartAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sourceCompanyId: string; targetCompanyId: string }) => ({
    sourceCompanyId: assertUuid(input.sourceCompanyId, "organisation"),
    targetCompanyId: assertUuid(input.targetCompanyId, "organisation"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.sourceCompanyId, "accounts.manage");
    await assertCompanyPermission(context.supabase, data.targetCompanyId, "accounts.manage");
    const { data: result, error } = await context.supabase.rpc(
      "copy_chart_accounts" as never,
      {
        _source: data.sourceCompanyId,
        _target: data.targetCompanyId,
      } as never,
    );
    if (error) throw new Error(error.message);
    return { copied: number(record(result), "copied") };
  });

export const suggestChartAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { description: string }) => ({
    description: (input.description ?? "").trim().slice(0, 200),
  }))
  .handler(async ({ data }) => {
    return { suggestions: suggestAccountFromDescription(data.description) };
  });

async function loadAccount(
  supabase: Parameters<typeof assertCompanyMember>[0],
  companyId: string,
  accountId: string,
): Promise<ChartAccount> {
  const { data, error } = await supabase
    .from("accounts" as never)
    .select(ACCOUNT_COLUMNS as never)
    .eq("company_id" as never, companyId as never)
    .eq("id" as never, accountId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Account was not found.");
  const totals = await accountTotals(supabase, companyId, accountId);
  return toChartAccount(record(data), totals);
}

type AccountTotals = {
  debit: number;
  credit: number;
  ytdDebit: number;
  ytdCredit: number;
  count: number;
};

/**
 * Per-account totals from SQL aggregates (no 1000-row cap, converted to base currency).
 * "YTD" is the company's financial year, not the calendar year (AC-06). Year-end closing
 * journals are left out of the YTD movement so P&L accounts still show the year's activity.
 */
async function chartTotals(
  supabase: Parameters<typeof assertCompanyMember>[0],
  companyId: string,
): Promise<{ totals: Map<string, AccountTotals>; fy: { start: string; end: string } }> {
  const sb = supabase as unknown as Sb;
  const meta = await loadCompanyMeta(sb, companyId);
  const fy = fiscalYearContaining(todayIso(), meta.fyEndMonth, meta.fyEndDay);
  const [allTime, movement] = await Promise.all([
    fetchLedgerBalances(sb, companyId, meta.baseCurrency),
    fetchLedgerBalances(sb, companyId, meta.baseCurrency, {
      from: fy.start,
      to: fy.end,
      excludeYearEndClose: true,
    }),
  ]);
  const totals = new Map<string, AccountTotals>();
  for (const row of allTime) {
    totals.set(row.account_id, {
      debit: Number(row.debit_minor),
      credit: Number(row.credit_minor),
      ytdDebit: 0,
      ytdCredit: 0,
      count: row.line_count,
    });
  }
  for (const row of movement) {
    const current = totals.get(row.account_id) ?? {
      debit: 0,
      credit: 0,
      ytdDebit: 0,
      ytdCredit: 0,
      count: 0,
    };
    current.ytdDebit = Number(row.debit_minor);
    current.ytdCredit = Number(row.credit_minor);
    current.count = Math.max(current.count, row.line_count);
    totals.set(row.account_id, current);
  }
  return { totals, fy };
}

async function accountTotals(
  supabase: Parameters<typeof assertCompanyMember>[0],
  companyId: string,
  accountId: string,
) {
  const { totals } = await chartTotals(supabase, companyId);
  return totals.get(accountId) ?? { debit: 0, credit: 0, ytdDebit: 0, ytdCredit: 0, count: 0 };
}

async function postedCount(supabase: Parameters<typeof assertCompanyMember>[0], accountId: string) {
  const { data, error } = await supabase
    .from("journal_lines" as never)
    .select("journals!inner(status)" as never)
    .eq("account_id" as never, accountId as never);
  if (error) throw new Error(error.message);
  return records(data).filter((line) => text(record(line["journals"]), "status") === "posted")
    .length;
}

/** Posted lines on the account in the current financial year, excluding year-end closing. */
async function currentYearActivity(
  supabase: Parameters<typeof assertCompanyMember>[0],
  companyId: string,
  accountId: string,
): Promise<number> {
  const sb = supabase as unknown as Sb;
  const meta = await loadCompanyMeta(sb, companyId);
  const fy = fiscalYearContaining(todayIso(), meta.fyEndMonth, meta.fyEndDay);
  const rows = await fetchLedgerBalances(sb, companyId, meta.baseCurrency, {
    from: fy.start,
    to: fy.end,
    excludeYearEndClose: true,
  });
  return rows.find((r) => r.account_id === accountId)?.line_count ?? 0;
}

async function archiveFacts(
  supabase: Parameters<typeof assertCompanyMember>[0],
  companyId: string,
  account: ChartAccount,
) {
  const { count: childCount, error: childError } = await supabase
    .from("accounts" as never)
    .select("id" as never, { count: "exact", head: true } as never)
    .eq("company_id" as never, companyId as never)
    .eq("parent_id" as never, account.id as never)
    .eq("is_active" as never, true as never);
  if (childError) throw new Error(childError.message);
  const { data: recurring, error: recurringError } = await supabase
    .from("sales_recurring_invoice_lines" as never)
    .select("sales_recurring_invoices!inner(is_active)" as never)
    .eq("account_id" as never, account.id as never)
    .limit(20);
  if (recurringError) throw new Error(recurringError.message);
  const { count: ruleCount, error: ruleError } = await supabase
    .from("bank_rules" as never)
    .select("id" as never, { count: "exact", head: true } as never)
    .eq("offset_account_id" as never, account.id as never)
    .eq("is_active" as never, true as never);
  if (ruleError) throw new Error(ruleError.message);
  return {
    isSystem: account.isSystem,
    isControl: account.isControl,
    isLocked: account.isLocked,
    activeChildCount: childCount ?? 0,
    accountClass: account.accountType,
    currentYearActivityCount: await currentYearActivity(supabase, companyId, account.id),
    postedDebitMinor: account.debitMinor,
    postedCreditMinor: account.creditMinor,
    activeRecurringInvoice: records(recurring).some((row) =>
      flag(record(row["sales_recurring_invoices"]), "is_active"),
    ),
    activeBankRule: (ruleCount ?? 0) > 0,
  };
}

function toChartAccount(
  row: Record<string, unknown>,
  totals?: { debit: number; credit: number; ytdDebit: number; ytdCredit: number; count: number },
): ChartAccount {
  const kindText = text(row, "account_kind");
  const accountType = text(row, "account_type");
  return {
    id: text(row, "id"),
    code: text(row, "code"),
    name: text(row, "name"),
    description: text(row, "description"),
    accountType: isClass(accountType) ? accountType : "expense",
    accountKind: isAccountKind(kindText) ? kindText : null,
    subtype: text(row, "subtype"),
    normalBalance: text(row, "normal_balance") === "debit" ? "debit" : "credit",
    parentId: text(row, "parent_id") || null,
    isHeader: flag(row, "is_header"),
    isSystem: flag(row, "is_system"),
    isPostable: flag(row, "is_postable"),
    isControl: flag(row, "is_control"),
    isActive: flag(row, "is_active"),
    isLocked: flag(row, "is_locked"),
    defaultTaxCodeId: text(row, "default_tax_code_id") || null,
    currencyCode: text(row, "currency_code"),
    isPaymentEnabled: flag(row, "is_payment_enabled"),
    showOnDashboardWatchlist: flag(row, "show_on_dashboard_watchlist"),
    showInExpenseClaims: flag(row, "show_in_expense_claims"),
    bankName: text(row, "bank_name"),
    accountNumberMasked: text(row, "account_number_masked"),
    detailType: text(row, "detail_type"),
    systemKey: text(row, "system_key"),
    debitMinor: totals?.debit ?? 0,
    creditMinor: totals?.credit ?? 0,
    ytdDebitMinor: totals?.ytdDebit ?? 0,
    ytdCreditMinor: totals?.ytdCredit ?? 0,
    transactionCount: totals?.count ?? 0,
  };
}

function accountWriteError(message: string): string {
  if (message.includes("accounts_company_name_lower"))
    return "An account with this name already exists.";
  if (message.includes("accounts_company_id_code") || message.includes("duplicate key")) {
    return "An account with this code already exists.";
  }
  return message;
}

function isClass(value: string): value is AccountClass {
  return (
    value === "asset" ||
    value === "liability" ||
    value === "equity" ||
    value === "income" ||
    value === "expense"
  );
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function number(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

function flag(row: Record<string, unknown>, key: string): boolean {
  return row[key] === true;
}
