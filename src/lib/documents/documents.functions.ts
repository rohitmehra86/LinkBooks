import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { daysOverdue, safeAccentColor } from "@/lib/documents/helpers";
import {
  defaultTemplateFor,
  isEmailTemplate,
  parseRecipients,
  renderEmail,
  type EmailInput,
  type EmailTemplate,
} from "@/lib/documents/email-templates";
import {
  loadCompanyDocContext,
  loadPrintDocument,
  sendPermissionFor,
  viewPermissionFor,
} from "@/lib/documents/documents-loader";
import { mapBranding, mapSalesInvoice } from "@/lib/documents/mappers";
import {
  DEFAULT_REMINDER_SETTINGS,
  normaliseReminderSettings,
  reminderDecision,
  type ReminderSettings,
} from "@/lib/documents/reminders";
import {
  DOCUMENT_KIND_LABEL,
  isDocumentKind,
  type DocumentKind,
  type PrintDocument,
} from "@/lib/documents/types";
import { loadCustomerStatement } from "@/lib/sales/sales-statements.functions";
import { fetchAllPages } from "@/lib/sales/fetch-all";
import { isMissingRpc, type SalesClient } from "@/lib/sales/rpc";
import { isIsoDateString } from "@/lib/sales/list-filters";

type Db = SalesClient;
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

const MIGRATION_HINT =
  "This needs a database update that has not been applied yet (migrations 20261025200000–20261025200300). Ask an administrator to apply the latest migrations.";

function rpcClient(db: Db): RpcClient {
  return db as unknown as RpcClient;
}

// ---------------------------------------------------------------------------
// Printable document
// ---------------------------------------------------------------------------

export const getPrintableDocument = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; kind: string; id: string }) => {
    if (!isDocumentKind(input.kind)) throw new Error("Unknown document type");
    return {
      companyId: assertUuid(input.companyId),
      kind: input.kind,
      id: assertUuid(input.id, "document"),
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, viewPermissionFor(data.kind));
    const ctx = await loadCompanyDocContext(supabase, data.companyId);
    const document = await loadPrintDocument(supabase, data.companyId, data.kind, data.id, ctx);
    return {
      document,
      branding: ctx.branding,
      locale: ctx.locale,
      dateFormat: ctx.dateFormat,
      today: ctx.today,
    };
  });

export const getDocumentBranding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const ctx = await loadCompanyDocContext(context.supabase, data.companyId);
    return {
      branding: ctx.branding,
      locale: ctx.locale,
      dateFormat: ctx.dateFormat,
      today: ctx.today,
    };
  });

// ---------------------------------------------------------------------------
// Branding settings
// ---------------------------------------------------------------------------

export const getBrandingSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const ctx = await loadCompanyDocContext(context.supabase, data.companyId);
    const raw = (ctx.rawBranding ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
    return {
      tradingName: s("trading_name"),
      letterheadLine: s("letterhead_line"),
      invoiceEmail: s("invoice_email"),
      invoicePhone: s("invoice_phone"),
      addressText: s("address_text"),
      taxNumber: s("tax_number"),
      bankDetails: s("bank_details"),
      paymentInstructions: s("payment_instructions"),
      defaultNotes: s("default_notes"),
      logoPath: s("logo_path"),
      externalLogoUrl: s("logo_url"),
      accentColor: ctx.branding.accentColor,
      footerText: ctx.branding.footerText ?? "",
      logoPreviewUrl: ctx.branding.logoUrl,
      // True once the wave 2-F migration has added the new branding columns.
      extendedFieldsAvailable: ctx.rawBranding === null ? null : "address_text" in raw,
      companyName: String(ctx.company["name"] ?? ""),
    };
  });

