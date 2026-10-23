import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { codeBankTransactionOnce, assertCodableAccounts } from "@/lib/banking/coding-server";
import { DatabaseUpdateRequiredError, isMissingSchema, recordAudit } from "@/lib/banking/rpc";
import { pickRule, validateRuleInput, type BankRuleDef } from "@/lib/banking/rules";
import type { AnyClient } from "@/lib/banking/server-helpers";

const RULE_COLUMNS_NEW =
  "id, name, match_field, match_pattern, match_type, offset_account_id, priority, is_active, direction, min_amount_minor, max_amount_minor, bank_account_id, tax_code_id, contact_id";
const RULE_COLUMNS_OLD =
  "id, name, match_field, match_pattern, match_type, offset_account_id, priority, is_active";

type RuleRow = Partial<BankRuleDef> & {
  id: string;
  name: string;
  match_field: string;
  match_pattern: string;
  match_type: string;
  offset_account_id: string;
  priority: number;
  is_active: boolean;
};

function toDef(r: RuleRow): BankRuleDef {
  return {
    direction: "any",
    min_amount_minor: null,
    max_amount_minor: null,
    bank_account_id: null,
    tax_code_id: null,
    contact_id: null,
    ...r,
  };
}

async function loadRules(
  supabase: AnyClient,
  companyId: string,
  activeOnly: boolean,
): Promise<BankRuleDef[]> {
  const run = (columns: string) => {
    let q = supabase
      .from("bank_rules" as never)
      .select(columns as never)
      .eq("company_id" as never, companyId as never)
      .order("priority" as never)
      .order("name" as never);
    if (activeOnly) q = q.eq("is_active" as never, true as never);
    return q;
  };
  let res = await run(RULE_COLUMNS_NEW);
  if (res.error && isMissingSchema(res.error)) res = await run(RULE_COLUMNS_OLD);
  if (res.error) throw new Error(res.error.message);
  return ((res.data ?? []) as unknown as RuleRow[]).map(toDef);
}

export const listBankRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const rules = await loadRules(supabase, data.companyId, false);
    const ids = [...new Set(rules.map((r) => r.offset_account_id))];
    const names = new Map<string, { code: string; name: string }>();
    if (ids.length) {
      const { data: accs } = await supabase
        .from("accounts" as never)
        .select("id, code, name" as never)
        .eq("company_id" as never, data.companyId as never)
        .in("id" as never, ids as never);
      for (const a of (accs ?? []) as unknown as Array<{
        id: string;
        code: string;
        name: string;
      }>) {
        names.set(a.id, { code: a.code, name: a.name });
      }
    }
    return rules.map((r) => ({ ...r, account: names.get(r.offset_account_id) ?? null }));
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
      direction?: string;
      minAmountMinor?: number | null;
      maxAmountMinor?: number | null;
      bankAccountId?: string | null;
      taxCodeId?: string | null;
      contactId?: string | null;
    }) => {
      const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = Math.round(Number(v));
        if (!Number.isSafeInteger(n)) throw new Error("Invalid amount");
        return n;
      };
      const parsed = {
        name: (input.name ?? "").trim().slice(0, 120),
        matchField: input.matchField,
        matchPattern: (input.matchPattern ?? "").trim().slice(0, 200),
        matchType: input.matchType,
        direction: input.direction ?? "any",
        minAmountMinor: num(input.minAmountMinor),
        maxAmountMinor: num(input.maxAmountMinor),
      };
      const problem = validateRuleInput(parsed);
      if (problem) throw new Error(problem);
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        ...parsed,
        offsetAccountId: assertUuid(input.offsetAccountId, "Account"),
        priority: Math.min(100000, Math.max(1, Math.round(Number(input.priority ?? 100)) || 100)),
        isActive: input.isActive !== false,
        bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
        taxCodeId: input.taxCodeId ? assertUuid(input.taxCodeId) : null,
        contactId: input.contactId ? assertUuid(input.contactId) : null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    // Rules suggest codings, so the target must be something a coding could actually post to.
    await assertCodableAccounts(supabase, data.companyId, [data.offsetAccountId], "");

    const base = {
      name: data.name,
      match_field: data.matchField,
      match_pattern: data.matchPattern,
      match_type: data.matchType,
      offset_account_id: data.offsetAccountId,
      priority: data.priority,
      is_active: data.isActive,
    };
    const extras = {
      direction: data.direction,
      min_amount_minor: data.minAmountMinor,
      max_amount_minor: data.maxAmountMinor,
      bank_account_id: data.bankAccountId,
      tax_code_id: data.taxCodeId,
      contact_id: data.contactId,
    };
    const usesExtras =
      data.direction !== "any" ||
      data.minAmountMinor !== null ||
      data.maxAmountMinor !== null ||
      data.bankAccountId !== null ||
      data.taxCodeId !== null ||
      data.contactId !== null;

    const write = async (payload: Record<string, unknown>) => {
      if (data.id) {
        const { data: row, error } = await supabase
          .from("bank_rules" as never)
          .update({ ...payload, updated_at: new Date().toISOString() } as never)
          .eq("id" as never, data.id as never)
          .eq("company_id" as never, data.companyId as never)
          .select("id" as never)
          .maybeSingle();
        return { id: (row as unknown as { id: string } | null)?.id ?? null, error };
      }
      const { data: row, error } = await supabase
        .from("bank_rules" as never)
        .insert({ ...payload, company_id: data.companyId, created_by: context.userId } as never)
        .select("id" as never)
        .single();
      return { id: (row as unknown as { id: string } | null)?.id ?? null, error };
    };

    let res = await write({ ...base, ...extras });
    if (res.error && isMissingSchema(res.error)) {
      if (usesExtras) throw new DatabaseUpdateRequiredError("bank_rules conditions");
      res = await write(base);
    }
    if (res.error) throw new Error(res.error.message);
    if (data.id && !res.id) throw new Error("Rule not found");
    await recordAudit(supabase, {
      companyId: data.companyId,
      action: data.id ? "bank_rule.update" : "bank_rule.create",
      entityType: "bank_rule",
      entityId: res.id,
      details: { name: data.name },
    });
    return { id: res.id as string };
  });

