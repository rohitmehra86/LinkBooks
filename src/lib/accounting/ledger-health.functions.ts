import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { parseHealthReport, type HealthReport } from "@/lib/accounting/ledger-health";

/**
 * Runs the read-only ledger health check. The checks live in the database function
 * `ledger_health_check`; when it is not installed the screen says so instead of showing a pass.
 */
export const runLedgerHealthCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({
    companyId: assertUuid(input?.companyId),
  }))
  .handler(
    async ({ data, context }): Promise<{ report: HealthReport } | { unavailable: string }> => {
      await assertCompanyMember(context.supabase, data.companyId);
      const { data: result, error } = await context.supabase.rpc(
        "ledger_health_check" as never,
        { payload: { company_id: data.companyId } } as never,
      );
      if (error) {
        if (
          /ledger_health_check/.test(error.message) &&
          /(does not exist|could not find|schema cache)/i.test(error.message)
        ) {
          return {
            unavailable:
              "The ledger health check is not available yet: the database migration 20261025130000_ledger_health_check has not been applied.",
          };
        }
        throw new Error(error.message);
      }
      return { report: parseHealthReport(result) };
    },
  );