export const saveBrandingSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      tradingName: string;
      letterheadLine: string;
      invoiceEmail: string;
      invoicePhone: string;
      addressText: string;
      taxNumber: string;
      bankDetails: string;
      paymentInstructions: string;
      defaultNotes: string;
      accentColor: string;
      footerText: string;
      /** undefined = keep, null / "" = remove, string = new object path in org-logos. */
      logoPath?: string | null;
    }) => {
      const clip = (v: string, n: number) => (v ?? "").trim().slice(0, n) || null;
      const email = clip(input.invoiceEmail, 160);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error("Enter a valid invoice email address.");
      const colour = (input.accentColor ?? "").trim();
      if (colour && !/^#[0-9A-Fa-f]{6}$/.test(colour))
        throw new Error("Accent colour must be #RRGGBB.");
      const companyId = assertUuid(input.companyId);
      let logoPath: string | null | undefined = undefined;
      if (input.logoPath !== undefined) {
        const p = (input.logoPath ?? "").trim();
        if (p && (!p.startsWith(`${companyId}/`) || p.includes("..") || p.length > 300)) {
          throw new Error("Invalid logo path");
        }
        logoPath = p || null;
      }
      return {
        companyId,
        tradingName: clip(input.tradingName, 160),
        letterheadLine: clip(input.letterheadLine, 200),
        invoiceEmail: email,
        invoicePhone: clip(input.invoicePhone, 40),
        addressText: clip(input.addressText, 500),
        taxNumber: clip(input.taxNumber, 60),
        bankDetails: clip(input.bankDetails, 800),
        paymentInstructions: clip(input.paymentInstructions, 800),
        defaultNotes: clip(input.defaultNotes, 1000),
        accentColor: colour ? safeAccentColor(colour) : "#0F766E",
        footerText: (input.footerText ?? "").trim().slice(0, 2000),
        logoPath,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "company.settings.edit");

    const existing = await supabase
      .from("company_branding" as never)
      .select("logo_path" as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    const previousLogo = (existing.data as { logo_path?: string | null } | null)?.logo_path ?? null;

    const row: Record<string, unknown> = {
      company_id: data.companyId,
      trading_name: data.tradingName,
      letterhead_line: data.letterheadLine,
      invoice_email: data.invoiceEmail,
      invoice_phone: data.invoicePhone,
      address_text: data.addressText,
      tax_number: data.taxNumber,
      bank_details: data.bankDetails,
      payment_instructions: data.paymentInstructions,
      default_notes: data.defaultNotes,
      updated_at: new Date().toISOString(),
    };
    if (data.logoPath !== undefined) row["logo_path"] = data.logoPath;

    const { error } = await supabase
      .from("company_branding" as never)
      .upsert(row as never, { onConflict: "company_id" });
    if (error) {
      if (error.code === "42703" || error.code === "PGRST204") throw new Error(MIGRATION_HINT);
      throw new Error(error.message);
    }
    const { error: cErr } = await supabase
      .from("companies" as never)
      .update({ document_theme_color: data.accentColor, invoice_footer: data.footerText } as never)
      .eq("id" as never, data.companyId as never);
    if (cErr) throw new Error(cErr.message);

    // Remove the replaced logo object (best effort; the new path is already saved).
    if (data.logoPath !== undefined && previousLogo && previousLogo !== data.logoPath) {
      await supabase.storage.from("org-logos").remove([previousLogo]);
    }
    await rpcClient(supabase).rpc("record_audit_event", {
      _company_id: data.companyId,
      _action: "settings.branding",
      _entity_type: "company",
      _entity_id: data.companyId,
      _details: {},
    });
    return { ok: true as const };
  });

// ---------------------------------------------------------------------------
// E-mail: status, history, send
// ---------------------------------------------------------------------------

export type EmailHistoryRow = {
  id: string;
  template: string;
  to_addresses: string[];
  subject: string;
  status: "sent" | "failed";
  error: string | null;
  created_at: string;
  sent_by: string | null;
};

type EmailState =
  { configured: true; blockedReason: null | "demo" } | { configured: false; blockedReason: null };

async function emailState(isDemo: boolean): Promise<EmailState> {
  const { readEmailConfig } = await import("@/lib/documents/email-provider.server");
  const cfg = readEmailConfig();
  if (!cfg.configured) return { configured: false, blockedReason: null };
  return { configured: true, blockedReason: isDemo ? "demo" : null };
}

/** Delivery panel data for one document: provider status, send history, online link state. */
export const getDocumentDelivery = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; kind: string; id: string }) => {
    if (!isDocumentKind(input.kind) && input.kind !== "customer_statement") {
      throw new Error("Unknown document type");
    }
    return {
      companyId: assertUuid(input.companyId),
      kind: input.kind,
      id: assertUuid(input.id, "document"),
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyMember(supabase, data.companyId);
    const { data: company } = await supabase
      .from("companies" as never)
      .select("is_demo" as never)
      .eq("id" as never, data.companyId as never)
      .maybeSingle();
    const state = await emailState(Boolean((company as { is_demo?: boolean } | null)?.is_demo));

    const entityType = data.kind === "customer_statement" ? "contact" : data.kind;
    const hist = await supabase
      .from("email_outbox" as never)
      .select("id, template, to_addresses, subject, status, error, created_at, sent_by" as never)
      .eq("company_id" as never, data.companyId as never)
      .eq("entity_type" as never, entityType as never)
      .eq("entity_id" as never, data.id as never)
      .order("created_at" as never, { ascending: false } as never)
      .limit(25);
    // A missing table just means the migration is not applied: show no history, not an error.
    const history = (hist.error ? [] : (hist.data ?? [])) as unknown as EmailHistoryRow[];

    let share: { active: number; views: number; lastViewedAt: string | null } | null = null;
    if (data.kind === "sales_invoice") {
      const links = await supabase
        .from("document_share_links" as never)
        .select("id, revoked_at, expires_at, view_count, last_viewed_at" as never)
        .eq("company_id" as never, data.companyId as never)
        .eq("entity_id" as never, data.id as never);
      if (!links.error) {
        const now = Date.now();
        const rows = (links.data ?? []) as unknown as Array<{
          revoked_at: string | null;
          expires_at: string | null;
          view_count: number;
          last_viewed_at: string | null;
        }>;
        const active = rows.filter(
          (r) => !r.revoked_at && (!r.expires_at || Date.parse(r.expires_at) > now),
        );
        share = {
          active: active.length,
          views: rows.reduce((s, r) => s + Number(r.view_count ?? 0), 0),
          lastViewedAt:
            rows
              .map((r) => r.last_viewed_at)
              .filter((v): v is string => Boolean(v))
              .sort()
              .pop() ?? null,
        };
      }
    }
    return {
      emailConfigured: state.configured,
      blockedReason: state.blockedReason,
      history,
      share,
    };
  });

