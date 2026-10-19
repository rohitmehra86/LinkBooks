import { describe, expect, it } from "vitest";
import { assertUuid, validateCompanyInput, validateTaxRegime } from "./company-validation";

describe("assertUuid", () => {
  it("accepts a valid uuid", () => {
    expect(assertUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rejects invalid ids", () => {
    expect(() => assertUuid("not-a-uuid")).toThrow(/Invalid company id/);
    expect(() => assertUuid(null)).toThrow(/Invalid company id/);
  });
});

describe("validateCompanyInput", () => {
  const valid = {
    name: "Northgate Consulting",
    country_code: "gb",
    base_currency: "gbp",
    fiscal_year_end_month: 3,
    fiscal_year_end_day: 31,
    timezone: "Europe/London",
  };

  it("normalises country and currency", () => {
    const result = validateCompanyInput(valid);
    expect(result.country_code).toBe("GB");
    expect(result.base_currency).toBe("GBP");
    expect(result.name).toBe("Northgate Consulting");
  });

  it("rejects short names", () => {
    expect(() => validateCompanyInput({ ...valid, name: "A" })).toThrow(/company name/);
  });

  it("rejects invalid FY day for month", () => {
    expect(() =>
      validateCompanyInput({ ...valid, fiscal_year_end_month: 2, fiscal_year_end_day: 31 }),
    ).toThrow(/financial year end day/);
  });
});

describe("validateTaxRegime", () => {
  it("defaults unknown to none", () => {
    expect(validateTaxRegime("mystery")).toBe("none");
    expect(validateTaxRegime("vat")).toBe("vat");
  });
});
