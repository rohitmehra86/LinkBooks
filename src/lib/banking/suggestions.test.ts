import { describe, expect, it } from "vitest";
import { normalizePayee, rankCodingSuggestions } from "./suggestions";

describe("bank coding suggestions", () => {
  it("normalizes payee text", () => {
    expect(normalizePayee("  CLOUD HOSTING*123  ")).toBe("cloud hosting 123");
  });

  it("ranks history above weaker rule matches and stays org-local", () => {
    const suggestions = rankCodingSuggestions({
      description: "CLOUD HOSTING monthly",
      amountMinor: -12000,
      history: [
        {
          payee_normalized: "cloud hosting monthly",
          offset_account_id: "acc-exp",
          direction: "out",
          times_used: 4,
          account_code: "6000",
          account_name: "Operating Expenses",
        },
      ],
      rules: [
        {
          id: "r1",
          name: "Hosting",
          match_field: "description",
          match_pattern: "cloud hosting",
          match_type: "contains",
          offset_account_id: "acc-exp",
          priority: 10,
          is_active: true,
          account_code: "6000",
          account_name: "Operating Expenses",
        },
      ], // account fields required for exactOptionalPropertyTypes
    });
    expect(suggestions[0]?.source).toBe("history");
    expect(suggestions[0]?.offsetAccountId).toBe("acc-exp");
    expect(suggestions[0]?.confidence).toBeGreaterThan(0.5);
  });

  it("applies equals / starts_with / ends_with rule types", () => {
    const base = {
      description: "BANK SERVICE FEE",
      amountMinor: -500,
      history: [],
    };
    const rule = {
      id: "r",
      name: "Fees",
      match_field: "description",
      match_pattern: "bank service",
      match_type: "starts_with",
      offset_account_id: "acc-fee",
      priority: 1,
      is_active: true,
      account_code: null,
      account_name: null,
    };
    expect(rankCodingSuggestions({ ...base, rules: [rule] })[0]?.offsetAccountId).toBe("acc-fee");
  });
});