/** Origin used in links sent by e-mail: APP_BASE_URL if set, otherwise the request origin. */
function appBaseUrl(): string | null {
  const configured = (process.env["APP_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^\s]+$/i.test(configured)) return configured;
  try {
    const req = getRequest();
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host =
      req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? req.headers.get("host");
    if (host && /^[A-Za-z0-9.:-]+$/.test(host))
      return `${proto === "http" ? "http" : "https"}://${host}`;
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

async function createInvoiceLink(
  db: Db,
  companyId: string,
  invoiceId: string,
  expiresInDays: number | null,
): Promise<{ url: string; expiresAt: string | null } | null> {
  const { data, error } = await rpcClient(db).rpc("create_invoice_share_link", {
    _company_id: companyId,
    _invoice_id: invoiceId,
    _expires_in_days: expiresInDays,
  });
  if (error) {
    if (isMissingRpc(error, "create_invoice_share_link")) return null;
    throw new Error(error.message ?? "Could not create the link");
  }
  const base = appBaseUrl();
  const r = data as { token?: string; expires_at?: string | null } | null;
  if (!base || !r?.token) return null;
  return { url: `${base}/share/invoice/${r.token}`, expiresAt: r.expires_at ?? null };
}

export type SendEmailResult =
  | { sent: true; recordWarning: string | null }
  | { sent: false; reason: "not_configured" | "demo" | "no_recipient" | "failed"; message: string };

type SendInput = {
  companyId: string;
  kind: DocumentKind | "customer_statement";
  id: string;
  template: EmailTemplate;
  to: string[];
  message: string | null;
  from: string | null;
  toDate: string | null;
};

async function sendOne(db: Db, input: SendInput): Promise<SendEmailResult> {
  const { readEmailConfig, sendViaResend } = await import("@/lib/documents/email-provider.server");
  const ctx = await loadCompanyDocContext(db, input.companyId);
  const cfg = readEmailConfig();
  if (!cfg.configured) {
    return {
      sent: false,
      reason: "not_configured",
      message:
        "Email sending is not configured. Download the PDF, copy the link, or use your own email program.",
    };
  }
  if (ctx.isDemo) {
    return {
      sent: false,
      reason: "demo",
      message:
        "Email sending is switched off in the Demo Company so sample customers are never emailed.",
    };
  }
  if (!input.to.length)
    return { sent: false, reason: "no_recipient", message: "Enter at least one valid recipient." };

  const branding = ctx.branding;
  let email: EmailInput;
  let entityType: string;
  let entityId: string;

  if (input.kind === "customer_statement") {
    const stmt = await loadCustomerStatement(db, {
      companyId: input.companyId,
      contactId: input.id,
      from: input.from,
      to: input.toDate,
    });
    const { data: contact } = await db
      .from("contacts" as never)
      .select("name" as never)
      .eq("id" as never, input.id as never)
      .eq("company_id" as never, input.companyId as never)
      .maybeSingle();
    email = {
      companyName: branding.displayName,
      partyName: (contact as { name?: string } | null)?.name ?? "customer",
      documentLabel: "Statement",
      documentNumber: null,
      currency: ctx.baseCurrency,
      totalMinor: 0,
      dueMinor: null,
      issueDate: null,
      dueDate: null,
      daysOverdue: 0,
      link: null,
      customMessage: input.message,
      locale: ctx.locale,
      dateFormat: ctx.dateFormat,
      bankDetails: branding.bankDetails,
      statement: {
        from: stmt.from,
        to: stmt.to,
        rows: stmt.currencies.map((c) => ({
          currency: c.currency_code,
          openingMinor: c.opening_balance_minor,
          closingMinor: c.closing_balance_minor,
        })),
      },
    };
    entityType = "contact";
    entityId = input.id;
  } else {
    const doc = await loadPrintDocument(db, input.companyId, input.kind, input.id, ctx);
    if (doc.mark === "DRAFT") {
      return {
        sent: false,
        reason: "failed",
        message: "Authorise the document before sending it.",
      };
    }
    if (doc.mark === "VOID" && input.template !== "reminder") {
      return { sent: false, reason: "failed", message: "A void document cannot be sent." };
    }
    if (
      input.template === "reminder" &&
      (doc.kind !== "sales_invoice" || (doc.totals.dueMinor ?? 0) <= 0)
    ) {
      return {
        sent: false,
        reason: "failed",
        message: "Reminders can only be sent for invoices with an amount due.",
      };
    }
    let link: string | null = null;
    if (doc.kind === "sales_invoice" && doc.mark !== "VOID") {
      const created = await createInvoiceLink(db, input.companyId, input.id, null);
      link = created?.url ?? null;
    }
    email = {
      companyName: branding.displayName,
      partyName: doc.party.name,
      documentLabel: DOCUMENT_KIND_LABEL[doc.kind],
      documentNumber: doc.number,
      currency: doc.currency,
      totalMinor:
        input.template === "receipt" || input.template === "remittance"
          ? (doc.paymentAmountMinor ?? doc.totals.totalMinor)
          : doc.totals.totalMinor,
      dueMinor: doc.totals.dueMinor,
      issueDate: doc.issueDate,
      dueDate: doc.dueDate,
      daysOverdue: doc.dueDate ? daysOverdue(doc.dueDate, ctx.today) : 0,
      link,
      customMessage: input.message,
      locale: ctx.locale,
      dateFormat: ctx.dateFormat,
      bankDetails:
        doc.showPaymentDetails &&
        (input.template !== "reminder" ||
          (await loadReminderSettings(db, input.companyId)).includeBankDetails)
          ? branding.bankDetails
          : null,
    };
    entityType = doc.kind;
    entityId = doc.id;
  }

  const rendered = renderEmail(input.template, email);
  const result = await sendViaResend(cfg, {
    to: input.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: branding.email,
  });

  let recordWarning: string | null = null;
  const { error: recErr } = await rpcClient(db).rpc("record_email_outbox", {
    payload: {
      company_id: input.companyId,
      entity_type: entityType,
      entity_id: entityId,
      template: input.template,
      to: input.to,
      subject: rendered.subject,
      provider: cfg.provider,
      provider_message_id: result.ok ? result.messageId : null,
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : result.error,
    },
  });
  if (recErr) {
    recordWarning = isMissingRpc(recErr, "record_email_outbox")
      ? "The send history table is not available yet (migration 20261025200200)."
      : (recErr.message ?? "Could not record the send history.");
  }

  if (!result.ok) {
    return {
      sent: false,
      reason: "failed",
      message: `The email provider rejected the message: ${result.error}`,
    };
  }
  if (input.kind === "sales_invoice") {
    // Best effort: stamp the first send on the invoice so it shows as "Sent".
    await db
      .from("sales_invoices" as never)
      .update({ sent_at: new Date().toISOString() } as never)
      .eq("id" as never, input.id as never)
      .eq("company_id" as never, input.companyId as never)
      .is("sent_at" as never, null as never);
  }
  return { sent: true, recordWarning };
}

export const sendDocumentEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      kind: string;
      id: string;
      template?: string;
      to: string;
      message?: string;
      from?: string;
      toDate?: string;
    }): SendInput => {
      const kind = input.kind === "customer_statement" ? "customer_statement" : input.kind;
      if (kind !== "customer_statement" && !isDocumentKind(kind))
        throw new Error("Unknown document type");
      const template: EmailTemplate | null =
        kind === "customer_statement"
          ? "statement"
          : isEmailTemplate(input.template) &&
              (input.template === "reminder" ||
                input.template === defaultTemplateFor(kind as DocumentKind))
            ? input.template
            : defaultTemplateFor(kind as DocumentKind);
      if (!template) throw new Error("This document type is not sent to anyone from LinkBooks.");
      const { valid, invalid } = parseRecipients(input.to ?? "");
      if (invalid.length) throw new Error(`Invalid email address: ${invalid.join(", ")}`);
      if (valid.length > 5) throw new Error("Send to at most 5 recipients at a time.");
      return {
        companyId: assertUuid(input.companyId),
        kind: kind as SendInput["kind"],
        id: assertUuid(input.id, "document"),
        template,
        to: valid,
        message: (input.message ?? "").trim().slice(0, 1500) || null,
        from: isIsoDateString(input.from) ? input.from : null,
        toDate: isIsoDateString(input.toDate) ? input.toDate : null,
      };
    },
  )
  .handler(async ({ data, context }): Promise<SendEmailResult> => {
    const { supabase } = context;
    await assertCompanyPermission(
      supabase,
      data.companyId,
      data.kind === "customer_statement" ? "sales.draft" : sendPermissionFor(data.kind),
    );
    return sendOne(supabase, data);
  });

// ---------------------------------------------------------------------------
// Online invoice link
// ---------------------------------------------------------------------------

export const createInvoiceShareLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string; expiresInDays?: number }) => {
    const days = input.expiresInDays === undefined ? null : Math.floor(Number(input.expiresInDays));
    if (days !== null && (!Number.isFinite(days) || days < 1 || days > 3650)) {
      throw new Error("Expiry must be between 1 and 3650 days.");
    }
    return {
      companyId: assertUuid(input.companyId),
      invoiceId: assertUuid(input.invoiceId, "invoice"),
      days,
    };
  })
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    const link = await createInvoiceLink(
      context.supabase,
      data.companyId,
      data.invoiceId,
      data.days,
    );
    if (!link) throw new Error(MIGRATION_HINT);
    return link;
  });

