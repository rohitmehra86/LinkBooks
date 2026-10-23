import { describe, expect, it, vi, beforeEach } from "vitest";

const postJournal = vi.fn();
const reverseJournal = vi.fn();
const requireAccountByCode = vi.fn();

vi.mock("@/lib/accounting/posting-engine", () => ({
  postJournal: (...args: unknown[]) => postJournal(...args),
  reverseJournal: (...args: unknown[]) => reverseJournal(...args),
}));

vi.mock("@/lib/purchases/accounts", () => ({
  requireAccountByCode: (...args: unknown[]) => requireAccountByCode(...args),
}));

// AR control account is now resolved by system_key first; in these unit tests it resolves via the
// same mocked code lookup so the posting assertions below are unchanged.
vi.mock("@/lib/sales/ar-accounts", () => ({
  resolveArAccount: (supabase: unknown, companyId: string) =>
    requireAccountByCode(supabase, companyId, "1100"),
}));

import {
  postInvoiceAuthorisation,
  postCustomerReceipt,
  postSalesCreditAuthorisation,
  postBankTransfer,
} from "./posting";

function mockSupabase() {
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from } as never;
}

describe("sales posting", () => {
  beforeEach(() => {
    postJournal.mockReset();
    reverseJournal.mockReset();
    requireAccountByCode.mockReset();
    requireAccountByCode.mockImplementation(async (_s: unknown, _c: string, code: string) => ({
      id: `acc-${code}`,
      code,
    }));
    postJournal.mockResolvedValue({ journalId: "j1" });
  });

  it("posts invoice as DR AR / CR revenue / CR tax", async () => {
    await postInvoiceAuthorisation(mockSupabase(), {
      company_id: "c1",
      invoice_id: "inv1",
      invoice_date: "2026-01-15",
      currency_code: "GBP",
      lines: [{ account_id: "rev", description: "Svc", net_minor: 10000, tax_minor: 2000 }],
    });
    const args = postJournal.mock.calls[0]![1];
    expect(args.idempotency_key).toBe("sales_invoice:inv1:authorise");
    expect(args.source_type).toBe("sales_invoice");
    const ar = args.lines.find((l: { account_id: string }) => l.account_id === "acc-1100");
    expect(ar.debit_minor).toBe(12000n);
    const tax = args.lines.find((l: { account_id: string }) => l.account_id === "acc-2100");
    expect(tax.credit_minor).toBe(2000n);
  });

  it("posts receipt DR bank CR AR", async () => {
    await postCustomerReceipt({} as never, {
      company_id: "c1",
      receipt_id: "r1",
      receipt_date: "2026-01-16",
      currency_code: "GBP",
      bank_account_id: "bank",
      amount_minor: 5000,
    });
    const args = postJournal.mock.calls[0]![1];
    expect(args.idempotency_key).toBe("customer_receipt:r1:post");
    expect(args.lines[0].account_id).toBe("bank");
    expect(args.lines[0].debit_minor).toBe(5000n);
  });

  it("posts credit note DR revenue CR AR", async () => {
    await postSalesCreditAuthorisation(mockSupabase(), {
      company_id: "c1",
      credit_note_id: "cn1",
      credit_date: "2026-01-17",
      currency_code: "GBP",
      lines: [{ account_id: "rev", description: "Refund", net_minor: 1000, tax_minor: 0 }],
    });
    const args = postJournal.mock.calls[0]![1];
    expect(args.idempotency_key).toBe("sales_credit_note:cn1:authorise");
    const ar = args.lines.find((l: { account_id: string }) => l.account_id === "acc-1100");
    expect(ar.credit_minor).toBe(1000n);
  });

  it("posts transfer between distinct bank GLs", async () => {
    await postBankTransfer({} as never, {
      company_id: "c1",
      transfer_id: "t1",
      transfer_date: "2026-01-18",
      currency_code: "GBP",
      from_gl_account_id: "b1",
      to_gl_account_id: "b2",
      amount_minor: 2500,
    });
    const args = postJournal.mock.calls[0]![1];
    expect(args.idempotency_key).toBe("bank_transfer:t1:post");
    expect(args.lines).toHaveLength(2);
  });

  it("rejects same-account transfer", async () => {
    await expect(
      postBankTransfer({} as never, {
        company_id: "c1",
        transfer_id: "t1",
        transfer_date: "2026-01-18",
        currency_code: "GBP",
        from_gl_account_id: "b1",
        to_gl_account_id: "b1",
        amount_minor: 100,
      }),
    ).rejects.toThrow(/differ/i);
  });
});
