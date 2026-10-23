import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertCompanyMember, assertCompanyPermission } from "@/lib/assert-company-access";
import { assertUuid } from "@/lib/company-validation";
import { validateBankDetails } from "@/lib/banking/account-details";
import { callRpc, isMissingRpc, type RpcClient } from "@/lib/banking/rpc";

export type BankAccountDetailsMasked = {
  bankAccountId: string;
  accountNumberMasked: string | null;
  sortCodeMasked: string | null;
  ibanMasked: string | null;
  bic: string | null;
  openingStatementBalanceMinor: number | null;
  openingStatementBalanceDate: string | null;
};

/** Masked identifiers only. The full values never leave the database through this call. */
export const listBankAccountDetails = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(async ({ data, context }): Promise<BankAccountDetailsMasked[]> => {
    await assertCompanyMember(context.supabase, data.companyId);
    const { data: rows, error } = await (context.supabase as unknown as RpcClient).rpc(
      "list_bank_account_details" as never,
      { _company_id: data.companyId } as never,
    );
    if (error) {
      // Not installed yet: show nothing rather than an error on the whole bank page.
      if (isMissingRpc(error)) return [];
      throw new Error(error.message);
    }
    return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      bankAccountId: String(r["bank_account_id"]),
      accountNumberMasked: (r["account_number_masked"] as string | null) ?? null,
      sortCodeMasked: (r["sort_code_masked"] as string | null) ?? null,
      ibanMasked: (r["iban_masked"] as string | null) ?? null,
      bic: (r["bic"] as string | null) ?? null,
      openingStatementBalanceMinor:
        r["opening_statement_balance_minor"] == null
          ? null
          : Number(r["opening_statement_balance_minor"]),
      openingStatementBalanceDate: (r["opening_statement_balance_date"] as string | null) ?? null,
    }));
  });

export const saveBankAccountDetails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      companyId: string;
      bankAccountId: string;
      accountNumber?: string;
      sortCode?: string;
      iban?: string;
      bic?: string;
      openingStatementBalanceMinor?: number | null;
      openingStatementBalanceDate?: string | null;
      clear?: Array<"account_number" | "sort_code" | "iban" | "bic">;
    }) => {
      const problem = validateBankDetails(input);
      if (problem) throw new Error(problem);
      const bal = input.openingStatementBalanceMinor;
      if (bal != null && !Number.isSafeInteger(Number(bal))) throw new Error("Invalid balance");
      return {
        companyId: assertUuid(input.companyId),
        bankAccountId: assertUuid(input.bankAccountId, "bank account"),
        accountNumber: (input.accountNumber ?? "").trim(),
        sortCode: (input.sortCode ?? "").trim(),
        iban: (input.iban ?? "").trim(),
        bic: (input.bic ?? "").trim(),
        openingStatementBalanceMinor: bal == null ? null : Number(bal),
        openingStatementBalanceDate: input.openingStatementBalanceDate || null,
        clear: (input.clear ?? []).filter((k) =>
          ["account_number", "sort_code", "iban", "bic"].includes(k),
        ),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertCompanyPermission(context.supabase, data.companyId, "accounts.manage");
    await callRpc(context.supabase as unknown as RpcClient, "save_bank_account_details", {
      payload: {
        company_id: data.companyId,
        bank_account_id: data.bankAccountId,
        account_number: data.accountNumber,
        sort_code: data.sortCode,
        iban: data.iban,
        bic: data.bic,
        opening_statement_balance_minor: data.openingStatementBalanceMinor,
        opening_statement_balance_date: data.openingStatementBalanceDate,
        clear: data.clear,
      },
    });
    return { ok: true };
  });

export type BankIntegrityFinding = {
  code: string;
  severity: "error" | "warning";
  message: string;
  count: number;
  sampleIds: string[];
};

/** Read-only check of bank data. `available: false` means the database function is not installed. */
export const getBankIntegrity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { companyId: string }) => ({ companyId: assertUuid(input.companyId) }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ available: boolean; findings: BankIntegrityFinding[] }> => {
      await assertCompanyMember(context.supabase, data.companyId);
      const { data: rows, error } = await (context.supabase as unknown as RpcClient).rpc(
        "bank_integrity_check" as never,
        { _company_id: data.companyId } as never,
      );
      if (error) {
        if (isMissingRpc(error)) return { available: false, findings: [] };
        throw new Error(error.message);
      }
      return {
        available: true,
        findings: ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
          code: String(r["code"]),
          severity: r["severity"] === "error" ? "error" : "warning",
          message: String(r["message"]),
          count: Number(r["finding_count"]),
          sampleIds: ((r["sample_ids"] as string[] | null) ?? []).slice(0, 5),
        })),
      };
    },
  );
