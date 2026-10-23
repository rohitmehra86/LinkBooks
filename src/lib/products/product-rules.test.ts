import { describe, expect, it } from "vitest";
import { productAccountProblem } from "@/lib/products/product-rules";

describe("productAccountProblem", () => {
  it("accepts income accounts for sales", () => {
    expect(productAccountProblem("income", "income", "service")).toBeNull();
  });
  it("rejects bank/asset/expense accounts for sales", () => {
    for (const t of ["asset", "liability", "equity", "expense"]) {
      expect(productAccountProblem("income", t, "service")).not.toBeNull();
    }
  });
  it("accepts expense accounts for purchases", () => {
    expect(productAccountProblem("expense", "expense", "service")).toBeNull();
  });
  it("accepts asset accounts for purchases only for stock products", () => {
    expect(productAccountProblem("expense", "asset", "product")).toBeNull();
    expect(productAccountProblem("expense", "asset", "service")).not.toBeNull();
    expect(productAccountProblem("expense", "income", "product")).not.toBeNull();
  });
  it("reports a missing account", () => {
    expect(productAccountProblem("income", null, "service")).toMatch(/not found/);
  });
});
