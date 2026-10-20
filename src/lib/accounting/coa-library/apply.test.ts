import { describe, expect, it } from "vitest";
import { accountsForIndustries, catalogStats, INDUSTRIES, LIBRARY_BY_KEY } from "./catalog";
import { previewIndustryApply, trackingDefaultsFor } from "./apply";

describe("industry CoA catalogue", () => {
  it("covers many industries without forcing every account onto every org", () => {
    const stats = catalogStats();
    expect(stats.industries).toBeGreaterThanOrEqual(35);
    expect(stats.libraryAccounts).toBeGreaterThanOrEqual(40);
    expect(stats.families.length).toBeGreaterThanOrEqual(10);
  });

  it("every industry key resolves to a library account", () => {
    for (const ind of INDUSTRIES) {
      for (const key of [...ind.simple, ...ind.standard, ...ind.detailed]) {
        expect(LIBRARY_BY_KEY[key], `${ind.code} → ${key}`).toBeTruthy();
      }
    }
  });

  it("simple ⊆ standard ⊆ detailed", () => {
    for (const ind of INDUSTRIES) {
      for (const k of ind.simple) expect(ind.standard).toContain(k);
      for (const k of ind.standard) expect(ind.detailed).toContain(k);
    }
  });

  it("combines Amazon FBA + Shopify without duplicate keys", () => {
    const accounts = accountsForIndustries(["amazon_fba", "shopify_dtc"], "standard");
    const keys = accounts.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("rev_marketplace");
    expect(keys).toContain("cogs_marketplace_fees");
  });

  it("church template includes fund equity and contribution income", () => {
    const accounts = accountsForIndustries(["church_religious"], "standard");
    const keys = accounts.map((a) => a.key);
    expect(keys).toContain("inc_tithes");
    expect(keys).toContain("eq_missions_fund");
    expect(keys).toContain("exp_missions_spend");
    const tracking = trackingDefaultsFor(["church_religious"]);
    expect(tracking.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Fund", "Mission", "Ministry"]),
    );
  });
});

describe("previewIndustryApply", () => {
  const coreExisting = [
    { code: "1000", name: "Bank", account_type: "asset", is_system: true },
    { code: "1100", name: "Accounts Receivable", account_type: "asset", is_control: true },
    { code: "2000", name: "Accounts Payable", account_type: "liability", is_control: true },
    { code: "4000", name: "Sales Revenue", account_type: "income", is_system: true },
  ];

  it("is additive and skips existing codes on re-apply", () => {
    const first = previewIndustryApply({
      existing: coreExisting,
      industryCodes: ["saas"],
      level: "standard",
    });
    expect(first.toCreate.length).toBeGreaterThan(0);

    const after = [
      ...coreExisting,
      ...first.toCreate.map((c) => ({
        code: c.code,
        name: c.name,
        account_type: c.accountType,
        catalog_key: c.key,
      })),
    ];
    const second = previewIndustryApply({
      existing: after,
      industryCodes: ["saas"],
      level: "standard",
    });
    expect(second.toCreate).toHaveLength(0);
    expect(second.alreadyPresent.length).toBe(first.toCreate.length);
  });

  it("flags code conflicts when types differ", () => {
    const preview = previewIndustryApply({
      existing: [
        ...coreExisting,
        { code: "4020", name: "Something Else", account_type: "expense" },
      ],
      industryCodes: ["saas"],
      level: "standard",
    });
    expect(preview.conflicts.some((c) => c.code === "4020")).toBe(true);
  });

  it("detailed adds more accounts than simple", () => {
    const simple = previewIndustryApply({
      existing: coreExisting,
      industryCodes: ["amazon_fba"],
      level: "simple",
    });
    const detailed = previewIndustryApply({
      existing: coreExisting,
      industryCodes: ["amazon_fba"],
      level: "detailed",
    });
    expect(detailed.toCreate.length).toBeGreaterThanOrEqual(simple.toCreate.length);
  });
});
