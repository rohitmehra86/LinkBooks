/**
 * Ledger data access for reports (RP-01 / BK-04 / U-03 / RP-07).
 *
 * Rules:
 *  - Only POSTED journals are read, and the filter is applied in the database query.
 *  - Nothing is ever silently truncated: either an RPC aggregates in SQL, or the pager walks
 *    every page (`fetchAllPages`).
 *  - Every amount is converted to the company base currency by the single decimal-aware converter.
 *  - If an RPC has not been deployed yet (PGRST202 / 42883) we fall back to the pager path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { fetchAllPages, isMissingRpc, type PageResult } from "@/lib/accounting/fetch-all";
import { lineToBaseMinor } from "@/lib/accounting/fx";
import {
  buildAccountTransactions,
  type AccountType,
  type PostedLine,
} from "@/lib/accounting/reporting";

export type Sb = SupabaseClient<Database>;

export type CompanyMeta = {
  id: string;
  name: string;
  baseCurrency: string;
  countryCode: string;
  fyEndMonth: number;
  fyEndDay: number;
  isDemo: boolean;
  locale: string | null;
};

export async function loadCompanyMeta(supabase: Sb, companyId: string): Promise<CompanyMeta> {
  const { data, error } = await supabase
    .from("companies" as never)
    .select(
      "id, name, base_currency, country_code, fiscal_year_end_month, fiscal_year_end_day, is_demo, locale" as never,
    )
    .eq("id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Organisation not found.");
  const row = data as unknown as {
    id: string;
    name: string;
    base_currency: string;
    country_code: string;
    fiscal_year_end_month: number | null;
    fiscal_year_end_day: number | null;
    is_demo: boolean;
    locale: string | null;
  };
  return {
    id: row.id,
    name: row.name,
    baseCurrency: row.base_currency,
    countryCode: row.country_code,
    fyEndMonth: row.fiscal_year_end_month ?? 12,
    fyEndDay: row.fiscal_year_end_day ?? 31,
    isDemo: Boolean(row.is_demo),
    locale: row.locale ?? null,
  };
}

export type AccountMeta = {
  id: string;
  code: string;
  name: string;
  account_type: AccountType;
  subtype: string | null;
  account_kind: string | null;
  system_key: string | null;
  fs_line: string | null;
  cash_flow_class: string | null;
  is_control: boolean;
  is_active: boolean;
  is_postable: boolean;
  show_on_dashboard_watchlist: boolean;
};

const ACCOUNT_META_COLUMNS =
  "id, code, name, account_type, subtype, account_kind, system_key, fs_line, cash_flow_class, is_control, is_active, is_postable, show_on_dashboard_watchlist";

export async function loadAccountMetas(supabase: Sb, companyId: string): Promise<AccountMeta[]> {
  const rows = await fetchAllPages<AccountMeta>(
    (from, to) =>
      supabase
        .from("accounts" as never)
        .select(ACCOUNT_META_COLUMNS as never)
        .eq("company_id" as never, companyId as never)
        .order("id" as never)
        .range(from, to) as unknown as PromiseLike<PageResult<AccountMeta>>,
  );
  return rows;
}

/* ------------------------------------------------------------------ */
/* Line-level loading (paged, posted only, converted to base)          */
/* ------------------------------------------------------------------ */

type RawLine = {
  id: string;
  account_id: string;
  debit_minor: number;
  credit_minor: number;
  description: string | null;
  journals: {
    id: string;
    journal_number: number;
    journal_date: string;
    status: string;
    memo: string | null;
    source_type: string;
    source_id: string | null;
    currency_code: string | null;
    fx_rate_to_base: number | string | null;
  };
  accounts: {
    code: string;
    name: string;
    account_type: AccountType;
    subtype: string | null;
    account_kind: string | null;
    system_key: string | null;
    fs_line: string | null;
    cash_flow_class: string | null;
  };
};

