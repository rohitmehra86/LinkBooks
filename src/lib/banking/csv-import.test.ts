import { describe, expect, it } from "vitest";
import { applyBankRule, parseBankCsv } from "./csv-import";

describe("parseBankCsv", () => {
  it("parses header + rows and hashes external ids", () => {
    const csv = `date,description,amount,reference
2026-01-10,Salary,1500.00,PAY1
10/01/2026,Coffee,-4.50,
`;
    const { rows, errors } = parseBankCsv(csv);
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amount_minor).toBe(150000n);
    expect(rows[1]!.amount_minor).toBe(-450n);
    expect(rows[0]!.external_id).toMatch(/^csv_/);
  });

  it("reports invalid dates and amounts", () => {
    const { rows, errors } = parseBankCsv("not-a-date,x,abc\n");
    expect(rows).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("produces same hash for duplicate content", () => {
    const line = "2026-02-01,Same,10.00,R1";
    const a = parseBankCsv(line).rows[0]!;
    const b = parseBankCsv(line).rows[0]!;
    expect(a.external_id).toBe(b.external_id);
  });
});

describe("applyBankRule", () => {
  it("matches contains / equals / starts_with", () => {
    expect(
      applyBankRule("ACME CORP FEE", null, {
        match_field: "description",
        match_pattern: "acme",
        match_type: "contains",
      }),
    ).toBe(true);
    expect(
      applyBankRule("ACME", null, {
        match_field: "description",
        match_pattern: "acme",
        match_type: "equals",
      }),
    ).toBe(true);
    expect(
      applyBankRule("NETFLIX.COM", null, {
        match_field: "description",
        match_pattern: "netflix",
        match_type: "starts_with",
      }),
    ).toBe(true);
    expect(
      applyBankRule("Other", "REF", {
        match_field: "reference",
        match_pattern: "ref",
        match_type: "equals",
      }),
    ).toBe(true);
  });
});
