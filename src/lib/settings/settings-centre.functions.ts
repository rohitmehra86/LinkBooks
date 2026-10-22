import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import {
  CATEGORY_SCHEMAS,
  defaultDocumentFor,
  type SettingsCategory,
} from "@/lib/settings/registry";
import {
  FEATURE_CATALOG,
  computeFeatureState,
  type ComputedFeatureState,
} from "@/lib/settings/feature-catalog";
import { evaluateSettingsChange } from "@/lib/settings/dependency-engine";

/** JSON-serializable settings document for TanStack server functions. */
export type SettingsDocument = Record<
  string,
  string | number | boolean | null | Array<string | number>
>;

function asCategory(raw: string): SettingsCategory {
  return raw as SettingsCategory;
}

function toSettingsDocument(raw: unknown): SettingsDocument {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: SettingsDocument = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.filter(
        (x): x is string | number => typeof x === "string" || typeof x === "number",
      );
    }
  }
  return out;
}

export const getOrganisationConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; category: string }) => ({
    companyId: assertUuid(input.companyId),
    category: String(input.category || "").slice(0, 64),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("organisation_config" as never)
      .select("category, document, version, updated_at" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("category" as never, data.category as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const category = asCategory(data.category);
    if (!row) {
      return {
        category: data.category,
        document: toSettingsDocument(defaultDocumentFor(category)),
        version: 0,
        updated_at: null as string | null,
      };
    }
    const typed = row as {
      category: string;
      document: unknown;
      version: number;
      updated_at: string;
    };
    return {
      category: typed.category,
      document: toSettingsDocument(typed.document),
      version: typed.version,
      updated_at: typed.updated_at,
    };
  });

export const upsertOrganisationConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      category: string;
      document: SettingsDocument;
      expectedVersion?: number | null;
      reason?: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      category: String(input.category || "").slice(0, 64),
      document: toSettingsDocument(input.document ?? {}),
      expectedVersion:
        input.expectedVersion == null ? null : Math.floor(Number(input.expectedVersion)),
      reason: (input.reason ?? "").trim().slice(0, 500),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const schema = CATEGORY_SCHEMAS[asCategory(data.category)];
    let document: SettingsDocument = data.document;
    if (schema) {
      const parsed = schema.safeParse(data.document);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => i.message).join("; ") || "Invalid settings");
      }
      document = toSettingsDocument(parsed.data);
    }

    const { data: result, error } = await context.supabase.rpc("upsert_organisation_config" as never, {
      _company_id: data.companyId,
      _category: data.category,
      _document: document,
      _expected_version: data.expectedVersion,
      _reason: data.reason || null,
      _source: "ui",
      _request_id: null,
    } as never);
    if (error) throw new Error(error.message);
    const typed = result as { category: string; document: unknown; version: number };
    return {
      category: typed.category,
      document: toSettingsDocument(typed.document),
      version: typed.version,
    };
  });

export const listOrganisationFeatures = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }): Promise<ComputedFeatureState[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const canEdit = await context.supabase.rpc("has_company_permission" as never, {
      _company_id: data.companyId,
      _permission: "company.settings.edit",
    } as never);

    const { data: rows, error } = await context.supabase
      .from("organisation_features" as never)
      .select("feature_key, enabled, config" as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);

    const byKey = new Map(
      ((rows ?? []) as Array<{ feature_key: string; enabled: boolean; config: Record<string, unknown> }>).map(
        (r) => [r.feature_key, r],
      ),
    );

    const { data: configs } = await context.supabase
      .from("organisation_config" as never)
      .select("category, document" as never)
      .eq("company_id" as never, data.companyId as never);
    const configByCat = new Map(
      ((configs ?? []) as Array<{ category: string; document: Record<string, unknown> }>).map((c) => [
        c.category,
        c.document,
      ]),
    );

    const editOk = Boolean(canEdit.data);

    return FEATURE_CATALOG.map((def) => {
      const row = byKey.get(def.key);
      const enabled = row?.enabled ?? false;
      let configComplete = true;
      if (def.requiresConfigCategory === "sales" && enabled) {
        const doc = configByCat.get("sales") ?? {};
        if (def.key === "late_fees") {
          configComplete =
            Boolean(doc["late_fees_enabled"]) && Number(doc["late_fee_amount"] ?? 0) > 0;
        }
      }
      if (def.requiresConfigCategory === "automation" && enabled) {
        const doc = configByCat.get("automation") ?? {};
        configComplete = (doc["ai_mode"] as string | undefined) !== "off" && Boolean(doc["ai_mode"]);
      }
      if (def.requiresConfigCategory === "products" && enabled) {
        const doc = configByCat.get("products") ?? {};
        configComplete = Boolean(doc["track_inventory"]);
      }
      return computeFeatureState(def, {
        enabled,
        canEdit: editOk,
        configComplete,
        entitlementBlocked: false,
      });
    });
  });

