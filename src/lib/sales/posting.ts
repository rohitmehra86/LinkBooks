import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { postJournal, reverseJournal } from "@/lib/accounting/posting-engine";
import type { JournalLineDraft } from "@/lib/accounting/money";
import { requireAccountByCode } from "@/lib/purchases/accounts";

type Client = SupabaseClient<Database>;

export type InvoiceLinePost = {
  account_id: string;
  description: string;
  net_minor: bigint | number;
  tax_minor: bigint | number;
};

/** Authorise invoice: DR AR, CR revenue(s), CR Tax Payable. */
export async function postInvoiceAuthorisation(
  supabase: Client,
  args: {
    company_id: string;
    invoice_id: string;
    invoice_date: string;
    currency_code: string;
    lines: InvoiceLinePost[];
    memo?: string;
  },
): Promise<string> {
  const ar = await requireAccountByCode(supabase, args.company_id, "1100");
  const taxPayable = await requireAccountByCode(supabase, args.company_id, "2100");

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
      account_id: taxPayable.id,
      description: "Output tax",
      debit_minor: 0n,
      credit_minor: taxTotal,
    });
  }
  const gross = netTotal + taxTotal;
  if (gross <= 0n) throw new Error("Invoice total must be greater than zero");
  journalLines.unshift({
    account_id: ar.id,
    description: args.memo ?? "Accounts receivable",
    debit_minor: gross,
    credit_minor: 0n,
  });

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.invoice_date,
    currency_code: args.currency_code,
    source_type: "sales_invoice",
    source_id: args.invoice_id,
    idempotency_key: `sales_invoice:${args.invoice_id}:authorise`,
    ...(args.memo ? { memo: args.memo } : {}),
    lines: journalLines,
  });
  return journalId;
}

/**
 * Customer receipt: DR bank, CR AR for full amount.
 * Overpayment remains unallocated on the receipt (still CR AR — treated as customer credit balance).
 * Refunds: use a negative-direction receipt is not supported; use credit note + payment out via banking.
 */
export async function postCustomerReceipt(
  supabase: Client,
  args: {
    company_id: string;
    receipt_id: string;
    receipt_date: string;
    currency_code: string;
    bank_account_id: string;
    amount_minor: bigint | number;
    memo?: string;
  },
): Promise<string> {
  const ar = await requireAccountByCode(supabase, args.company_id, "1100");
  const amount = typeof args.amount_minor === "bigint" ? args.amount_minor : BigInt(args.amount_minor);
  if (amount <= 0n) throw new Error("Receipt amount must be positive");

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.receipt_date,
    currency_code: args.currency_code,
    source_type: "customer_receipt",
    source_id: args.receipt_id,
    idempotency_key: `customer_receipt:${args.receipt_id}:post`,
    ...(args.memo ? { memo: args.memo } : {}),
    lines: [
      {
        account_id: args.bank_account_id,
        description: args.memo ?? "Bank",
        debit_minor: amount,
        credit_minor: 0n,
      },
      {
        account_id: ar.id,
        description: args.memo ?? "Customer receipt",
        debit_minor: 0n,
        credit_minor: amount,
      },
    ],
  });
  return journalId;
}

/** Credit note: DR revenue(s) + DR Tax Payable, CR AR. */
export async function postSalesCreditAuthorisation(
  supabase: Client,
  args: {
    company_id: string;
    credit_note_id: string;
    credit_date: string;
    currency_code: string;
    lines: InvoiceLinePost[];
    memo?: string;
  },
): Promise<string> {
  const ar = await requireAccountByCode(supabase, args.company_id, "1100");
  const taxPayable = await requireAccountByCode(supabase, args.company_id, "2100");
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
      account_id: taxPayable.id,
      description: "Output tax reversal",
      debit_minor: taxTotal,
      credit_minor: 0n,
    });
  }
  const gross = netTotal + taxTotal;
  if (gross <= 0n) throw new Error("Credit note total must be greater than zero");
  journalLines.push({
    account_id: ar.id,
    description: args.memo ?? "Customer credit",
    debit_minor: 0n,
    credit_minor: gross,
  });

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.credit_date,
    currency_code: args.currency_code,
    source_type: "sales_credit_note",
    source_id: args.credit_note_id,
    idempotency_key: `sales_credit_note:${args.credit_note_id}:authorise`,
    ...(args.memo ? { memo: args.memo } : {}),
    lines: journalLines,
  });
  return journalId;
}

/** Transfer: DR destination bank GL, CR source bank GL. One journal only. */
export async function postBankTransfer(
  supabase: Client,
  args: {
    company_id: string;
    transfer_id: string;
    transfer_date: string;
    currency_code: string;
    from_gl_account_id: string;
    to_gl_account_id: string;
    amount_minor: bigint | number;
    memo?: string;
  },
): Promise<string> {
  const amount = typeof args.amount_minor === "bigint" ? args.amount_minor : BigInt(args.amount_minor);
  if (amount <= 0n) throw new Error("Transfer amount must be positive");
  if (args.from_gl_account_id === args.to_gl_account_id) {
    throw new Error("Transfer accounts must differ");
  }

  const { journalId } = await postJournal(supabase, {
    company_id: args.company_id,
    journal_date: args.transfer_date,
    currency_code: args.currency_code,
    source_type: "bank_transfer",
    source_id: args.transfer_id,
    idempotency_key: `bank_transfer:${args.transfer_id}:post`,
    ...(args.memo ? { memo: args.memo } : {}),
    lines: [
      {
        account_id: args.to_gl_account_id,
        description: args.memo ?? "Transfer in",
        debit_minor: amount,
        credit_minor: 0n,
      },
      {
        account_id: args.from_gl_account_id,
        description: args.memo ?? "Transfer out",
        debit_minor: 0n,
        credit_minor: amount,
      },
    ],
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