const LINE_SELECT =
  "id, account_id, debit_minor, credit_minor, description, journals!inner(id, journal_number, journal_date, status, memo, source_type, source_id, currency_code, fx_rate_to_base), accounts!inner(code, name, account_type, subtype, account_kind, system_key, fs_line, cash_flow_class)";

export type LineFilter = {
  from?: string | undefined;
  to?: string | undefined;
  accountIds?: string[] | undefined;
  journalIds?: string[] | undefined;
};

export function rawLineToPosted(r: RawLine, baseCurrency: string): PostedLine {
  const debit = lineToBaseMinor(
    BigInt(r.debit_minor),
    r.journals.fx_rate_to_base,
    r.journals.currency_code,
    baseCurrency,
  );
  const credit = lineToBaseMinor(
    BigInt(r.credit_minor),
    r.journals.fx_rate_to_base,
    r.journals.currency_code,
    baseCurrency,
  );
  return {
    account_id: r.account_id,
    account_code: r.accounts.code,
    account_name: r.accounts.name,
    account_type: r.accounts.account_type,
    account_subtype: r.accounts.subtype,
    account_kind: r.accounts.account_kind,
    system_key: r.accounts.system_key,
    fs_line: r.accounts.fs_line,
    cash_flow_class: r.accounts.cash_flow_class,
    journal_date: r.journals.journal_date,
    debit_minor: debit,
    credit_minor: credit,
    // Already converted to base: downstream builders must not scale again.
    fx_rate_to_base: null,
    currency_code: baseCurrency,
    base_currency: baseCurrency,
    journal_id: r.journals.id,
    journal_number: r.journals.journal_number,
    memo: r.journals.memo,
    source_type: r.journals.source_type,
    source_id: r.journals.source_id,
    description: r.description,
  };
}

/**
 * Every POSTED journal line matching the filter, paged (never truncated), converted to base.
 * Prefer the aggregate RPCs for totals; use this for line-level reports.
 */
export async function loadPostedLines(
  supabase: Sb,
  companyId: string,
  baseCurrency: string,
  filter: LineFilter = {},
): Promise<PostedLine[]> {
  if (filter.accountIds && filter.accountIds.length === 0) return [];
  if (filter.journalIds && filter.journalIds.length === 0) return [];
  const rows = await fetchAllPages<RawLine>((from, to) => {
    let q = supabase
      .from("journal_lines" as never)
      .select(LINE_SELECT as never)
      .eq("company_id" as never, companyId as never)
      .eq("journals.status" as never, "posted" as never);
    if (filter.from) q = q.gte("journals.journal_date" as never, filter.from as never);
    if (filter.to) q = q.lte("journals.journal_date" as never, filter.to as never);
    if (filter.accountIds) q = q.in("account_id" as never, filter.accountIds as never);
    if (filter.journalIds) q = q.in("journal_id" as never, filter.journalIds as never);
    return q.order("id" as never).range(from, to) as unknown as PromiseLike<PageResult<RawLine>>;
  });
  return rows.map((r) => rawLineToPosted(r, baseCurrency));
}

/* ------------------------------------------------------------------ */
/* Aggregates: RPC first, pager fallback                               */
/* ------------------------------------------------------------------ */

export type LedgerBalance = {
  account_id: string;
  debit_minor: bigint;
  credit_minor: bigint;
  line_count: number;
};

export function aggregateLines(lines: PostedLine[]): LedgerBalance[] {
  const map = new Map<string, LedgerBalance>();
  for (const l of lines) {
    const cur = map.get(l.account_id) ?? {
      account_id: l.account_id,
      debit_minor: 0n,
      credit_minor: 0n,
      line_count: 0,
    };
    cur.debit_minor += BigInt(l.debit_minor);
    cur.credit_minor += BigInt(l.credit_minor);
    cur.line_count += 1;
    map.set(l.account_id, cur);
  }
  return [...map.values()];
}

