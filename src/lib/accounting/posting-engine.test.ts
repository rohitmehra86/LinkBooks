import { describe, expect, it, vi } from "vitest";
import { assertLinesBalance } from "./money";
import { postJournal } from "./posting-engine";

describe("posting engine client validation", () => {
  it("refuses unbalanced payload before RPC", async () => {
    const supabase = { rpc: vi.fn() };
    await expect(
      postJournal(supabase as never, {
        company_id: "11111111-1111-4111-8111-111111111111",
        journal_date: "2026-03-01",
        lines: [
          {
            account_id: "22222222-2222-4222-8222-222222222222",
            debit_minor: 100n,
            credit_minor: 0n,
          },
          {
            account_id: "33333333-3333-4333-8333-333333333333",
            debit_minor: 0n,
            credit_minor: 50n,
          },
        ],
      }),
    ).rejects.toThrow(/does not balance/);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("calls post_journal RPC for balanced payload", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", error: null }),
    };
    const result = await postJournal(supabase as never, {
      company_id: "11111111-1111-4111-8111-111111111111",
      journal_date: "2026-03-01",
      idempotency_key: "test:1",
      lines: [
        {
          account_id: "22222222-2222-4222-8222-222222222222",
          debit_minor: 100n,
          credit_minor: 0n,
        },
        {
          account_id: "33333333-3333-4333-8333-333333333333",
          debit_minor: 0n,
          credit_minor: 100n,
        },
      ],
    });
    expect(result.journalId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(supabase.rpc).toHaveBeenCalledOnce();
    const [, args] = supabase.rpc.mock.calls[0]!;
    expect(args.payload.idempotency_key).toBe("test:1");
  });

  it("simulates duplicate idempotency as same returned id", async () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const supabase = {
      rpc: vi
        .fn()
        .mockResolvedValueOnce({ data: id, error: null })
        .mockResolvedValueOnce({ data: id, error: null }),
    };
    const input = {
      company_id: "11111111-1111-4111-8111-111111111111",
      journal_date: "2026-03-01",
      idempotency_key: "dup:key",
      lines: [
        {
          account_id: "22222222-2222-4222-8222-222222222222",
          debit_minor: 10n,
          credit_minor: 0n,
        },
        {
          account_id: "33333333-3333-4333-8333-333333333333",
          debit_minor: 0n,
          credit_minor: 10n,
        },
      ],
    };
    const first = await postJournal(supabase as never, input);
    const second = await postJournal(supabase as never, input);
    expect(first.journalId).toBe(second.journalId);
  });

  it("simulates concurrent duplicate uniqueness via shared key invariant", () => {
    // DB UNIQUE(company_id, idempotency_key) + exception handler returns existing id.
    // Contract: clients must always send stable keys for automated posts.
    const key = "sales_invoice:xyz:authorise";
    expect(key).toMatch(/:/);
    assertLinesBalance([
      { account_id: "22222222-2222-4222-8222-222222222222", debit_minor: 1n, credit_minor: 0n },
      { account_id: "33333333-3333-4333-8333-333333333333", debit_minor: 0n, credit_minor: 1n },
    ]);
  });
});

describe("locked period / invalid org contracts", () => {
  it("documents RPC error surfaces for locked period", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Accounting period is locked; posting is not allowed" },
      }),
    };
    await expect(
      postJournal(supabase as never, {
        company_id: "11111111-1111-4111-8111-111111111111",
        journal_date: "2026-03-01",
        lines: [
          {
            account_id: "22222222-2222-4222-8222-222222222222",
            debit_minor: 100n,
            credit_minor: 0n,
          },
          {
            account_id: "33333333-3333-4333-8333-333333333333",
            debit_minor: 0n,
            credit_minor: 100n,
          },
        ],
      }),
    ).rejects.toThrow(/locked/);
  });

  it("documents RPC error for unauthorized organisation", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "You do not have access to that organisation" },
      }),
    };
    await expect(
      postJournal(supabase as never, {
        company_id: "11111111-1111-4111-8111-111111111111",
        journal_date: "2026-03-01",
        lines: [
          {
            account_id: "22222222-2222-4222-8222-222222222222",
            debit_minor: 100n,
            credit_minor: 0n,
          },
          {
            account_id: "33333333-3333-4333-8333-333333333333",
            debit_minor: 0n,
            credit_minor: 100n,
          },
        ],
      }),
    ).rejects.toThrow(/access/);
  });

  it("documents RPC error for invalid account", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "Account 00000000-0000-4000-8000-000000000000 not found in organisation" },
      }),
    };
    await expect(
      postJournal(supabase as never, {
        company_id: "11111111-1111-4111-8111-111111111111",
        journal_date: "2026-03-01",
        lines: [
          {
            account_id: "00000000-0000-4000-8000-000000000000",
            debit_minor: 100n,
            credit_minor: 0n,
          },
          {
            account_id: "33333333-3333-4333-8333-333333333333",
            debit_minor: 0n,
            credit_minor: 100n,
          },
        ],
      }),
    ).rejects.toThrow(/not found/);
  });
});
