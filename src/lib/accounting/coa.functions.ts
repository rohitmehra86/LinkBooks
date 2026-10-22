import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import {
  CATALOG_VERSION,
  INDUSTRIES,
  LIBRARY_ACCOUNTS,
  catalogStats,
} from "@/lib/accounting/coa-library/catalog";
import { previewIndustryApply, trackingDefaultsFor } from "@/lib/accounting/coa-library/apply";
import type { DetailLevel, ExistingAccount } from "@/lib/accounting/coa-library/types";
import { accountKindForPlacement } from "@/lib/accounting/account-kinds";
import { accountPlacementById } from "@/lib/accounting/account-placement";

function companyIdInput(input: { companyId: string }) {
  return { companyId: assertUuid(input?.companyId) };
}

export const listCoaIndustries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return INDUSTRIES.map((i) => ({
      code: i.code,
      name: i.name,
      family: i.family,
      description: i.description,
      simpleCount: i.simple.length,
      standardCount: i.standard.length,
      detailedCount: i.detailed.length,
      hasTracking: Boolean(i.trackingDefaults?.length),
    }));
  });

export const getCoaCatalogStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => catalogStats());

export const listOptionalLibraryAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { q?: string; recommendation?: string }) => ({
    q: (input?.q ?? "").trim().toLowerCase(),
    recommendation: input?.recommendation ?? "",
  }))
  .handler(async ({ data }) => {
    return LIBRARY_ACCOUNTS.filter((a) => {
      if (data.recommendation && a.recommendation !== data.recommendation) return false;
      if (!data.q) return true;
      const hay = `${a.code} ${a.name} ${a.description} ${a.key}`.toLowerCase();
      return hay.includes(data.q);
    }).map((a) => ({
      key: a.key,
      code: a.code,
      name: a.name,
      description: a.description,
      accountType: a.accountType,
      subtype: a.subtype,
      fsLine: a.fsLine,
      recommendation: a.recommendation,
      whyRecommended: a.whyRecommended ?? null,
    }));
  });

export const getCompanyCoaSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("company_coa_settings" as never)
      .select("detail_level, industry_codes, catalog_version, updated_at" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const r = row as {
      detail_level?: string;
      industry_codes?: string[];
      catalog_version?: string | null;
      updated_at?: string;
    } | null;
    return {
      detailLevel: (r?.detail_level as DetailLevel) ?? "standard",
      industryCodes: r?.industry_codes ?? [],
      catalogVersion: r?.catalog_version ?? null,
      updatedAt: r?.updated_at ?? null,
      liveCatalogVersion: CATALOG_VERSION,
    };
  });

type AccountsReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
  };
};

function isAccountsReader(value: unknown): value is AccountsReader {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in value &&
    typeof value.from === "function"
  );
}

async function loadExistingAccounts(
  supabase: unknown,
  companyId: string,
): Promise<ExistingAccount[]> {
  if (!isAccountsReader(supabase)) throw new Error("Accounts could not be loaded.");
  const { data: rows, error } = await supabase
    .from("accounts")
    .select("id, code, name, account_type, catalog_key, is_control, is_system")
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);
  return (rows ?? []) as ExistingAccount[];
}

export const previewCoaIndustryApply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; industryCodes: string[]; level: DetailLevel }) => ({
    companyId: assertUuid(input?.companyId),
    industryCodes: [...new Set((input?.industryCodes ?? []).filter(Boolean))],
    level: (["simple", "standard", "detailed"].includes(input?.level)
      ? input.level
      : "standard") as DetailLevel,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const existing = await loadExistingAccounts(context.supabase, data.companyId);
    const preview = previewIndustryApply({
      existing,
      industryCodes: data.industryCodes,
      level: data.level,
    });
    return {
      ...preview,
      catalogVersion: CATALOG_VERSION,
      trackingDefaults: trackingDefaultsFor(data.industryCodes),
    };
  });

