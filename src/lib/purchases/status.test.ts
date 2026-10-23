import { describe, expect, it } from "vitest";
import {
  creditRemainingMinor,
  deriveCreditNoteStatus,
  nextBillStatus,
} from "@/lib/purchases/status";

const bill = (status: string, paid: number, credited: number) => ({
  status,
  total_minor: 1000,
  amount_paid_minor: paid,
  amount_credited_minor: credited,
});

describe("nextBillStatus", () => {
  it("moves through the lifecycle from balances", () => {
    expect(nextBillStatus(bill("authorised", 0, 0))).toBe("authorised");
    expect(nextBillStatus(bill("authorised", 400, 0))).toBe("partly_paid");
    expect(nextBillStatus(bill("partly_paid", 400, 600))).toBe("paid");
    expect(nextBillStatus(bill("paid", 0, 0))).toBe("authorised");
  });

  it("never touches unposted or void bills", () => {
    expect(nextBillStatus(bill("draft", 0, 0))).toBe("draft");
    expect(nextBillStatus(bill("awaiting_approval", 0, 0))).toBe("awaiting_approval");
    expect(nextBillStatus(bill("void", 0, 0))).toBe("void");
  });
});

describe("deriveCreditNoteStatus", () => {
  const credit = (status: string, used: number) => ({
    status,
    total_minor: 500,
    amount_allocated_minor: used,
  });
  it("is paid when fully used, even if allocated at creation", () => {
    expect(deriveCreditNoteStatus(credit("authorised", 500))).toBe("paid");
  });
  it("is partly_paid when partly used and authorised when unused", () => {
    expect(deriveCreditNoteStatus(credit("authorised", 100))).toBe("partly_paid");
    expect(deriveCreditNoteStatus(credit("paid", 0))).toBe("authorised");
  });
  it("leaves draft and void alone", () => {
    expect(deriveCreditNoteStatus(credit("draft", 0))).toBe("draft");
    expect(deriveCreditNoteStatus(credit("void", 0))).toBe("void");
  });
  it("computes remaining credit", () => {
    expect(creditRemainingMinor({ total_minor: 500, amount_allocated_minor: 120 })).toBe(380n);
    expect(creditRemainingMinor({ total_minor: 500, amount_allocated_minor: 900 })).toBe(0n);
  });
});
