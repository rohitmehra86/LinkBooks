/**
 * Indirect cash flow statement (net profit → cash), built from period ledger movements.
 *
 * Inputs are per-account debit/credit totals for the period with year-end closing journals left out,
 * so every included journal is balanced and the identity holds exactly:
 *
 *   cash movement = net profit − Σ(debit − credit) over every non-bank balance sheet account
 *
 * Operating = net profit + depreciation add-back + working-capital movements (receivables, payables,
 * tax, inventory, prepayments, other current items). Investing = fixed / non-current assets.
 * Financing = equity and loans. Classification reuses `classifyCashCounterpart`, the same rules as
 * the direct cash flow report, so an account's section agrees between the two.
 *
 * Limitation: a gain or loss on disposal stays inside net profit (operating) and the asset's net book
 * value shows under investing, instead of being split into proceeds and a non-cash adjustment.
 */

import { classifyCashCounterpart, type CashFlowSection } from "@/lib/accounting/reporting";

type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export type CfAccount = {
  id: string;
  code: string;
  name: string;
  account_type: AccountType;
  subtype: string | null;
  account_kind: string | null;
  system_key: string | null;
  cash_flow_class: string | null;
};

export type CfMovement = { accountId: string; debitMinor: number; creditMinor: number };

export type CashFlowRowOut = {
  label: string;
  amountMinor: number;
  accountId: string | null;
  /** "profit" | "non_cash" | "movement" | "other" — lets the UI style and link rows. */
  kind: "profit" | "non_cash" | "movement" | "other";
};

export type IndirectCashFlow = {
  operating: CashFlowRowOut[];
  investing: CashFlowRowOut[];
  financing: CashFlowRowOut[];
  netProfitMinor: number;
  operatingMinor: number;
  investingMinor: number;
  financingMinor: number;
  netChangeMinor: number;
  openingCashMinor: number;
  closingCashMinor: number;
  /** Closing cash from the ledger, independent of the movements above. */
  closingCashLedgerMinor: number;
  reconciles: boolean;
};

const DEPRECIATION_NAME = /depreciation|amortisation|amortization/i;

function isAccumulatedAccount(a: CfAccount): boolean {
  return (
    a.account_type === "asset" &&
    (/accumulated/i.test(a.name) || (a.subtype ?? "").toLowerCase().includes("depreciation"))
  );
}

export function isDepreciationExpense(a: CfAccount): boolean {
  return a.account_type === "expense" && DEPRECIATION_NAME.test(a.name);
}

const sum = (rows: CashFlowRowOut[]) => rows.reduce((s, r) => s + r.amountMinor, 0);

export function buildIndirectCashFlow(args: {
  accounts: CfAccount[];
  movements: CfMovement[];
  bankAccountIds: string[];
  /** Extra expense accounts to treat as depreciation (e.g. those used by the asset register). */
  depreciationAccountIds?: string[];
  openingCashMinor: number;
  closingCashLedgerMinor: number;
}): IndirectCashFlow {
  const byId = new Map(args.accounts.map((a) => [a.id, a]));
  const bank = new Set(args.bankAccountIds);
  const extraDep = new Set(args.depreciationAccountIds ?? []);

  // Net movement (debit − credit) per account.
  const net = new Map<string, number>();
  for (const m of args.movements) {
    net.set(m.accountId, (net.get(m.accountId) ?? 0) + m.debitMinor - m.creditMinor);
  }

  let netProfit = 0;
  let depreciation = 0;
  for (const [id, dc] of net) {
    const a = byId.get(id);
    if (!a) continue;
    if (a.account_type === "income" || a.account_type === "expense") {
      netProfit -= dc;
      if (a.account_type === "expense" && (isDepreciationExpense(a) || extraDep.has(id))) {
        depreciation += dc;
      }
    }
  }

  const operating: CashFlowRowOut[] = [
    { label: "Net profit", amountMinor: netProfit, accountId: null, kind: "profit" },
  ];
  if (depreciation !== 0) {
    operating.push({
      label: "Add back: depreciation (non-cash)",
      amountMinor: depreciation,
      accountId: null,
      kind: "non_cash",
    });
  }
  const investing: CashFlowRowOut[] = [];
  const financing: CashFlowRowOut[] = [];

  let accumulatedNet = 0;
  const sorted = [...net.entries()]
    .map(([id, dc]) => ({ a: byId.get(id), dc }))
    .filter((x): x is { a: CfAccount; dc: number } => Boolean(x.a))
    .sort((x, y) => x.a.code.localeCompare(y.a.code, undefined, { numeric: true }));

  for (const { a, dc } of sorted) {
    if (dc === 0) continue;
    if (a.account_type === "income" || a.account_type === "expense") continue;
    if (bank.has(a.id)) continue;
    const { section } = classifyCashCounterpart({
      account_type: a.account_type,
      account_subtype: a.subtype,
      account_kind: a.account_kind,
      system_key: a.system_key,
      cash_flow_class: a.cash_flow_class,
      account_code: a.code,
    });
    if (isAccumulatedAccount(a) && section === "investing") {
      accumulatedNet += dc;
      continue;
    }
    const row: CashFlowRowOut = {
      label: `${a.code} ${a.name}`.trim(),
      amountMinor: -dc,
      accountId: a.id,
      kind: "movement",
    };
    pushTo(section, row, { operating, investing, financing });
  }

  // Accumulated depreciation moves with the depreciation charge (already added back in operating).
  // Anything beyond the charge, such as release on disposal, is a real investing movement.
  const accumulatedOther = -accumulatedNet - depreciation;
  if (accumulatedOther !== 0) {
    investing.push({
      label: "Accumulated depreciation other than the period charge (e.g. on disposal)",
      amountMinor: accumulatedOther,
      accountId: null,
      kind: "other",
    });
  }

  const operatingMinor = sum(operating);
  const investingMinor = sum(investing);
  const financingMinor = sum(financing);
  const netChange = operatingMinor + investingMinor + financingMinor;
  return {
    operating,
    investing,
    financing,
    netProfitMinor: netProfit,
    operatingMinor,
    investingMinor,
    financingMinor,
    netChangeMinor: netChange,
    openingCashMinor: args.openingCashMinor,
    closingCashMinor: args.openingCashMinor + netChange,
    closingCashLedgerMinor: args.closingCashLedgerMinor,
    reconciles: args.openingCashMinor + netChange === args.closingCashLedgerMinor,
  };
}

function pushTo(
  section: CashFlowSection,
  row: CashFlowRowOut,
  into: {
    operating: CashFlowRowOut[];
    investing: CashFlowRowOut[];
    financing: CashFlowRowOut[];
  },
) {
  into[section].push(row);
}
