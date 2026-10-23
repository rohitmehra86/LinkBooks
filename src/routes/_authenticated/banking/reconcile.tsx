import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  completeReconciliation,
  getReconciliationWorkspace,
  listBankAccounts,
  listReconciliationSessions,
} from "@/lib/banking/banking.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/banking/reconcile")({
  head: () => ({ meta: [{ title: "Reconcile — LinkBooks" }] }),
  component: Reconcile,
});

function parseMinor(value: string, currency: string): bigint | null {
  if (!value.trim()) return null;
  try {
    return toMinorUnits(value.trim(), currency);
  } catch {
    return null;
  }
}

function Reconcile() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchSessions = useServerFn(listReconciliationSessions);
  const fetchWorkspace = useServerFn(getReconciliationWorkspace);
  const complete = useServerFn(completeReconciliation);

  const [bankAccountId, setBankAccountId] = useState("");
  const [statementDate, setStatementDate] = useState(today);
  const [balance, setBalance] = useState("");
  const [notes, setNotes] = useState("");

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const sessionsQ = useQuery({
    queryKey: ["recon-sessions", companyId, bankAccountId],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetchSessions({
        data: { companyId: companyId!, ...(bankAccountId ? { bankAccountId } : {}) },
      }),
  });
  const workspaceQ = useQuery({
    queryKey: ["recon-workspace", companyId, bankAccountId, statementDate],
    enabled: Boolean(companyId && bankAccountId && statementDate),
    queryFn: () =>
      fetchWorkspace({ data: { companyId: companyId!, bankAccountId, statementDate } }),
  });

  const statementMinor = parseMinor(balance, currency);
  const ws = workspaceQ.data;
  const difference =
    ws && statementMinor !== null ? statementMinor - BigInt(ws.ledgerBalanceMinor) : null;
  const blockers: string[] = [];
  if (ws && ws.uncategorisedCount > 0) {
    blockers.push(
      `${ws.uncategorisedCount} bank transaction(s) on or before the statement date are not yet coded.`,
    );
  }
  if (difference !== null && difference !== 0n) {
    blockers.push(
      `Statement and ledger differ by ${fromMinorUnits(difference < 0n ? -difference : difference, currency)}.`,
    );
  }
  if (statementMinor === null) blockers.push("Enter the closing balance from the bank statement.");
  const ready = Boolean(ws) && blockers.length === 0;

  const mutation = useMutation({
    mutationFn: () =>
      complete({
        data: {
          companyId: companyId!,
          bankAccountId,
          statementDate,
          statementBalanceMinor: Number(statementMinor ?? 0n),
          notes,
        },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["recon-sessions", companyId] });
      await qc.invalidateQueries({ queryKey: ["recon-workspace", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      await qc.invalidateQueries({ queryKey: ["banking-counts", companyId] });
      toast.success(
        `Reconciled. Ledger balance ${fromMinorUnits(r.ledgerBalanceMinor, currency)} matches the statement.`,
      );
      setBalance("");
      setNotes("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="Enter the closing balance from your bank statement. The reconciliation completes when every transaction up to that date is coded and the ledger balance equals the statement."
      />
      <div className="mb-6 grid max-w-3xl gap-3 rounded-md border p-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Bank account</Label>
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {((accountsQ.data ?? []) as Array<{ id: string; name: string }>).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rec-date">Statement date</Label>
          <Input
            id="rec-date"
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rec-balance">Statement closing balance ({currency})</Label>
          <Input
            id="rec-balance"
            inputMode="decimal"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rec-notes">Notes</Label>
          <Input id="rec-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      {bankAccountId ? (
        workspaceQ.isPending ? (
          <LoadingState rows={3} />
        ) : workspaceQ.isError ? (
          <ErrorState
            title="Could not load reconciliation data"
            description={friendlyAuthError(workspaceQ.error)}
            onRetry={() => void workspaceQ.refetch()}
          />
        ) : ws ? (
          <div className="mb-8 space-y-4">
            <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
              <Summary
                label="Statement balance"
                value={statementMinor === null ? "—" : fromMinorUnits(statementMinor, currency)}
              />
              <Summary
                label="Ledger balance"
                value={fromMinorUnits(ws.ledgerBalanceMinor, currency)}
              />
              <Summary
                label="Difference"
                value={difference === null ? "—" : fromMinorUnits(difference, currency)}
                tone={difference === null ? "muted" : difference === 0n ? "good" : "bad"}
              />
            </div>

            <ul className="max-w-3xl space-y-1 text-sm">
              {blockers.length === 0 ? (
                <li className="flex items-center gap-2 text-emerald-600">
                  <CheckCircle2 className="size-4" /> Ready to reconcile.
                </li>
              ) : (
                blockers.map((b) => (
                  <li key={b} className="flex items-center gap-2 text-destructive">
                    <XCircle className="size-4 shrink-0" /> {b}
                  </li>
                ))
              )}
            </ul>

            {ws.uncategorisedCount > 0 ? (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium">Bank transactions still to code</h3>
                  <Link
                    to="/banking/transactions"
                    search={{ status: "uncategorised" } as never}
                    className="text-sm underline"
                  >
                    Open For review
                  </Link>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ws.uncategorised.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell>{t.txn_date}</TableCell>
                        <TableCell>{t.description ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fromMinorUnits(t.amount_minor, currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}

            {ws.unmatchedLedgerCount > 0 ? (
              <div>
                <h3 className="text-sm font-medium">
                  Ledger entries not matched to a statement line ({ws.unmatchedLedgerCount})
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">
                  Total {fromMinorUnits(ws.unmatchedLedgerTotalMinor, currency)}. These are
                  outstanding items (for example a cheque not yet cleared) or opening balances.
                  Check them if the difference above is not zero.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Journal</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ws.unmatchedLedgerLines.map((l) => (
                      <TableRow key={l.lineId}>
                        <TableCell>{l.date}</TableCell>
                        <TableCell>
                          #{l.journalNumber} · {l.source.replace(/_/g, " ")}
                        </TableCell>
                        <TableCell className="max-w-[320px] truncate">
                          {l.description || "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fromMinorUnits(l.amountMinor, currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}

            <Button
              size="sm"
              disabled={!ready || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Complete
              reconciliation
            </Button>
          </div>
        ) : null
      ) : null}

      <h3 className="mb-2 text-sm font-medium text-muted-foreground">History</h3>
      {sessionsQ.isPending ? (
        <LoadingState />
      ) : sessionsQ.isError ? (
        <ErrorState
          title="Could not load history"
          description={friendlyAuthError(sessionsQ.error)}
        />
      ) : (sessionsQ.data ?? []).length === 0 ? (
        <EmptyState title="No reconciliations yet" description="Complete a period above." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Statement date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Statement</TableHead>
              <TableHead className="text-right">Ledger</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              sessionsQ.data as Array<{
                id: string;
                statement_date: string;
                status: string;
                statement_balance_minor: number;
                reconciled_balance_minor: number | null;
                notes: string | null;
              }>
            ).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.statement_date}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{s.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fromMinorUnits(s.statement_balance_minor, currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.reconciled_balance_minor == null
                    ? "—"
                    : fromMinorUnits(s.reconciled_balance_minor, currency)}
                </TableCell>
                <TableCell className="max-w-[240px] truncate">{s.notes ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function Summary({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "muted" | "good" | "bad";
}) {
  const color =
    tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
