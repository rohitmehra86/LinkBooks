import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { postJournal, reverseJournal } from "@/lib/accounting/posting-engine";
import type { JournalLineDraft } from "@/lib/accounting/money";
import { requireAccountByCode } from "@/lib/purchases/accounts";

type Client = SupabaseClient<Database>;

export type BillLinePost = {
  account_id: string;
  description: string;
  net_minor: bigint | number;
  tax_minor: bigint | number;
};

/** Authorise bill: DR expense(s) + DR VAT recoverable, CR AP. */
export async function postBillAuthorisation(
  supabase: Client,
  args: {
    company_id: string;
    bill_id: string;
    bill_date: string;
    currency_code: string;
    lines: BillLinePost[];
    memo?: string;
    fx_rate_to_base?: number;
  },
): Promise<string> {
  const ap = await requireAccountByCode(supabase, args.company_id, "2000");
  const { resolveInputTaxAccount } = await import("@/lib/tax/tax-accounts");
  const vatAcc = await resolveInputTaxAccount(supabase, args.company_id);
  const vat = { id: vatAcc.id };

  const journalLines: JournalLineDraft[] = [];
  let taxTotal = 0n;
  let netTotal = 0n;

  for (const line of args.lines) {
    const net = typeof line.net_minor === "bigint" ? line.net_minor : BigInt(line.net_minor);
    const tax = typeof line.tax_minor === "bigint" ? line.tax_minor : BigInt(line.tax_minor);
    if (net > 0n) {
      journalLines.push({
        account_id: line.account_id,
        description: line.description,
        debit_minor: net,
        credit_minor: 0n,
      });
    }
    netTotal += net;
    taxTotal += tax;
  }
  if (taxTotal > 0n) {
    journalLines.push({
      account_id: vat.id,
      description: "Input tax",
      debit_minor: taxTotal,
      credit_minor: 0n,
    });
  }
  const gross = netTotal + taxTotal;
  if (gross <= 0n) throw new Error("Bill total must be greater than zero");
  journalLines.push({
    account_id: ap.id,
    description: args.memo ?? "Accounts payable",
    debit_minor: 0n,
    credit_minor: gross,
  });

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.bill_date,
    currency_code: args.currency_code,
    source_type: "purchase_bill",
    source_id: args.bill_id,
    idempotency_key: `purchase_bill:${args.bill_id}:authorise`,
    ...(args.memo ? { memo: args.memo } : {}),
    ...(args.fx_rate_to_base != null ? { fx_rate_to_base: args.fx_rate_to_base } : {}),
    lines: journalLines,
  });
  return journalId;
}

/** Direct expense paid now: DR expense (+ tax), CR bank. */
export async function postDirectExpense(
  supabase: Client,
  args: {
    company_id: string;
    expense_id: string;
    expense_date: string;
    currency_code: string;
    expense_account_id: string;
    payment_account_id: string;
    net_minor: bigint | number;
    tax_minor: bigint | number;
    memo?: string;
  },
): Promise<string> {
  const { resolveInputTaxAccount } = await import("@/lib/tax/tax-accounts");
  const vatAcc = await resolveInputTaxAccount(supabase, args.company_id);
  const vat = { id: vatAcc.id };
  const net = typeof args.net_minor === "bigint" ? args.net_minor : BigInt(args.net_minor);
  const tax = typeof args.tax_minor === "bigint" ? args.tax_minor : BigInt(args.tax_minor);
  const total = net + tax;
  if (total <= 0n) throw new Error("Expense total must be greater than zero");

  const lines: JournalLineDraft[] = [
    {
      account_id: args.expense_account_id,
      description: args.memo ?? "Expense",
      debit_minor: net,
      credit_minor: 0n,
    },
  ];
  if (tax > 0n) {
    lines.push({
      account_id: vat.id,
      description: "Input tax",
      debit_minor: tax,
      credit_minor: 0n,
    });
  }
  lines.push({
    account_id: args.payment_account_id,
    description: args.memo ?? "Payment",
    debit_minor: 0n,
    credit_minor: total,
  });

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.expense_date,
    currency_code: args.currency_code,
    source_type: "expense",
    source_id: args.expense_id,
    idempotency_key: `purchase_expense:${args.expense_id}:post`,
    ...(args.memo ? { memo: args.memo } : {}),
    lines,
  });
  return journalId;
}

