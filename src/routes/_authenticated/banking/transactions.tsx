import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  applyRulesToUncategorised, categoriseTransaction, listBankAccounts, listBankTransactions,
} from "@/lib/banking/banking.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/banking/transactions")({
  head: () => ({ meta: [{ title: "Bank transactions — LinkBooks" }] }),
  component: BankTransactions,
});

function BankTransactions() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const qc = useQueryClient();
  const fetchTxns = useServerFn(listBankTransactions);
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchGl = useServerFn(listAccounts);
  const categorise = useServerFn(categoriseTransaction);
  const applyRules = useServerFn(applyRulesToUncategorised);

  const [bankAccountId, setBankAccountId] = useState("all");
  const [status, setStatus] = useState("uncategorised");
  const [offsetByTxn, setOffsetByTxn] = useState<Record<string, string>>({});

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const txnsQ = useQuery({
    queryKey: ["bank-transactions", companyId, bankAccountId, status],
    enabled: Boolean(companyId),
    queryFn: () => fetchTxns({
      data: {
        companyId: companyId!,
        ...(bankAccountId !== "all" ? { bankAccountId } : {}),
        ...(status !== "all" ? { status } : {}),
      },
    }),
  });
  const glQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGl({ data: { companyId: companyId! } }),
  });
  const offsets = ((glQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>)
    .filter((a) => a.is_active && a.is_postable);

  const catM = useMutation({
    mutationFn: (txnId: string) => {
      const offset = offsetByTxn[txnId];
      if (!offset) throw new Error("Choose an offset account");
      return categorise({ data: { companyId: companyId!, bankTransactionId: txnId, offsetAccountId: offset } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      toast.success("Categorised — one journal posted and linked");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rulesM = useMutation({
    mutationFn: () => applyRules({
      data: {
        companyId: companyId!,
        ...(bankAccountId !== "all" ? { bankAccountId } : {}),
      },
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
      toast.success(`Rules applied: ${r.applied}; skipped: ${r.skipped}`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Transactions"
        description="Categorise posts one balanced journal and links it — never a second movement for the same money."
        actions={
          <Button size="sm" variant="outline" disabled={rulesM.isPending} onClick={() => rulesM.mutate()}>
            Apply bank rules
          </Button>
        } />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select value={bankAccountId} onValueChange={setBankAccountId}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {((accountsQ.data ?? []) as Array<{ id: string; name: string }>).map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="uncategorised">Uncategorised</SelectItem>
            <SelectItem value="matched">Matched</SelectItem>
            <SelectItem value="reconciled">Reconciled</SelectItem>
            <SelectItem value="excluded">Excluded</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {txnsQ.isPending ? <LoadingState /> : txnsQ.isError ? (
        <ErrorState title="Could not load" description={friendlyAuthError(txnsQ.error)} />
      ) : (txnsQ.data?.rows ?? []).length === 0 ? (
        <EmptyState title="No transactions" description="Import a CSV statement first." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Date</TableHead><TableHead>Description</TableHead>
            <TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead>Categorise</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(txnsQ.data!.rows as Array<{ id: string; txn_date: string; description: string | null; amount_minor: number; status: string }>).map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.txn_date}</TableCell>
                <TableCell>{t.description ?? "—"}</TableCell>
                <TableCell className="text-right">{fromMinorUnits(t.amount_minor, currency)}</TableCell>
                <TableCell><Badge variant="secondary">{t.status}</Badge></TableCell>
                <TableCell>
                  {t.status === "uncategorised" ? (
                    <div className="flex gap-2">
                      <Select value={offsetByTxn[t.id] ?? ""} onValueChange={(v) => setOffsetByTxn((m) => ({ ...m, [t.id]: v }))}>
                        <SelectTrigger className="w-40"><SelectValue placeholder="Offset" /></SelectTrigger>
                        <SelectContent>{offsets.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.code}</SelectItem>
                        ))}</SelectContent>
                      </Select>
                      <Button size="sm" variant="outline" disabled={catM.isPending} onClick={() => catM.mutate(t.id)}>
                        Post
                      </Button>
                    </div>
                  ) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