export const revokeInvoiceShareLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceId: string }) => ({
    companyId: assertUuid(input.companyId),
    invoiceId: assertUuid(input.invoiceId, "invoice"),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "sales.draft");
    const { data: n, error } = await rpcClient(context.supabase).rpc("revoke_invoice_share_links", {
      _company_id: data.companyId,
      _invoice_id: data.invoiceId,
    });
    if (error) {
      if (isMissingRpc(error, "revoke_invoice_share_links")) throw new Error(MIGRATION_HINT);
      throw new Error(error.message ?? "Could not revoke the links");
    }
    return { revoked: Number(n ?? 0) };
  });

/** PUBLIC: one invoice by token. No sign-in. Returns null for unknown / revoked / expired. */
export const getSharedInvoice = createServerFn({ method: "GET" })
  .inputValidator((input: { token: string }) => {
    const token = (input.token ?? "").trim().toLowerCase();
    return { token: /^[0-9a-f]{64}$/.test(token) ? token : null };
  })
  .handler(async ({ data }) => {
    if (!data.token) return null;
    const url = process.env["SUPABASE_URL"];
    const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
    if (!url || !key) throw new Error("This service is not available right now.");
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: res, error } = await (anon as unknown as RpcClient).rpc("get_shared_invoice", {
      _token: data.token,
    });
    if (error) {
      if (isMissingRpc(error, "get_shared_invoice")) return null;
      throw new Error("This invoice link could not be opened.");
    }
    if (!res) return null;
    const r = res as {
      invoice: Record<string, unknown>;
      lines: Record<string, unknown>[];
      customer: Record<string, unknown>;
      company: Record<string, unknown>;
      branding: Record<string, unknown>;
    };

    // Sign the logo with the service role only if it is configured; otherwise show no logo.
    let logoUrl: string | null = null;
    const logoPath =
      typeof r.branding["logo_path"] === "string" ? (r.branding["logo_path"] as string) : null;
    if (logoPath) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const signed = await supabaseAdmin.storage
          .from("org-logos")
          .createSignedUrl(logoPath, 3600);
        logoUrl = signed.data?.signedUrl ?? null;
      } catch {
        logoUrl = null;
      }
    }
    const external =
      typeof r.branding["logo_url"] === "string" ? (r.branding["logo_url"] as string).trim() : "";
    if (!logoUrl && /^https:\/\/[^\s"'<>]+$/i.test(external)) logoUrl = external;

    const branding = mapBranding(r.company, r.branding, logoUrl);
    const baseCurrency = String(r.company["base_currency"] ?? "GBP");
    const document: PrintDocument = mapSalesInvoice(
      { id: "shared", contact_id: null, ...r.invoice },
      r.lines,
      r.customer,
      { baseCurrency, companyTaxNumber: branding.taxNumber },
    );
    // Never expose internal identifiers or contact details beyond what the printed invoice shows.
    document.partyEmail = null;
    document.partyId = null;
    document.party.email = null;
    document.party.phone = null;
    return {
      document,
      branding,
      locale: String(r.company["locale"] ?? "en-GB"),
      dateFormat:
        typeof r.company["date_format"] === "string" ? (r.company["date_format"] as string) : null,
    };
  });

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

