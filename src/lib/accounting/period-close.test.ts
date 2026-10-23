import { describe, expect, it } from "vitest";
import { buildCloseChecklist, summariseChecklist, type CloseFacts } from "./period-close";

const clean: CloseFacts = {
  periodEnd: "2026-12-31",
  unreconciledBankLines: 0,
  draftDocuments: 0,
  ar: { found: true, variance: 0 },
  ap: { found: true, variance: 0 },
  openingBalanceMinor: 0,
  taxReturn: { applicable: true, filed: true },
  yearEnd: { closed: true },
};

const status = (f: CloseFacts, id: string) =>
  buildCloseChecklist(f).find((c) => c.id === id)?.status;

describe("period close checklist", () => {
  it("is clean when everything agrees", () => {
    const s = summariseChecklist(buildCloseChecklist(clean));
    expect(s).toEqual({ blockers: 0, warnings: 0, clean: true });
  });

  it("fails on unreconciled bank lines and subledger variances", () => {
    const f = { ...clean, unreconciledBankLines: 3, ar: { found: true, variance: 500 } };
    expect(status(f, "bank")).toBe("fail");
    expect(status(f, "ar_tie")).toBe("fail");
    expect(summariseChecklist(buildCloseChecklist(f)).blockers).toBe(2);
  });

  it("warns (not blocks) for drafts, opening balance, missing return and open year-end", () => {
    const f: CloseFacts = {
      ...clean,
      draftDocuments: 2,
      openingBalanceMinor: 1200,
      taxReturn: { applicable: true, filed: false },
      yearEnd: { closed: false },
    };
    expect(status(f, "drafts")).toBe("warn");
    expect(status(f, "opening_balance")).toBe("warn");
    expect(status(f, "tax_return")).toBe("warn");
    expect(status(f, "year_end")).toBe("warn");
    const s = summariseChecklist(buildCloseChecklist(f));
    expect(s.blockers).toBe(0);
    expect(s.warnings).toBe(4);
    expect(s.clean).toBe(false);
  });

  it("marks checks not applicable when the data does not exist", () => {
    const f: CloseFacts = {
      ...clean,
      ar: { found: false, variance: 0 },
      ap: null,
      openingBalanceMinor: null,
      taxReturn: null,
      yearEnd: null,
    };
    const items = buildCloseChecklist(f);
    expect(items.find((i) => i.id === "ar_tie")?.status).toBe("na");
    expect(items.find((i) => i.id === "ap_tie")?.status).toBe("na");
    expect(items.find((i) => i.id === "opening_balance")?.status).toBe("na");
    expect(items.find((i) => i.id === "tax_return")?.status).toBe("na");
    expect(items.find((i) => i.id === "year_end")).toBeUndefined();
  });

  it("uses singular wording for one item", () => {
    const items = buildCloseChecklist({ ...clean, unreconciledBankLines: 1 });
    expect(items.find((i) => i.id === "bank")?.detail).toMatch(/^1 bank line is not/);
  });
});
