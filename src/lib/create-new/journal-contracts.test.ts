import { describe, expect, it } from "vitest";
import {
  bankAdjustmentJournal,
  bankDepositJournal,
  cardPaymentJournal,
  customerRefundJournal,
  receiveMoneyJournal,
  recurringJournalTemplatePostsOnSave,
  salesReceiptJournal,
  supplierRefundJournal,
} from "@/lib/create-new/journal-contracts";

const bank = "bank";
const income = "income";
const tax = "tax";
const ar = "ar";
const ap = "ap";
const clearing = "clearing";
const card = "card";
const expense = "expense";

describe("create-new journals", () => {
  it("posts a sales receipt to cash and income with no receivable", () => {
    const lines = salesReceiptJournal({
      settlementAccountId: bank,
      outputTaxAccountId: tax,
      lines: [{ accountId: income, netMinor: 10000n, taxMinor: 2000n, description: "Service" }],
    });
    expect(lines.some((line) => line.account_id === ar)).toBe(false);
    expect(lines.find((line) => line.account_id === bank)?.debit_minor).toBe(12000n);
    expect(lines.find((line) => line.account_id === income)?.credit_minor).toBe(10000n);
    expect(lines.find((line) => line.account_id === tax)?.credit_minor).toBe(2000n);
  });

  it("refuses a customer refund above the credit balance", () => {
    expect(() =>
      customerRefundJournal({
        amountMinor: 500n,
        availableMinor: 400n,
        bankAccountId: bank,
        creditBalanceAccountId: ar,
      }),
    ).toThrow(/available balance/);
  });

  it("receives a supplier refund into the bank and accounts payable", () => {
    const lines = supplierRefundJournal({
      amountMinor: 800n,
      availableMinor: 800n,
      bankAccountId: bank,
      payableAccountId: ap,
    });
    expect(lines.find((line) => line.account_id === bank)?.debit_minor).toBe(800n);
    expect(lines.find((line) => line.account_id === ap)?.credit_minor).toBe(800n);
    expect(lines.some((line) => line.account_id === expense)).toBe(false);
  });

  it("receives money without an invoice", () => {
    const lines = receiveMoneyJournal({
      settlementAccountId: clearing,
      outputTaxAccountId: tax,
      lines: [{ accountId: income, netMinor: 5000n, taxMinor: 0n, description: "Grant" }],
    });
    expect(lines[0]?.account_id).toBe(clearing);
    expect(lines[0]?.description).toBe("Receive money");
  });

  it("refuses to deposit a receipt twice", () => {
    expect(() =>
      bankDepositJournal({
        bankAccountId: bank,
        items: [
          { id: "r1", undepositedAccountId: clearing, amountMinor: 100n, alreadyDeposited: true },
        ],
      }),
    ).toThrow(/already deposited/);
  });

  it("settles a credit card liability from the bank", () => {
    const lines = cardPaymentJournal({
      amountMinor: 2500n,
      bankAccountId: bank,
      liabilityAccountId: card,
      bankAccountType: "asset",
      liabilityAccountType: "liability",
    });
    expect(lines.find((line) => line.account_id === card)?.debit_minor).toBe(2500n);
    expect(lines.find((line) => line.account_id === bank)?.credit_minor).toBe(2500n);
    expect(() =>
      cardPaymentJournal({
        amountMinor: 10n,
        bankAccountId: expense,
        liabilityAccountId: card,
        bankAccountType: "expense",
        liabilityAccountType: "liability",
      }),
    ).toThrow(/not an operating expense/);
  });

  it("records a bank fee against the bank balance", () => {
    const lines = bankAdjustmentJournal({
      adjustmentType: "bank_fee",
      amountMinor: 150n,
      bankAccountId: bank,
      counterAccountId: expense,
    });
    expect(lines.find((line) => line.account_id === expense)?.debit_minor).toBe(150n);
    expect(lines.find((line) => line.account_id === bank)?.credit_minor).toBe(150n);
  });

  it("does not post when a recurring journal template is saved", () => {
    expect(recurringJournalTemplatePostsOnSave()).toBe(false);
  });
});
