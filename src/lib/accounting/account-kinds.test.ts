import { describe, expect, it } from "vitest";
import { ACCOUNT_KINDS, kindSpec, suggestNextCode } from "@/lib/accounting/account-kinds";
import {
  archiveDecision,
  lockedFieldChanges,
  mergeAllowed,
  mergeJournalLines,
  signedBalance,
} from "@/lib/accounting/account-rules";
import {
  externalTypeToKind,
  suggestAccountFromDescription,
} from "@/lib/accounting/account-suggest";
import { parseChartCsv } from "@/lib/accounting/account-import";
import { STARTER_CHARTS } from "@/lib/accounting/starter-charts";
import { balanceSheetSectionFor, profitAndLossSectionFor } from "@/lib/accounting/reporting";

describe("account kinds", () => {
  it("keeps every kind on the existing report section", () => {
    for (const kind of ACCOUNT_KINDS) {
      const spec = kindSpec(kind);
      if (spec.accountClass === "income" || spec.accountClass === "expense") {
        expect(
          profitAndLossSectionFor({ account_type: spec.accountClass, subtype: spec.subtype }),
        ).toBe(
          spec.kind === "depreciation" || spec.kind === "other_expense"
            ? "other"
            : spec.kind === "overhead" || spec.kind === "expense"
              ? "operating_expense"
              : spec.fsLine === "revenue"
                ? "revenue"
                : spec.fsLine === "other_income"
                  ? "other"
                  : spec.fsLine,
        );
      } else {
        const section = balanceSheetSectionFor({
          account_type: spec.accountClass,
          subtype: spec.subtype,
        });
        if (spec.fsLine === "current_assets") expect(section).toBe("current_assets");
        if (spec.fsLine === "non_current_assets") expect(section).toBe("non_current_assets");
        if (spec.fsLine === "current_liabilities") expect(section).toBe("current_liabilities");
        if (spec.fsLine === "non_current_liabilities")
          expect(section).toBe("non_current_liabilities");
        if (spec.fsLine === "equity") expect(section).toBe("equity");
      }
      if (spec.kind === "contra_revenue") expect(spec.normalBalance).toBe("debit");
    }
  });

  it("suggests the next free code inside the range", () => {
    expect(suggestNextCode("expense", ["6000", "6010", "4000"])).toBe("6020");
    expect(suggestNextCode("bank", [])).toBe("1000");
    expect(signedBalance("revenue", 100, 250)).toBe(150);
  });
});

describe("archive and merge", () => {
  const clear = {
    isSystem: false,
    isControl: false,
    isLocked: false,
    activeChildCount: 0,
    postedDebitMinor: 40,
    postedCreditMinor: 40,
    activeRecurringInvoice: false,
    activeBankRule: false,
  };

  it("blocks a non-zero balance and a locked account", () => {
    expect(archiveDecision({ ...clear, postedDebitMinor: 50 }).ok).toBe(false);
    expect(archiveDecision({ ...clear, isLocked: true }).ok).toBe(false);
    expect(archiveDecision(clear).ok).toBe(true);
  });

  it("archives income/expense accounts by current-year activity, not all-time balance (AC-07)", () => {
    const pl = {
      ...clear,
      accountClass: "expense" as const,
      postedDebitMinor: 900,
      postedCreditMinor: 0,
    };
    expect(archiveDecision({ ...pl, currentYearActivityCount: 0 }).ok).toBe(true);
    const busy = archiveDecision({ ...pl, currentYearActivityCount: 2 });
    expect(busy.ok).toBe(false);
    // Balance-sheet accounts keep the zero-balance rule even with no current-year activity.
    const bs = { ...pl, accountClass: "asset" as const, currentYearActivityCount: 0 };
    expect(archiveDecision(bs).ok).toBe(false);
  });

  it("builds a balanced merge and refuses a class change", () => {
    const lines = mergeJournalLines({ sourceId: "a", targetId: "b", netMinor: 25 });
    expect(
      Array.isArray(lines) &&
        lines.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0),
    ).toBe(0);
    expect(
      mergeAllowed({
        sourceClass: "expense",
        targetClass: "asset",
        sourceSystem: false,
        sourceCurrency: "USD",
        targetCurrency: "EUR",
      }).ok,
    ).toBe(false);
  });
});

describe("chart import and suggestions", () => {
  it("maps a CSV type and does not invent a kind", () => {
    const parsed = parseChartCsv("Code,Name,Account type\n6100,Rent,Expense\n");
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]?.accountKind).toBe("expense");
    expect(externalTypeToKind("not a type")).toBeNull();
    expect(suggestAccountFromDescription("monthly rent")[0]?.kind).toBe("expense");
    expect(suggestAccountFromDescription("x")).toEqual([]);
  });

  it("gives every starter chart unique codes", () => {
    for (const chart of STARTER_CHARTS) {
      const codes = new Set(chart.accounts.map((account) => account.code));
      expect(codes.size).toBe(chart.accounts.length);
    }
  });
});

describe("locked account fields (AC-03)", () => {
  const sys = {
    isSystem: true,
    isControl: false,
    isLocked: false,
    code: "1100",
    accountKind: "accounts_receivable",
    isHeader: false,
  };
  it("lists code, type and header changes on a system account", () => {
    expect(lockedFieldChanges(sys, { code: "1101", accountKind: "bank", isHeader: true })).toEqual([
      "code",
      "type",
      "header setting",
    ]);
  });
  it("allows name-only edits and leaves ordinary accounts alone", () => {
    expect(
      lockedFieldChanges(sys, {
        code: "1100",
        accountKind: "accounts_receivable",
        isHeader: false,
      }),
    ).toEqual([]);
    expect(
      lockedFieldChanges(
        { ...sys, isSystem: false },
        { code: "9", accountKind: "bank", isHeader: true },
      ),
    ).toEqual([]);
  });
});