export const deleteBankRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; id: string }) => ({
    companyId: assertUuid(input.companyId),
    id: assertUuid(input.id),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    const { error } = await supabase
      .from("bank_rules" as never)
      .delete()
      .eq("id" as never, data.id as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    await recordAudit(supabase, {
      companyId: data.companyId,
      action: "bank_rule.delete",
      entityType: "bank_rule",
      entityId: data.id,
    });
    return { ok: true as const };
  });

export const setBankRuleActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; id: string; isActive: boolean }) => ({
    companyId: assertUuid(input.companyId),
    id: assertUuid(input.id),
    isActive: input.isActive === true,
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    const { error } = await supabase
      .from("bank_rules" as never)
      .update({ is_active: data.isActive, updated_at: new Date().toISOString() } as never)
      .eq("id" as never, data.id as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    await recordAudit(supabase, {
      companyId: data.companyId,
      action: data.isActive ? "bank_rule.enable" : "bank_rule.disable",
      entityType: "bank_rule",
      entityId: data.id,
    });
    return { ok: true as const };
  });

type TxnRow = {
  id: string;
  bank_account_id: string;
  txn_date: string;
  amount_minor: number;
  description: string | null;
  reference?: string | null;
  payee?: string | null;
};

/**
 * Rules never post on their own: this lists what each active rule WOULD code, for the user to confirm.
 */
export const previewRuleSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; bankAccountId?: string | null; limit?: number }) => ({
      companyId: assertUuid(input.companyId),
      bankAccountId: input.bankAccountId ? assertUuid(input.bankAccountId) : null,
      limit: Math.min(500, Math.max(1, Math.round(Number(input.limit ?? 200)) || 200)),
    }),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    const rules = await loadRules(supabase, data.companyId, true);
    if (rules.length === 0) return { suggestions: [], scanned: 0, unmatched: 0 };

    const run = (columns: string) => {
      let q = supabase
        .from("bank_transactions" as never)
        .select(columns as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("status" as never, "uncategorised" as never)
        .order("txn_date" as never, { ascending: false })
        .order("id" as never)
        .limit(data.limit);
      if (data.bankAccountId) q = q.eq("bank_account_id" as never, data.bankAccountId as never);
      return q;
    };
    let res = await run(
      "id, bank_account_id, txn_date, amount_minor, description, reference, payee",
    );
    if (res.error && isMissingSchema(res.error))
      res = await run("id, bank_account_id, txn_date, amount_minor, description");
    if (res.error) throw new Error(res.error.message);
    const txns = (res.data ?? []) as unknown as TxnRow[];

    const accountIds = [...new Set(rules.map((r) => r.offset_account_id))];
    const { data: accs } = await supabase
      .from("accounts" as never)
      .select("id, code, name" as never)
      .eq("company_id" as never, data.companyId as never)
      .in("id" as never, accountIds as never);
    const accountMap = new Map(
      ((accs ?? []) as unknown as Array<{ id: string; code: string; name: string }>).map((a) => [
        a.id,
        a,
      ]),
    );

    const suggestions = [];
    for (const t of txns) {
      const rule = pickRule(rules, {
        bankAccountId: t.bank_account_id,
        amountMinor: t.amount_minor,
        description: t.description,
        reference: t.reference ?? null,
        payee: t.payee ?? null,
      });
      if (!rule) continue;
      const acc = accountMap.get(rule.offset_account_id);
      suggestions.push({
        bankTransactionId: t.id,
        txnDate: t.txn_date,
        amountMinor: t.amount_minor,
        description: t.description,
        ruleId: rule.id,
        ruleName: rule.name,
        accountId: rule.offset_account_id,
        accountLabel: acc ? `${acc.code} ${acc.name}` : "",
        taxCodeId: rule.tax_code_id,
        contactId: rule.contact_id,
      });
    }
    return { suggestions, scanned: txns.length, unmatched: txns.length - suggestions.length };
  });