export const setOrganisationFeature = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; featureKey: string; enabled: boolean; reason?: string }) => ({
      companyId: assertUuid(input.companyId),
      featureKey: String(input.featureKey || "").slice(0, 64),
      enabled: Boolean(input.enabled),
      reason: (input.reason ?? "").trim().slice(0, 500),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const def = FEATURE_CATALOG.find((f) => f.key === data.featureKey);
    if (!def) throw new Error("Unknown feature");
    if (def.implementation === "unavailable" && data.enabled) {
      throw new Error(`${def.label} is unavailable under the current implementation`);
    }

    if (!data.enabled) {
      const impact = evaluateSettingsChange({
        changeType: "disable_feature",
        featureKey: data.featureKey,
      });
      if (impact.verdict === "blocked") {
        throw new Error(impact.explanation);
      }
    }

    const { data: result, error } = await context.supabase.rpc("set_organisation_feature" as never, {
      _company_id: data.companyId,
      _feature_key: data.featureKey,
      _enabled: data.enabled,
      _config: {},
      _reason: data.reason || null,
      _source: "ui",
    } as never);
    if (error) throw new Error(error.message);
    return result as { feature_key: string; enabled: boolean };
  });

export const getLockPolicy = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("organisation_lock_policy" as never)
      .select(
        "lock_date_everyone, lock_date_except_advisors, conversion_date, require_override_reason, updated_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (
      (row as {
        lock_date_everyone: string | null;
        lock_date_except_advisors: string | null;
        conversion_date: string | null;
        require_override_reason: boolean;
        updated_at: string;
      } | null) ?? {
        lock_date_everyone: null,
        lock_date_except_advisors: null,
        conversion_date: null,
        require_override_reason: true,
        updated_at: null as string | null,
      }
    );
  });

export const setLockPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      lockDateEveryone?: string | null;
      lockDateExceptAdvisors?: string | null;
      conversionDate?: string | null;
      requireOverrideReason?: boolean;
      reason: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      lockDateEveryone: input.lockDateEveryone || null,
      lockDateExceptAdvisors: input.lockDateExceptAdvisors || null,
      conversionDate: input.conversionDate || null,
      requireOverrideReason: input.requireOverrideReason !== false,
      reason: String(input.reason || "").trim(),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "periods.lock");
    if (!data.reason) throw new Error("A reason is required to change lock dates");

    const impact = evaluateSettingsChange({ changeType: "change_lock_policy" });
    if (impact.verdict === "blocked") throw new Error(impact.explanation);

    const { data: result, error } = await context.supabase.rpc("set_organisation_lock_policy" as never, {
      _company_id: data.companyId,
      _lock_date_everyone: data.lockDateEveryone,
      _lock_date_except_advisors: data.lockDateExceptAdvisors,
      _conversion_date: data.conversionDate,
      _require_override_reason: data.requireOverrideReason,
      _reason: data.reason,
    } as never);
    if (error) throw new Error(error.message);
    return result;
  });

export const getSettingsOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input.companyId),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);

    const { data: company } = await context.supabase
      .from("companies" as never)
      .select("name, base_currency, fiscal_year_end_month, tax_regime, is_demo" as never)
      .eq("id" as never, data.companyId as never)
      .maybeSingle();

    const { data: lock } = await context.supabase
      .from("organisation_lock_policy" as never)
      .select("lock_date_everyone, lock_date_except_advisors, conversion_date" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();

    const { count: memberCount } = await context.supabase
      .from("company_members" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("company_id" as never, data.companyId as never);

    const features = await listOrganisationFeatures({ data: { companyId: data.companyId } });

    const warnings: Array<{ severity: "high" | "medium" | "low"; message: string; href?: string }> =
      [];
    const lockRow = lock as {
      lock_date_everyone: string | null;
      lock_date_except_advisors: string | null;
    } | null;
    if (!lockRow?.lock_date_everyone && !lockRow?.lock_date_except_advisors) {
      warnings.push({
        severity: "high",
        message: "No lock dates set — periods can still be locked individually under Accounting.",
        href: "/settings?section=accounting",
      });
    }
    warnings.push({
      severity: "medium",
      message: "Email delivery is not configured — invitations and reminders cannot be sent outbound.",
      href: "/settings?section=integrations",
    });
    warnings.push({
      severity: "low",
      message: "Bank feeds and payment gateways are not connected.",
      href: "/settings?section=integrations",
    });

    const incomplete = features.filter((f) => f.state === "enabled_needs_config").map((f) => f.label);

    const lockPolicy = (lock as {
      lock_date_everyone: string | null;
      lock_date_except_advisors: string | null;
      conversion_date: string | null;
    } | null) ?? {
      lock_date_everyone: null,
      lock_date_except_advisors: null,
      conversion_date: null,
    };

    return {
      company: (company as {
        name: string;
        base_currency: string;
        fiscal_year_end_month: number;
        tax_regime: string | null;
        is_demo: boolean;
      } | null),
      lockPolicy,
      memberCount: memberCount ?? 0,
      warnings,
      incompleteConfigurations: incomplete,
      featureSummary: {
        operational: features.filter((f) => f.state === "enabled_operational").length,
        needsConfig: incomplete.length,
        unavailable: features.filter((f) => f.state === "unavailable").length,
        disabled: features.filter((f) => f.state === "available_disabled").length,
      },
      integrations: [
        { name: "Outbound email", status: "unavailable" as const },
        { name: "Live FX feed", status: "unavailable" as const },
        { name: "Bank aggregator", status: "unavailable" as const },
        { name: "Payment gateway", status: "unavailable" as const },
      ],
    };
  });