export const applyCoaIndustryTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      industryCodes: string[];
      level: DetailLevel;
      confirmConflicts?: boolean;
    }) => ({
      companyId: assertUuid(input?.companyId),
      industryCodes: [...new Set((input?.industryCodes ?? []).filter(Boolean))],
      level: (["simple", "standard", "detailed"].includes(input?.level)
        ? input.level
        : "standard") as DetailLevel,
      confirmConflicts: Boolean(input?.confirmConflicts),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    if (data.industryCodes.length === 0) {
      throw new Error("Select at least one industry before applying.");
    }

    const existing = await loadExistingAccounts(context.supabase, data.companyId);
    const preview = previewIndustryApply({
      existing,
      industryCodes: data.industryCodes,
      level: data.level,
    });

    if (preview.conflicts.length > 0 && !data.confirmConflicts) {
      throw new Error(
        `Code conflicts detected (${preview.conflicts.length}). Review preview and confirm to skip conflicts.`,
      );
    }

    let created = 0;
    const createdCodes: string[] = [];
    for (const item of preview.toCreate) {
      const lib = LIBRARY_ACCOUNTS.find((a) => a.key === item.key);
      if (!lib) continue;
      const { error } = await context.supabase.from("accounts" as never).insert({
        company_id: data.companyId,
        code: lib.code,
        name: lib.name,
        account_type: lib.accountType,
        normal_balance: lib.normalBalance,
        subtype: lib.subtype,
        catalog_key: lib.key,
        recommendation_level: data.level,
        fs_line: lib.fsLine,
        cash_flow_class: lib.cashFlowClass,
        source: "industry",
        is_system: false,
        is_postable: true,
        is_control: false,
        is_active: true,
      } as never);
      if (error) {
        // Unique violation = concurrent create / already exists — treat as skip
        if (error.code === "23505") continue;
        throw new Error(error.message);
      }
      created += 1;
      createdCodes.push(lib.code);
    }

    // Tracking dimensions (church / nonprofit) — additive by name
    const tracking = trackingDefaultsFor(data.industryCodes);
    for (const t of tracking) {
      const { data: catRow, error: catErr } = await context.supabase
        .from("tracking_categories" as never)
        .upsert(
          {
            company_id: data.companyId,
            name: t.name,
            is_active: true,
          } as never,
          { onConflict: "company_id,name" } as never,
        )
        .select("id" as never)
        .single();
      if (catErr) throw new Error(catErr.message);
      const categoryId = (catRow as { id: string }).id;
      for (let i = 0; i < t.options.length; i++) {
        const { error: optErr } = await context.supabase.from("tracking_options" as never).upsert(
          {
            company_id: data.companyId,
            category_id: categoryId,
            name: t.options[i],
            is_active: true,
            sort_order: i,
          } as never,
          { onConflict: "category_id,name" } as never,
        );
        if (optErr && optErr.code !== "23505") throw new Error(optErr.message);
      }
    }

    const { error: settingsErr } = await context.supabase
      .from("company_coa_settings" as never)
      .upsert(
        {
          company_id: data.companyId,
          detail_level: data.level,
          industry_codes: data.industryCodes,
          catalog_version: CATALOG_VERSION,
          updated_at: new Date().toISOString(),
          updated_by: context.userId,
        } as never,
        { onConflict: "company_id" } as never,
      );
    if (settingsErr) throw new Error(settingsErr.message);

    const { error: logErr } = await context.supabase.from("coa_apply_events" as never).insert({
      company_id: data.companyId,
      actor_user_id: context.userId,
      detail_level: data.level,
      industry_codes: data.industryCodes,
      catalog_version: CATALOG_VERSION,
      created_count: created,
      skipped_count: preview.alreadyPresent.length + preview.skippedControls.length,
      conflict_count: preview.conflicts.length,
      details: {
        createdCodes,
        conflicts: preview.conflicts,
        trackingCategories: tracking.map((t) => t.name),
      },
    } as never);
    if (logErr) throw new Error(logErr.message);

    return {
      ok: true as const,
      created,
      alreadyPresent: preview.alreadyPresent.length,
      skippedControls: preview.skippedControls.length,
      conflicts: preview.conflicts.length,
      catalogVersion: CATALOG_VERSION,
      createdCodes,
    };
  });

