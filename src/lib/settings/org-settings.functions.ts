import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertCompanyMember,
  assertCompanyPermission,
} from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import type { CompanyRole } from "@/lib/company-constants";

const DOCUMENT_TYPES = [
  "sales_invoice",
  "purchase_bill",
  "sales_quote",
  "sales_credit_note",
  "purchase_credit_note",
] as const;

const LOCALES = ["en-GB", "en-US", "en-AU", "en-NZ", "en-IE", "en-CA"] as const;
const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const;

async function audit(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }> },
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

export const getOrgExtendedSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: company, error } = await context.supabase
      .from("companies" as never)
      .select(
        "locale, date_format, invoice_footer, document_theme_color, base_currency, is_demo" as never,
      )
      .eq("id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const { data: branding } = await context.supabase
      .from("company_branding" as never)
      .select("trading_name, letterhead_line, invoice_email, invoice_phone, logo_url" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();

    const { data: sequences } = await context.supabase
      .from("document_sequences" as never)
      .select("document_type, prefix, next_number, padding" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("document_type" as never);

    const { data: currencies } = await context.supabase
      .from("company_currencies" as never)
      .select("currency_code" as never)
      .eq("company_id" as never, data.companyId as never);

    const { data: rates } = await context.supabase
      .from("exchange_rates" as never)
      .select(
        "id, from_currency, to_currency, rate_date, rate, note, voided_at, created_at" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("rate_date" as never, { ascending: false })
      .limit(50);

    return {
      company: company as {
        locale: string;
        date_format: string;
        invoice_footer: string;
        document_theme_color: string;
        base_currency: string;
        is_demo: boolean;
      } | null,
      branding: (branding as {
        trading_name: string | null;
        letterhead_line: string | null;
        invoice_email: string | null;
        invoice_phone: string | null;
        logo_url: string | null;
      } | null) ?? {
        trading_name: null,
        letterhead_line: null,
        invoice_email: null,
        invoice_phone: null,
        logo_url: null,
      },
      sequences: (sequences ?? []) as Array<{
        document_type: string;
        prefix: string;
        next_number: number;
        padding: number;
      }>,
      enabledCurrencies: ((currencies ?? []) as Array<{ currency_code: string }>).map(
        (c) => c.currency_code,
      ),
      exchangeRates: (rates ?? []) as Array<{
        id: string;
        from_currency: string;
        to_currency: string;
        rate_date: string;
        rate: number;
        note: string | null;
        voided_at: string | null;
        created_at: string;
      }>,
      documentTypes: [...DOCUMENT_TYPES],
      locales: [...LOCALES],
      dateFormats: [...DATE_FORMATS],
    };
  });

export const updateLocalization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      locale: string;
      date_format: string;
      invoice_footer: string;
      document_theme_color: string;
    }) => {
      const locale = LOCALES.includes(input.locale as (typeof LOCALES)[number])
        ? input.locale
        : "en-GB";
      const date_format = DATE_FORMATS.includes(input.date_format as (typeof DATE_FORMATS)[number])
        ? input.date_format
        : "DD/MM/YYYY";
      const color = (input.document_theme_color ?? "").trim();
      if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) throw new Error("Theme colour must be #RRGGBB");
      return {
        companyId: assertUuid(input.companyId),
        locale,
        date_format,
        invoice_footer: (input.invoice_footer ?? "").slice(0, 2000),
        document_theme_color: color || "#0F766E",
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const { error } = await context.supabase
      .from("companies" as never)
      .update({
        locale: data.locale,
        date_format: data.date_format,
        invoice_footer: data.invoice_footer,
        document_theme_color: data.document_theme_color,
      } as never)
      .eq("id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    await audit(context.supabase as never, data.companyId, "settings.localization", "company", data.companyId, {
      locale: data.locale,
      date_format: data.date_format,
    });
    return { ok: true };
  });

