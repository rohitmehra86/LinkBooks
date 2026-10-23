import { describe, expect, it } from "vitest";
import {
  QUICK_REPORT_IDS,
  REPORT_CATALOG,
  getReportById,
  nonEmptyCategories,
  searchReports,
} from "./catalog";

describe("reports catalogue", () => {
  it("lists only honest ready vs depends entries", () => {
    expect(REPORT_CATALOG.length).toBeGreaterThan(8);
    expect(REPORT_CATALOG.every((r) => r.status === "ready" || r.status === "depends")).toBe(true);
    for (const r of REPORT_CATALOG.filter((x) => x.status === "depends")) {
      expect(r.dependency).toBeTruthy();
      expect(r.runner).toBe("none");
    }
  });

  it("quick links resolve to ready reports", () => {
    for (const id of QUICK_REPORT_IDS) {
      const r = getReportById(id);
      expect(r?.status).toBe("ready");
    }
  });

  it("searches by title and tags", () => {
    expect(searchReports("aged").some((r) => r.id === "aged-receivables")).toBe(true);
    // Budgets now exist, so the budget report is a real runner rather than a blocked placeholder.
    expect(searchReports("budget")[0]?.id).toBe("budget-vs-actual");
    expect(getReportById("budget-vs-actual")?.status).toBe("ready");
    expect(getReportById("budget-vs-actual")?.runner).toBe("budget_vs_actual");
  });

  it("every ready report has a runner or a link target", () => {
    for (const r of REPORT_CATALOG.filter((x) => x.status === "ready")) {
      expect(r.runner).not.toBe("none");
      if (r.runner === "link") expect(r.linkTo).toBeTruthy();
    }
    const ids = REPORT_CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("link reports point at an existing screen and runner reports have a runner", () => {
    for (const r of REPORT_CATALOG.filter((x) => x.runner === "link")) {
      expect(r.linkTo).toBeTruthy();
    }
    expect(getReportById("general-ledger-all")?.runner).toBe("general_ledger_all");
    expect(getReportById("statement-of-changes-in-equity")?.status).toBe("ready");
    expect(getReportById("bank-reconciliation")?.linkTo).toBe("/banking/reconcile");
  });

  it("never lists a category with no reports (RP-10)", () => {
    const cats = nonEmptyCategories();
    expect(cats.some((c) => c.id === "custom")).toBe(false);
    expect(cats.some((c) => c.id === "contacts")).toBe(false);
    for (const c of cats) expect(REPORT_CATALOG.some((r) => r.category === c.id)).toBe(true);
    const filtered = nonEmptyCategories(searchReports("aged"));
    expect(filtered.map((c) => c.id).sort()).toEqual(["purchases", "sales"]);
  });
});