export type RpcClient = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
};

/** Per-account debit/credit sums in base currency for a date range (posted journals only). */
export async function fetchLedgerBalances(
  supabase: Sb,
  companyId: string,
  baseCurrency: string,
  opts: { from?: string | undefined; to?: string | undefined; excludeYearEndClose?: boolean } = {},
): Promise<LedgerBalance[]> {
  const { data, error } = await (supabase as unknown as RpcClient).rpc("ledger_balances", {
    _company_id: companyId,
    _from: opts.from ?? null,
    _to: opts.to ?? null,
    _exclude_year_end_close: Boolean(opts.excludeYearEndClose),
  });
  if (!error) {
    return (
      (data ?? []) as Array<{
        account_id: string;
        debit_minor: number | string;
        credit_minor: number | string;
        line_count: number | string;
      }>
    ).map((r) => ({
      account_id: r.account_id,
      debit_minor: BigInt(r.debit_minor),
      credit_minor: BigInt(r.credit_minor),
      line_count: Number(r.line_count),
    }));
  }
  if (!isMissingRpc(error)) throw new Error(error.message);
  const lines = await loadPostedLines(supabase, companyId, baseCurrency, {
    from: opts.from,
    to: opts.to,
  });
  const filtered = opts.excludeYearEndClose
    ? lines.filter(
        (l) => !(l.source_type === "other" && (l.memo ?? "").startsWith("Year-end close")),
      )
    : lines;
  return aggregateLines(filtered);
}

/**
 * Turn per-account balances into one synthetic PostedLine per account, dated `date`, so the
 * pure builders (TB / P&L / BS) can run on SQL aggregates. Debit/credit are already base.
 */
export function balancesToLines(
  balances: LedgerBalance[],
  accounts: Map<string, AccountMeta>,
  date: string,
  baseCurrency: string,
): PostedLine[] {
  const out: PostedLine[] = [];
  for (const b of balances) {
    const a = accounts.get(b.account_id);
    if (!a) continue;
    out.push({
      account_id: a.id,
      account_code: a.code,
      account_name: a.name,
      account_type: a.account_type,
      account_subtype: a.subtype,
      account_kind: a.account_kind,
      system_key: a.system_key,
      fs_line: a.fs_line,
      cash_flow_class: a.cash_flow_class,
      journal_date: date,
      debit_minor: b.debit_minor,
      credit_minor: b.credit_minor,
      fx_rate_to_base: null,
      currency_code: baseCurrency,
      base_currency: baseCurrency,
    });
  }
  return out;
}

export function accountMap(accounts: AccountMeta[]): Map<string, AccountMeta> {
  return new Map(accounts.map((a) => [a.id, a]));
}

/** Net debit − credit of one account as at a date, base currency. */
export async function fetchAccountBalanceAsOf(
  supabase: Sb,
  companyId: string,
  baseCurrency: string,
  accountId: string,
  asOf: string,
): Promise<bigint> {
  const { data, error } = await (supabase as unknown as RpcClient).rpc("account_balance_as_of", {
    _company_id: companyId,
    _account_id: accountId,
    _as_of: asOf,
  });
  if (!error) return BigInt(typeof data === "number" || typeof data === "string" ? data : 0);
  if (!isMissingRpc(error)) throw new Error(error.message);
  const lines = await loadPostedLines(supabase, companyId, baseCurrency, {
    to: asOf,
    accountIds: [accountId],
  });
  let net = 0n;
  for (const l of lines) net += BigInt(l.debit_minor) - BigInt(l.credit_minor);
  return net;
}

export type AccountTxnPageRow = {
  line_id: string;
  journal_id: string;
  journal_number: number;
  journal_date: string;
  line_no: number;
  memo: string | null;
  description: string | null;
  source_type: string;
  source_id: string | null;
  debit_minor: bigint;
  credit_minor: bigint;
  running_balance_minor: bigint;
};

