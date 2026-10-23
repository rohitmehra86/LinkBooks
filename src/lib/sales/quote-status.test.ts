import { describe, expect, it } from "vitest";
import {
  assertQuoteTransition,
  canTransitionQuote,
  isQuoteConvertible,
  quoteTimestampColumns,
} from "./quote-status";

describe("quote status transitions", () => {
  it("allows the normal pipeline", () => {
    expect(canTransitionQuote("draft", "sent")).toBe(true);
    expect(canTransitionQuote("sent", "accepted")).toBe(true);
    expect(canTransitionQuote("sent", "declined")).toBe(true);
    expect(canTransitionQuote("accepted", "void")).toBe(true);
  });

  it("blocks backwards and nonsensical moves", () => {
    expect(canTransitionQuote("accepted", "draft")).toBe(false);
    expect(canTransitionQuote("declined", "accepted")).toBe(false);
    expect(canTransitionQuote("draft", "expired")).toBe(false);
    expect(canTransitionQuote("accepted", "expired")).toBe(false);
  });

  it("treats converted and void as terminal", () => {
    expect(canTransitionQuote("converted", "void")).toBe(false);
    expect(canTransitionQuote("void", "draft")).toBe(false);
  });

  it("never allows a manual move to converted", () => {
    expect(() => assertQuoteTransition("accepted", "converted")).toThrow(/Convert to invoice/);
  });

  it("rejects same-status and unknown statuses", () => {
    expect(() => assertQuoteTransition("sent", "sent")).toThrow();
    expect(canTransitionQuote("sent", "bogus")).toBe(false);
  });

  it("stamps sent/accepted/declined dates", () => {
    expect(quoteTimestampColumns("sent", "T")).toEqual({ sent_at: "T" });
    expect(quoteTimestampColumns("accepted", "T")).toEqual({ accepted_at: "T" });
    expect(quoteTimestampColumns("declined", "T")).toEqual({ declined_at: "T" });
    expect(quoteTimestampColumns("void", "T")).toEqual({});
  });
});

describe("isQuoteConvertible", () => {
  it("accepts draft/sent/accepted within expiry", () => {
    expect(isQuoteConvertible({ status: "accepted", expiry_date: "2026-12-31" }, "2026-10-23")).toEqual({
      ok: true,
    });
    expect(isQuoteConvertible({ status: "draft", expiry_date: null }, "2026-10-23").ok).toBe(true);
  });
  it("refuses expired, declined, void and converted quotes", () => {
    expect(isQuoteConvertible({ status: "sent", expiry_date: "2026-10-01" }, "2026-10-23").ok).toBe(false);
    expect(isQuoteConvertible({ status: "declined", expiry_date: null }, "2026-10-23").ok).toBe(false);
    expect(isQuoteConvertible({ status: "expired", expiry_date: null }, "2026-10-23").ok).toBe(false);
    expect(
      isQuoteConvertible({ status: "accepted", expiry_date: null, converted_invoice_id: "x" }, "2026-10-23").ok,
    ).toBe(false);
  });
});
