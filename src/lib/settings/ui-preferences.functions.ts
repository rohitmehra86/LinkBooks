import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";

export type BillSidebarState = "open" | "collapsed" | "closed";

export type BillWorkspacePrefs = {
  sidebarState: BillSidebarState;
  sidebarWidthPx: number;
  sidebarTab: string;
  viewMode: "basic" | "professional" | "custom";
  visibleColumns: string[];
  columnOrder: string[];
};

export const DEFAULT_BILL_WORKSPACE_PREFS: BillWorkspacePrefs = {
  sidebarState: "open",
  sidebarWidthPx: 340,
  sidebarTab: "summary",
  viewMode: "professional",
  visibleColumns: [
    "item",
    "description",
    "quantity",
    "unitPrice",
    "account",
    "tax",
    "class",
    "location",
    "amount",
  ],
  columnOrder: [
    "item",
    "description",
    "quantity",
    "unitPrice",
    "discount",
    "account",
    "tax",
    "class",
    "location",
    "customer",
    "project",
    "billable",
    "amount",
  ],
};

const KEY = "bill_workspace";
const LIST_KEY = "bills_list_workspace";

export type BillsListColumnId =
  | "select"
  | "supplier"
  | "reference"
  | "bill_date"
  | "due_date"
  | "status"
  | "total"
  | "paid"
  | "balance"
  | "attachments"
  | "actions"
  | "account_number"
  | "bill_number"
  | "supplier_invoice"
  | "approval_status"
  | "payment_status"
  | "days_overdue"
  | "currency"
  | "exchange_rate"
  | "tax"
  | "credited"
  | "created_at"
  | "updated_at";

export type BillsListWorkspacePrefs = {
  density: "compact" | "comfortable";
  visibleColumns: BillsListColumnId[];
  columnOrder: BillsListColumnId[];
  savedViews: Array<{ id: string; name: string; tab: string; q?: string; includeVoid?: boolean }>;
};

export const DEFAULT_BILLS_LIST_PREFS: BillsListWorkspacePrefs = {
  density: "comfortable",
  visibleColumns: [
    "select",
    "supplier",
    "reference",
    "bill_date",
    "due_date",
    "status",
    "total",
    "paid",
    "balance",
    "attachments",
  ],
  columnOrder: [
    "select",
    "supplier",
    "reference",
    "bill_date",
    "due_date",
    "status",
    "total",
    "paid",
    "balance",
    "attachments",
    "account_number",
    "bill_number",
    "supplier_invoice",
    "approval_status",
    "payment_status",
    "days_overdue",
    "currency",
    "exchange_rate",
    "tax",
    "credited",
    "created_at",
    "updated_at",
  ],
  savedViews: [],
};

export const getBillsListPrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row } = await context.supabase
      .from("user_ui_preferences" as never)
      .select("preference_value" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("user_id" as never, context.userId as never)
      .eq("preference_key" as never, LIST_KEY as never)
      .maybeSingle();
    const stored = (row as { preference_value?: Partial<BillsListWorkspacePrefs> } | null)
      ?.preference_value;
    const stripActions = (cols: BillsListColumnId[] | undefined) =>
      (cols ?? []).filter((c) => c !== "actions");
    return {
      ...DEFAULT_BILLS_LIST_PREFS,
      ...(stored ?? {}),
      visibleColumns: stored?.visibleColumns?.length
        ? stripActions(stored.visibleColumns)
        : DEFAULT_BILLS_LIST_PREFS.visibleColumns,
      columnOrder: stored?.columnOrder?.length
        ? stripActions(stored.columnOrder)
        : DEFAULT_BILLS_LIST_PREFS.columnOrder,
      savedViews: stored?.savedViews ?? [],
    } satisfies BillsListWorkspacePrefs;
  });

export const saveBillsListPrefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; prefs: Partial<BillsListWorkspacePrefs> }) => ({
    companyId: assertUuid(input.companyId),
    prefs: input.prefs ?? {},
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: existing } = await context.supabase
      .from("user_ui_preferences" as never)
      .select("preference_value" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("user_id" as never, context.userId as never)
      .eq("preference_key" as never, LIST_KEY as never)
      .maybeSingle();
    const prev = ((existing as { preference_value?: Partial<BillsListWorkspacePrefs> } | null)
      ?.preference_value ?? {}) as Partial<BillsListWorkspacePrefs>;
    const next: BillsListWorkspacePrefs = {
      ...DEFAULT_BILLS_LIST_PREFS,
      ...prev,
      ...data.prefs,
      visibleColumns:
        data.prefs.visibleColumns ?? prev.visibleColumns ?? DEFAULT_BILLS_LIST_PREFS.visibleColumns,
      columnOrder: data.prefs.columnOrder ?? prev.columnOrder ?? DEFAULT_BILLS_LIST_PREFS.columnOrder,
      savedViews: data.prefs.savedViews ?? prev.savedViews ?? [],
    };
    const { error } = await context.supabase.from("user_ui_preferences" as never).upsert(
      {
        company_id: data.companyId,
        user_id: context.userId,
        preference_key: LIST_KEY,
        preference_value: next,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "company_id,user_id,preference_key" } as never,
    );
    if (error) throw new Error(error.message);
    return next;
  });

export const getBillWorkspacePrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row } = await context.supabase
      .from("user_ui_preferences" as never)
      .select("preference_value" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("user_id" as never, context.userId as never)
      .eq("preference_key" as never, KEY as never)
      .maybeSingle();
    const stored = (row as { preference_value?: Partial<BillWorkspacePrefs> } | null)
      ?.preference_value;
    return {
      ...DEFAULT_BILL_WORKSPACE_PREFS,
      ...(stored ?? {}),
      sidebarWidthPx: Math.min(
        480,
        Math.max(260, Number(stored?.sidebarWidthPx ?? DEFAULT_BILL_WORKSPACE_PREFS.sidebarWidthPx)),
      ),
    } satisfies BillWorkspacePrefs;
  });

export const saveBillWorkspacePrefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; prefs: Partial<BillWorkspacePrefs> }) => ({
    companyId: assertUuid(input.companyId),
    prefs: input.prefs ?? {},
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: existing } = await context.supabase
      .from("user_ui_preferences" as never)
      .select("preference_value" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("user_id" as never, context.userId as never)
      .eq("preference_key" as never, KEY as never)
      .maybeSingle();
    const prev = ((existing as { preference_value?: Partial<BillWorkspacePrefs> } | null)
      ?.preference_value ?? {}) as Partial<BillWorkspacePrefs>;
    const next: BillWorkspacePrefs = {
      ...DEFAULT_BILL_WORKSPACE_PREFS,
      ...prev,
      ...data.prefs,
      sidebarWidthPx: Math.min(
        480,
        Math.max(
          260,
          Number(data.prefs.sidebarWidthPx ?? prev.sidebarWidthPx ?? DEFAULT_BILL_WORKSPACE_PREFS.sidebarWidthPx),
        ),
      ),
    };
    const { error } = await context.supabase.from("user_ui_preferences" as never).upsert(
      {
        company_id: data.companyId,
        user_id: context.userId,
        preference_key: KEY,
        preference_value: next,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "company_id,user_id,preference_key" } as never,
    );
    if (error) throw new Error(error.message);
    return next;
  });
