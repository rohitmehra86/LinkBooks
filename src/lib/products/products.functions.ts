import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { productAccountProblem } from "@/lib/products/product-rules";
import { buildIlikeOr } from "@/lib/purchases/search-terms";

export type ProductRow = {
  id: string;
  kind: string;
  code: string | null;
  name: string;
  description: string | null;
  sales_price_minor: number;
  purchase_cost_minor: number;
  income_account_id: string | null;
  expense_account_id: string | null;
  sales_tax_rate_bps: number;
  purchase_tax_rate_bps: number;
  unit: string;
  is_active: boolean;
  created_at: string;
};

function productWriteError(error: { code?: string | null; message: string }): string {
  return error.code === "23505" ? "Another item already uses this code" : error.message;
}

export const listProducts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      q?: string;
      kind?: string;
      includeInactive?: boolean;
      limit?: number;
    }) => ({
      companyId: assertUuid(input.companyId),
      q: (input.q ?? "").trim().slice(0, 100),
      kind: (input.kind ?? "all").trim(),
      includeInactive: Boolean(input.includeInactive),
      limit: Math.min(Math.max(Number(input.limit) || 100, 1), 500),
    }),
  )
  .handler(async ({ data, context }): Promise<ProductRow[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("products" as never)
      .select(
        "id, kind, code, name, description, sales_price_minor, purchase_cost_minor, income_account_id, expense_account_id, sales_tax_rate_bps, purchase_tax_rate_bps, unit, is_active, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("name" as never)
      .limit(data.limit);
    if (!data.includeInactive) q = q.eq("is_active" as never, true as never);
    if (data.kind !== "all") q = q.eq("kind" as never, data.kind as never);
    const search = buildIlikeOr(["name", "code", "description"], data.q);
    if (search) q = q.or(search as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []) as ProductRow[];
  });

export const getProduct = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; productId: string }) => ({
    companyId: assertUuid(input.companyId),
    productId: assertUuid(input.productId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("products" as never)
      .select("*" as never)
      .eq("id" as never, data.productId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Product not found");
    return row;
  });

export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      id?: string;
      kind: string;
      code?: string;
      name: string;
      description?: string;
      salesPriceMinor?: number;
      purchaseCostMinor?: number;
      incomeAccountId?: string;
      expenseAccountId?: string;
      salesTaxRateBps?: number;
      purchaseTaxRateBps?: number;
      unit?: string;
      isActive?: boolean;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Name is required");
      if (!["service", "product", "non_inventory"].includes(input.kind)) {
        throw new Error("Invalid product kind");
      }
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        kind: input.kind,
        code: (input.code ?? "").trim().slice(0, 40) || null,
        name: name.slice(0, 200),
        description: (input.description ?? "").trim().slice(0, 2000) || null,
        salesPriceMinor: Math.max(0, Math.floor(Number(input.salesPriceMinor) || 0)),
        purchaseCostMinor: Math.max(0, Math.floor(Number(input.purchaseCostMinor) || 0)),
        incomeAccountId: input.incomeAccountId ? assertUuid(input.incomeAccountId, "income account") : null,
        expenseAccountId: input.expenseAccountId
          ? assertUuid(input.expenseAccountId, "expense account")
          : null,
        salesTaxRateBps: Math.min(10000, Math.max(0, Math.floor(Number(input.salesTaxRateBps) || 0))),
        purchaseTaxRateBps: Math.min(
          10000,
          Math.max(0, Math.floor(Number(input.purchaseTaxRateBps) || 0)),
        ),
        unit: ((input.unit ?? "each").trim() || "each").slice(0, 40),
        isActive: input.isActive !== false,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "products.manage");
    for (const [role, accountId] of [
      ["income", data.incomeAccountId],
      ["expense", data.expenseAccountId],
    ] as const) {
      if (!accountId) continue;
      const { data: acct, error: acctErr } = await context.supabase
        .from("accounts" as never)
        .select("account_type, is_active, archived_at" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("id" as never, accountId as never)
        .maybeSingle();
      if (acctErr) throw new Error(acctErr.message);
      const a = acct as { account_type: string; is_active: boolean; archived_at: string | null } | null;
      const problem = productAccountProblem(role, a?.account_type, data.kind);
      if (problem) throw new Error(problem);
      if (a && (!a.is_active || a.archived_at)) throw new Error(`The ${role} account is inactive`);
    }
    const payload = {
      company_id: data.companyId,
      kind: data.kind,
      code: data.code,
      name: data.name,
      description: data.description,
      sales_price_minor: data.salesPriceMinor,
      purchase_cost_minor: data.purchaseCostMinor,
      income_account_id: data.incomeAccountId,
      expense_account_id: data.expenseAccountId,
      sales_tax_rate_bps: data.salesTaxRateBps,
      purchase_tax_rate_bps: data.purchaseTaxRateBps,
      unit: data.unit,
      is_active: data.isActive,
      archived_at: data.isActive ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (data.id) {
      const { data: row, error } = await context.supabase
        .from("products" as never)
        .update(payload as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never)
        .select("id")
        .single();
      if (error) throw new Error(productWriteError(error));
      return { id: (row as { id: string }).id };
    }
    const { data: row, error } = await context.supabase
      .from("products" as never)
      .insert(payload as never)
      .select("id")
      .single();
    if (error) throw new Error(productWriteError(error));
    return { id: (row as { id: string }).id };
  });

export const archiveProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; productId: string; restore?: boolean }) => ({
    companyId: assertUuid(input.companyId),
    productId: assertUuid(input.productId),
    restore: Boolean(input.restore),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "products.manage");
    const { error } = await context.supabase
      .from("products" as never)
      .update({
        is_active: data.restore,
        archived_at: data.restore ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id" as never, data.productId as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