async function loadReminderSettings(db: Db, companyId: string): Promise<ReminderSettings> {
  const { data, error } = await db
    .from("company_reminder_settings" as never)
    .select("first_after_days, repeat_every_days, max_reminders, include_bank_details" as never)
    .eq("company_id" as never, companyId as never)
    .maybeSingle();
  if (error || !data) return DEFAULT_REMINDER_SETTINGS;
  const r = data as {
    first_after_days: number;
    repeat_every_days: number;
    max_reminders: number;
    include_bank_details: boolean;
  };
  return normaliseReminderSettings({
    firstAfterDays: r.first_after_days,
    repeatEveryDays: r.repeat_every_days,
    maxReminders: r.max_reminders,
    includeBankDetails: r.include_bank_details,
  });
}

export const getReminderSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    return loadReminderSettings(context.supabase, data.companyId);
  });

export const saveReminderSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string } & Partial<ReminderSettings>) => ({
    companyId: assertUuid(input.companyId),
    settings: normaliseReminderSettings(input),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "company.settings.edit");
    const { error } = await context.supabase.from("company_reminder_settings" as never).upsert(
      {
        company_id: data.companyId,
        first_after_days: data.settings.firstAfterDays,
        repeat_every_days: data.settings.repeatEveryDays,
        max_reminders: data.settings.maxReminders,
        include_bank_details: data.settings.includeBankDetails,
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "company_id" },
    );
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") throw new Error(MIGRATION_HINT);
      throw new Error(error.message);
    }
    return data.settings;
  });

