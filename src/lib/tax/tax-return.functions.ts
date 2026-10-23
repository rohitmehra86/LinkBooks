import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { isMissingRpc } from "@/lib/accounting/fetch-all";
import { loadCompanyMeta, type Sb } from "@/lib/accounting/ledger-data";
import { postJournal } from "@/lib/accounting/posting-engine";
import { requireAccountInCompany } from "@/lib/purchases/accounts";
import { todayIso } from "@/lib/accounting/fiscal-year";
import { loadTaxFacts } from "@/lib/tax/tax-return-data";
import { suggestReturnPeriod } from "@/lib/tax/return-periods";
import { isAccountTypeAllowedForTaxRole } from "@/lib/tax/account-pickers";
import {
  buildReturnLines,
  buildTaxReturnSettlementJournal,
  computeReturnTotals,
  isUkReturn,
  type BoxLine,
} from "@/lib/tax/vat-return";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MIGRATION_MESSAGE =
  "Tax returns are not available yet: the database update 20261024130200 has not been applied.";

type Row = Record<string, unknown>;

function isoDate(v: unknown, label: string): string {
  if (typeof v !== "string" || !ISO.test(v)) throw new Error(`${label} must be YYYY-MM-DD`);
  return v;
}

function periodInput(input: {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  basis?: string;
}) {
  const periodStart = isoDate(input?.periodStart, "Period start");
  const periodEnd = isoDate(input?.periodEnd, "Period end");
  if (periodStart > periodEnd) throw new Error("The period cannot end before it starts.");
  const basis: "accrual" | "cash" = input?.basis === "cash" ? "cash" : "accrual";
  return { companyId: assertUuid(input?.companyId), periodStart, periodEnd, basis };
}

async function taxSettings(sb: Sb, companyId: string) {
  const { data, error } = await sb
    .from("company_tax_settings" as never)
    .select(
      "tax_regime, jurisdiction_code, tax_basis, filing_frequency, output_tax_account_id, input_tax_account_id" as never,
    )
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Row;
  const s = (k: string): string | null => (typeof row[k] === "string" ? (row[k] as string) : null);
  return {
    regime: s("tax_regime") ?? "none",
    jurisdiction: s("jurisdiction_code"),
    basis: s("tax_basis") === "cash" ? ("cash" as const) : ("accrual" as const),
    filing: s("filing_frequency"),
    outputAccountId: s("output_tax_account_id"),
    inputAccountId: s("input_tax_account_id"),
  };
}

async function computeReturn(
  sb: Sb,
  p: { companyId: string; periodStart: string; periodEnd: string; basis: "accrual" | "cash" },
) {
  const meta = await loadCompanyMeta(sb, p.companyId);
  const settings = await taxSettings(sb, p.companyId);
  const jurisdiction = settings.jurisdiction ?? meta.countryCode;
  const { facts, documents, skippedNoRate } = await loadTaxFacts(sb, {
    companyId: p.companyId,
    from: p.periodStart,
    to: p.periodEnd,
    basis: p.basis,
    baseCurrency: meta.baseCurrency,
  });
  const totals = computeReturnTotals(facts);
  const lines = buildReturnLines(totals, jurisdiction);
  return { meta, settings, jurisdiction, totals, lines, documents, skippedNoRate };
}

function summaryOf(r: Awaited<ReturnType<typeof computeReturn>>) {
  return {
    documents: r.documents,
    lines: r.totals.counts.lines,
    uncodedLines: r.totals.counts.uncoded,
    outOfScopeLines: r.totals.counts.outOfScope,
    reverseChargeLines: r.totals.counts.reverseCharge,
    skippedNoRate: r.skippedNoRate,
    nonRecoverableTaxMinor: Number(r.totals.nonRecoverableTax),
    outputTaxMinor: Number(r.totals.outputTax),
    inputTaxMinor: Number(r.totals.inputTax),
  };
}

export type ReturnSummary = ReturnType<typeof summaryOf>;

