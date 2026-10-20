import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import {
  DIMENSION_KINDS,
  isDimensionKind,
  wouldCreateOptionCycle,
} from "@/lib/settings/dimension-helpers";

async function audit(
  supabase: {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
  },
  companyId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown>,
) {
  await supabase.rpc("record_audit_event", {
    _company_id: companyId,
    _action: action,
    _entity_type: entityType,
    _entity_id: entityId,
    _details: details,
  });
}

export const listTrackingDimensions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; includeInactive?: boolean }) => ({
    companyId: assertUuid(input.companyId),
    includeInactive: Boolean(input.includeInactive),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let cq = context.supabase
      .from("tracking_categories" as never)
      .select(
        "id, name, description, dimension_kind, applies_to, is_required, is_active, sort_order" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("sort_order" as never)
      .order("name" as never);
    if (!data.includeInactive) cq = cq.eq("is_active" as never, true as never);
    const { data: categories, error } = await cq;
    if (error) throw new Error(error.message);

    let oq = context.supabase
      .from("tracking_options" as never)
      .select(
        "id, category_id, name, code, description, parent_option_id, is_active, sort_order" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("sort_order" as never)
      .order("name" as never);
    if (!data.includeInactive) oq = oq.eq("is_active" as never, true as never);
    const { data: options, error: oErr } = await oq;
    if (oErr) throw new Error(oErr.message);

    return {
      categories: categories ?? [],
      options: options ?? [],
      dimensionKinds: [...DIMENSION_KINDS],
    };
  });

export const upsertTrackingCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      id?: string;
      name: string;
      description?: string;
      dimensionKind?: string;
      appliesTo?: string[];
      isRequired?: boolean;
      isActive?: boolean;
      sortOrder?: number;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Dimension name is required");
      const kind = (input.dimensionKind ?? "custom").trim();
      if (!isDimensionKind(kind)) throw new Error("Invalid dimension kind");
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        name: name.slice(0, 80),
        description: (input.description ?? "").trim().slice(0, 400) || null,
        dimensionKind: kind,
        appliesTo: (input.appliesTo ?? ["sales", "purchases", "banking", "journals"])
          .map((a) => a.trim())
          .filter(Boolean)
          .slice(0, 10),
        isRequired: Boolean(input.isRequired),
        isActive: input.isActive !== false,
        sortOrder: Math.max(0, Math.floor(Number(input.sortOrder ?? 0) || 0)),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const payload = {
      name: data.name,
      description: data.description,
      dimension_kind: data.dimensionKind,
      applies_to: data.appliesTo,
      is_required: data.isRequired,
      is_active: data.isActive,
      sort_order: data.sortOrder,
      updated_at: new Date().toISOString(),
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("tracking_categories" as never)
        .update(payload as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      await audit(context.supabase, data.companyId, "dimension.category.update", "tracking_category", data.id, {
        name: data.name,
        kind: data.dimensionKind,
        is_active: data.isActive,
      });
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("tracking_categories" as never)
      .insert({ company_id: data.companyId, ...payload } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    await audit(context.supabase, data.companyId, "dimension.category.create", "tracking_category", id, {
      name: data.name,
      kind: data.dimensionKind,
    });
    return { id };
  });

export const upsertTrackingOption = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      categoryId: string;
      id?: string;
      name: string;
      code?: string;
      description?: string;
      parentOptionId?: string | null;
      isActive?: boolean;
      sortOrder?: number;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Option name is required");
      return {
        companyId: assertUuid(input.companyId),
        categoryId: assertUuid(input.categoryId),
        id: input.id ? assertUuid(input.id) : undefined,
        name: name.slice(0, 80),
        code: (input.code ?? "").trim().slice(0, 40) || null,
        description: (input.description ?? "").trim().slice(0, 400) || null,
        parentOptionId: input.parentOptionId ? assertUuid(input.parentOptionId) : null,
        isActive: input.isActive !== false,
        sortOrder: Math.max(0, Math.floor(Number(input.sortOrder ?? 0) || 0)),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");

    const { data: cat } = await context.supabase
      .from("tracking_categories" as never)
      .select("id" as never)
      .eq("id" as never, data.categoryId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (!cat) throw new Error("Dimension not found");

    if (data.parentOptionId) {
      const { data: allOpts } = await context.supabase
        .from("tracking_options" as never)
        .select("id, parent_option_id" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("category_id" as never, data.categoryId as never);
      const parentById = new Map(
        ((allOpts ?? []) as Array<{ id: string; parent_option_id: string | null }>).map((o) => [
          o.id,
          o.parent_option_id,
        ]),
      );
      const selfId = data.id ?? "__new__";
      if (data.id && wouldCreateOptionCycle(selfId, data.parentOptionId, parentById)) {
        throw new Error("Cannot set parent: would create a cycle");
      }
      const parent = ((allOpts ?? []) as Array<{ id: string }>).find((o) => o.id === data.parentOptionId);
      if (!parent) throw new Error("Parent option must belong to the same dimension");
    }

    const payload = {
      category_id: data.categoryId,
      name: data.name,
      code: data.code,
      description: data.description,
      parent_option_id: data.parentOptionId,
      is_active: data.isActive,
      sort_order: data.sortOrder,
      updated_at: new Date().toISOString(),
    };

    if (data.id) {
      const { error } = await context.supabase
        .from("tracking_options" as never)
        .update(payload as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      await audit(context.supabase, data.companyId, "dimension.option.update", "tracking_option", data.id, {
        name: data.name,
        is_active: data.isActive,
      });
      return { id: data.id };
    }

    const { data: row, error } = await context.supabase
      .from("tracking_options" as never)
      .insert({ company_id: data.companyId, ...payload } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    await audit(context.supabase, data.companyId, "dimension.option.create", "tracking_option", id, {
      name: data.name,
      category_id: data.categoryId,
    });
    return { id };
  });

export const setDocumentTracking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      entityType: string;
      entityId: string;
      assignments: Array<{ categoryId: string; optionId: string }>;
    }) => ({
      companyId: assertUuid(input.companyId),
      entityType: (input.entityType ?? "").trim(),
      entityId: assertUuid(input.entityId),
      assignments: (input.assignments ?? [])
        .slice(0, 20)
        .map((a) => ({
          categoryId: assertUuid(a.categoryId),
          optionId: assertUuid(a.optionId),
        })),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const allowed = [
      "sales_invoice",
      "sales_quote",
      "sales_credit_note",
      "purchase_bill",
      "purchase_credit_note",
      "purchase_order",
      "journal",
      "bank_transaction",
      "expense",
    ];
    if (!allowed.includes(data.entityType)) throw new Error("Invalid entity type");

    // Validate options belong to categories and are active (or already assigned historically — new assigns must be active)
    for (const a of data.assignments) {
      const { data: opt } = await context.supabase
        .from("tracking_options" as never)
        .select("id, category_id, is_active" as never)
        .eq("id" as never, a.optionId as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      const o = opt as { id: string; category_id: string; is_active: boolean } | null;
      if (!o || o.category_id !== a.categoryId) throw new Error("Invalid dimension option");
      if (!o.is_active) throw new Error("Cannot assign an inactive dimension option");
    }

    await context.supabase
      .from("document_tracking_assignments" as never)
      .delete()
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, data.entityType as never)
      .eq("entity_id" as never, data.entityId as never);

    if (data.assignments.length) {
      const { error } = await context.supabase.from("document_tracking_assignments" as never).insert(
        data.assignments.map((a) => ({
          company_id: data.companyId,
          entity_type: data.entityType,
          entity_id: data.entityId,
          category_id: a.categoryId,
          option_id: a.optionId,
        })) as never,
      );
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const getDocumentTracking = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; entityType: string; entityId: string }) => ({
    companyId: assertUuid(input.companyId),
    entityType: (input.entityType ?? "").trim(),
    entityId: assertUuid(input.entityId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("document_tracking_assignments" as never)
      .select(
        "category_id, option_id, tracking_categories(name, dimension_kind), tracking_options(name, code)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, data.entityType as never)
      .eq("entity_id" as never, data.entityId as never);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** P&L by dimension option — income/expense from posted journals filtered via document assignments on invoices/bills. */
export const reportPnLByDimension = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      categoryId: string;
      fromDate: string;
      toDate: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      categoryId: assertUuid(input.categoryId),
      fromDate: String(input.fromDate ?? "").slice(0, 10),
      toDate: String(input.toDate ?? "").slice(0, 10),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "reports.view");

    const { data: options } = await context.supabase
      .from("tracking_options" as never)
      .select("id, name, code, is_active" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("category_id" as never, data.categoryId as never);

    const { data: invAssign } = await context.supabase
      .from("document_tracking_assignments" as never)
      .select("entity_id, option_id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, "sales_invoice" as never)
      .eq("category_id" as never, data.categoryId as never);

    const { data: billAssign } = await context.supabase
      .from("document_tracking_assignments" as never)
      .select("entity_id, option_id" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, "purchase_bill" as never)
      .eq("category_id" as never, data.categoryId as never);

    const invByOption = new Map<string, string[]>();
    for (const a of (invAssign ?? []) as Array<{ entity_id: string; option_id: string }>) {
      const list = invByOption.get(a.option_id) ?? [];
      list.push(a.entity_id);
      invByOption.set(a.option_id, list);
    }
    const billByOption = new Map<string, string[]>();
    for (const a of (billAssign ?? []) as Array<{ entity_id: string; option_id: string }>) {
      const list = billByOption.get(a.option_id) ?? [];
      list.push(a.entity_id);
      billByOption.set(a.option_id, list);
    }

    const rows: Array<{
      optionId: string;
      optionName: string;
      incomeMinor: number;
      expenseMinor: number;
      netMinor: number;
      invoiceCount: number;
      billCount: number;
      unassignedNote?: string;
    }> = [];

    for (const opt of (options ?? []) as Array<{ id: string; name: string; code: string | null }>) {
      const invIds = invByOption.get(opt.id) ?? [];
      const billIds = billByOption.get(opt.id) ?? [];
      let income = 0;
      let expense = 0;

      if (invIds.length) {
        const { data: invs } = await context.supabase
          .from("sales_invoices" as never)
          .select("total_minor, status, invoice_date" as never)
          .eq("company_id" as never, data.companyId as never)
          .in("id" as never, invIds as never)
          .gte("invoice_date" as never, data.fromDate as never)
          .lte("invoice_date" as never, data.toDate as never)
          .neq("status" as never, "void" as never)
          .neq("status" as never, "draft" as never);
        for (const i of (invs ?? []) as Array<{ total_minor: number }>) {
          income += Number(i.total_minor) || 0;
        }
      }
      if (billIds.length) {
        const { data: bills } = await context.supabase
          .from("purchase_bills" as never)
          .select("total_minor, status, bill_date" as never)
          .eq("company_id" as never, data.companyId as never)
          .in("id" as never, billIds as never)
          .gte("bill_date" as never, data.fromDate as never)
          .lte("bill_date" as never, data.toDate as never)
          .neq("status" as never, "void" as never)
          .neq("status" as never, "draft" as never);
        for (const b of (bills ?? []) as Array<{ total_minor: number }>) {
          expense += Number(b.total_minor) || 0;
        }
      }

      rows.push({
        optionId: opt.id,
        optionName: opt.name,
        incomeMinor: income,
        expenseMinor: expense,
        netMinor: income - expense,
        invoiceCount: invIds.length,
        billCount: billIds.length,
      });
    }

    rows.push({
      optionId: "__unassigned__",
      optionName: "Unassigned",
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
      invoiceCount: 0,
      billCount: 0,
      unassignedNote:
        "Documents without this dimension are excluded from option rows; use the unassigned report filter in a future ledger-line rollup for full GL reconciliation.",
    });

    return {
      categoryId: data.categoryId,
      fromDate: data.fromDate,
      toDate: data.toDate,
      rows,
      method:
        "Document totals for authorised/posted invoices and bills carrying this dimension. Tax and control lines are not double-counted because amounts use document totals once per document.",
    };
  });

export const exportDimensionsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const { data: cats, error } = await context.supabase
      .from("tracking_categories" as never)
      .select("id, name, dimension_kind" as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    const { data: opts, error: oErr } = await context.supabase
      .from("tracking_options" as never)
      .select("category_id, name, code, is_active" as never)
      .eq("company_id" as never, data.companyId as never);
    if (oErr) throw new Error(oErr.message);
    const catList = (cats ?? []) as Array<{ id: string; name: string; dimension_kind: string }>;
    const catName = new Map(catList.map((c) => [c.id, c.name]));
    const catKind = new Map(catList.map((c) => [c.id, c.dimension_kind]));
    const lines = ["dimension,kind,option,code,active"];
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    for (const o of (opts ?? []) as Array<{
      category_id: string;
      name: string;
      code: string | null;
      is_active: boolean;
    }>) {
      lines.push(
        [
          esc(catName.get(o.category_id) ?? ""),
          esc(catKind.get(o.category_id) ?? ""),
          esc(o.name),
          esc(o.code ?? ""),
          o.is_active ? "true" : "false",
        ].join(","),
      );
    }
    return { csv: `${lines.join("\n")}\n`, count: (opts ?? []).length };
  });
