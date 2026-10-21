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
