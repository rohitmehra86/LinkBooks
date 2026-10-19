import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { wrapUntrustedBlock } from "@/lib/ai/sanitize";
import {
  findPossibleDuplicateTransactions,
  findReconciliationExceptions,
  highlightUnusualMovements,
  type BankTxnLike,
} from "@/lib/ai/local-analysis";

type AuthedClient = SupabaseClient<Database>;

export type CompanyAiContext = {
  companyId: string;
  companyName: string;
  baseCurrency: string;
  factsMarkdown: string;
  calculatedBlocks: Array<{ kind: string; title: string; body: string }>;
  accountIds: string[];
  promptChars: number;
};

/**
 * Load minimised, permission-scoped context for a single company.
 * Caller must already have asserted ai.use + membership.
 */
export async function buildCompanyAiContext(
  supabase: AuthedClient,
  companyId: string,
  maxChars: number,
): Promise<CompanyAiContext> {
  const { data: company, error: cErr } = await supabase
    .from("companies")
    .select("id, name, base_currency")
    .eq("id", companyId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!company) throw new Error("Organisation not found or not accessible");

  const { data: accounts } = await supabase
    .from("accounts" as never)
    .select("id, code, name, account_type" as never)
    .eq("company_id" as never, companyId as never)
    .eq("is_active" as never, true)
    .order("code" as never)
    .limit(200);

  const accountRows = (accounts ?? []) as Array<{
    id: string;
    code: string;
    name: string;
    account_type: string;
  }>;

  const { data: recentJournals } = await supabase
    .from("journals" as never)
    .select("journal_number, journal_date, memo, source_type, currency_code" as never)
    .eq("company_id" as never, companyId as never)
    .eq("status" as never, "posted" as never)
    .order("journal_date" as never, { ascending: false })
    .limit(15);

  let bankTxns: BankTxnLike[] = [];
  try {
    const { data: txns } = await supabase
      .from("bank_transactions" as never)
      .select("id, amount_minor, txn_date, description, status" as never)
      .eq("company_id" as never, companyId as never)
      .order("txn_date" as never, { ascending: false })
      .limit(80);
    bankTxns = ((txns ?? []) as BankTxnLike[]).map((t) => ({
      id: t.id,
      amount_minor: Number(t.amount_minor),
      txn_date: t.txn_date,
      description: t.description ?? null,
      status: t.status ?? null,
    }));
  } catch {
    bankTxns = [];
  }

  const duplicates = findPossibleDuplicateTransactions(bankTxns);
  const reconcile = findReconciliationExceptions(bankTxns);

  // Simple account movement proxy from recent journal lines if available
  let unusualNote = "No posted movement sample available.";
  try {
    const { data: lines } = await supabase
      .from("journal_lines" as never)
      .select(
        "debit_minor, credit_minor, accounts!inner(code, name), journals!inner(company_id, status)" as never,
      )
      .eq("company_id" as never, companyId as never)
      .limit(400);
    const map = new Map<string, { code: string; name: string; net: number }>();
    for (const row of (lines ?? []) as Array<{
      debit_minor: number;
      credit_minor: number;
      accounts: { code: string; name: string };
      journals: { status: string; company_id: string };
    }>) {
      if (row.journals.status !== "posted" || row.journals.company_id !== companyId) continue;
      const key = row.accounts.code;
      const cur = map.get(key) ?? { code: row.accounts.code, name: row.accounts.name, net: 0 };
      cur.net += Number(row.debit_minor) - Number(row.credit_minor);
      map.set(key, cur);
    }
    const unusual = highlightUnusualMovements(
      [...map.values()].map((r) => ({
        account_code: r.code,
        account_name: r.name,
        net_minor: r.net,
      })),
    );
    unusualNote =
      unusual.length === 0
        ? "No accounts exceeded the unusual-movement heuristic in the sample."
        : unusual
            .map((u) => `${u.account_code} ${u.account_name}: net ${u.net_minor} minor`)
            .join("\n");
  } catch {
    /* optional */
  }

  const coa = accountRows
    .slice(0, 120)
    .map((a) => `${a.code} | ${a.name} | ${a.account_type} | ${a.id}`)
    .join("\n");

  const journals = ((recentJournals ?? []) as Array<{
    journal_number: number;
    journal_date: string;
    memo: string | null;
    source_type: string;
    currency_code: string | null;
  }>)
    .map(
      (j) =>
        `#${j.journal_number} ${j.journal_date} ${j.source_type} ${j.currency_code ?? ""} ${j.memo ?? ""}`,
    )
    .join("\n");

  const parts = [
    `FACT company_id=${company.id} name=${company.name} base_currency=${company.base_currency}`,
    "FACT chart_of_accounts (code | name | type | id):",
    coa || "(none)",
    "FACT recent_posted_journals:",
    wrapUntrustedBlock("journal_memos", journals || "(none)"),
    "FACT bank_sample_size=" + String(bankTxns.length),
  ];

  let factsMarkdown = parts.join("\n");
  if (factsMarkdown.length > maxChars) {
    factsMarkdown = factsMarkdown.slice(0, maxChars) + "\n[context truncated]";
  }

  const calculatedBlocks = [
    {
      kind: "duplicates",
      title: "Possible duplicate bank transactions (calculated)",
      body:
        duplicates.length === 0
          ? "None detected in sample."
          : duplicates
              .map((d) => `${d.txn_date} amount=${d.amount_minor}: ${d.reason} (${d.a_id.slice(0, 8)}… / ${d.b_id.slice(0, 8)}…)`)
              .join("\n"),
    },
    {
      kind: "reconcile",
      title: "Reconciliation exceptions (calculated)",
      body:
        reconcile.length === 0
          ? "No uncategorised items in sample."
          : reconcile
              .slice(0, 30)
              .map((r) => `${r.txn_date} ${r.amount_minor} ${r.description}`)
              .join("\n"),
    },
    {
      kind: "unusual",
      title: "Unusual movements heuristic (calculated)",
      body: unusualNote,
    },
  ];

  return {
    companyId: company.id,
    companyName: company.name,
    baseCurrency: company.base_currency,
    factsMarkdown,
    calculatedBlocks,
    accountIds: accountRows.map((a) => a.id),
    promptChars: factsMarkdown.length,
  };
}
