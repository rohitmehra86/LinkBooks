import { describe, expect, it } from "vitest";
import { csvCell, minorToDecimalString, toCsv } from "./csv";

describe("csv", () => {
  it("quotes cells with commas, quotes and newlines", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
  });

  it("neutralises spreadsheet formulas but leaves negative numbers alone", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("-evil")).toBe("'-evil");
  });

  it("writes CRLF rows with a header", () => {
    expect(toCsv(["a", "b"], [[1, "x,y"]])).toBe('a,b\r\n1,"x,y"\r\n');
  });

  it("formats minor units", () => {
    expect(minorToDecimalString(12345)).toBe("123.45");
    expect(minorToDecimalString(-5)).toBe("-0.05");
    expect(minorToDecimalString(1000, 0)).toBe("1000");
    expect(minorToDecimalString(1234, 3)).toBe("1.234");
  });
});
