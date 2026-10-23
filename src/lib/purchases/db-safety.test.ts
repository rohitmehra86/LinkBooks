import { describe, expect, it } from "vitest";
import { isMissingFunctionError } from "@/lib/purchases/db-safety";

describe("isMissingFunctionError", () => {
  it("detects PostgREST and Postgres missing-function codes", () => {
    expect(isMissingFunctionError({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingFunctionError({ code: "42883", message: "x" })).toBe(true);
    expect(
      isMissingFunctionError({
        message: "Could not find the function public.foo(a) in the schema cache",
      }),
    ).toBe(true);
  });

  it("does not treat real failures as a missing function", () => {
    expect(isMissingFunctionError({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isMissingFunctionError({ code: "P0001", message: "Not allowed" })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });
});