export const createManualAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      code: string;
      name: string;
      accountType?: "asset" | "liability" | "equity" | "income" | "expense";
      subtype?: string;
      normalBalance?: "debit" | "credit";
      placementId?: string;
    }) => {
      const code = (input?.code ?? "").trim();
      const name = (input?.name ?? "").trim();
      if (!code || code.length > 10)
        throw new Error("Enter an account code of up to 10 characters.");
      if (!name || name.length > 150)
        throw new Error("Enter an account name of up to 150 characters.");
      const placement = input.placementId ? accountPlacementById(input.placementId) : undefined;
      if (input.placementId && !placement)
        throw new Error("Choose where this account appears in the reports.");
      const accountType = placement?.accountType ?? input.accountType;
      if (
        !accountType ||
        !["asset", "liability", "equity", "income", "expense"].includes(accountType)
      ) {
        throw new Error("Invalid account type.");
      }
      const normalBalance =
        placement?.normalBalance ??
        input.normalBalance ??
        (accountType === "asset" || accountType === "expense" ? "debit" : "credit");
      return {
        companyId: assertUuid(input.companyId),
        code,
        name,
        accountType,
        subtype: placement?.subtype ?? ((input.subtype ?? "").trim() || null),
        normalBalance,
        fsLine: placement?.fsLine ?? null,
        cashFlowClass: placement?.cashFlowClass ?? null,
        accountKind: input.placementId
          ? (accountKindForPlacement(input.placementId) ?? null)
          : null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    const { data: row, error } = await context.supabase
      .from("accounts" as never)
      .insert({
        company_id: data.companyId,
        code: data.code,
        name: data.name,
        account_type: data.accountType,
        normal_balance: data.normalBalance,
        subtype: data.subtype,
        ...(data.accountKind ? { account_kind: data.accountKind } : {}),
        ...(data.fsLine ? { fs_line: data.fsLine, cash_flow_class: data.cashFlowClass } : {}),
        source: "manual",
        is_system: false,
        is_postable: true,
        is_control: false,
        is_active: true,
      } as never)
      .select("id, code, name" as never)
      .single();
    if (error) {
      if (error.code === "23505" && error.message.includes("accounts_company_name_lower")) {
        throw new Error("An account with this name already exists.");
      }
      if (error.code === "23505") throw new Error("An account with this code already exists.");
      throw new Error(error.message);
    }
    return row as { id: string; code: string; name: string };
  });

export const addOptionalLibraryAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; keys: string[] }) => ({
    companyId: assertUuid(input?.companyId),
    keys: [...new Set((input?.keys ?? []).filter(Boolean))],
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    if (data.keys.length === 0) throw new Error("Select at least one optional account.");
    const existing = await loadExistingAccounts(context.supabase, data.companyId);
    const existingCodes = new Set(existing.map((e) => e.code));
    const existingKeys = new Set(existing.map((e) => e.catalog_key).filter(Boolean));
    let created = 0;
    for (const key of data.keys) {
      const lib = LIBRARY_ACCOUNTS.find((a) => a.key === key);
      if (!lib) continue;
      if (existingKeys.has(lib.key) || existingCodes.has(lib.code)) continue;
      const { error } = await context.supabase.from("accounts" as never).insert({
        company_id: data.companyId,
        code: lib.code,
        name: lib.name,
        account_type: lib.accountType,
        normal_balance: lib.normalBalance,
        subtype: lib.subtype,
        catalog_key: lib.key,
        recommendation_level: "optional",
        fs_line: lib.fsLine,
        cash_flow_class: lib.cashFlowClass,
        source: "optional",
        is_system: false,
        is_postable: true,
        is_control: false,
        is_active: true,
      } as never);
      if (error) {
        if (error.code === "23505") continue;
        throw new Error(error.message);
      }
      created += 1;
      existingCodes.add(lib.code);
      existingKeys.add(lib.key);
    }
    return { ok: true as const, created };
  });

export const listTrackingCategories = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(companyIdInput)
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: cats, error } = await context.supabase
      .from("tracking_categories" as never)
      .select("id, name, is_active, sort_order" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("sort_order" as never);
    if (error) throw new Error(error.message);
    const { data: opts, error: optErr } = await context.supabase
      .from("tracking_options" as never)
      .select("id, category_id, name, is_active, sort_order" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("sort_order" as never);
    if (optErr) throw new Error(optErr.message);
    const options = (opts ?? []) as Array<{
      id: string;
      category_id: string;
      name: string;
      is_active: boolean;
    }>;
    return ((cats ?? []) as Array<{ id: string; name: string; is_active: boolean }>).map((c) => ({
      ...c,
      options: options.filter((o) => o.category_id === c.id),
    }));
  });