export type ReminderCandidateRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string;
  customerEmail: string | null;
  currency: string;
  outstandingMinor: number;
  dueDate: string;
  daysOverdue: number;
  remindersSent: number;
  lastReminderDate: string | null;
  due: boolean;
  reason: string | null;
};

/** Overdue invoices with a decision on whether the next scheduled reminder is due today. */
export const listReminderCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.view");
    const ctx = await loadCompanyDocContext(supabase, data.companyId);
    const settings = await loadReminderSettings(supabase, data.companyId);
    const state = await emailState(ctx.isDemo);

    type Inv = {
      id: string;
      invoice_number: string | null;
      due_date: string;
      currency_code: string;
      total_minor: number;
      amount_paid_minor: number;
      amount_credited_minor: number;
      status: string;
      contacts: { name: string; email: string | null } | null;
    };
    const invoices = await fetchAllPages<Inv>(
      (from, to) =>
        supabase
          .from("sales_invoices" as never)
          .select(
            "id, invoice_number, due_date, currency_code, total_minor, amount_paid_minor, amount_credited_minor, status, contacts(name, email)" as never,
          )
          .eq("company_id" as never, data.companyId as never)
          .in("status" as never, ["authorised", "partly_paid"] as never)
          .lt("due_date" as never, ctx.today as never)
          .order("id" as never)
          .range(from, to) as unknown as PromiseLike<{
          data: Inv[] | null;
          error: { message: string } | null;
        }>,
    );

    type Sent = { entity_id: string; created_at: string };
    const sentRows = await fetchAllPages<Sent>(
      (from, to) =>
        supabase
          .from("email_outbox" as never)
          .select("entity_id, created_at" as never)
          .eq("company_id" as never, data.companyId as never)
          .eq("entity_type" as never, "sales_invoice" as never)
          .eq("template" as never, "reminder" as never)
          .eq("status" as never, "sent" as never)
          .order("created_at" as never)
          .range(from, to) as unknown as PromiseLike<{
          data: Sent[] | null;
          error: { message: string } | null;
        }>,
    ).catch(() => [] as Sent[]); // history table not applied yet: no reminders recorded
    const sent = new Map<string, { n: number; last: string }>();
    for (const s of sentRows) {
      const cur = sent.get(s.entity_id) ?? { n: 0, last: "" };
      cur.n += 1;
      if (s.created_at > cur.last) cur.last = s.created_at;
      sent.set(s.entity_id, cur);
    }

    const rows: ReminderCandidateRow[] = [];
    for (const i of invoices) {
      const outstanding =
        Number(i.total_minor) - Number(i.amount_paid_minor) - Number(i.amount_credited_minor);
      if (outstanding <= 0) continue;
      const s = sent.get(i.id);
      const lastDate = s?.last ? s.last.slice(0, 10) : null;
      const d = reminderDecision(
        {
          status: i.status,
          dueDate: i.due_date,
          outstandingMinor: outstanding,
          remindersSent: s?.n ?? 0,
          lastReminderDate: lastDate,
        },
        ctx.today,
        settings,
      );
      rows.push({
        invoiceId: i.id,
        invoiceNumber: i.invoice_number,
        customerName: i.contacts?.name ?? "—",
        customerEmail: i.contacts?.email ?? null,
        currency: i.currency_code,
        outstandingMinor: outstanding,
        dueDate: i.due_date,
        daysOverdue: daysOverdue(i.due_date, ctx.today),
        remindersSent: s?.n ?? 0,
        lastReminderDate: lastDate,
        due: d.due,
        reason: d.due ? null : d.reason,
      });
    }
    rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return {
      today: ctx.today,
      settings,
      emailConfigured: state.configured,
      blockedReason: state.blockedReason,
      rows,
      locale: ctx.locale,
      dateFormat: ctx.dateFormat,
    };
  });

