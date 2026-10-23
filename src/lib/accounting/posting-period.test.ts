import { describe, expect, it } from "vitest";
import {
  ensureFiscalPeriodForDate,
  isMissingRpcError,
  isNoPeriodError,
  postJournal,
  type PostJournalInput,
} from "./posting-engine";

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

function fakeClient(handlers: Record<string, RpcResult[]>) {
  const calls: string[] = [];
  const client = {
    rpc: async (fn: string) => {
      calls.push(fn);
      const queue = handlers[fn];
      if (!queue || queue.length === 0) throw new Error(`unexpected rpc ${fn}`);
      return queue.shift() as RpcResult;
    },
  };
  return { client: client as never, calls };
}

const input: PostJournalInput = {
  company_id: "c1",
  journal_date: "2027-03-01",
  lines: [
    { account_id: "a", debit_minor: 100n, credit_minor: 0n },
    { account_id: "b", debit_minor: 0n, credit_minor: 100n },
  ],
};

const noPeriod: RpcResult = {
  data: null,
  error: { message: "No accounting period covers posting date 2027-03-01" },
};

describe("AC-01 period auto-creation", () => {
  it("creates the period and retries once when none covers the date", async () => {
    const { client, calls } = fakeClient({
      post_journal: [noPeriod, { data: "journal-1", error: null }],
      ensure_fiscal_period_for_date: [{ data: "period-1", error: null }],
    });
    const res = await postJournal(client, input);
    expect(res.journalId).toBe("journal-1");
    expect(calls).toEqual(["post_journal", "ensure_fiscal_period_for_date", "post_journal"]);
  });

  it("surfaces the original error when the migration is not applied", async () => {
    const { client, calls } = fakeClient({
      post_journal: [noPeriod],
      ensure_fiscal_period_for_date: [
        { data: null, error: { code: "PGRST202", message: "Could not find the function" } },
      ],
    });
    await expect(postJournal(client, input)).rejects.toThrow(/No accounting period covers/);
    expect(calls).toEqual(["post_journal", "ensure_fiscal_period_for_date"]);
  });

  it("does not try to create a period for other errors", async () => {
    const { client, calls } = fakeClient({
      post_journal: [{ data: null, error: { message: "Accounting period is locked" } }],
    });
    await expect(postJournal(client, input)).rejects.toThrow(/locked/);
    expect(calls).toEqual(["post_journal"]);
  });

  it("reports why a period could not be created", async () => {
    const { client } = fakeClient({
      ensure_fiscal_period_for_date: [
        { data: null, error: { message: "Posting date is outside the supported range" } },
      ],
    });
    const res = await ensureFiscalPeriodForDate(client, "c1", "1900-01-01");
    expect(res).toEqual({ ok: false, reason: "Posting date is outside the supported range" });
  });

  it("classifies errors", () => {
    expect(isNoPeriodError("No accounting period covers posting date 2027-01-01")).toBe(true);
    expect(isNoPeriodError("other")).toBe(false);
    expect(isMissingRpcError({ code: "42883", message: "x" })).toBe(true);
    expect(isMissingRpcError({ message: "boom" })).toBe(false);
    expect(isMissingRpcError(null)).toBe(false);
  });
});
