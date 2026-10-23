import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { loadCompanyDefaults, loadTaxTreatment } from "@/lib/sales/sales-common";
import { loadSalesTaxCodes } from "@/lib/sales/tax-codes";
import { listDepositAccountRows } from "@/lib/sales/ar-accounts";

/**
 * Everything the sales document forms need from the server so the UI preview matches what the
 * server will compute: tax treatment (company_tax_settings is the single source — AR-18), sales tax
 * codes with their rates (AR-19), base currency and company-local "today" (AR-16).
 */
export const getSalesDocumentConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    const [treatment, defaults, taxCodes] = await Promise.all([
      loadTaxTreatment(context.supabase, data.companyId),
      loadCompanyDefaults(context.supabase, data.companyId),
      loadSalesTaxCodes(context.supabase, data.companyId),
    ]);
    return {
      treatment,
      baseCurrency: defaults.baseCurrency,
      timezone: defaults.timezone,
      today: defaults.today,
      taxCodes,
    };
  });

/** Bank / cash accounts only (AR-25). */
export const listDepositAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }) => {
    await assertCompanyMember(context.supabase, data.companyId);
    return listDepositAccountRows(context.supabase, data.companyId);
  });
