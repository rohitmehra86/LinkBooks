import { describe, expect, it } from "vitest";
import { QUICK_REPORT_IDS, REPORT_CATALOG, getReportById, searchReports } from "./catalog";

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
    expect(searchReports("budget")[0]?.status).toBe("depends");
  });
});