const SUMMARY_KEYS: (keyof ReturnSummary)[] = [
  "documents",
  "lines",
  "uncodedLines",
  "outOfScopeLines",
  "reverseChargeLines",
  "skippedNoRate",
  "nonRecoverableTaxMinor",
  "outputTaxMinor",
  "inputTaxMinor",
];

/** Keep only the numeric summary fields so the stored JSON stays serializable and typed. */
function pickSummary(raw: unknown): Partial<ReturnSummary> {
  const src = raw && typeof raw === "object" ? (raw as Row) : {};
  const out: Partial<ReturnSummary> = {};
  for (const k of SUMMARY_KEYS) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Calculates a return for a period without saving anything. */
export const previewTaxReturn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(periodInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const r = await computeReturn(context.supabase as unknown as Sb, data);
    return {
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      basis: data.basis,
      jurisdiction: r.jurisdiction,
      isUk: isUkReturn(r.jurisdiction),
      currency: r.meta.baseCurrency,
      regime: r.settings.regime,
      lines: r.lines,
      netTaxMinor: Number(r.totals.netTax),
      summary: summaryOf(r),
    };
  });

/** Where the "new return" form should start, from the filing frequency and the last filed return. */
export const getReturnDefaults = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input?.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const settings = await taxSettings(context.supabase as unknown as Sb, data.companyId);
    let lastFiledEnd: string | null = null;
    const { data: last, error } = await context.supabase
      .from("tax_returns" as never)
      .select("period_end" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("status" as never, "filed" as never)
      .order("period_end" as never, { ascending: false } as never)
      .limit(1);
    const available = !error;
    if (!error) {
      const row = ((last ?? []) as Row[])[0];
      lastFiledEnd = typeof row?.["period_end"] === "string" ? (row["period_end"] as string) : null;
    }
    const period = suggestReturnPeriod({
      frequency: settings.filing,
      today: todayIso(),
      lastFiledEnd,
    });
    return {
      available,
      regime: settings.regime,
      basis: settings.basis,
      frequency: settings.filing,
      jurisdiction: settings.jurisdiction,
      outputAccountId: settings.outputAccountId,
      inputAccountId: settings.inputAccountId,
      start: period.start,
      end: period.end,
    };
  });

export type TaxReturnListItem = {
  id: string;
  period_start: string;
  period_end: string;
  basis: string;
  status: string;
  net_tax_minor: number;
  currency_code: string | null;
  filed_at: string | null;
  settlement_journal_id: string | null;
};

export const listTaxReturns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input?.companyId) }))
  .handler(
    async ({ data, context }): Promise<{ available: boolean; returns: TaxReturnListItem[] }> => {
      await assertCompanyMember(context.supabase, data.companyId);
      const { data: rows, error } = await context.supabase
        .from("tax_returns" as never)
        .select(
          "id, period_start, period_end, basis, status, net_tax_minor, currency_code, filed_at, settlement_journal_id" as never,
        )
        .eq("company_id" as never, data.companyId as never)
        .order("period_end" as never, { ascending: false } as never)
        .limit(200);
      if (error) {
        if (isMissingRpc(error) || error.code === "42P01" || error.code === "PGRST205") {
          return { available: false, returns: [] };
        }
        throw new Error(error.message);
      }
      return { available: true, returns: (rows ?? []) as unknown as TaxReturnListItem[] };
    },
  );

/** Calculates the period again on the server and stores it as the draft for that period. */
export const saveTaxReturnDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(periodInput)
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    const r = await computeReturn(context.supabase as unknown as Sb, data);
    const { data: id, error } = await context.supabase.rpc(
      "save_tax_return_draft" as never,
      {
        _company_id: data.companyId,
        _period_start: data.periodStart,
        _period_end: data.periodEnd,
        _basis: data.basis,
        _jurisdiction: r.jurisdiction,
        _currency: r.meta.baseCurrency,
        _net_tax_minor: Number(r.totals.netTax),
        _summary: summaryOf(r),
        _lines: r.lines,
      } as never,
    );
    if (error) throw new Error(isMissingRpc(error) ? MIGRATION_MESSAGE : error.message);
    if (typeof id !== "string") throw new Error("The return could not be saved.");
    return { id };
  });