/** Supplier payment: DR AP, CR bank. Overpayment stays as unallocated (still CR bank / DR AP for full payment amount). */
export async function postSupplierPayment(
  supabase: Client,
  args: {
    company_id: string;
    payment_id: string;
    payment_date: string;
    currency_code: string;
    bank_account_id: string;
    amount_minor: bigint | number;
    memo?: string;
  },
): Promise<string> {
  const ap = await requireAccountByCode(supabase, args.company_id, "2000");
  const amount =
    typeof args.amount_minor === "bigint" ? args.amount_minor : BigInt(args.amount_minor);
  if (amount <= 0n) throw new Error("Payment amount must be positive");

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.payment_date,
    currency_code: args.currency_code,
    source_type: "supplier_payment",
    source_id: args.payment_id,
    idempotency_key: `supplier_payment:${args.payment_id}:post`,
    ...(args.memo ? { memo: args.memo } : {}),
    lines: [
      {
        account_id: ap.id,
        description: args.memo ?? "Supplier payment",
        debit_minor: amount,
        credit_minor: 0n,
      },
      {
        account_id: args.bank_account_id,
        description: args.memo ?? "Bank",
        debit_minor: 0n,
        credit_minor: amount,
      },
    ],
  });
  return journalId;
}

/** Credit note: DR AP, CR expense(s) + CR VAT. */
export async function postCreditNoteAuthorisation(
  supabase: Client,
  args: {
    company_id: string;
    credit_note_id: string;
    credit_date: string;
    currency_code: string;
    lines: BillLinePost[];
    memo?: string;
    /** Same convention as bills: stored on the journal, amounts stay in the document currency. */
    fx_rate_to_base?: number;
  },
): Promise<string> {
  const ap = await requireAccountByCode(supabase, args.company_id, "2000");
  const { resolveInputTaxAccount } = await import("@/lib/tax/tax-accounts");
  const vatAcc = await resolveInputTaxAccount(supabase, args.company_id);
  const vat = { id: vatAcc.id };
  const journalLines: JournalLineDraft[] = [];
  let taxTotal = 0n;
  let netTotal = 0n;

  for (const line of args.lines) {
    const net = typeof line.net_minor === "bigint" ? line.net_minor : BigInt(line.net_minor);
    const tax = typeof line.tax_minor === "bigint" ? line.tax_minor : BigInt(line.tax_minor);
    if (net > 0n) {
      journalLines.push({
        account_id: line.account_id,
        description: line.description,
        debit_minor: 0n,
        credit_minor: net,
      });
    }
    netTotal += net;
    taxTotal += tax;
  }
  if (taxTotal > 0n) {
    journalLines.push({
      account_id: vat.id,
      description: "Input tax reversal",
      debit_minor: 0n,
      credit_minor: taxTotal,
    });
  }
  const gross = netTotal + taxTotal;
  journalLines.unshift({
    account_id: ap.id,
    description: args.memo ?? "Supplier credit",
    debit_minor: gross,
    credit_minor: 0n,
  });

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.credit_date,
    currency_code: args.currency_code,
    source_type: "purchase_credit_note",
    source_id: args.credit_note_id,
    idempotency_key: `purchase_credit_note:${args.credit_note_id}:authorise`,
    ...(args.memo ? { memo: args.memo } : {}),
    ...(args.fx_rate_to_base != null ? { fx_rate_to_base: args.fx_rate_to_base } : {}),
    lines: journalLines,
  });
  return journalId;
}

export async function voidPostedDocument(
  supabase: Client,
  postedJournalId: string,
  idempotencyKey: string,
): Promise<string> {
  const { journalId } = await reverseJournal(supabase, postedJournalId, idempotencyKey);
  return journalId;
}
