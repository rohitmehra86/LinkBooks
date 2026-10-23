import type { JournalLineDraft } from "@/lib/accounting/money";

export type MoneyLine = {
  accountId: string;
  netMinor: bigint;
  taxMinor: bigint;
  description: string;
};

function asMinor(value: bigint, label: string): bigint {
  if (value < 0n) throw new Error(`${label} cannot be negative`);
  return value;
}

export function assertBalanced(lines: JournalLineDraft[]): JournalLineDraft[] {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    debit += BigInt(line.debit_minor);
    credit += BigInt(line.credit_minor);
    if (BigInt(line.debit_minor) > 0n && BigInt(line.credit_minor) > 0n) {
      throw new Error("A journal line cannot be both a debit and a credit");
    }
  }
  if (debit !== credit) throw new Error("Journal does not balance");
  if (debit <= 0n) throw new Error("Amount must be greater than zero");
  return lines;
}

/** Cash sale: debit the bank or undeposited account, credit income and output tax. No accounts receivable. */
export function salesReceiptJournal(input: {
  settlementAccountId: string;
  outputTaxAccountId: string;
  lines: MoneyLine[];
}): JournalLineDraft[] {
  if (input.lines.length === 0) throw new Error("Add at least one sales line");
  let net = 0n;
  let tax = 0n;
  const credits: JournalLineDraft[] = [];
  for (const line of input.lines) {
    asMinor(line.netMinor, "Net");
    asMinor(line.taxMinor, "Tax");
    if (line.accountId === input.settlementAccountId) {
      throw new Error("The income account and the payment account must be different");
    }
    net += line.netMinor;
    tax += line.taxMinor;
    if (line.netMinor > 0n) {
      credits.push({
        account_id: line.accountId,
        description: line.description,
        debit_minor: 0n,
        credit_minor: line.netMinor,
      });
    }
  }
  const total = net + tax;
  const journal: JournalLineDraft[] = [
    {
      account_id: input.settlementAccountId,
      description: "Sales receipt",
      debit_minor: total,
      credit_minor: 0n,
    },
    ...credits,
  ];
  if (tax > 0n) {
    journal.push({
      account_id: input.outputTaxAccountId,
      description: "Output tax",
      debit_minor: 0n,
      credit_minor: tax,
    });
  }
  return assertBalanced(journal);
}

export function assertRefundWithinBalance(amountMinor: bigint, availableMinor: bigint): void {
  asMinor(amountMinor, "Refund");
  asMinor(availableMinor, "Available balance");
  if (amountMinor <= 0n) throw new Error("Refund must be greater than zero");
  if (amountMinor > availableMinor) throw new Error("Refund exceeds the available balance");
}

/** Uses a customer credit or overpayment. Debit the credit balance, credit the bank. */
export function customerRefundJournal(input: {
  amountMinor: bigint;
  availableMinor: bigint;
  bankAccountId: string;
  creditBalanceAccountId: string;
}): JournalLineDraft[] {
  assertRefundWithinBalance(input.amountMinor, input.availableMinor);
  if (input.bankAccountId === input.creditBalanceAccountId) {
    throw new Error("Choose a bank account that is not the customer balance account");
  }
  return assertBalanced([
    {
      account_id: input.creditBalanceAccountId,
      description: "Customer refund",
      debit_minor: input.amountMinor,
      credit_minor: 0n,
    },
    {
      account_id: input.bankAccountId,
      description: "Customer refund",
      debit_minor: 0n,
      credit_minor: input.amountMinor,
    },
  ]);
}

/** Supplier pays us back. Debit the bank, credit accounts payable. This is not a new expense. */
export function supplierRefundJournal(input: {
  amountMinor: bigint;
  availableMinor: bigint;
  bankAccountId: string;
  payableAccountId: string;
}): JournalLineDraft[] {
  assertRefundWithinBalance(input.amountMinor, input.availableMinor);
  return assertBalanced([
    {
      account_id: input.bankAccountId,
      description: "Supplier refund",
      debit_minor: input.amountMinor,
      credit_minor: 0n,
    },
    {
      account_id: input.payableAccountId,
      description: "Supplier refund",
      debit_minor: 0n,
      credit_minor: input.amountMinor,
    },
  ]);
}

