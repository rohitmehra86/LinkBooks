import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Printer } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  getAccountTransactions,
  getAgedPayables,
  getAgedReceivables,
  getAuditReport,
  getBalanceSheet,
  getCashFlow,
  getJournalReport,
  getProfitAndLoss,
  getTaxReport,
  getTrialBalance,
  listAccounts,
} from "@/lib/accounting/accounting.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export type ReportTabId =
  | "tb"
  | "pl"
  | "bs"
  | "gl"
  | "ar"
  | "ap"
  | "cf"
  | "tax"
  | "journals"
  | "audit";

export function exportCsv(filename: string, headers: string[], rows: Array<Array<string | number>>) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const body = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** First day of the current fiscal year (day after FY end month). March YE → 1 April. */
function fiscalYearStart(fyEndMonth: number, asOf = new Date()): string {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth() + 1; // 1-12
  const startMonth = (fyEndMonth % 12) + 1;
  const year = m > fyEndMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}

export function FinancialReportsWorkspace({
  initialTab = "tb",
  hideCatalogueLink = false,
}: {
  initialTab?: ReportTabId;
  hideCatalogueLink?: boolean;
}) {
  const { company, isPending } = useActiveCompany();
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defaultFrom = useMemo(() => {
    const fyEnd = company?.fiscal_year_end_month ?? 3;
    return fiscalYearStart(fyEnd);
  }, [company?.fiscal_year_end_month]);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [accountId, setAccountId] = useState("");
  const [tab, setTab] = useState<ReportTabId>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  // When company loads, snap report range to its fiscal year (fixes empty Demo TB)
  useEffect(() => {
    if (company?.fiscal_year_end_month) {
      setFrom(fiscalYearStart(company.fiscal_year_end_month));
    }
  }, [company?.id, company?.fiscal_year_end_month]);

  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const fetchTb = useServerFn(getTrialBalance);
  const fetchPl = useServerFn(getProfitAndLoss);
  const fetchBs = useServerFn(getBalanceSheet);
  const fetchAgedAr = useServerFn(getAgedReceivables);
  const fetchAgedAp = useServerFn(getAgedPayables);
  const fetchCf = useServerFn(getCashFlow);
  const fetchTax = useServerFn(getTaxReport);
  const fetchJr = useServerFn(getJournalReport);
  const fetchAudit = useServerFn(getAuditReport);
  const fetchAcct = useServerFn(getAccountTransactions);
  const fetchAccounts = useServerFn(listAccounts);

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  // Trial balance is as-of `to` (cumulative) — not filtered by `from`
  const tbQuery = useQuery({
    queryKey: ["report-tb", companyId, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchTb({ data: { companyId: companyId!, to } }),
  });
  const plQuery = useQuery({
    queryKey: ["report-pl", companyId, from, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchPl({ data: { companyId: companyId!, from, to } }),
  });
  const bsQuery = useQuery({
    queryKey: ["report-bs", companyId, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchBs({ data: { companyId: companyId!, asOf: to } }),
  });
  const arQuery = useQuery({
    queryKey: ["report-aged-ar", companyId, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchAgedAr({ data: { companyId: companyId!, asOf: to } }),
  });
  const apQuery = useQuery({
    queryKey: ["report-aged-ap", companyId, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchAgedAp({ data: { companyId: companyId!, asOf: to } }),
  });
  const cfQuery = useQuery({
    queryKey: ["report-cf", companyId, from, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchCf({ data: { companyId: companyId!, from, to } }),
  });
  const taxQuery = useQuery({
    queryKey: ["report-tax", companyId, from, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchTax({ data: { companyId: companyId!, from, to } }),
  });
  const jrQuery = useQuery({
    queryKey: ["report-journals", companyId, from, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchJr({ data: { companyId: companyId!, from, to, status: "posted" } }),
  });
  const auditQuery = useQuery({
    queryKey: ["report-audit", companyId, from, to],
    enabled: Boolean(companyId),
    queryFn: () => fetchAudit({ data: { companyId: companyId!, from, to } }),
    retry: false,
  });
  const acctQuery = useQuery({
    queryKey: ["report-acct-txn", companyId, accountId, from, to],
    enabled: Boolean(companyId && accountId),
    queryFn: () =>
      fetchAcct({ data: { companyId: companyId!, accountId, from, to } }),
  });

  if (isPending) return <LoadingState />;
  if (!companyId) {
    return (
      <EmptyState title="No organisation selected" description="Open an organisation to run ledger reports." />
    );
  }

  return (
    <>
      <PageHeader
        title="Report workspace"
        description={`${company?.name ?? "Organisation"} · ${currency} · Posted ledger only · Generated ${today}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {!hideCatalogueLink ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/reports">All reports</Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1 size-4" /> Print / PDF
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to">To / As of</Label>
          <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as ReportTabId)}
      >
        <TabsList className="mb-4 flex h-auto flex-wrap gap-1">
          <TabsTrigger value="tb">Trial balance</TabsTrigger>
          <TabsTrigger value="pl">P&amp;L</TabsTrigger>
          <TabsTrigger value="bs">Balance sheet</TabsTrigger>
          <TabsTrigger value="gl">Account txns</TabsTrigger>
          <TabsTrigger value="ar">Aged AR</TabsTrigger>
          <TabsTrigger value="ap">Aged AP</TabsTrigger>
          <TabsTrigger value="cf">Cash flow</TabsTrigger>
          <TabsTrigger value="tax">Tax</TabsTrigger>
          <TabsTrigger value="journals">Journals</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="tb">
          <ReportPane
            query={tbQuery}
            emptyTitle="No posted activity"
            emptyDescription="Authorise documents or post journals to populate the trial balance."
            onExport={() => {
              if (!tbQuery.data) return;
              exportCsv(
                `trial-balance-${to}.csv`,
                ["Code", "Name", "Debit", "Credit"],
                tbQuery.data.rows.map((r) => [
                  r.code,
                  r.name,
                  fromMinorUnits(r.debit_minor, currency),
                  fromMinorUnits(r.credit_minor, currency),
                ]),
              );
            }}
          >
            {tbQuery.data ? (
              <>
                <p className="mb-2 text-sm">
                  Totals {fromMinorUnits(tbQuery.data.totalDebit, currency)} /{" "}
                  {fromMinorUnits(tbQuery.data.totalCredit, currency)}{" "}
                  <Badge variant={tbQuery.data.balances ? "secondary" : "destructive"}>
                    {tbQuery.data.balances ? "Balances" : "Out of balance"}
                  </Badge>
                </p>
                <AccountTable currency={currency} rows={tbQuery.data.rows} onDrill={(id) => setAccountId(id)} />
              </>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="pl">
          <ReportPane
            query={plQuery}
            emptyTitle="No income or expense in range"
            emptyDescription="Post revenue or expense journals in this period."
            onExport={() => {
              if (!plQuery.data) return;
              exportCsv(
                `profit-loss-${from}-${to}.csv`,
                ["Code", "Name", "Debit", "Credit"],
                plQuery.data.rows.map((r) => [
                  r.code,
                  r.name,
                  fromMinorUnits(r.debit_minor, currency),
                  fromMinorUnits(r.credit_minor, currency),
                ]),
              );
            }}
          >
            {plQuery.data ? (
              <>
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <Stat label="Income" value={fromMinorUnits(plQuery.data.income, currency)} />
                  <Stat
                    label="Gross profit"
                    value={fromMinorUnits(
                      plQuery.data.grossProfit ?? plQuery.data.income,
                      currency,
                    )}
                  />
                  <Stat label="Expense" value={fromMinorUnits(plQuery.data.expense, currency)} />
                  <Stat label="Net" value={fromMinorUnits(plQuery.data.net, currency)} />
                </div>
                <AccountTable currency={currency} rows={plQuery.data.rows} onDrill={(id) => setAccountId(id)} />
              </>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="bs">
          <ReportPane query={bsQuery} emptyTitle="No balance sheet balances" emptyDescription="Post assets, liabilities or equity.">
            {bsQuery.data ? (
              <>
                {!bsQuery.data.equationHolds ? (
                  <Alert variant="destructive" className="mb-3">
                    <AlertDescription>
                      Accounting equation does not hold (assets ≠ liabilities + equity). Investigate journals.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="mb-4 grid gap-3 sm:grid-cols-4">
                  <Stat label="Assets" value={fromMinorUnits(bsQuery.data.assets, currency)} />
                  <Stat label="Liabilities" value={fromMinorUnits(bsQuery.data.liabilities, currency)} />
                  <Stat label="Equity" value={fromMinorUnits(bsQuery.data.equity, currency)} />
                  <Stat label="Retained (closed P&amp;L)" value={fromMinorUnits(bsQuery.data.retainedEarningsMinor, currency)} />
                </div>
                {"sections" in bsQuery.data && Array.isArray(bsQuery.data.sections) && bsQuery.data.sections.length > 0 ? (
                  <BalanceSheetSections
                    currency={currency}
                    sections={bsQuery.data.sections as Array<{
                      id: string;
                      label: string;
                      total_minor: number;
                      rows: Array<{ account_id: string; code: string; name: string; debit_minor: number; credit_minor: number }>;
                    }>}
                    onDrill={(id) => setAccountId(id)}
                  />
                ) : (
                  <AccountTable currency={currency} rows={bsQuery.data.rows} onDrill={(id) => setAccountId(id)} />
                )}
              </>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="gl">
          <div className="mb-3 max-w-sm space-y-1">
            <Label>Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
              <SelectContent>
                {((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string }>).map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!accountId ? (
            <EmptyState title="Choose an account" description="Drill from TB/P&amp;L/BS or select an account." />
          ) : (
            <ReportPane query={acctQuery} emptyTitle="No movements" emptyDescription="No posted lines for this account in range.">
              {acctQuery.data ? (
                <>
                  <p className="mb-2 text-sm text-muted-foreground">
                    Opening {fromMinorUnits(acctQuery.data.opening_balance_minor, currency)} · Closing{" "}
                    {fromMinorUnits(acctQuery.data.closing_balance_minor, currency)}
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Journal</TableHead>
                        <TableHead>Memo</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                        <TableHead className="text-right">Balance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {acctQuery.data.rows.map((r, i) => (
                        <TableRow key={`${r.journal_id}-${i}`}>
                          <TableCell>{r.journal_date}</TableCell>
                          <TableCell className="font-mono text-xs">#{r.journal_number}</TableCell>
                          <TableCell>{r.memo ?? r.description ?? "—"}</TableCell>
                          <TableCell className="text-right">{fromMinorUnits(r.debit_minor, currency)}</TableCell>
                          <TableCell className="text-right">{fromMinorUnits(r.credit_minor, currency)}</TableCell>
                          <TableCell className="text-right">{fromMinorUnits(r.running_balance_minor, currency)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              ) : null}
            </ReportPane>
          )}
        </TabsContent>

        <TabsContent value="ar">
          <ReportPane query={arQuery} emptyTitle="No open receivables" emptyDescription="Authorised invoices with outstanding balances appear here.">
            {arQuery.data ? (
              <>
                <p className="mb-2 text-sm">
                  Aging total {fromMinorUnits(arQuery.data.total, currency)} · AR control{" "}
                  {fromMinorUnits(arQuery.data.arControlBalanceMinor, currency)}{" "}
                  <Badge variant={arQuery.data.tiesToControl ? "secondary" : "destructive"}>
                    {arQuery.data.tiesToControl ? "Ties to control" : "Does not tie — investigate"}
                  </Badge>
                  {arQuery.data.excludedUnpostedCount ? (
                    <span className="ml-2 text-muted-foreground">
                      ({arQuery.data.excludedUnpostedCount} unposted invoice shell(s) excluded)
                    </span>
                  ) : null}
                </p>
                {arQuery.data.diagnostic ? (
                  <Alert className="mb-3">
                    <AlertDescription>
                      Variance {fromMinorUnits(arQuery.data.varianceMinor ?? 0, currency)}.{" "}
                      {arQuery.data.diagnostic}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <AgingTable currency={currency} rows={arQuery.data.rows} kind="ar" />
              </>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="ap">
          <ReportPane query={apQuery} emptyTitle="No open payables" emptyDescription="Authorised bills with outstanding balances appear here.">
            {apQuery.data ? (
              <>
                <p className="mb-2 text-sm">
                  Aging total {fromMinorUnits(apQuery.data.total, currency)} · AP control{" "}
                  {fromMinorUnits(apQuery.data.apControlBalanceMinor, currency)}{" "}
                  <Badge variant={apQuery.data.tiesToControl ? "secondary" : "destructive"}>
                    {apQuery.data.tiesToControl ? "Ties to control" : "Does not tie — investigate"}
                  </Badge>
                  {apQuery.data.excludedUnpostedCount ? (
                    <span className="ml-2 text-muted-foreground">
                      ({apQuery.data.excludedUnpostedCount} unposted bill shell(s) excluded)
                    </span>
                  ) : null}
                </p>
                {apQuery.data.diagnostic ? (
                  <Alert className="mb-3">
                    <AlertDescription>
                      Variance {fromMinorUnits(apQuery.data.varianceMinor ?? 0, currency)}.{" "}
                      {apQuery.data.diagnostic}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <AgingTable currency={currency} rows={apQuery.data.rows} kind="ap" />
              </>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="cf">
          <ReportPane query={cfQuery} emptyTitle="No cash movements" emptyDescription="Bank GL activity in range will appear here.">
            {cfQuery.data ? (
              <>
                <Alert className="mb-3">
                  <AlertDescription>{cfQuery.data.limitation}</AlertDescription>
                </Alert>
                <div className="mb-4 grid gap-3 sm:grid-cols-4">
                  <Stat label="Opening cash" value={fromMinorUnits(cfQuery.data.opening_cash, currency)} />
                  <Stat label="Net change" value={fromMinorUnits(cfQuery.data.net_change, currency)} />
                  <Stat label="Closing (movements)" value={fromMinorUnits(cfQuery.data.closing_cash, currency)} />
                  <Stat
                    label="Closing (bank ledger)"
                    value={fromMinorUnits(cfQuery.data.closing_cash_ledger ?? cfQuery.data.closing_cash, currency)}
                  />
                </div>
                <p className="mb-3 text-sm">
                  <Badge variant={cfQuery.data.reconciles ? "secondary" : "destructive"}>
                    {cfQuery.data.reconciles
                      ? "Opening + movements = bank ledger"
                      : "Cash movement total does not equal bank ledger — investigate"}
                  </Badge>
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cfQuery.data.rows.map((r) => (
                      <TableRow key={r.category}>
                        <TableCell>{r.category}</TableCell>
                        <TableCell className="text-right">{fromMinorUnits(r.amount_minor, currency)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="tax">
          <ReportPane query={taxQuery} emptyTitle="No tax control movements" emptyDescription="Configure tax accounts and post taxable documents.">
            {taxQuery.data ? (
              <>
                <Alert className="mb-3">
                  <AlertDescription>
                    Regime: {taxQuery.data.regime}
                    {taxQuery.data.jurisdictionCode ? ` (${taxQuery.data.jurisdictionCode})` : ""}.{" "}
                    {taxQuery.data.complianceNote}{" "}
                    <Link className="underline" to="/settings">Tax settings</Link>
                  </AlertDescription>
                </Alert>
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <Stat label="Output (credits)" value={fromMinorUnits(taxQuery.data.output_credit_minor, currency)} />
                  <Stat label="Input (debits)" value={fromMinorUnits(taxQuery.data.input_debit_minor, currency)} />
                  <Stat label="Net payable" value={fromMinorUnits(taxQuery.data.net_payable_minor, currency)} />
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Journal</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {taxQuery.data.detail.map((l, i) => (
                      <TableRow key={`${l.journal_id}-${i}`}>
                        <TableCell>{l.journal_date}</TableCell>
                        <TableCell className="font-mono text-xs">#{l.journal_number}</TableCell>
                        <TableCell>{l.account_code} {l.account_name}</TableCell>
                        <TableCell className="text-right">{fromMinorUnits(l.debit_minor, currency)}</TableCell>
                        <TableCell className="text-right">{fromMinorUnits(l.credit_minor, currency)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="journals">
          <ReportPane
            query={jrQuery}
            emptyTitle="No journals"
            emptyDescription="Posted journals in range will list here."
            onExport={() => {
              if (!jrQuery.data) return;
              exportCsv(
                `journals-${from}-${to}.csv`,
                ["Number", "Date", "Source", "Memo", "Debit", "Credit"],
                jrQuery.data.map((j) => [
                  j.journal_number,
                  j.journal_date,
                  j.source_type,
                  j.memo ?? "",
                  fromMinorUnits(j.total_debit_minor, currency),
                  fromMinorUnits(j.total_credit_minor, currency),
                ]),
              );
            }}
          >
            {jrQuery.data ? (
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
                  {jrQuery.data.map((j) => (
                    <TableRow key={j.journal_id}>
                      <TableCell>{j.journal_number}</TableCell>
                      <TableCell>{j.journal_date}</TableCell>
                      <TableCell>{j.source_type}</TableCell>
                      <TableCell>{j.memo ?? "—"}</TableCell>
                      <TableCell className="text-right">{fromMinorUnits(j.total_debit_minor, currency)}</TableCell>
                      <TableCell className="text-right">{fromMinorUnits(j.total_credit_minor, currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </ReportPane>
        </TabsContent>

        <TabsContent value="audit">
          {auditQuery.isError ? (
            <ErrorState title="Audit log unavailable" description={friendlyAuthError(auditQuery.error)} />
          ) : (
            <ReportPane query={auditQuery} emptyTitle="No audit events" emptyDescription="Posting and period actions will appear when audited.">
              {auditQuery.data ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Entity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(auditQuery.data as Array<{ id: string; created_at: string; action: string; entity_type: string; entity_id: string }>).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell>{new Date(e.created_at).toLocaleString()}</TableCell>
                        <TableCell>{e.action}</TableCell>
                        <TableCell className="font-mono text-xs">{e.entity_type} {e.entity_id?.slice(0, 8)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
            </ReportPane>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
      <CardContent className="text-lg font-semibold">{value}</CardContent>
    </Card>
  );
}

function AccountTable({
  currency,
  rows,
  onDrill,
}: {
  currency: string;
  rows: Array<{ account_id: string; code: string; name: string; debit_minor: number; credit_minor: number }>;
  onDrill?: (accountId: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Code</TableHead>
          <TableHead>Account</TableHead>
          <TableHead className="text-right">Debit</TableHead>
          <TableHead className="text-right">Credit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.account_id}>
            <TableCell>
              {onDrill && !r.account_id.startsWith("__") ? (
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => onDrill(r.account_id)}>
                  {r.code}
                </button>
              ) : (
                r.code
              )}
            </TableCell>
            <TableCell>{r.name}</TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.debit_minor, currency)}</TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.credit_minor, currency)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function BalanceSheetSections({
  currency,
  sections,
  onDrill,
}: {
  currency: string;
  sections: Array<{
    id: string;
    label: string;
    total_minor: number;
    rows: Array<{ account_id: string; code: string; name: string; debit_minor: number; credit_minor: number }>;
  }>;
  onDrill?: (accountId: string) => void;
}) {
  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <div key={section.id}>
          <div className="mb-2 flex items-baseline justify-between border-b pb-1">
            <h3 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">{section.label}</h3>
            <span className="font-medium tabular-nums">{fromMinorUnits(section.total_minor, currency)}</span>
          </div>
          <AccountTable
            currency={currency}
            rows={section.rows}
            {...(onDrill ? { onDrill } : {})}
          />
        </div>
      ))}
    </div>
  );
}

function AgingTable({
  currency,
  rows,
  kind,
}: {
  currency: string;
  rows: Array<{
    contact_id: string;
    contact_name: string;
    current: number;
    b_1_30: number;
    b_31_60: number;
    b_61_90: number;
    b_90_plus: number;
    total: number;
  }>;
  kind: "ar" | "ap";
}) {
  return (
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
        {rows.map((r) => (
          <TableRow key={r.contact_id}>
            <TableCell>
              <Link
                to="/contacts/$contactId"
                params={{ contactId: r.contact_id }}
                className="underline-offset-2 hover:underline"
              >
                {r.contact_name}
              </Link>
              <span className="sr-only">{kind}</span>
            </TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.current, currency)}</TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.b_1_30, currency)}</TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.b_31_60, currency)}</TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.b_61_90, currency)}</TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.b_90_plus, currency)}</TableCell>
            <TableCell className="text-right">{fromMinorUnits(r.total, currency)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReportPane({
  query,
  children,
  emptyTitle,
  emptyDescription,
  onExport,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: unknown; refetch: () => void };
  children: ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  onExport?: () => void;
}) {
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState title="Could not load report" description={friendlyAuthError(query.error)} onRetry={() => query.refetch()} />
    );
  }
  const empty =
    query.data == null ||
    (Array.isArray(query.data) && query.data.length === 0) ||
    (typeof query.data === "object" &&
      query.data !== null &&
      "rows" in query.data &&
      Array.isArray((query.data as { rows: unknown[] }).rows) &&
      (query.data as { rows: unknown[] }).rows.length === 0 &&
      !("total" in query.data && Number((query.data as { total: number }).total) > 0) &&
      !("income" in query.data) &&
      !("assets" in query.data) &&
      !("operating" in query.data) &&
      !("output_credit_minor" in query.data) &&
      !("opening_balance_minor" in query.data));

  // Prefer rendering children when structured reports have summary fields even with empty rows
  const hasSummary =
    typeof query.data === "object" &&
    query.data !== null &&
    ("income" in query.data ||
      "assets" in query.data ||
      "operating" in query.data ||
      "output_credit_minor" in query.data ||
      "opening_balance_minor" in query.data ||
      "total" in query.data ||
      "balances" in query.data);

  if (empty && !hasSummary) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div>
      {onExport ? (
        <div className="mb-3">
          <Button size="sm" variant="outline" onClick={onExport}>
            Export CSV
          </Button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