export const upsertBranding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      trading_name: string;
      letterhead_line: string;
      invoice_email: string;
      invoice_phone: string;
      logo_url: string;
    }) => ({
      companyId: assertUuid(input.companyId),
      trading_name: (input.trading_name ?? "").trim().slice(0, 160) || null,
      letterhead_line: (input.letterhead_line ?? "").trim().slice(0, 200) || null,
      invoice_email: (input.invoice_email ?? "").trim().slice(0, 160) || null,
      invoice_phone: (input.invoice_phone ?? "").trim().slice(0, 40) || null,
      logo_url: (input.logo_url ?? "").trim().slice(0, 500) || null,
    }),
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const { error } = await context.supabase.from("company_branding" as never).upsert(
      {
        company_id: data.companyId,
        trading_name: data.trading_name,
        letterhead_line: data.letterhead_line,
        invoice_email: data.invoice_email,
        invoice_phone: data.invoice_phone,
        logo_url: data.logo_url,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "company_id" },
    );
    if (error) throw new Error(error.message);
    await audit(context.supabase as never, data.companyId, "settings.branding", "company", data.companyId, {});
    return { ok: true };
  });

export const updateDocumentSequence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      document_type: string;
      prefix: string;
      next_number: number;
      padding: number;
    }) => {
      if (!(DOCUMENT_TYPES as readonly string[]).includes(input.document_type)) {
        throw new Error("Unknown document type");
      }
      const next = Number(input.next_number);
      const pad = Number(input.padding);
      if (!Number.isInteger(next) || next < 1) throw new Error("Next number must be ≥ 1");
      if (!Number.isInteger(pad) || pad < 1 || pad > 10) throw new Error("Padding must be 1–10");
      return {
        companyId: assertUuid(input.companyId),
        document_type: input.document_type,
        prefix: (input.prefix ?? "").trim().slice(0, 20),
        next_number: next,
        padding: pad,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const { error } = await context.supabase.from("document_sequences" as never).upsert(
      {
        company_id: data.companyId,
        document_type: data.document_type,
        prefix: data.prefix,
        next_number: data.next_number,
        padding: data.padding,
      } as never,
      { onConflict: "company_id,document_type" },
    );
    if (error) throw new Error(error.message);
    await audit(context.supabase as never, data.companyId, "settings.sequence", "document_sequence", null, {
      document_type: data.document_type,
      next_number: data.next_number,
    });
    return { ok: true };
  });

export const setEnabledCurrencies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; currencies: string[] }) => ({
    companyId: assertUuid(input.companyId),
    currencies: [...new Set((input.currencies ?? []).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)))],
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const { data: company } = await context.supabase
      .from("companies")
      .select("base_currency")
      .eq("id", data.companyId)
      .maybeSingle();
    const base = company?.base_currency ?? "GBP";
    await context.supabase
      .from("company_currencies" as never)
      .delete()
      .eq("company_id" as never, data.companyId as never);
    const rows = data.currencies
      .filter((c) => c !== base)
      .map((currency_code) => ({ company_id: data.companyId, currency_code }));
    if (rows.length) {
      const { error } = await context.supabase.from("company_currencies" as never).insert(rows as never);
      if (error) throw new Error(error.message);
    }
    await audit(context.supabase as never, data.companyId, "settings.currencies", "company", data.companyId, {
      currencies: data.currencies,
    });
    return { ok: true };
  });

