import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { isRateEffective } from "@/lib/tax/tax-math";
import { postJournal } from "@/lib/accounting/posting-engine";
import { requireAccountInCompany } from "@/lib/purchases/accounts";

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export const getTaxSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: row, error } = await context.supabase
      .from("company_tax_settings" as never)
      .select(
        "tax_regime, registration_number, prices_include_tax, filing_frequency, tax_basis, jurisdiction_code, default_sales_tax_code_id, default_purchase_tax_code_id, output_tax_account_id, input_tax_account_id, registration_date, registration_end_date, applied_pack_id, applied_pack_version, non_recoverable_tax_account_id" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateTaxSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      taxRegime: string;
      registrationNumber?: string;
      pricesIncludeTax: boolean;
      filingFrequency?: string | null;
      taxBasis?: string;
      jurisdictionCode?: string | null;
      defaultSalesTaxCodeId?: string | null;
      defaultPurchaseTaxCodeId?: string | null;
      outputTaxAccountId?: string | null;
      inputTaxAccountId?: string | null;
      nonRecoverableTaxAccountId?: string | null;
      registrationDate?: string | null;
      registrationEndDate?: string | null;
    }) => {
      if (!["none", "vat", "gst", "sales_tax", "other"].includes(input.taxRegime)) {
        throw new Error("Invalid tax regime");
      }
      const basis = input.taxBasis ?? "invoice";
      if (!["invoice", "cash"].includes(basis)) throw new Error("Invalid tax basis");
      const regDate = (input.registrationDate ?? "").trim();
      const regEnd = (input.registrationEndDate ?? "").trim();
      if (regDate && !isIsoDate(regDate)) throw new Error("registrationDate must be YYYY-MM-DD");
      if (regEnd && !isIsoDate(regEnd)) throw new Error("registrationEndDate must be YYYY-MM-DD");
      return {
        companyId: assertUuid(input.companyId),
        taxRegime: input.taxRegime,
        registrationNumber: (input.registrationNumber ?? "").trim().slice(0, 80) || null,
        pricesIncludeTax: Boolean(input.pricesIncludeTax),
        filingFrequency: input.filingFrequency || null,
        taxBasis: basis,
        jurisdictionCode: (input.jurisdictionCode ?? "").trim().toUpperCase().slice(0, 8) || null,
        defaultSalesTaxCodeId: input.defaultSalesTaxCodeId
          ? assertUuid(input.defaultSalesTaxCodeId)
          : null,
        defaultPurchaseTaxCodeId: input.defaultPurchaseTaxCodeId
          ? assertUuid(input.defaultPurchaseTaxCodeId)
          : null,
        outputTaxAccountId: input.outputTaxAccountId
          ? assertUuid(input.outputTaxAccountId)
          : null,
        inputTaxAccountId: input.inputTaxAccountId ? assertUuid(input.inputTaxAccountId) : null,
        nonRecoverableTaxAccountId: input.nonRecoverableTaxAccountId
          ? assertUuid(input.nonRecoverableTaxAccountId)
          : null,
        registrationDate: regDate || null,
        registrationEndDate: regEnd || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    const { error } = await context.supabase
      .from("company_tax_settings" as never)
      .update({
        tax_regime: data.taxRegime,
        registration_number: data.registrationNumber,
        prices_include_tax: data.pricesIncludeTax,
        filing_frequency: data.filingFrequency,
        tax_basis: data.taxBasis,
        jurisdiction_code: data.jurisdictionCode,
        default_sales_tax_code_id: data.defaultSalesTaxCodeId,
        default_purchase_tax_code_id: data.defaultPurchaseTaxCodeId,
        output_tax_account_id: data.outputTaxAccountId,
        input_tax_account_id: data.inputTaxAccountId,
        non_recoverable_tax_account_id: data.nonRecoverableTaxAccountId,
        registration_date: data.registrationDate,
        registration_end_date: data.registrationEndDate,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("company_id" as never, data.companyId as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listTaxRates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; onDate?: string }) => ({
    companyId: assertUuid(input.companyId),
    onDate: input.onDate && isIsoDate(input.onDate) ? input.onDate : null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("tax_rates" as never)
      .select(
        "id, name, code, rate_bps, effective_from, effective_to, is_active, treatment, applies_to, jurisdiction_code, source_note" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("effective_from" as never, { ascending: false });
    if (error) throw new Error(error.message);
    const all = (rows ?? []) as Array<{
      id: string;
      name: string;
      rate_bps: number;
      effective_from: string;
      effective_to: string | null;
      is_active: boolean;
    }>;
    if (!data.onDate) return all;
    return all.filter((r) => isRateEffective(r, data.onDate!));
  });

export const saveTaxRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      id?: string;
      name: string;
      rateBps: number;
      effectiveFrom: string;
      effectiveTo?: string | null;
      isActive?: boolean;
    }) => {
      const name = (input.name ?? "").trim();
      if (!name) throw new Error("Rate name is required");
      if (!isIsoDate(input.effectiveFrom)) throw new Error("effectiveFrom must be YYYY-MM-DD");
      const to = input.effectiveTo ? String(input.effectiveTo).trim() : "";
      if (to && !isIsoDate(to)) throw new Error("effectiveTo must be YYYY-MM-DD");
      if (to && to < input.effectiveFrom) throw new Error("effectiveTo cannot be before effectiveFrom");
      const rateBps = Math.round(Number(input.rateBps));
      if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
        throw new Error("Rate must be 0–10000 basis points");
      }
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        name,
        rateBps,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: to || null,
        isActive: input.isActive !== false,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    if (data.id) {
      const { error } = await context.supabase
        .from("tax_rates" as never)
        .update({
          name: data.name,
          rate_bps: data.rateBps,
          effective_from: data.effectiveFrom,
          effective_to: data.effectiveTo,
          is_active: data.isActive,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("tax_rates" as never)
      .insert({
        company_id: data.companyId,
        name: data.name,
        rate_bps: data.rateBps,
        effective_from: data.effectiveFrom,
        effective_to: data.effectiveTo,
        is_active: data.isActive,
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (row as { id: string }).id };
  });

export const listTaxCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await context.supabase
      .from("tax_codes" as never)
      .select(
        "id, code, name, tax_rate_id, tax_account_id, applies_to, is_recoverable, is_active, tax_rates(name, rate_bps, effective_from, effective_to, is_active)" as never,
      )
      .eq("company_id" as never, data.companyId as never)
      .order("code" as never);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const saveTaxCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      id?: string;
      code: string;
      name: string;
      taxRateId: string;
      taxAccountId?: string | null;
      appliesTo?: string;
      isRecoverable?: boolean;
      isActive?: boolean;
    }) => {
      const code = (input.code ?? "").trim().toUpperCase();
      const name = (input.name ?? "").trim();
      if (!code || !name) throw new Error("Code and name are required");
      const appliesTo = input.appliesTo ?? "both";
      if (!["sales", "purchases", "both"].includes(appliesTo)) throw new Error("Invalid appliesTo");
      return {
        companyId: assertUuid(input.companyId),
        id: input.id ? assertUuid(input.id) : undefined,
        code: code.slice(0, 20),
        name,
        taxRateId: assertUuid(input.taxRateId),
        taxAccountId: input.taxAccountId ? assertUuid(input.taxAccountId) : null,
        appliesTo,
        isRecoverable: input.isRecoverable !== false,
        isActive: input.isActive !== false,
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    if (data.id) {
      const { error } = await context.supabase
        .from("tax_codes" as never)
        .update({
          code: data.code,
          name: data.name,
          tax_rate_id: data.taxRateId,
          tax_account_id: data.taxAccountId,
          applies_to: data.appliesTo,
          is_recoverable: data.isRecoverable,
          is_active: data.isActive,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, data.id as never)
        .eq("company_id" as never, data.companyId as never);
      if (error) {
        if (error.code === "23505") throw new Error("Tax code already exists");
        throw new Error(error.message);
      }
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("tax_codes" as never)
      .insert({
        company_id: data.companyId,
        code: data.code,
        name: data.name,
        tax_rate_id: data.taxRateId,
        tax_account_id: data.taxAccountId,
        applies_to: data.appliesTo,
        is_recoverable: data.isRecoverable,
        is_active: data.isActive,
      } as never)
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error("Tax code already exists");
      throw new Error(error.message);
    }
    return { id: (row as { id: string }).id };
  });

export const seedTaxPack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; packId?: string }) => ({
    companyId: assertUuid(input.companyId),
    packId: (input.packId ?? "").trim().slice(0, 60) || null,
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    const { data: result, error } = await context.supabase.rpc("seed_country_tax_pack" as never, {
      _company_id: data.companyId,
      _pack_id: data.packId,
    } as never);
    if (error) {
      const { error: e2 } = await context.supabase.rpc("seed_default_tax_pack" as never, {
        _company_id: data.companyId,
      } as never);
      if (e2) throw new Error(error.message);
      return { ok: true, result: null, fallback: true as const };
    }
    return { ok: true, result, fallback: false as const };
  });

export const listTaxCountryPacks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; countryCode?: string }) => ({
    companyId: assertUuid(input.companyId),
    countryCode: (input.countryCode ?? "").trim().toUpperCase().slice(0, 2),
  }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { packsForCountry, TAX_COUNTRY_PACKS } = await import("@/lib/tax/country-packs");
    const packs = data.countryCode ? packsForCountry(data.countryCode) : TAX_COUNTRY_PACKS;
    return {
      packs,
      disclaimer:
        "Packs configure rates and codes only. Filing is not implemented. Verify starter rates against official sources.",
    };
  });