export type TaxReturnDetail = {
  id: string;
  period_start: string;
  period_end: string;
  basis: string;
  status: string;
  jurisdiction: string | null;
  isUk: boolean;
  currency: string;
  net_tax_minor: number;
  filed_at: string | null;
  settlement_journal_id: string | null;
  summary: Partial<ReturnSummary>;
  lines: BoxLine[];
  /** Filed returns only: boxes whose figures differ if the period is calculated again now. */
  changedSinceFiling: Array<{ box_key: string; filed_minor: number; now_minor: number }>;
  outputAccountId: string | null;
  inputAccountId: string | null;
};

export const getTaxReturn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; returnId: string }) => ({
    companyId: assertUuid(input?.companyId),
    returnId: assertUuid(input?.returnId, "return"),
  }))
  .handler(async ({ data, context }): Promise<TaxReturnDetail> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const sb = context.supabase as unknown as Sb;
    const { data: head, error } = await context.supabase
      .from("tax_returns" as never)
      .select(
        "id, period_start, period_end, basis, status, jurisdiction_code, net_tax_minor, currency_code, filed_at, settlement_journal_id, summary" as never,
      )
      .eq("id" as never, data.returnId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!head) throw new Error("Tax return not found.");
    const h = head as Row;
    const { data: lineRows, error: lineError } = await context.supabase
      .from("tax_return_lines" as never)
      .select("box_key, label, amount_minor, sort_order" as never)
      .eq("return_id" as never, data.returnId as never)
      .order("sort_order" as never);
    if (lineError) throw new Error(lineError.message);
    const lines = ((lineRows ?? []) as Row[]).map((l) => ({
      box_key: String(l["box_key"]) as BoxLine["box_key"],
      label: String(l["label"]),
      amount_minor: Number(l["amount_minor"]),
      sort_order: Number(l["sort_order"]),
    }));

    const periodStart = String(h["period_start"]);
    const periodEnd = String(h["period_end"]);
    const basis = h["basis"] === "cash" ? "cash" : "accrual";
    const status = String(h["status"]);
    const settings = await taxSettings(sb, data.companyId);

    let changedSinceFiling: TaxReturnDetail["changedSinceFiling"] = [];
    if (status === "filed") {
      const now = await computeReturn(sb, {
        companyId: data.companyId,
        periodStart,
        periodEnd,
        basis,
      });
      const nowByKey = new Map(now.lines.map((l) => [l.box_key, l.amount_minor]));
      changedSinceFiling = lines
        .filter((l) => nowByKey.has(l.box_key) && nowByKey.get(l.box_key) !== l.amount_minor)
        .map((l) => ({
          box_key: l.box_key,
          filed_minor: l.amount_minor,
          now_minor: nowByKey.get(l.box_key) ?? 0,
        }));
    }
    const jurisdiction = typeof h["jurisdiction_code"] === "string" ? h["jurisdiction_code"] : null;
    return {
      id: String(h["id"]),
      period_start: periodStart,
      period_end: periodEnd,
      basis,
      status,
      jurisdiction,
      isUk: isUkReturn(jurisdiction),
      currency: typeof h["currency_code"] === "string" ? h["currency_code"] : "",
      net_tax_minor: Number(h["net_tax_minor"]),
      filed_at: typeof h["filed_at"] === "string" ? h["filed_at"] : null,
      settlement_journal_id:
        typeof h["settlement_journal_id"] === "string" ? h["settlement_journal_id"] : null,
      summary: pickSummary(h["summary"]),
      lines,
      changedSinceFiling,
      outputAccountId: settings.outputAccountId,
      inputAccountId: settings.inputAccountId,
    };
  });

