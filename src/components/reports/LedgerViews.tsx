import { Fragment, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useFormat } from "@/hooks/use-format";
import { csvMoney } from "@/lib/reports/csv";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  getAccountTransactions,
  getAgedPayables,
  getAgedReceivables,
  getAuditFilterOptions,
  getAuditReport,
  getGeneralLedgerAll,
  getJournalReport,
  getTaxReport,
} from "@/lib/reports/report.functions";
import { getAgedReceivablesAsAt } from "@/lib/sales/ar-reports.functions";
import { SOURCE_LABELS, sourceLabel } from "@/lib/reports/links";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  JournalLink,
  PagerBar,
  ReportPane,
  ReportShell,
  SourceLink,
  Stat,
  type ReportCtx,
} from "./ReportShell";

const selectCls = "flex h-10 rounded-md border border-input bg-background px-3 text-sm";

/* ---------------- Account transactions (single account, running balance) ---------------- */

export function AccountTransactionsView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchAccounts = useServerFn(listAccounts);
  const fetchTxns = useServerFn(getAccountTransactions);
  const accountId = ctx.search.account ?? "";
  const page = Math.max(0, (ctx.search.page ?? 1) - 1);
  const accountsQ = useQuery({
    queryKey: ["accounts", ctx.companyId],
    queryFn: () => fetchAccounts({ data: { companyId: ctx.companyId } }),
  });
  const q = useQuery({
    queryKey: ["report-acct-txn", ctx.companyId, accountId, ctx.from, ctx.to, page],
    enabled: Boolean(accountId),
    queryFn: () =>
      fetchTxns({
        data: {
          companyId: ctx.companyId,
          accountId,
          from: ctx.from,
          to: ctx.to,
          page,
          pageSize: 100,
        },
      }),
  });
  const d = q.data;
  const accounts = (accountsQ.data ?? []) as Array<{ id: string; code: string; name: string }>;
  return (
    <ReportShell
      title={
        d ? `Account Transactions: ${d.account.code} ${d.account.name}` : "Account Transactions"
      }
      ctx={ctx}
      mode="range"
      basis="Running balance is shown on the account's normal side"
      extraControls={
        <div className="space-y-1">
          <Label htmlFor="report-account">Account</Label>
          <select
            id="report-account"
            className={`${selectCls} w-72`}
            value={accountId}
            onChange={(e) =>
              ctx.setSearch({ account: e.target.value || undefined, page: undefined })
            }
          >
            <option value="">Select account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </div>
      }
      getCsv={() =>
        d
          ? {
              headers: ["Date", "Journal", "Source", "Memo", "Debit", "Credit", "Balance"],
              rows: [
                [
                  "",
                  "",
                  "",
                  "Opening balance",
                  "",
                  "",
                  csvMoney(d.opening_balance_minor, ctx.currency),
                ],
                ...d.rows.map((r) => [
                  r.journal_date,
                  r.journal_number,
                  sourceLabel(r.source_type),
                  r.memo ?? r.description ?? "",
                  csvMoney(r.debit_minor, ctx.currency),
                  csvMoney(r.credit_minor, ctx.currency),
                  csvMoney(r.running_balance_minor, ctx.currency),
                ]),
              ],
            }
          : null
      }
    >
      {!accountId ? (
        <p className="text-sm text-muted-foreground">
          Choose an account, or open this report from a row in the Trial Balance, Profit and Loss or
          Balance Sheet.
        </p>
      ) : (
        <ReportPane
          query={q}
          isEmpty={Boolean(d) && d!.rows.length === 0 && d!.opening_balance_minor === 0}
          emptyTitle="No movements"
          emptyDescription="No posted lines for this account in the range."
        >
          {d ? (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                Opening {fmt.amount(d.opening_balance_minor, ctx.currency)} · Closing{" "}
                {fmt.amount(d.closing_balance_minor, ctx.currency)}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Journal</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Memo</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.rows.map((r) => (
                    <TableRow key={r.line_id}>
                      <TableCell>{fmt.date(r.journal_date)}</TableCell>
                      <TableCell>
                        <JournalLink journalId={r.journal_id} number={r.journal_number} />
                      </TableCell>
                      <TableCell>
                        <SourceLink type={r.source_type} id={r.source_id} />
                      </TableCell>
                      <TableCell>{r.memo ?? r.description ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.amount(r.debit_minor, ctx.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.amount(r.credit_minor, ctx.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.amount(r.running_balance_minor, ctx.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <PagerBar
                page={d.page}
                pageSize={d.pageSize}
                total={d.total_count}
                onPage={(p) => ctx.setSearch({ page: p === 0 ? undefined : p + 1 })}
              />
            </>
          ) : null}
        </ReportPane>
      )}
    </ReportShell>
  );
}

/* ---------------- General ledger, all accounts ---------------- */

export function GeneralLedgerAllView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchGl = useServerFn(getGeneralLedgerAll);
  const q = useQuery({
    queryKey: ["report-gl-all", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchGl({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="General Ledger"
      ctx={ctx}
      mode="range"
      basis="All accounts with activity or an opening balance; running balance on the normal side"
      getCsv={() =>
        d
          ? {
              headers: [
                "Account",
                "Date",
                "Journal",
                "Source",
                "Memo",
                "Debit",
                "Credit",
                "Balance",
              ],
              rows: d.accounts.flatMap((a) => [
                [
                  `${a.account.code} ${a.account.name}`,
                  "",
                  "",
                  "",
                  "Opening balance",
                  "",
                  "",
                  csvMoney(a.opening_balance_minor, ctx.currency),
                ],
                ...a.rows.map((r) => [
                  `${a.account.code} ${a.account.name}`,
                  r.journal_date,
                  r.journal_number,
                  sourceLabel(r.source_type),
                  r.memo ?? "",
                  csvMoney(r.debit_minor, ctx.currency),
                  csvMoney(r.credit_minor, ctx.currency),
                  csvMoney(r.running_balance_minor, ctx.currency),
                ]),
              ]),
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.accounts.length === 0}
        emptyTitle="No ledger activity"
        emptyDescription="Nothing was posted in this period."
      >
        {d ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Journal</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.accounts.map((a) => (
                <Fragment key={a.account.id}>
                  <TableRow className="bg-muted/40">
                    <TableCell colSpan={6} className="font-semibold">
                      <Link
                        to="/reports/$reportId"
                        params={{ reportId: "general-ledger" }}
                        search={{ account: a.account.id, from: ctx.from, to: ctx.to }}
                        className="underline-offset-2 hover:underline"
                      >
                        {a.account.code} {a.account.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right text-xs">
                      Opening {fmt.amount(a.opening_balance_minor, ctx.currency)}
                    </TableCell>
                  </TableRow>
                  {a.rows.map((r, i) => (
                    <TableRow key={`${r.journal_id}-${i}`}>
                      <TableCell>{fmt.date(r.journal_date)}</TableCell>
                      <TableCell>
                        <JournalLink journalId={r.journal_id} number={r.journal_number} />
                      </TableCell>
                      <TableCell>
                        <SourceLink type={r.source_type} id={r.source_id} />
                      </TableCell>
                      <TableCell>{r.memo ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.amount(r.debit_minor, ctx.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.amount(r.credit_minor, ctx.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.amount(r.running_balance_minor, ctx.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-medium">
                    <TableCell colSpan={6}>Closing balance</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt.amount(a.closing_balance_minor, ctx.currency)}
                    </TableCell>
                  </TableRow>
                </Fragment>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ---------------- Journal report ---------------- */

export function JournalReportView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchJr = useServerFn(getJournalReport);
  const page = Math.max(0, (ctx.search.page ?? 1) - 1);
  const source = ctx.search.source ?? "";
  const status = ctx.search.status ?? "posted";
  const q = useQuery({
    queryKey: ["report-journals", ctx.companyId, ctx.from, ctx.to, source, status, page],
    queryFn: () =>
      fetchJr({
        data: {
          companyId: ctx.companyId,
          from: ctx.from,
          to: ctx.to,
          status,
          source,
          page,
          pageSize: 100,
        },
      }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="Journal Report"
      ctx={ctx}
      mode="range"
      extraControls={
        <>
          <div className="space-y-1">
            <Label htmlFor="jr-source">Source</Label>
            <select
              id="jr-source"
              className={selectCls}
              value={source}
              onChange={(e) =>
                ctx.setSearch({ source: e.target.value || undefined, page: undefined })
              }
            >
              <option value="">All sources</option>
              {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="jr-status">Status</Label>
            <select
              id="jr-status"
              className={selectCls}
              value={status}
              onChange={(e) =>
                ctx.setSearch({
                  status: e.target.value === "posted" ? undefined : e.target.value,
                  page: undefined,
                })
              }
            >
              <option value="posted">Posted</option>
              <option value="reversed">Reversed</option>
              <option value="draft">Draft</option>
            </select>
          </div>
        </>
      }
      getCsv={() =>
        d
          ? {
              headers: ["Number", "Date", "Source", "Status", "Memo", "Debit", "Credit"],
              rows: d.rows.map((j) => [
                j.journal_number,
                j.journal_date,
                sourceLabel(j.source_type),
                j.status,
                j.memo ?? "",
                csvMoney(j.total_debit_minor, j.currency_code || ctx.currency),
                csvMoney(j.total_credit_minor, j.currency_code || ctx.currency),
              ]),
              basis: "Current page only; narrow the filters to export a smaller set",
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0}
        emptyTitle="No journals"
        emptyDescription="Journals matching the filters will list here."
      >
        {d ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Memo</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.rows.map((j) => (
                  <TableRow key={j.journal_id}>
                    <TableCell>
                      <JournalLink journalId={j.journal_id} number={j.journal_number} />
                    </TableCell>
                    <TableCell>{fmt.date(j.journal_date)}</TableCell>
                    <TableCell>
                      <SourceLink type={j.source_type} id={j.source_id} />
                    </TableCell>
                    <TableCell>{j.memo ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt.amount(j.total_debit_minor, j.currency_code || ctx.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt.amount(j.total_credit_minor, j.currency_code || ctx.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PagerBar
              page={d.page}
              pageSize={d.pageSize}
              total={d.total}
              onPage={(p) => ctx.setSearch({ page: p === 0 ? undefined : p + 1 })}
            />
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ---------------- Aged receivables / payables ---------------- */

type AgedData = Pick<
  Awaited<ReturnType<typeof getAgedReceivables>>,
  "rows" | "total" | "byBucket" | "varianceMinor" | "tiesToControl" | "excludedUnpostedCount"
> & { controlMinor: number; diagnostic: string | null };

export function AgedView({ ctx, kind }: { ctx: ReportCtx; kind: "ar" | "ap" }) {
  const fmt = useFormat();
  const fetchAr = useServerFn(getAgedReceivablesAsAt);
  const fetchAp = useServerFn(getAgedPayables);
  const q = useQuery({
    queryKey: ["report-aged", kind, ctx.companyId, ctx.to],
    queryFn: async (): Promise<AgedData> => {
      if (kind === "ar") {
        // As-at ageing: rebuilt from dated allocations; unapplied receipts/credits shown as negatives.
        const r = await fetchAr({ data: { companyId: ctx.companyId, asOf: ctx.to } });
        const baseTotals = r.totalsByCurrency.find((t) => t.currency_code === r.baseCurrency);
        const total = baseTotals?.total ?? 0;
        const foreign = r.totalsByCurrency.filter((t) => t.currency_code !== r.baseCurrency);
        const variance = total - r.arControlBalanceMinor;
        return {
          rows: r.rows
            .filter((row) => row.currency_code === r.baseCurrency)
            .map((row) => ({ ...row, docs: [] })),
          total,
          byBucket: baseTotals?.byBucket ?? {
            current: 0,
            "1_30": 0,
            "31_60": 0,
            "61_90": 0,
            "90_plus": 0,
          },
          varianceMinor: variance,
          tiesToControl: variance === 0 && foreign.length === 0,
          excludedUnpostedCount: 0,
          controlMinor: r.arControlBalanceMinor,
          diagnostic:
            foreign.length > 0
              ? `Foreign-currency balances (${foreign.map((t) => t.currency_code).join(", ")}) are not included in the ${r.baseCurrency} table above; the control account is in base currency.`
              : r.diagnostic,
        };
      }
      const r = await fetchAp({ data: { companyId: ctx.companyId, asOf: ctx.to } });
      return { ...r, controlMinor: r.apControlBalanceMinor };
    },
  });
  const d = q.data;
  const control = d?.controlMinor ?? 0;
  const title = kind === "ar" ? "Aged Receivables" : "Aged Payables";
  return (
    <ReportShell
      title={title}
      ctx={ctx}
      mode="asof"
      getCsv={() =>
        d
          ? {
              headers: ["Contact", "Current", "1-30", "31-60", "61-90", "90+", "Total"],
              rows: [
                ...d.rows.map((r) => [
                  r.contact_name,
                  csvMoney(r.current, ctx.currency),
                  csvMoney(r.b_1_30, ctx.currency),
                  csvMoney(r.b_31_60, ctx.currency),
                  csvMoney(r.b_61_90, ctx.currency),
                  csvMoney(r.b_90_plus, ctx.currency),
                  csvMoney(r.total, ctx.currency),
                ]),
                [
                  "Total",
                  csvMoney(d.byBucket.current, ctx.currency),
                  csvMoney(d.byBucket["1_30"], ctx.currency),
                  csvMoney(d.byBucket["31_60"], ctx.currency),
                  csvMoney(d.byBucket["61_90"], ctx.currency),
                  csvMoney(d.byBucket["90_plus"], ctx.currency),
                  csvMoney(d.total, ctx.currency),
                ],
              ],
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.rows.length === 0 && d!.varianceMinor === 0}
        emptyTitle={kind === "ar" ? "No open receivables" : "No open payables"}
        emptyDescription="Authorised documents with outstanding balances appear here."
      >
        {d ? (
          <>
            <p className="mb-2 text-sm">
              Ageing total {fmt.amount(d.total, ctx.currency)} · Control account{" "}
              {fmt.amount(control, ctx.currency)}{" "}
              <Badge variant={d.tiesToControl ? "secondary" : "destructive"}>
                {d.tiesToControl ? "Ties to control" : "Does not tie, investigate"}
              </Badge>
              {d.excludedUnpostedCount ? (
                <span className="ml-2 text-muted-foreground">
                  ({d.excludedUnpostedCount} unposted document(s) excluded)
                </span>
              ) : null}
            </p>
            {d.diagnostic ? (
              <Alert className="mb-3">
                <AlertDescription>
                  Variance {fmt.amount(d.varianceMinor, ctx.currency)}. {d.diagnostic}
                </AlertDescription>
              </Alert>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead className="text-right">Current</TableHead>
                  <TableHead className="text-right">1–30</TableHead>
                  <TableHead className="text-right">31–60</TableHead>
                  <TableHead className="text-right">61–90</TableHead>
                  <TableHead className="text-right">90+</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.rows.map((r) => (
                  <TableRow key={r.contact_id}>
                    <TableCell>
                      <Link
                        to="/contacts/$contactId"
                        params={{ contactId: r.contact_id }}
                        className="underline-offset-2 hover:underline"
                      >
                        {r.contact_name}
                      </Link>
                    </TableCell>
                    {[r.current, r.b_1_30, r.b_31_60, r.b_61_90, r.b_90_plus, r.total].map(
                      (v, i) => (
                        <TableCell key={i} className="text-right tabular-nums">
                          {fmt.amount(v, ctx.currency)}
                        </TableCell>
                      ),
                    )}
                  </TableRow>
                ))}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>Total</TableCell>
                  {[
                    d.byBucket.current,
                    d.byBucket["1_30"],
                    d.byBucket["31_60"],
                    d.byBucket["61_90"],
                    d.byBucket["90_plus"],
                    d.total,
                  ].map((v, i) => (
                    <TableCell key={i} className="text-right tabular-nums">
                      {fmt.amount(v, ctx.currency)}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ---------------- Tax control summary ---------------- */

export function TaxSummaryView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchTax = useServerFn(getTaxReport);
  const q = useQuery({
    queryKey: ["report-tax", ctx.companyId, ctx.from, ctx.to],
    queryFn: () => fetchTax({ data: { companyId: ctx.companyId, from: ctx.from, to: ctx.to } }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="Tax Summary"
      ctx={ctx}
      mode="range"
      basis="Tax control account movements"
      getCsv={() =>
        d
          ? {
              headers: ["Date", "Journal", "Source", "Account", "Debit", "Credit"],
              rows: d.detail.map((l) => [
                l.journal_date,
                l.journal_number,
                sourceLabel(l.source_type),
                `${l.account_code} ${l.account_name}`,
                csvMoney(l.debit_minor, ctx.currency),
                csvMoney(l.credit_minor, ctx.currency),
              ]),
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.taxAccountCount === 0}
        emptyTitle="No tax accounts"
        emptyDescription="Map tax accounts under Tax → GL mappings, or tag chart accounts with the tax system key."
      >
        {d ? (
          <>
            <Alert className="mb-3">
              <AlertDescription>
                Regime: {d.regime}
                {d.jurisdictionCode ? ` (${d.jurisdictionCode})` : ""}. {d.complianceNote}{" "}
                <Link className="underline" to="/tax">
                  Tax settings and returns
                </Link>
              </AlertDescription>
            </Alert>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Stat
                label="Output (credits)"
                value={fmt.money(d.output_credit_minor, ctx.currency)}
              />
              <Stat label="Input (debits)" value={fmt.money(d.input_debit_minor, ctx.currency)} />
              <Stat label="Net payable" value={fmt.money(d.net_payable_minor, ctx.currency)} />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Journal</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.detail.map((l, i) => (
                  <TableRow key={`${l.journal_id}-${i}`}>
                    <TableCell>{fmt.date(l.journal_date)}</TableCell>
                    <TableCell>
                      <JournalLink journalId={l.journal_id} number={l.journal_number} />
                    </TableCell>
                    <TableCell>
                      <SourceLink type={l.source_type} id={l.source_id} />
                    </TableCell>
                    <TableCell>
                      {l.account_code} {l.account_name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt.amount(l.debit_minor, ctx.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmt.amount(l.credit_minor, ctx.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}

/* ---------------- Audit trail ---------------- */

export function AuditView({ ctx }: { ctx: ReportCtx }) {
  const fmt = useFormat();
  const fetchAudit = useServerFn(getAuditReport);
  const fetchOptions = useServerFn(getAuditFilterOptions);
  const page = Math.max(0, (ctx.search.page ?? 1) - 1);
  const [open, setOpen] = useState<string | null>(null);
  const optionsQ = useQuery({
    queryKey: ["audit-options", ctx.companyId],
    queryFn: () => fetchOptions({ data: { companyId: ctx.companyId } }),
    retry: false,
  });
  const q = useQuery({
    queryKey: [
      "report-audit",
      ctx.companyId,
      ctx.from,
      ctx.to,
      ctx.search.actor,
      ctx.search.entity,
      ctx.search.action,
      page,
    ],
    retry: false,
    queryFn: () =>
      fetchAudit({
        data: {
          companyId: ctx.companyId,
          from: ctx.from,
          to: ctx.to,
          ...(ctx.search.actor ? { actorId: ctx.search.actor } : {}),
          ...(ctx.search.entity ? { entityType: ctx.search.entity } : {}),
          ...(ctx.search.action ? { action: ctx.search.action } : {}),
          page,
          pageSize: 50,
        },
      }),
  });
  const d = q.data;
  return (
    <ReportShell
      title="Audit Trail"
      ctx={ctx}
      mode="range"
      extraControls={
        <>
          <div className="space-y-1">
            <Label htmlFor="audit-actor">User</Label>
            <select
              id="audit-actor"
              className={selectCls}
              value={ctx.search.actor ?? ""}
              onChange={(e) =>
                ctx.setSearch({ actor: e.target.value || undefined, page: undefined })
              }
            >
              <option value="">Everyone</option>
              {(optionsQ.data?.actors ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-entity">Entity</Label>
            <Input
              id="audit-entity"
              placeholder="e.g. journal"
              defaultValue={ctx.search.entity ?? ""}
              onBlur={(e) =>
                ctx.setSearch({ entity: e.target.value.trim() || undefined, page: undefined })
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-action">Action</Label>
            <Input
              id="audit-action"
              placeholder="contains…"
              defaultValue={ctx.search.action ?? ""}
              onBlur={(e) =>
                ctx.setSearch({ action: e.target.value.trim() || undefined, page: undefined })
              }
            />
          </div>
        </>
      }
      getCsv={() =>
        d
          ? {
              headers: ["When", "User", "Action", "Entity", "Entity id", "Details"],
              rows: d.events.map((e) => [
                e.created_at,
                e.actor_name,
                e.action,
                e.entity_type,
                e.entity_id ?? "",
                e.details_json,
              ]),
              basis: "Current page only",
            }
          : null
      }
    >
      <ReportPane
        query={q}
        isEmpty={Boolean(d) && d!.events.length === 0}
        emptyTitle="No audit events"
        emptyDescription="Posting and period actions appear here when audited. Viewing needs the audit permission."
      >
        {d ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead className="print:hidden">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.events.map((e) => (
                  <Fragment key={e.id}>
                    <TableRow>
                      <TableCell>{fmt.dateTime(e.created_at)}</TableCell>
                      <TableCell>{e.actor_name}</TableCell>
                      <TableCell>{e.action}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {e.entity_type} {e.entity_id?.slice(0, 8)}
                      </TableCell>
                      <TableCell className="print:hidden">
                        {e.details_json !== "{}" ? (
                          <button
                            type="button"
                            className="text-xs underline-offset-2 hover:underline"
                            aria-expanded={open === e.id}
                            onClick={() => setOpen(open === e.id ? null : e.id)}
                          >
                            {open === e.id ? "Hide" : "Show"}
                          </button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                    {open === e.id ? (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                            {JSON.stringify(JSON.parse(e.details_json), null, 2)}
                          </pre>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
            <PagerBar
              page={d.page}
              pageSize={d.pageSize}
              total={d.total}
              onPage={(p) => ctx.setSearch({ page: p === 0 ? undefined : p + 1 })}
            />
          </>
        ) : null}
      </ReportPane>
    </ReportShell>
  );
}
