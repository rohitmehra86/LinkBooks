/**
 * Period-close checklist (AC-09). Pure: the server supplies raw facts, this decides the status
 * of each step so the rules are testable. Nothing here posts or locks anything.
 */

export type CloseCheckStatus = "pass" | "warn" | "fail" | "na";

export type CloseCheckId =
  "bank" | "drafts" | "ar_tie" | "ap_tie" | "opening_balance" | "tax_return" | "year_end";

export type CloseCheck = {
  id: CloseCheckId;
  label: string;
  status: CloseCheckStatus;
  detail: string;
  /** In-app place to fix the problem. */
  href?: string;
};

export type CloseFacts = {
  periodEnd: string;
  /** Bank lines up to period end that are still uncategorised or matched but not reconciled. */
  unreconciledBankLines: number;
  /** Draft or awaiting-approval invoices and bills dated up to period end. */
  draftDocuments: number;
  ar: { found: boolean; variance: number } | null;
  ap: { found: boolean; variance: number } | null;
  /** Net balance of the opening-balance equity account at period end (minor units), if any. */
  openingBalanceMinor: number | null;
  /** null = tax returns are not applicable or the feature is not installed. */
  taxReturn: { applicable: boolean; filed: boolean } | null;
  /** null when the period does not end on a financial year end. */
  yearEnd: { closed: boolean } | null;
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildCloseChecklist(f: CloseFacts): CloseCheck[] {
  const out: CloseCheck[] = [];

  out.push({
    id: "bank",
    label: "Bank lines reconciled",
    status: f.unreconciledBankLines === 0 ? "pass" : "fail",
    detail:
      f.unreconciledBankLines === 0
        ? "Every bank line up to the period end is reconciled or excluded."
        : `${plural(f.unreconciledBankLines, "bank line is", "bank lines are")} not reconciled up to ${f.periodEnd}.`,
    href: "/banking",
  });

  out.push({
    id: "drafts",
    label: "No draft invoices or bills",
    status: f.draftDocuments === 0 ? "pass" : "warn",
    detail:
      f.draftDocuments === 0
        ? "No draft or awaiting-approval documents dated in or before the period."
        : `${plural(f.draftDocuments, "draft document", "draft documents")} dated up to ${f.periodEnd} will not be in the ledger until authorised.`,
    href: "/sales/invoices",
  });

  for (const [id, label, tie, href] of [
    ["ar_tie", "Receivables agree to the ledger", f.ar, "/reports/aged-receivables"],
    ["ap_tie", "Payables agree to the ledger", f.ap, "/reports/aged-payables"],
  ] as const) {
    if (!tie || !tie.found) {
      out.push({
        id,
        label,
        status: "na",
        detail: "No control account is set up, so there is nothing to compare.",
        href,
      });
    } else {
      out.push({
        id,
        label,
        status: tie.variance === 0 ? "pass" : "fail",
        detail:
          tie.variance === 0
            ? "Open documents equal the control account balance."
            : "Open documents differ from the control account. Open the aged report to find the difference.",
        href,
      });
    }
  }

  if (f.openingBalanceMinor === null) {
    out.push({
      id: "opening_balance",
      label: "Opening balance equity cleared",
      status: "na",
      detail: "No opening balance equity account.",
    });
  } else {
    out.push({
      id: "opening_balance",
      label: "Opening balance equity cleared",
      status: f.openingBalanceMinor === 0 ? "pass" : "warn",
      detail:
        f.openingBalanceMinor === 0
          ? "The opening balance account is nil."
          : "The opening balance account still holds a balance. Reclassify it to retained earnings once opening balances are complete.",
      href: "/reports/trial-balance",
    });
  }

  if (!f.taxReturn || !f.taxReturn.applicable) {
    out.push({
      id: "tax_return",
      label: "Tax return filed",
      status: "na",
      detail: "Tax returns are not used for this organisation.",
    });
  } else {
    out.push({
      id: "tax_return",
      label: "Tax return filed",
      status: f.taxReturn.filed ? "pass" : "warn",
      detail: f.taxReturn.filed
        ? "A filed return covers this period end."
        : "No filed tax return covers this period end. File it first so its figures are locked.",
      href: "/tax",
    });
  }

  if (f.yearEnd) {
    out.push({
      id: "year_end",
      label: "Year-end closing journal",
      status: f.yearEnd.closed ? "pass" : "warn",
      detail: f.yearEnd.closed
        ? "Profit for the year has been moved to retained earnings."
        : "Optional: post the closing journal to move profit to retained earnings. Reports already show it correctly without it.",
    });
  }

  return out;
}

export type CloseSummary = {
  blockers: number;
  warnings: number;
  /** Locking is allowed without an extra acknowledgement only when nothing fails or warns. */
  clean: boolean;
};

export function summariseChecklist(items: CloseCheck[]): CloseSummary {
  const blockers = items.filter((i) => i.status === "fail").length;
  const warnings = items.filter((i) => i.status === "warn").length;
  return { blockers, warnings, clean: blockers === 0 && warnings === 0 };
}
