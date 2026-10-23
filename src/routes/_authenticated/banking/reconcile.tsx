import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { listBankAccounts } from "@/lib/banking/banking.functions";
import { summariseReconciliation } from "@/lib/banking/recon-math";
import {
  completeReconciliation,
  getReconciliationWorkspace,
  listReconciliationSessions,
  voidReconciliationSession,
} from "@/lib/banking/reconcile.functions";
import { ConfirmButton } from "@/components/banking/ConfirmButton";
import { MoneyField, moneyFieldMinor } from "@/components/banking/MoneyField";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Search = { bankAccountId?: string };

export const Route = createFileRoute("/_authenticated/banking/reconcile")({
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s["bankAccountId"] === "string" && s["bankAccountId"]
      ? { bankAccountId: s["bankAccountId"] }
      : {},
  head: () => ({ meta: [{ title: "Reconcile — LinkBooks" }] }),
  component: Reconcile,
});

function Reconcile() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const search = Route.useSearch();
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchWorkspace = useServerFn(getReconciliationWorkspace);
  const fetchSessions = useServerFn(listReconciliationSessions);
  const complete = useServerFn(completeReconciliation);
  const voidSession = useServerFn(voidReconciliationSession);

  const [bankAccountId, setBankAccountId] = useState(search.bankAccountId ?? "");
  const [statementDate, setStatementDate] = useState(today);
  const [closing, setClosing] = useState("");
  const [opening, setOpening] = useState("");
  const [notes, setNotes] = useState("");
  const [tickedGroups, setTickedGroups] = useState<Set<string>>(new Set());
  const [tickedLedger, setTickedLedger] = useState<Set<string>>(new Set());

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const account = (accountsQ.data ?? []).find((a) => a.id === bankAccountId);
  const currency = account?.currency_code ?? company?.base_currency ?? "GBP";

  const wsQ = useQuery({
    queryKey: ["bank-recon-workspace", companyId, bankAccountId, statementDate],
    enabled: Boolean(companyId && bankAccountId && /^\d{4}-\d{2}-\d{2}$/.test(statementDate)),
    queryFn: () =>
      fetchWorkspace({ data: { companyId: companyId!, bankAccountId, statementDate } }),
  });
  const sessionsQ = useQuery({
    queryKey: ["bank-recon-sessions", companyId, bankAccountId],
    enabled: Boolean(companyId && bankAccountId),
    queryFn: () => fetchSessions({ data: { companyId: companyId!, bankAccountId } }),
  });
  const ws = wsQ.data;

  // Reset ticks when the account or date changes; adopt the proposed opening balance once.
  useEffect(() => {
    setTickedGroups(new Set());
    setTickedLedger(new Set());
  }, [bankAccountId, statementDate]);
  useEffect(() => {
    if (!ws) return;
    if (ws.openingProposalMinor !== null)
      setOpening(fromMinorUnits(ws.openingProposalMinor, currency));
  }, [ws?.openingProposalMinor, ws?.lastSession?.id, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  const openingLocked = ws?.openingProposalMinor !== null && ws?.openingProposalMinor !== undefined;
  const closingMinor = moneyFieldMinor(closing, currency);
  const openingMinor = moneyFieldMinor(opening, currency);

  const clearedAmounts = useMemo(() => {
    if (!ws) return [] as number[];
    const amounts: number[] = [];
    for (const g of ws.groups) if (tickedGroups.has(g.key)) amounts.push(g.ledgerTotalMinor);
    for (const l of ws.ledgerOnly) if (tickedLedger.has(l.lineId)) amounts.push(l.amountMinor);
    return amounts;
  }, [ws, tickedGroups, tickedLedger]);

  const summary =
    closingMinor !== null && openingMinor !== null
      ? summariseReconciliation({ openingMinor, closingMinor, tickedAmountsMinor: clearedAmounts })
      : null;

  const money = (v: bigint | number) => fromMinorUnits(v, currency);
  const tickedTxnIds = ws
    ? ws.groups
        .filter((g) => tickedGroups.has(g.key))
        .flatMap((g) => g.transactions.map((t) => t.id))
    : [];
  const tickedLineIds = ws
    ? [
        ...ws.groups
          .filter((g) => tickedGroups.has(g.key))
          .flatMap((g) => g.ledgerLines.map((l) => l.lineId)),
        ...ws.ledgerOnly.filter((l) => tickedLedger.has(l.lineId)).map((l) => l.lineId),
      ]
    : [];
  const blockedByUncategorised = (ws?.uncategorisedCount ?? 0) > 0;
  const canComplete =
    Boolean(summary?.balanced) &&
    clearedAmounts.length > 0 &&
    !blockedByUncategorised &&
    ws !== undefined;

  const completeM = useMutation({
    mutationFn: () =>
      complete({
        data: {
          companyId: companyId!,
          bankAccountId,
          statementDate,
          statementBalanceMinor: Number(closingMinor),
          openingBalanceMinor: Number(openingMinor),
          bankTransactionIds: tickedTxnIds,
          journalLineIds: tickedLineIds,
          notes,
        },
      }),
    onSuccess: async () => {
      toast.success("Reconciliation completed");
      setTickedGroups(new Set());
      setTickedLedger(new Set());
      setClosing("");
      setNotes("");
      await qc.invalidateQueries({ queryKey: ["bank-recon-workspace", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-recon-sessions", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-account-summaries", companyId] });
      await qc.invalidateQueries({ queryKey: ["banking-counts", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const voidM = useMutation({
    mutationFn: (sessionId: string) => voidSession({ data: { companyId: companyId!, sessionId } }),
    onSuccess: async (r) => {
      toast.success(`Reopened. ${r.statementLinesReopened} statement lines are back to matched.`);
      await qc.invalidateQueries({ queryKey: ["bank-recon-workspace", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-recon-sessions", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-account-summaries", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const sessions = sessionsQ.data ?? [];
  const latestCompleted = sessions.find((s) => s.status === "completed");

  const toggleSet = (
    set: Set<string>,
    key: string,
    on: boolean,
    apply: (n: Set<string>) => void,
  ) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    apply(next);
  };

  return (
    <>
      <PageHeader
        title="Reconcile"
        description="Tick the statement and ledger items that appear on your bank statement. Opening balance + ticked items must equal the statement closing balance before you can complete."
      />

      <div className="mb-6 grid max-w-3xl gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Bank account</Label>
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger aria-label="Bank account">
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              {(accountsQ.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} ({a.currency_code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Statement date</Label>
          <Input
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>Opening balance ({currency})</Label>
          <MoneyField
            label="Opening balance"
            value={opening}
            currency={currency}
            disabled={openingLocked}
            onChange={setOpening}
          />
          <p className="text-xs text-muted-foreground">
            {openingLocked
              ? `From the reconciliation completed on ${ws?.lastSession?.statementDate}.`
              : "First reconciliation for this account: enter the statement's opening balance once (0 if you reconcile from the very first ledger entry)."}
          </p>
        </div>
        <div className="space-y-1">
          <Label>Statement closing balance ({currency})</Label>
          <MoneyField
            label="Statement closing balance"
            value={closing}
            currency={currency}
            onChange={setClosing}
          />
        </div>
      </div>

      {!bankAccountId ? (
        <EmptyState
          title="Choose a bank account"
          description="Select an account to start reconciling."
        />
      ) : wsQ.isPending ? (
        <LoadingState />
      ) : wsQ.isError ? (
        <ErrorState
          title="Could not load reconciliation"
          description={friendlyAuthError(wsQ.error)}
        />
      ) : ws ? (
        <>
          <div className="sticky top-0 z-10 mb-4 grid gap-2 rounded-md border bg-background p-3 text-sm sm:grid-cols-5">
            <div>
              <div className="text-xs text-muted-foreground">Opening</div>
              <div className="font-mono">{openingMinor === null ? "—" : money(openingMinor)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Ticked ({clearedAmounts.length})</div>
              <div className="font-mono">{summary ? money(summary.cleared) : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Statement closing</div>
              <div className="font-mono">{closingMinor === null ? "—" : money(closingMinor)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Difference</div>
              <div
                className={`font-mono ${summary?.balanced ? "text-emerald-600" : "text-destructive"}`}
              >
                {summary ? money(summary.difference) : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Ledger balance at {statementDate}</div>
              <div className="font-mono">{money(ws.ledgerBalanceMinor)}</div>
            </div>
          </div>

          {blockedByUncategorised ? (
            <Alert className="mb-4" variant="destructive">
              <AlertTitle>
                {ws.uncategorisedCount} statement lines are still uncategorised
              </AlertTitle>
              <AlertDescription>
                Code, match or exclude them first (or choose an earlier statement date).{" "}
                <Link
                  to="/banking/transactions"
                  search={
                    { status: "uncategorised", bankAccountId, dateTo: statementDate } as never
                  }
                  className="underline"
                >
                  Open For review
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="mb-6">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">
                Matched statement lines ({ws.groups.length})
              </h2>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setTickedGroups(
                      new Set(ws.groups.filter((g) => !g.inconsistent).map((g) => g.key)),
                    )
                  }
                >
                  Tick all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setTickedGroups(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
            {ws.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No matched statement lines up to {statementDate}.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Statement</TableHead>
                    <TableHead>Ledger</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ws.groups.map((g) => (
                    <TableRow key={g.key}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Tick ${g.transactions[0]?.description ?? "statement line"}`}
                          disabled={g.inconsistent}
                          checked={tickedGroups.has(g.key)}
                          onCheckedChange={(v) =>
                            toggleSet(tickedGroups, g.key, v === true, setTickedGroups)
                          }
                        />
                      </TableCell>
                      <TableCell>
                        {g.transactions.map((t) => (
                          <div key={t.id} className="text-sm">
                            {t.date} · {t.description ?? "—"}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {g.ledgerLines.length === 0
                          ? "No ledger link"
                          : g.ledgerLines.map((l) => (
                              <div key={l.lineId}>
                                #{l.journalNumber} · {l.description || l.source}
                              </div>
                            ))}
                        {g.inconsistent ? (
                          <Badge variant="destructive" className="mt-1">
                            Statement and ledger totals differ. Unmatch and rematch.
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {money(g.statementTotalMinor)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="mb-6">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">
                Ledger items not on an imported statement ({ws.unmatchedLedgerCount})
              </h2>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTickedLedger(new Set(ws.ledgerOnly.map((l) => l.lineId)))}
                >
                  Tick all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setTickedLedger(new Set())}>
                  Clear
                </Button>
              </div>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              Tick the ones that appear on the bank statement (for example when you did not import
              every line). Unticked items stay outstanding and are listed in the report.
            </p>
            {ws.ledgerOnlyTruncated ? (
              <Alert className="mb-2">
                <AlertDescription>
                  Only the first {ws.ledgerOnly.length} items are listed. Narrow the statement date
                  to see the rest.
                </AlertDescription>
              </Alert>
            ) : null}
            {ws.ledgerOnly.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing outstanding in the ledger.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Date</TableHead>
                    <TableHead>Journal</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ws.ledgerOnly.map((l) => (
                    <TableRow key={l.lineId}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Tick journal ${l.journalNumber}`}
                          checked={tickedLedger.has(l.lineId)}
                          onCheckedChange={(v) =>
                            toggleSet(tickedLedger, l.lineId, v === true, setTickedLedger)
                          }
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                      <TableCell className="text-sm">
                        #{l.journalNumber} · {l.description || l.source}
                      </TableCell>
                      <TableCell className="text-right font-mono">{money(l.amountMinor)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <div className="mb-10 flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Notes (optional)</Label>
              <Input
                className="w-72"
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <Button
              disabled={!canComplete || completeM.isPending}
              onClick={() => completeM.mutate()}
            >
              {completeM.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Complete reconciliation
            </Button>
            {summary && !summary.balanced ? (
              <span className="text-sm text-destructive">
                Difference {money(summary.difference)} must be zero.
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {bankAccountId ? (
        <section>
          <h2 className="mb-2 text-base font-semibold">Reconciliation history</h2>
          {sessionsQ.isPending ? (
            <LoadingState rows={2} />
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No reconciliations for this account yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Statement date</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Closing</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.statement_date}</TableCell>
                    <TableCell className="text-right font-mono">
                      {s.opening_balance_minor === null ? "—" : money(s.opening_balance_minor)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {money(s.statement_balance_minor)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={s.status === "completed" ? "secondary" : "outline"}>
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {s.status === "completed" ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              to="/banking/reconciliation-report/$sessionId"
                              params={{ sessionId: s.id }}
                            >
                              Report
                            </Link>
                          </Button>
                        ) : null}
                        {s.id === latestCompleted?.id ? (
                          <ConfirmButton
                            title="Reopen this reconciliation?"
                            description="The session is voided and its statement lines go back to matched. Only the latest reconciliation of an account can be reopened."
                            confirmLabel="Reopen"
                            disabled={voidM.isPending}
                            onConfirm={() => voidM.mutate(s.id)}
                          >
                            Reopen
                          </ConfirmButton>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      ) : null}
    </>
  );
}