export type AccountTxnPage = {
  opening_balance_minor: bigint;
  closing_balance_minor: bigint;
  total_count: number;
  rows: AccountTxnPageRow[];
};

/**
 * One page of an account's transactions with running balance (signed debit − credit).
 * The RPC computes the running balance in SQL; the fallback pages every line then slices.
 */
export async function fetchAccountTransactionsPage(
  supabase: Sb,
  companyId: string,
  baseCurrency: string,
  args: { accountId: string; from: string; to: string; limit: number; offset: number },
): Promise<AccountTxnPage> {
  const { data, error } = await (supabase as unknown as RpcClient).rpc("account_transactions", {
    _company_id: companyId,
    _account_id: args.accountId,
    _from: args.from,
    _to: args.to,
    _limit: args.limit,
    _offset: args.offset,
  });
  if (!error) {
    const raw = (data ?? []) as Array<{
      line_id: string;
      journal_id: string;
      journal_number: number | string;
      journal_date: string;
      line_no: number;
      memo: string | null;
      description: string | null;
      source_type: string;
      source_id: string | null;
      debit_minor: number | string;
      credit_minor: number | string;
      running_balance_minor: number | string;
      opening_balance_minor: number | string;
      total_count: number | string;
    }>;
    const rows = raw.map((r) => ({
      line_id: r.line_id,
      journal_id: r.journal_id,
      journal_number: Number(r.journal_number),
      journal_date: r.journal_date,
      line_no: r.line_no,
      memo: r.memo,
      description: r.description,
      source_type: r.source_type,
      source_id: r.source_id,
      debit_minor: BigInt(r.debit_minor),
      credit_minor: BigInt(r.credit_minor),
      running_balance_minor: BigInt(r.running_balance_minor),
    }));
    if (raw.length === 0) {
      // No lines in range (or an offset past the end): opening == closing == balance before `from`.
      const opening = await fetchAccountBalanceAsOf(
        supabase,
        companyId,
        baseCurrency,
        args.accountId,
        dayBefore(args.from),
      );
      return {
        opening_balance_minor: opening,
        closing_balance_minor: opening,
        total_count: 0,
        rows,
      };
    }
    const opening = BigInt(raw[0]!.opening_balance_minor);
    const total = Number(raw[0]!.total_count);
    const closing =
      args.offset + rows.length >= total
        ? rows[rows.length - 1]!.running_balance_minor
        : await fetchAccountBalanceAsOf(supabase, companyId, baseCurrency, args.accountId, args.to);
    return {
      opening_balance_minor: opening,
      closing_balance_minor: closing,
      total_count: total,
      rows,
    };
  }
  if (!isMissingRpc(error)) throw new Error(error.message);

  const lines = await loadPostedLines(supabase, companyId, baseCurrency, {
    to: args.to,
    accountIds: [args.accountId],
  });
  const result = buildAccountTransactions(lines, {
    accountId: args.accountId,
    from: args.from,
    to: args.to,
  });
  const slice = result.rows.slice(args.offset, args.offset + args.limit);
  return {
    opening_balance_minor: result.opening_balance_minor,
    closing_balance_minor: result.closing_balance_minor,
    total_count: result.rows.length,
    rows: slice.map((l) => ({
      line_id: `${l.journal_id ?? ""}:${l.account_id}:${l.journal_number ?? 0}`,
      journal_id: l.journal_id ?? "",
      journal_number: l.journal_number ?? 0,
      journal_date: l.journal_date,
      line_no: 0,
      memo: l.memo ?? null,
      description: l.description ?? null,
      source_type: l.source_type ?? "other",
      source_id: l.source_id ?? null,
      debit_minor: BigInt(l.debit_minor),
      credit_minor: BigInt(l.credit_minor),
      running_balance_minor: l.running_balance_minor,
    })),
  };
}

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
