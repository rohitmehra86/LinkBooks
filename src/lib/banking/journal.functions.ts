import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import type { AnyClient } from "@/lib/banking/server-helpers";

/** Read-only journal detail for the "Journal #N" links on bank transactions (BK-18). */
export const getJournalDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string; journalId: string }) => ({
    companyId: assertUuid(input.companyId),
    journalId: assertUuid(input.journalId),
  }))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as AnyClient;
    await assertCompanyMember(supabase, data.companyId);
    const { data: journal, error } = await supabase
      .from("journals" as never)
      .select(
        "id, journal_number, journal_date, memo, status, source_type, source_id, currency_code, reversed_by_journal_id, reverses_journal_id" as never,
      )
      .eq("id" as never, data.journalId as never)
      .eq("company_id" as never, data.companyId as never)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!journal) throw new Error("Journal not found");

    const { data: lines, error: lErr } = await supabase
      .from("journal_lines" as never)
      .select("id, description, debit_minor, credit_minor, accounts(code, name)" as never)
      .eq("journal_id" as never, data.journalId as never)
      .eq("company_id" as never, data.companyId as never)
      .order("id" as never);
    if (lErr) throw new Error(lErr.message);

    return {
      journal: journal as unknown as {
        id: string;
        journal_number: number;
        journal_date: string;
        memo: string | null;
        status: string;
        source_type: string;
        source_id: string | null;
        currency_code: string | null;
        reversed_by_journal_id: string | null;
        reverses_journal_id: string | null;
      },
      lines: (lines ?? []) as unknown as Array<{
        id: string;
        description: string | null;
        debit_minor: number;
        credit_minor: number;
        accounts: { code: string; name: string } | null;
      }>,
    };
  });