export const listSettingsChangeLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; category?: string; limit?: number; offset?: number }) => ({
      companyId: assertUuid(input.companyId),
      category: input.category ? String(input.category).slice(0, 64) : null,
      limit: Math.min(100, Math.max(1, Math.floor(Number(input.limit ?? 25) || 25))),
      offset: Math.max(0, Math.floor(Number(input.offset ?? 0) || 0)),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "audit.view");
    let q = context.supabase
      .from("settings_change_log" as never)
      .select(
        "id, category, setting_key, old_value, new_value, reason, source, created_at, actor_user_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("created_at" as never, { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);
    if (data.category) {
      q = q.eq("category" as never, data.category as never);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Array<{
      id: string;
      category: string;
      setting_key: string;
      old_value: unknown;
      new_value: unknown;
      reason: string | null;
      source: string;
      created_at: string;
      actor_user_id: string | null;
    }>).map((r) => ({
      id: r.id,
      category: r.category,
      setting_key: r.setting_key,
      old_value_json: r.old_value == null ? null : JSON.stringify(r.old_value),
      new_value_json: r.new_value == null ? null : JSON.stringify(r.new_value),
      reason: r.reason,
      source: r.source,
      created_at: r.created_at,
      actor_user_id: r.actor_user_id,
    }));
  });

export const evaluateFeatureChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { companyId: string; featureKey: string; enabled: boolean }) => ({
      companyId: assertUuid(input.companyId),
      featureKey: String(input.featureKey || "").slice(0, 64),
      enabled: Boolean(input.enabled),
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);

    let foreignCurrencyBalances = 0;
    let openFxDocuments = 0;
    if (data.featureKey === "multicurrency" && !data.enabled) {
      const { count } = await context.supabase
        .from("company_currencies" as never)
        .select("currency_code" as never, { count: "exact", head: true })
        .eq("company_id" as never, data.companyId as never);
      foreignCurrencyBalances = count ?? 0;
    }

    return evaluateSettingsChange({
      changeType: data.enabled ? "enable_feature" : "disable_feature",
      featureKey: data.featureKey,
      context: { foreignCurrencyBalances, openFxDocuments },
    });
  });

export const writeOrganisationSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; secretKey: string; plaintext: string }) => ({
    companyId: assertUuid(input.companyId),
    secretKey: String(input.secretKey || "").slice(0, 64),
    plaintext: String(input.plaintext || ""),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const { data: result, error } = await context.supabase.rpc("write_organisation_secret" as never, {
      _company_id: data.companyId,
      _secret_key: data.secretKey,
      _plaintext: data.plaintext,
    } as never);
    if (error) throw new Error(error.message);
    return result as { secret_key: string; last4: string; rotated: boolean };
  });

/** Whether a dimension feature is enabled for form visibility. */
export const isDimensionFeatureEnabled = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; featureKey: string }) => ({
    companyId: assertUuid(input.companyId),
    featureKey: String(input.featureKey || "").slice(0, 64),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row } = await context.supabase
      .from("organisation_features" as never)
      .select("enabled" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("feature_key" as never, data.featureKey as never)
      .maybeSingle();
    if (!row) {
      // Default: classes/locations/projects on for backward compatibility
      return ["classes", "locations", "projects", "purchase_orders", "billable_expenses", "discounts", "recurring_transactions", "multicurrency", "advanced_approvals"].includes(
        data.featureKey,
      );
    }
    return Boolean((row as { enabled: boolean }).enabled);
  });