/** Direct bank receipt with no invoice. */
export function receiveMoneyJournal(input: {
  settlementAccountId: string;
  outputTaxAccountId: string;
  lines: MoneyLine[];
}): JournalLineDraft[] {
  const journal = salesReceiptJournal(input).map((line) =>
    line.description === "Sales receipt" ? { ...line, description: "Receive money" } : line,
  );
  return journal;
}

export function bankDepositJournal(input: {
  bankAccountId: string;
  items: Array<{
    id: string;
    undepositedAccountId: string;
    amountMinor: bigint;
    alreadyDeposited: boolean;
  }>;
}): JournalLineDraft[] {
  if (input.items.length === 0) throw new Error("Select at least one undeposited receipt");
  const seen = new Set<string>();
  let total = 0n;
  const credits: JournalLineDraft[] = [];
  for (const item of input.items) {
    if (seen.has(item.id)) throw new Error("The same receipt is selected twice");
    seen.add(item.id);
    if (item.alreadyDeposited) throw new Error("A selected receipt is already deposited");
    asMinor(item.amountMinor, "Receipt");
    if (item.amountMinor <= 0n) throw new Error("A receipt amount must be greater than zero");
    if (item.undepositedAccountId === input.bankAccountId) {
      throw new Error("The deposit bank cannot be the undeposited account");
    }
    total += item.amountMinor;
    credits.push({
      account_id: item.undepositedAccountId,
      description: "Bank deposit",
      debit_minor: 0n,
      credit_minor: item.amountMinor,
    });
  }
  return assertBalanced([
    {
      account_id: input.bankAccountId,
      description: "Bank deposit",
      debit_minor: total,
      credit_minor: 0n,
    },
    ...credits,
  ]);
}

export function cardPaymentJournal(input: {
  amountMinor: bigint;
  bankAccountId: string;
  liabilityAccountId: string;
  bankAccountType: string;
  liabilityAccountType: string;
}): JournalLineDraft[] {
  asMinor(input.amountMinor, "Payment");
  if (input.amountMinor <= 0n) throw new Error("Payment must be greater than zero");
  if (input.bankAccountId === input.liabilityAccountId) {
    throw new Error("Choose a bank account and a credit-card liability account");
  }
  if (input.liabilityAccountType !== "liability") {
    throw new Error("The credit card account must be a liability");
  }
  if (input.bankAccountType === "expense") {
    throw new Error("A credit-card payment is not an operating expense");
  }
  return assertBalanced([
    {
      account_id: input.liabilityAccountId,
      description: "Credit card payment",
      debit_minor: input.amountMinor,
      credit_minor: 0n,
    },
    {
      account_id: input.bankAccountId,
      description: "Credit card payment",
      debit_minor: 0n,
      credit_minor: input.amountMinor,
    },
  ]);
}

export type BankAdjustmentType = "bank_fee" | "interest_income" | "interest_expense";

export function bankAdjustmentJournal(input: {
  adjustmentType: BankAdjustmentType;
  amountMinor: bigint;
  bankAccountId: string;
  counterAccountId: string;
}): JournalLineDraft[] {
  asMinor(input.amountMinor, "Adjustment");
  if (input.amountMinor <= 0n) throw new Error("Adjustment must be greater than zero");
  if (input.bankAccountId === input.counterAccountId) {
    throw new Error("The bank account and the offset account must be different");
  }
  const amount = input.amountMinor;
  if (input.adjustmentType === "interest_income") {
    return assertBalanced([
      { account_id: input.bankAccountId, description: "Bank interest", debit_minor: amount, credit_minor: 0n },
      { account_id: input.counterAccountId, description: "Bank interest", debit_minor: 0n, credit_minor: amount },
    ]);
  }
  const description = input.adjustmentType === "bank_fee" ? "Bank fee" : "Bank interest expense";
  return assertBalanced([
    { account_id: input.counterAccountId, description, debit_minor: amount, credit_minor: 0n },
    { account_id: input.bankAccountId, description, debit_minor: 0n, credit_minor: amount },
  ]);
}

/** Saving a recurring journal template must not post. */
export function recurringJournalTemplatePostsOnSave(): boolean {
  return false;
}
