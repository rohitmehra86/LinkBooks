import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";

export const listSavedReportViews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; reportId?: string }) => ({
    companyId: assertUuid(input?.companyId),
    reportId: input?.reportId ?? "",
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    let q = context.supabase
      .from("report_saved_views" as never)
      .select("id, report_id, name, is_favourite, config, updated_at" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("user_id" as never, context.userId as never)
      .order("updated_at" as never, { ascending: false });
    if (data.reportId) q = q.eq("report_id" as never, data.reportId as never);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const saveReportView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    companyId: string;
    reportId: string;
    name: string;
    config: Record<string, unknown>;
    isFavourite?: boolean;
  }) => {
    const name = (input?.name ?? "").trim();
    if (!name) throw new Error("View name is required.");
    const reportId = (input?.reportId ?? "").trim();
    if (!reportId) throw new Error("reportId is required.");
    return {
      companyId: assertUuid(input.companyId),
      reportId,
      name,
      config: input.config ?? {},
      isFavourite: Boolean(input.isFavourite),
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("report_saved_views" as never)
      .insert({
        company_id: data.companyId,
        user_id: context.userId,
        report_id: data.reportId,
        name: data.name,
        is_favourite: data.isFavourite,
        config: data.config,
      } as never)
      .select("id, name" as never)
      .single();
    if (error) throw new Error(error.message);
    return row as { id: string; name: string };
  });

export const deleteSavedReportView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; viewId: string }) => ({
    companyId: assertUuid(input?.companyId),
    viewId: assertUuid(input?.viewId, "view"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { error } = await context.supabase
      .from("report_saved_views" as never)
      .delete()
      .eq("id" as never, data.viewId as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("user_id" as never, context.userId as never);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