export const createExchangeRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      from_currency: string;
      to_currency: string;
      rate_date: string;
      rate: number | string;
      note?: string;
    }) => {
      const from = (input.from_currency ?? "").toUpperCase();
      const to = (input.to_currency ?? "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw new Error("Invalid currency");
      if (from === to) throw new Error("Currencies must differ");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.rate_date ?? "")) throw new Error("rate_date must be YYYY-MM-DD");
      const rate = Number(input.rate);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error("Rate must be positive");
      return {
        companyId: assertUuid(input.companyId),
        from_currency: from,
        to_currency: to,
        rate_date: input.rate_date,
        rate,
        note: (input.note ?? "").trim().slice(0, 200) || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const { data: row, error } = await context.supabase
      .from("exchange_rates" as never)
      .insert({
        company_id: data.companyId,
        from_currency: data.from_currency,
        to_currency: data.to_currency,
        rate_date: data.rate_date,
        rate: data.rate,
        note: data.note,
        created_by: context.userId,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const id = (row as { id: string }).id;
    await audit(context.supabase as never, data.companyId, "exchange_rate.create", "exchange_rate", id, {
      from: data.from_currency,
      to: data.to_currency,
      rate_date: data.rate_date,
      rate: data.rate,
    });
    return { id };
  });

export const voidExchangeRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { rateId: string }) => ({ rateId: assertUuid(input.rateId, "rate") }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("void_exchange_rate" as never, {
      _rate_id: data.rateId,
    } as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateMemberRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; userId: string; role: CompanyRole }) => {
    const allowed: CompanyRole[] = ["owner", "admin", "accountant", "bookkeeper", "staff", "read_only"];
    if (!allowed.includes(input.role)) throw new Error("Invalid role");
    return {
      companyId: assertUuid(input.companyId),
      userId: assertUuid(input.userId, "user"),
      role: input.role,
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "members.manage");
    if (data.role === "owner") {
      await assertCompanyPermission(context.supabase, data.companyId, "members.grant_owner");
    }

    const { data: target } = await context.supabase
      .from("company_members")
      .select("role")
      .eq("company_id", data.companyId)
      .eq("user_id", data.userId)
      .maybeSingle();
    if (!target) throw new Error("Member not found");

    if (target.role === "owner" && data.role !== "owner") {
      const { count } = await context.supabase
        .from("company_members")
        .select("user_id", { count: "exact", head: true })
        .eq("company_id", data.companyId)
        .eq("role", "owner")
        .eq("status", "active");
      if ((count ?? 0) <= 1) throw new Error("Cannot remove the last owner");
    }

    const { error } = await context.supabase
      .from("company_members")
      .update({ role: data.role })
      .eq("company_id", data.companyId)
      .eq("user_id", data.userId);
    if (error) throw new Error(error.message);

    await audit(context.supabase as never, data.companyId, "members.role_change", "company_member", data.userId, {
      from: target.role,
      to: data.role,
    });
    return { ok: true };
  });

export const resetDemoCompany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "demo.reset");
    const { data: company } = await context.supabase
      .from("companies")
      .select("is_demo")
      .eq("id", data.companyId)
      .maybeSingle();
    if (!company?.is_demo) throw new Error("Only Demo Company can be reset");
    const { error } = await context.supabase.rpc("reset_demo_company" as never, {
      _company_id: data.companyId,
    } as never);
    if (error) throw new Error(error.message);
    const { seedDemoCompanyData } = await import("@/lib/demo/seed-demo");
    const seeded = await seedDemoCompanyData(context.supabase, {
      companyId: data.companyId,
      userId: context.userId,
    });
    return { ok: true, ...seeded };
  });

export const listCompanyAuditEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; limit?: number }) => ({
    companyId: assertUuid(input.companyId),
    limit: Math.min(Math.max(Number(input.limit) || 50, 1), 200),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "audit.view");
    const { data: rows, error } = await context.supabase
      .from("audit_events" as never)
      .select("id, action, entity_type, entity_id, details, actor_user_id, created_at" as never)
      .eq("company_id" as never, data.companyId as never)
      .order("created_at" as never, { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Array<{
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      details: unknown;
      actor_user_id: string | null;
      created_at: string;
    }>).map((r) => ({
      id: r.id,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      details_json: JSON.stringify(r.details ?? {}),
      actor_user_id: r.actor_user_id,
      created_at: r.created_at,
    }));
  });