/** User-confirmed application of rule suggestions (single or bulk). Each line is re-checked against its rule. */
export const applyRuleSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; items: Array<{ bankTransactionId: string; ruleId: string }> }) => {
      const items = (input.items ?? []).slice(0, 100).map((i) => ({
        bankTransactionId: assertUuid(i.bankTransactionId),
        ruleId: assertUuid(i.ruleId),
      }));
      if (items.length === 0) throw new Error("Select at least one suggestion");
      return { companyId: assertUuid(input.companyId), items };
    },
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyPermission(supabase, data.companyId, "banking.categorise");
    const rules = await loadRules(supabase, data.companyId, true);
    const byId = new Map(rules.map((r) => [r.id, r]));

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const item of data.items) {
      try {
        const rule = byId.get(item.ruleId);
        if (!rule) throw new Error("Rule is no longer active");
        let { data: row, error } = await supabase
          .from("bank_transactions" as never)
          .select(
            "id, bank_account_id, txn_date, amount_minor, description, reference, payee, status" as never,
          )
          .eq("id" as never, item.bankTransactionId as never)
          .eq("company_id" as never, data.companyId as never)
          .maybeSingle();
        if (error && isMissingSchema(error)) {
          ({ data: row, error } = await supabase
            .from("bank_transactions" as never)
            .select("id, bank_account_id, txn_date, amount_minor, description, status" as never)
            .eq("id" as never, item.bankTransactionId as never)
            .eq("company_id" as never, data.companyId as never)
            .maybeSingle());
        }
        if (error) throw new Error(error.message);
        const t = row as unknown as (TxnRow & { status: string }) | null;
        if (!t) throw new Error("Transaction not found");
        if (t.status !== "uncategorised") throw new Error(`Status is ${t.status}`);
        const picked = pickRule([rule], {
          bankAccountId: t.bank_account_id,
          amountMinor: t.amount_minor,
          description: t.description,
          reference: t.reference ?? null,
          payee: t.payee ?? null,
        });
        if (!picked) throw new Error("The rule no longer matches this line");
        await codeBankTransactionOnce(supabase, context.userId, {
          companyId: data.companyId,
          bankTransactionId: t.id,
          splits: [
            {
              accountId: rule.offset_account_id,
              amountMinor: Math.abs(t.amount_minor),
              taxCodeId: rule.tax_code_id,
            },
          ],
          treatment: "inclusive",
          contactId: rule.contact_id,
        });
        await recordAudit(supabase, {
          companyId: data.companyId,
          action: "bank_rule.applied",
          entityType: "bank_transaction",
          entityId: t.id,
          details: { rule_id: rule.id, rule_name: rule.name },
        });
        results.push({ id: item.bankTransactionId, ok: true });
      } catch (e) {
        results.push({
          id: item.bankTransactionId,
          ok: false,
          error: e instanceof Error ? e.message : "Failed",
        });
      }
    }
    return {
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });
