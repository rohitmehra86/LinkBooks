import { describe, expect, it } from "vitest";
import { findLookupDuplicates } from "@/lib/lookup/duplicates";
import {
  accountSelectionProblem,
  bankSelectionProblem,
  taxSelectionProblem,
  toAccountLookupOption,
  toBankLookupOption,
  toContactLookupOption,
  toProductLookupOption,
  toTaxLookupOption,
  toTrackingLookupOption,
} from "@/lib/lookup/eligibility";
import {
  belongsToOrganisation,
  filterLookupOptions,
  formatLookupLabel,
  groupLookupOptions,
  isCurrentRequest,
  lookupCacheKey,
  lookupPopupMaxHeight,
  sliceLookupPage,
} from "@/lib/lookup/search";
import {
  activationTarget,
  canOfferCreate,
  initialLookupUi,
  lookupKeyAction,
  reduceLookupUi,
  withResultCount,
} from "@/lib/lookup/session";
import type { LookupOption } from "@/lib/lookup/types";

const option = (patch: Partial<LookupOption> & Pick<LookupOption, "id" | "label">): LookupOption =>
  patch;

describe("lookup search", () => {
  const rows: LookupOption[] = [
    option({
      id: "a1",
      label: "Sales",
      code: "4000",
      name: "Sales",
      group: "Income",
      companyId: "co-1",
    }),
    option({
      id: "a2",
      label: "Consulting",
      code: "SKU-9",
      name: "Consulting",
      description: "Advisory retainer",
      keywords: "service",
      companyId: "co-1",
    }),
    option({ id: "a3", label: "Other org", code: "1000", name: "Cash", companyId: "co-2" }),
  ];

  it("formats code and name, and leaves a plain label alone", () => {
    expect(formatLookupLabel(rows[0]!)).toBe("4000 — Sales");
    expect(formatLookupLabel({ label: "Already shown" })).toBe("Already shown");
  });

  it("matches code, name, sku, description and keywords", () => {
    expect(filterLookupOptions(rows, "4000", "co-1").map((row) => row.id)).toEqual(["a1"]);
    expect(filterLookupOptions(rows, "advisory", "co-1").map((row) => row.id)).toEqual(["a2"]);
    expect(filterLookupOptions(rows, "sku-9", "co-1").map((row) => row.id)).toEqual(["a2"]);
    expect(filterLookupOptions(rows, "service", "co-1").map((row) => row.id)).toEqual(["a2"]);
  });

  it("keeps selection identity on the record id", () => {
    const match = filterLookupOptions(rows, "Sales", "co-1")[0];
    expect(match?.id).toBe("a1");
    expect(match?.id).not.toBe(match?.label);
  });

  it("drops records from another organisation and everything when no organisation is active", () => {
    expect(belongsToOrganisation("co-2", "co-1")).toBe(false);
    expect(belongsToOrganisation(null, "co-1")).toBe(true);
    expect(belongsToOrganisation("co-1", "")).toBe(false);
    expect(filterLookupOptions(rows, "", "co-1").map((row) => row.id)).toEqual(["a1", "a2"]);
    expect(filterLookupOptions(rows, "", null)).toEqual(rows);
  });

  it("groups under category headings with ungrouped rows first", () => {
    const groups = groupLookupOptions(filterLookupOptions(rows, "", "co-1"));
    expect(groups.map((group) => group.heading)).toEqual([null, "Income"]);
    expect(groups[1]?.items.map((row) => row.id)).toEqual(["a1"]);
  });

  it("pages large result sets", () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      option({ id: `r${index}`, label: `Row ${index}` }),
    );
    const first = sliceLookupPage(many, 0, 50);
    const last = sliceLookupPage(many, 2, 50);
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(last.items).toHaveLength(20);
    expect(last.hasMore).toBe(false);
  });

  it("uses a shorter popup on a phone-width viewport", () => {
    expect(lookupPopupMaxHeight(390)).toBe(240);
    expect(lookupPopupMaxHeight(1280)).toBe(320);
    expect(lookupPopupMaxHeight(800, 200)).toBe(200);
  });

  it("keys the cache by organisation, kind, query and page, and ignores stale responses", () => {
    expect(lookupCacheKey("co-1", "account", " Sales ", 1)).toBe(
      lookupCacheKey("co-1", "account", "sales", 1),
    );
    expect(lookupCacheKey("co-1", "account", "sales", 1)).not.toBe(
      lookupCacheKey("co-2", "account", "sales", 1),
    );
    expect(isCurrentRequest(2, 2)).toBe(true);
    expect(isCurrentRequest(1, 2)).toBe(false);
  });
});

describe("lookup keyboard and create session", () => {
  it("opens with ArrowDown and Enter, then moves without wrapping", () => {
    expect(lookupKeyAction("ArrowDown", false)).toEqual({ type: "open" });
    expect(lookupKeyAction("Enter", false)).toEqual({ type: "open" });
    let ui = reduceLookupUi(initialLookupUi(), { type: "open" });
    ui = reduceLookupUi(ui, withResultCount({ type: "move", delta: 1, count: 0 }, 3));
    ui = reduceLookupUi(ui, withResultCount({ type: "move", delta: 1, count: 0 }, 3));
    ui = reduceLookupUi(ui, withResultCount({ type: "move", delta: 1, count: 0 }, 3));
    expect(ui.highlight).toBe(2);
    ui = reduceLookupUi(ui, withResultCount({ type: "end", count: 0 }, 3));
    expect(ui.highlight).toBe(2);
    ui = reduceLookupUi(ui, { type: "home" });
    expect(ui.highlight).toBe(0);
  });

  it("treats Escape as dismiss and Tab as dismiss without consuming the field value", () => {
    const open = reduceLookupUi(initialLookupUi(), { type: "query", query: "cash" });
    expect(lookupKeyAction("Escape", true)).toEqual({ type: "dismiss" });
    expect(lookupKeyAction("Tab", true)).toEqual({ type: "dismiss" });
    const closed = reduceLookupUi(open, { type: "dismiss" });
    expect(closed.open).toBe(false);
    expect(closed.query).toBe("cash");
  });

  it("does not activate a disabled row", () => {
    expect(activationTarget({ id: "a1", disabled: true })).toBeNull();
    expect(activationTarget({ id: "a1" })).toBe("a1");
    expect(activationTarget("create")).toBe("create");
  });

  it("keeps the search and selection when create is cancelled, and selects the new id on success", () => {
    let ui = reduceLookupUi(initialLookupUi(), { type: "query", query: "new supplier" });
    ui = reduceLookupUi(ui, { type: "start-create" });
    expect(ui.createOpen).toBe(true);
    expect(ui.query).toBe("new supplier");
    const cancelled = reduceLookupUi(ui, { type: "cancel-create" });
    expect(cancelled.createOpen).toBe(false);
    expect(cancelled.query).toBe("new supplier");
    expect(cancelled.pinnedId).toBeNull();
    const saved = reduceLookupUi(ui, { type: "complete-create", id: "created-1" });
    expect(saved.pinnedId).toBe("created-1");
    expect(saved.createOpen).toBe(false);
    expect(saved.query).toBe("");
  });

  it("shows create only when an action exists and the user is allowed", () => {
    expect(canOfferCreate(true, true)).toBe(true);
    expect(canOfferCreate(false, true)).toBe(false);
    expect(canOfferCreate(undefined, false)).toBe(false);
  });
});

describe("lookup duplicates", () => {
  const rows: LookupOption[] = [
    option({ id: "c1", label: "Acme Ltd", code: "ACME", name: "Acme Ltd" }),
    option({ id: "c2", label: "Acme Holdings", name: "Acme Holdings" }),
  ];

  it("flags an exact code or name, and a similar name, and ignores a short query", () => {
    expect(
      findLookupDuplicates(rows, "acme").map((match) => [match.option.id, match.exact]),
    ).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
    expect(findLookupDuplicates(rows, "a")).toEqual([]);
  });
});

describe("lookup accounting eligibility", () => {
  it("blocks inactive and non-postable accounts, and non-bank accounts for payments", () => {
    expect(
      accountSelectionProblem(
        { id: "1", code: "4000", name: "Sales", is_active: false, is_postable: true },
        "posting",
      ),
    ).toBe("Account is inactive");
    expect(
      accountSelectionProblem(
        { id: "1", code: "4000", name: "Sales", is_active: true, is_postable: false },
        "posting",
      ),
    ).toBe("Account is not postable");
    expect(
      accountSelectionProblem(
        {
          id: "1",
          code: "1200",
          name: "Debtors",
          account_type: "asset",
          is_active: true,
          is_postable: true,
        },
        "bank",
      ),
    ).toMatch(/bank or cash/i);
    const optionRow = toAccountLookupOption(
      {
        id: "1",
        code: "5000",
        name: "Rent",
        account_type: "expense",
        is_active: true,
        is_postable: true,
      },
      "posting",
    );
    expect(optionRow.disabled).toBe(false);
    expect(optionRow.label).toBe("5000 — Rent");
    expect(optionRow.group).toBe("Expense");
  });

  it("allows a header as a parent and rejects the wrong account type for a product", () => {
    expect(
      accountSelectionProblem(
        { id: "h", code: "5000", name: "Expenses", is_active: true, is_postable: false },
        "parent",
      ),
    ).toBeNull();
    expect(
      accountSelectionProblem(
        {
          id: "b",
          code: "1000",
          name: "Bank",
          account_type: "asset",
          is_active: true,
          is_postable: true,
        },
        "income",
      ),
    ).toMatch(/income account/);
  });

  it("groups contacts and disables inactive ones", () => {
    const row = toContactLookupOption({
      id: "c",
      name: "Northwind",
      code: "NW",
      kind: "supplier",
      is_active: false,
      companyId: "co-1",
    });
    expect(row.group).toBe("Suppliers");
    expect(row.disabled).toBe(true);
    expect(row.companyId).toBe("co-1");
  });

  it("shows product sku, price and stock metadata", () => {
    const row = toProductLookupOption({
      id: "p",
      sku: "WIDGET",
      name: "Widget",
      description: "Boxed",
      unit: "each",
      priceLabel: "12.00",
      stockLabel: "4 in stock",
      taxLabel: "20%",
    });
    expect(row.label).toBe("WIDGET — Widget");
    expect(row.meta).toContain("12.00");
    expect(row.meta).toContain("4 in stock");
    expect(row.description).toBe("Boxed");
  });

  it("disables tax outside its effective dates or the wrong side of the books", () => {
    const rate = {
      id: "t",
      code: "VAT",
      name: "VAT",
      effective_from: "2026-01-01",
      effective_to: "2026-06-30",
      is_active: true,
      appliesTo: "sales",
      rateLabel: "20%",
      jurisdiction: "UK",
    };
    expect(taxSelectionProblem(rate, "2026-03-01", "purchases")).toMatch(/Sales tax only/);
    expect(taxSelectionProblem(rate, "2026-07-01", "sales")).toBe("Ended");
    const current = toTaxLookupOption(rate, "2026-03-01", "sales");
    expect(current.disabled).toBe(false);
    expect(current.group).toBe("UK");
  });

  it("groups tracking options and blocks an inactive one", () => {
    const row = toTrackingLookupOption({
      id: "p",
      code: "P1",
      name: "Website",
      category: "Projects",
      is_active: false,
    });
    expect(row.group).toBe("Projects");
    expect(row.disabledReason).toMatch(/inactive/i);
  });

  it("blocks an inactive bank account, the same account, and a currency mismatch when one is required", () => {
    expect(bankSelectionProblem({ id: "b", name: "Current", is_active: false })).toMatch(
      /inactive/,
    );
    expect(
      bankSelectionProblem({ id: "b", name: "Current", currency_code: "GBP" }, { excludeId: "b" }),
    ).toMatch(/different account/);
    expect(
      bankSelectionProblem(
        { id: "b", name: "Euro", currency_code: "EUR" },
        { requiredCurrency: "GBP" },
      ),
    ).toMatch(/GBP/);
    const row = toBankLookupOption({
      id: "b",
      name: "Current",
      currency_code: "GBP",
      code: "1000",
    });
    expect(row.disabled).toBe(false);
    expect(row.group).toBe("GBP");
    expect(row.label).toBe("1000 — Current");
  });
});
