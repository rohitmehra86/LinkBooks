import { describe, expect, it } from "vitest";
import { isMissingRpc, requireRpc } from "./rpc";

describe("isMissingRpc", () => {
  it("detects an undeployed function via PostgREST and Postgres codes", () => {
    expect(
      isMissingRpc(
        {
          code: "PGRST202",
          message:
            "Could not find the function public.record_customer_receipt(payload) in the schema cache",
        },
        "record_customer_receipt",
      ),
    ).toBe(true);
    expect(
      isMissingRpc(
        { code: "42883", message: "function public.record_customer_receipt(jsonb) does not exist" },
        "record_customer_receipt",
      ),
    ).toBe(true);
  });

  it("does not treat errors raised inside a deployed function as missing", () => {
    expect(
      isMissingRpc(
        { code: "P0001", message: "Allocations exceed receipt amount" },
        "record_customer_receipt",
      ),
    ).toBe(false);
    // 42883 about some OTHER function (e.g. a missing dependency) must surface, not trigger a fallback
    expect(
      isMissingRpc(
        {
          code: "42883",
          message: "function public.reverse_journal_on(uuid, date, text) does not exist",
        },
        "void_customer_receipt",
      ),
    ).toBe(false);
    expect(isMissingRpc(null, "x")).toBe(false);
  });

  it("requireRpc explains a missing migration", () => {
    expect(() => requireRpc({ missing: true }, "void_customer_receipt", "20261024110300")).toThrow(
      /20261024110300/,
    );
    expect(requireRpc({ missing: false, data: 5 }, "f", "m")).toBe(5);
  });
});