/** Freezes a draft. Requires explicit confirmation. Does not post any journal. */
export const fileTaxReturn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; returnId: string; confirm: boolean }) => {
    if (input?.confirm !== true) throw new Error("Filing a return needs explicit confirmation.");
    return {
      companyId: assertUuid(input.companyId),
      returnId: assertUuid(input.returnId, "return"),
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    const { error } = await context.supabase.rpc(
      "file_tax_return" as never,
      {
        _return_id: data.returnId,
      } as never,
    );
    if (error) throw new Error(isMissingRpc(error) ? MIGRATION_MESSAGE : error.message);
    return { ok: true as const };
  });

export const deleteDraftTaxReturn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; returnId: string }) => ({
    companyId: assertUuid(input?.companyId),
    returnId: assertUuid(input?.returnId, "return"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    const { error } = await context.supabase.rpc(
      "delete_draft_tax_return" as never,
      {
        _return_id: data.returnId,
      } as never,
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/**
 * Posts the journal that clears output and input tax into a settlement account, for a filed return.
 * Runs only when the user confirms, goes through the single posting engine, and is posted once.
 */
export const postTaxReturnSettlement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      returnId: string;
      settlementAccountId: string;
      journalDate: string;
      confirm: boolean;
    }) => {
      if (input?.confirm !== true)
        throw new Error("Posting a settlement needs explicit confirmation.");
      return {
        companyId: assertUuid(input.companyId),
        returnId: assertUuid(input.returnId, "return"),
        settlementAccountId: assertUuid(input.settlementAccountId, "settlement account"),
        journalDate: isoDate(input.journalDate, "Journal date"),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounting.post");
    const sb = context.supabase as unknown as Sb;
    const { data: head, error } = await context.supabase
      .from("tax_returns" as never)
      .select("id, status, period_end, settlement_journal_id, currency_code" as never)
      .eq("id" as never, data.returnId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const h = (head ?? null) as Row | null;
    if (!h) throw new Error("Tax return not found.");
    if (h["status"] !== "filed") throw new Error("File the return before settling it.");
    if (h["settlement_journal_id"])
      throw new Error("This return already has a settlement journal.");

    const settings = await taxSettings(sb, data.companyId);
    if (!settings.outputAccountId || !settings.inputAccountId) {
      throw new Error(
        "Map the output and input tax accounts under Tax → GL mappings before settling a return.",
      );
    }
    await requireAccountInCompany(context.supabase, data.companyId, data.settlementAccountId);
    const { data: acc } = await context.supabase
      .from("accounts" as never)
      .select("account_type" as never)
      .eq("id" as never, data.settlementAccountId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    const type = String((acc as Row | null)?.["account_type"] ?? "");
    if (!isAccountTypeAllowedForTaxRole("adjustment_offset", type) || type === "income") {
      throw new Error(
        "Choose a balance-sheet account for the settlement (for example tax payable or bank).",
      );
    }

    const { data: lineRows, error: lineError } = await context.supabase
      .from("tax_return_lines" as never)
      .select("box_key, amount_minor" as never)
      .eq("return_id" as never, data.returnId as never);
    if (lineError) throw new Error(lineError.message);
    const amount = (key: string): bigint => {
      const row = ((lineRows ?? []) as Row[]).find((l) => l["box_key"] === key);
      return BigInt(Math.round(Number(row?.["amount_minor"] ?? 0)));
    };

    const journal = buildTaxReturnSettlementJournal({
      companyId: data.companyId,
      returnId: data.returnId,
      journalDate: data.journalDate,
      periodEnd: String(h["period_end"]),
      outputAccountId: settings.outputAccountId,
      inputAccountId: settings.inputAccountId,
      settlementAccountId: data.settlementAccountId,
      outputTaxMinor: amount("box3"),
      inputTaxMinor: amount("box4"),
      currencyCode: typeof h["currency_code"] === "string" ? h["currency_code"] : "",
    });
    const { journalId } = await postJournal(context.supabase, journal);
    const { error: linkError } = await context.supabase.rpc(
      "set_tax_return_settlement" as never,
      {
        _return_id: data.returnId,
        _journal_id: journalId,
      } as never,
    );
    if (linkError) throw new Error(linkError.message);
    return { journalId };
  });