/** Send the reminder template for the chosen invoices (max 20 per call), one result each. */
export const sendReminders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; invoiceIds: string[] }) => {
    const ids = [...new Set((input.invoiceIds ?? []).map((i) => assertUuid(i, "invoice")))];
    if (!ids.length) throw new Error("Choose at least one invoice.");
    if (ids.length > 20) throw new Error("Send at most 20 reminders at a time.");
    return { companyId: assertUuid(input.companyId), ids };
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await assertCompanyPermission(supabase, data.companyId, "sales.draft");
    const results: Array<{ invoiceId: string; sent: boolean; message: string }> = [];
    for (const id of data.ids) {
      const { data: inv } = await supabase
        .from("sales_invoices" as never)
        .select("id, contacts(email)" as never)
        .eq("id" as never, id as never)
        .eq("company_id" as never, data.companyId as never)
        .maybeSingle();
      const email = (
        (inv as { contacts?: { email?: string | null } | null } | null)?.contacts?.email ?? ""
      ).trim();
      const { valid } = parseRecipients(email);
      if (!valid.length) {
        results.push({ invoiceId: id, sent: false, message: "The customer has no email address." });
        continue;
      }
      const r = await sendOne(supabase, {
        companyId: data.companyId,
        kind: "sales_invoice",
        id,
        template: "reminder",
        to: valid,
        message: null,
        from: null,
        toDate: null,
      });
      results.push({ invoiceId: id, sent: r.sent, message: r.sent ? "Sent" : r.message });
      if (!r.sent && (r.reason === "not_configured" || r.reason === "demo")) break;
    }
    return { results };
  });
