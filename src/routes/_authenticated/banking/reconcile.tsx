import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  completeReconciliation, listBankAccounts, listReconciliationSessions,
} from "@/lib/banking/banking.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/banking/reconcile")({
  head: () => ({ meta: [{ title: "Reconcile — LinkBooks" }] }),
  component: Reconcile,
});

function Reconcile() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchSessions = useServerFn(listReconciliationSessions);
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
    queryFn: () => fetchSessions({
      data: { companyId: companyId!, ...(bankAccountId ? { bankAccountId } : {}) },
    }),
  });

  const mutation = useMutation({
    mutationFn: () => complete({
      data: {
        companyId: companyId!,
        bankAccountId,
        statementDate,
        statementBalanceMinor: Number(toMinorUnits(balance || "0", currency)),
        notes,
      },
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["recon-sessions", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      toast.success(
        `Reconciliation completed. Ledger balance ${fromMinorUnits(r.ledgerBalanceMinor, currency)} matched statement.`,
      );
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Reconciliation"
        description="Completes only when all statement-date transactions are categorised/matched and ledger balance equals the statement." />
      <div className="mb-8 grid max-w-md gap-3 rounded-md border p-4">
        <div className="space-y-1"><Label>Bank account</Label>
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
            <SelectContent>
              {((accountsQ.data ?? []) as Array<{ id: string; name: string }>).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1"><Label>Statement date</Label>
          <Input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} /></div>
        <div className="space-y-1"><Label>Statement closing balance</Label>
          <Input value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" /></div>
        <div className="space-y-1"><Label>Notes</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <Button size="sm" disabled={mutation.isPending || !bankAccountId} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Complete reconciliation
        </Button>
      </div>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">History</h3>
      {sessionsQ.isPending ? <LoadingState /> : sessionsQ.isError ? (
        <ErrorState title="Could not load history" description={friendlyAuthError(sessionsQ.error)} />
      ) : (sessionsQ.data ?? []).length === 0 ? (
        <EmptyState title="No reconciliations yet" description="Complete a period above." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Statement date</TableHead><TableHead>Status</TableHead>
            <TableHead className="text-right">Statement</TableHead>
            <TableHead className="text-right">Ledger</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(sessionsQ.data as Array<{
              id: string; statement_date: string; status: string;
              statement_balance_minor: number; reconciled_balance_minor: number | null;
            }>).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.statement_date}</TableCell>
                <TableCell><Badge variant="secondary">{s.status}</Badge></TableCell>
                <TableCell className="text-right">{fromMinorUnits(s.statement_balance_minor, currency)}</TableCell>
                <TableCell className="text-right">
                  {s.reconciled_balance_minor == null ? "—" : fromMinorUnits(s.reconciled_balance_minor, currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
