import { describe, expect, it } from "vitest";
import { csvCell, csvFilename, toCsv } from "./csv";

describe("report CSV (RP-08)", () => {
  it("quotes, escapes and keeps numbers numeric", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell(-12.5)).toBe('"-12.5"');
    expect(csvCell("-12.50")).toBe('"-12.50"');
    expect(csvCell(10n)).toBe('"10"');
    expect(csvCell(null)).toBe('""');
  });
  it("neutralises formula injection in text", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("@cmd")).toBe('"\'@cmd"');
    expect(csvCell("+1 supplier")).toBe('"\'+1 supplier"');
  });
  it("writes a shared header then the table", () => {
    const csv = toCsv(
      {
        company: "Acme",
        report: "Trial balance",
        period: "As at 2026-03-31",
        currency: "GBP",
        generatedAt: "2026-04-01T00:00:00Z",
      },
      ["Code", "Debit"],
      [["1000", "5.00"]],
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe('"Company","Acme"');
    expect(lines).toContain('"Code","Debit"');
    expect(lines[lines.length - 1]).toBe('"1000","5.00"');
    expect(lines.indexOf("")).toBeGreaterThan(0);
  });
  it("builds a safe filename", () => {
    expect(csvFilename("Profit & Loss", "2026-01-01 to 2026-03-31")).toBe(
      "profit-loss-2026-01-01-to-2026-03-31.csv",
    );
  });
});
