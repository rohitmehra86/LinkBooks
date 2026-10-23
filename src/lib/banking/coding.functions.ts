import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { fetchAllPages } from "@/lib/banking/fetch-all";
import { codeBankTransactionOnce } from "@/lib/banking/coding-server";
import { applyTxnFilter, normaliseTxnFilter } from "@/lib/banking/txn-filter";
import { isMissingSchema } from "@/lib/banking/rpc";
import type { AnyClient } from "@/lib/banking/server-helpers";

const MAX_SPLITS = 30;
const BULK_LIMIT = 300;

function parseSplit(raw: unknown, i: number) {
  const s = raw as {
    accountId?: string;
    amountMinor?: number;
    description?: string | null;
    taxCodeId?: string | null;
  };
  const amount = Math.round(Number(s.amountMinor));
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error(`Line ${i + 1}: amount must be greater than zero`);
  return {
    accountId: assertUuid(s.accountId ?? "", "Account"),
    amountMinor: amount,
    description: (s.description ?? "").toString().trim().slice(0, 500) || null,
    taxCodeId: s.taxCodeId ? assertUuid(s.taxCodeId, "Tax code") : null,
  };
}

function parseTreatment(v: unknown): "inclusive" | "exclusive" {
  return v === "exclusive" ? "exclusive" : "inclusive";
}

/** Everything the coding panel needs: postable non-control accounts, tax codes with rates, contacts. */
export const listCodingOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);

    const accounts = await fetchAllPages<{
      id: string;
      code: string;
      name: string;
      account_type: string;
    }>(
      (a, b) =>
        supabase
          .from("accounts" as never)
          .select("id, code, name, account_type" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("is_active" as never, true as never)
          .eq("is_postable" as never, true as never)
          .eq("is_control" as never, false as never)
          .is("archived_at" as never, null as never)
          .order("code" as never)
          .range(a, b) as never,
    );

    const { data: taxRows, error: tErr } = await supabase
      .from("tax_codes" as never)
      .select(
        "id, code, name, applies_to, is_recoverable, treatment, tax_rates!inner(rate_bps, effective_from, effective_to, is_active)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("is_active" as never, true as never)
      .order("code" as never);
    if (tErr && !isMissingSchema(tErr)) throw new Error(tErr.message);
    const taxCodes = (
      (taxRows ?? []) as unknown as Array<{
        id: string;
        code: string;
        name: string;
        applies_to: string;
        is_recoverable: boolean;
        treatment: string | null;
        tax_rates: {
          rate_bps: number;
          effective_from: string;
          effective_to: string | null;
          is_active: boolean;
        } | null;
      }>
    ).map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      appliesTo: t.applies_to,
      isRecoverable: t.is_recoverable,
      treatment: t.treatment ?? "standard",
      rateBps: t.tax_rates?.rate_bps ?? 0,
      effectiveFrom: t.tax_rates?.effective_from ?? null,
      effectiveTo: t.tax_rates?.effective_to ?? null,
      rateActive: t.tax_rates?.is_active ?? false,
    }));

    const contacts = await fetchAllPages<{ id: string; name: string; kind: string }>(
      (a, b) =>
        supabase
          .from("contacts" as never)
          .select("id, name, kind" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("is_active" as never, true as never)
          .order("name" as never)
          .order("id" as never)
          .range(a, b) as never,
    );

    return { accounts, taxCodes, contacts };
  });

/**
 * Code one statement line: contact, split lines (account / tax code / description) and reference.
 * Posts ONE balanced journal (source_type bank_transaction) through the posting engine.
 */
export const codeBankTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankTransactionId: string;
      splits: Array<{
        accountId: string;
        amountMinor: number;
        description?: string | null;
        taxCodeId?: string | null;
      }>;
      treatment?: "inclusive" | "exclusive";
      contactId?: string | null;
      reference?: string | null;
      memo?: string | null;
    }) => {
      if (!Array.isArray(input.splits) || input.splits.length === 0)
        throw new Error("Add at least one coding line");
      if (input.splits.length > MAX_SPLITS) throw new Error(`At most ${MAX_SPLITS} coding lines`);
      return {
        companyId: assertUuid(input.companyId),
        bankTransactionId: assertUuid(input.bankTransactionId),
        splits: input.splits.map(parseSplit),
        treatment: parseTreatment(input.treatment),
        contactId: input.contactId ? assertUuid(input.contactId, "Contact") : null,
        reference: (input.reference ?? "").trim().slice(0, 120) || null,
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    return codeBankTransactionOnce(supabase, context.userId, data);
  });

/**
 * Server-side "select all matching filter": code every UNCATEGORISED line that matches the filter to one account
 * (optionally with a tax code). Works through at most BULK_LIMIT lines per call and reports what remains,
 * so the browser loops until `remaining` is 0 without holding thousands of ids.
 */
export const bulkCodeByFilter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankAccountId?: string | null;
      q?: string | null;
      dateFrom?: string | null;
      dateTo?: string | null;
      direction?: string | null;
      accountId: string;
      taxCodeId?: string | null;
      treatment?: "inclusive" | "exclusive";
      contactId?: string | null;
    }) => ({
      companyId: assertUuid(input.companyId),
      filter: normaliseTxnFilter({
        bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
        q: input.q ?? null,
        dateFrom: input.dateFrom ?? null,
        dateTo: input.dateTo ?? null,
        direction: input.direction ?? null,
        status: "uncategorised",
      }),
      accountId: assertUuid(input.accountId, "Account"),
      taxCodeId: input.taxCodeId ? assertUuid(input.taxCodeId, "Tax code") : null,
      treatment: parseTreatment(input.treatment),
      contactId: input.contactId ? assertUuid(input.contactId, "Contact") : null,
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");

    const exec = (extras: boolean) =>
      applyTxnFilter(
        supabase
          .from("bank_transactions" as never)
          .select("id, amount_minor" as never, { count: "exact" })
          .eq("company_id" as never, data.companyId as never),
        data.filter,
        extras,
      )
        .order("txn_date" as never)
        .order("id" as never)
        .limit(BULK_LIMIT);
    let res = await exec(true);
    if (res.error && isMissingSchema(res.error)) res = await exec(false);
    if (res.error) throw new Error(res.error.message);

    const rows = (res.data ?? []) as unknown as Array<{ id: string; amount_minor: number }>;
    let coded = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const row of rows) {
      try {
        await codeBankTransactionOnce(supabase, context.userId, {
          companyId: data.companyId,
          bankTransactionId: row.id,
          splits: [
            {
              accountId: data.accountId,
              amountMinor: Math.abs(row.amount_minor),
              taxCodeId: data.taxCodeId,
            },
          ],
          treatment: data.treatment,
          contactId: data.contactId,
        });
        coded += 1;
      } catch (e) {
        failed += 1;
        if (errors.length < 5) errors.push(e instanceof Error ? e.message : "Failed");
      }
    }
    const total = res.count ?? rows.length;
    return {
      coded,
      failed,
      errors,
      /** Lines still matching the filter and uncategorised (includes the ones that failed). */
      remaining: Math.max(0, total - coded),
      stuck: coded === 0 && rows.length > 0,
    };
  });
