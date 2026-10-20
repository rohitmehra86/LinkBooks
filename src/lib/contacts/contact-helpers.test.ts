import { describe, expect, it } from "vitest";
import {
  buildContactsCsv,
  csvEscape,
  dueDateFromTerms,
  duplicateScore,
  normalizeContactName,
  parseContactsCsv,
} from "./contact-helpers";

describe("contact-helpers", () => {
  it("normalizes names", () => {
    expect(normalizeContactName("  Acme   Ltd ")).toBe("acme ltd");
  });

  it("computes due dates from terms", () => {
    expect(dueDateFromTerms("2026-01-01", 30)).toBe("2026-01-31");
    expect(dueDateFromTerms("2026-01-01", 0)).toBe("2026-01-01");
  });

  it("escapes CSV and formula injection", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("=1+1")).toBe("'=1+1");
  });

  it("round-trips CSV parse", () => {
    const csv = buildContactsCsv(
      [{ name: "A", kind: "customer", email: null }],
      ["name", "kind", "email"],
    );
    const { headers, rows } = parseContactsCsv(csv);
    expect(headers).toEqual(["name", "kind", "email"]);
    expect(rows[0]?.[0]).toBe("A");
  });

  it("scores duplicates", () => {
    const { score, reasons } = duplicateScore(
      { name: "Acme", email: "a@x.com", tax_number: "T1" },
      { name: "Acme", email: "a@x.com", tax_number: "T1" },
    );
    expect(score).toBeGreaterThanOrEqual(90);
    expect(reasons).toContain("Same name");
    expect(reasons).toContain("Same email");
  });
});
