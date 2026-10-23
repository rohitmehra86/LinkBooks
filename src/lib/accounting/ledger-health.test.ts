import { describe, expect, it } from "vitest";
import {
  checkHref,
  headline,
  overallStatus,
  parseHealthReport,
  problemLabel,
} from "./ledger-health";

const raw = (checks: Array<Record<string, unknown>>) => ({
  company_id: "c1",
  base_currency: "GBP",
  generated_at: "2026-10-25T10:00:00Z",
  overall: "pass", // never trusted: recomputed from the checks
  journals_checked: 12,
  lines_checked: 24,
  checks,
});

const check = (key: string, status: string, over: Record<string, unknown> = {}) => ({
  key,
  label: key,
  status,
  count: status === "pass" ? 0 : 1,
  summary: "s",
  items: [],
  ...over,
});

describe("overallStatus", () => {
  it("worst status wins and n/a does not count", () => {
    expect(overallStatus([{ status: "pass" }, { status: "na" }])).toBe("pass");
    expect(overallStatus([{ status: "pass" }, { status: "warn" }])).toBe("warn");
    expect(overallStatus([{ status: "warn" }, { status: "fail" }, { status: "pass" }])).toBe(
      "fail",
    );
    expect(overallStatus([])).toBe("pass");
  });
});

describe("parseHealthReport", () => {
  it("recomputes the overall status from the checks", () => {
    const r = parseHealthReport(raw([check("a", "pass"), check("b", "fail")]));
    expect(r.overall).toBe("fail");
    expect(r.journalsChecked).toBe(12);
    expect(r.baseCurrency).toBe("GBP");
  });

  it("treats an unknown status as a failure, never a pass", () => {
    const r = parseHealthReport(raw([check("a", "ok-ish")]));
    expect(r.checks[0]!.status).toBe("fail");
    expect(r.overall).toBe("fail");
  });

  it("keeps items and drops junk", () => {
    const r = parseHealthReport(
      raw([check("a", "fail", { items: [{ x: 1 }, null, "text", { y: "z" }] })]),
    );
    expect(r.checks[0]!.items).toEqual([{ x: 1 }, { y: "z" }]);
  });

  it("rejects an empty result", () => {
    expect(() => parseHealthReport(null)).toThrow();
  });
});

describe("headline", () => {
  it("says what passed or failed", () => {
    const pass = parseHealthReport(raw([check("a", "pass"), check("b", "na"), check("c", "pass")]));
    expect(headline(pass)).toBe("All 2 checks passed.");
    const bad = parseHealthReport(
      raw([check("a", "fail"), check("b", "warn"), check("c", "pass")]),
    );
    expect(headline(bad)).toBe("1 failed, 1 need a look of 3 checks.");
  });
});

describe("labels and links", () => {
  it("words known problems and falls back for unknown ones", () => {
    expect(problemLabel("no_journal")).toBe("Issued but has no journal");
    expect(problemLabel("some_new_problem")).toBe("some new problem");
    expect(problemLabel(null)).toBe("Problem");
  });
  it("points subledger checks at the aged reports", () => {
    expect(checkHref("subledger_ar")).toBe("/reports/aged-receivables");
    expect(checkHref("subledger_ap")).toBe("/reports/aged-payables");
    expect(checkHref("nope")).toBeNull();
  });
});