/**
 * Period-end tax adjustment: posts one balanced journal via PostingEngine
 * (source_type tax_adjustment). Idempotent per adjustmentKey.
 * Does not claim filing compliance — ledger adjustment only.
 */
export const postTaxAdjustment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      journalDate: string;
      taxAccountId: string;
      offsetAccountId: string;
      amountMinor: number;
      direction: "increase_payable" | "decrease_payable";
      memo?: string;
      adjustmentKey: string;
      currencyCode: string;
    }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.journalDate ?? "")) {
        throw new Error("Journal date must be YYYY-MM-DD");
      }
      const amount = Math.round(Number(input.amountMinor));
      if (!(amount > 0)) throw new Error("Adjustment amount must be positive");
      if (!["increase_payable", "decrease_payable"].includes(input.direction)) {
        throw new Error("Invalid adjustment direction");
      }
      const key = (input.adjustmentKey ?? "").trim();
      if (key.length < 4) throw new Error("adjustmentKey is required for idempotency");
      return {
        companyId: assertUuid(input.companyId),
        journalDate: input.journalDate,
        taxAccountId: assertUuid(input.taxAccountId),
        offsetAccountId: assertUuid(input.offsetAccountId),
        amountMinor: amount,
        direction: input.direction as "increase_payable" | "decrease_payable",
        memo: (input.memo ?? "").trim().slice(0, 500) || null,
        adjustmentKey: key.slice(0, 120),
        currencyCode: (input.currencyCode ?? "").toUpperCase().slice(0, 3),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "tax.settings");
    await requireAccountInCompany(context.supabase, data.companyId, data.taxAccountId);
    await requireAccountInCompany(context.supabase, data.companyId, data.offsetAccountId);
    if (data.taxAccountId === data.offsetAccountId) {
      throw new Error("Tax and offset accounts must differ");
    }

    const amount = BigInt(data.amountMinor);
    // increase_payable: CR tax, DR offset (expense/equity); decrease: DR tax, CR offset
    const taxIsCredit = data.direction === "increase_payable";
    const result = await postJournal(context.supabase, {
      company_id: data.companyId,
      journal_date: data.journalDate,
      currency_code: data.currencyCode,
      source_type: "tax_adjustment",
      source_id: data.adjustmentKey,
      idempotency_key: `tax_adjustment:${data.companyId}:${data.adjustmentKey}`,
      ...(data.memo ? { memo: data.memo } : {}),
      lines: taxIsCredit
        ? [
            {
              account_id: data.offsetAccountId,
              description: data.memo ?? "Tax adjustment",
              debit_minor: amount,
              credit_minor: 0n,
            },
            {
              account_id: data.taxAccountId,
              description: data.memo ?? "Tax payable",
              debit_minor: 0n,
              credit_minor: amount,
            },
          ]
        : [
            {
              account_id: data.taxAccountId,
              description: data.memo ?? "Tax payable",
              debit_minor: amount,
              credit_minor: 0n,
            },
            {
              account_id: data.offsetAccountId,
              description: data.memo ?? "Tax adjustment",
              debit_minor: 0n,
              credit_minor: amount,
            },
          ],
    });
    return { journalId: result.journalId };
  });
