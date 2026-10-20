import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  bulkCategoriseTransactions,
  excludeBankTransaction,
  listBankAccounts,
  listBankTransactions,
} from "@/lib/banking/banking.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/banking/cash-coding")({
  head: () => ({
    meta: [
      { title: "Cash coding — LinkBooks" },
      { name: "description", content: "Bulk-code uncategorised bank statement lines." },
    ],
  }),
  component: CashCoding,
});

function CashCoding() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const qc = useQueryClient();
  const fetchTxns = useServerFn(listBankTransactions);
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchGl = useServerFn(listAccounts);
  const bulkCat = useServerFn(bulkCategoriseTransactions);
  const doExclude = useServerFn(excludeBankTransaction);

  const [bankAccountId, setBankAccountId] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [offsetAccountId, setOffsetAccountId] = useState("");

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const txnsQ = useQuery({
    queryKey: ["bank-transactions", companyId, bankAccountId, "uncategorised", "cash"],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetchTxns({
        data: {
          companyId: companyId!,
          status: "uncategorised",
          pageSize: 100,
          ...(bankAccountId !== "all" ? { bankAccountId } : {}),
        },
      }),
  });
  const glQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGl({ data: { companyId: companyId! } }),
  });

  const rows = (txnsQ.data?.rows ?? []) as unknown as Array<{
    id: string;
    txn_date: string;
    description: string | null;
    amount_minor: number;
  }>;

  const summary = useMemo(() => {
    let moneyIn = 0;
    let moneyOut = 0;
    for (const id of selected) {
      const r = rows.find((x) => x.id === id);
      if (!r) continue;
      if (r.amount_minor >= 0) moneyIn += r.amount_minor;
      else moneyOut += r.amount_minor;
    }
    return { count: selected.length, moneyIn, moneyOut };
  }, [selected, rows]);

  const offsets = (
    (glQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>
  ).filter((a) => a.is_active && a.is_postable);

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["bank-transactions", companyId] });
    await qc.invalidateQueries({ queryKey: ["banking-counts", companyId] });
    setSelected([]);
  };

  const bulkM = useMutation({
    mutationFn: () =>
      bulkCat({
        data: {
          companyId: companyId!,
          bankTransactionIds: selected,
          offsetAccountId,
        },
      }),
    onSuccess: async (r) => {
      await invalidate();
      toast.success(`Posted ${r.succeeded}; failed ${r.failed}`);
      if (r.failed) {
        const first = r.results.find((x) => !x.ok);
        if (first?.error) toast.error(first.error);
      }
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const excludeM = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const id of selected) {
        await doExclude({ data: { companyId: companyId!, bankTransactionId: id } });
        n += 1;
      }
      return n;
    },
    onSuccess: async (n) => {
      await invalidate();
      toast.success(`Excluded ${n} — no journals created`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Cash coding"
        description="Select multiple uncategorised statement lines and apply one GL account. Each successful row posts one balanced journal via the shared posting engine."
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/banking/transactions" search={{ status: "uncategorised" }}>
              For review
            </Link>
          </Button>
        }
      />

      <Alert className="mb-4">
        <AlertTitle>Accountant workflow</AlertTitle>
        <AlertDescription>
          Preview selection totals before posting. Failures are reported per transaction — already-matched
          or excluded lines are skipped without creating duplicate journals.
        </AlertDescription>
      </Alert>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Select value={bankAccountId} onValueChange={setBankAccountId}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Account" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {((accountsQ.data ?? []) as Array<{ id: string; name: string }>).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={offsetAccountId} onValueChange={setOffsetAccountId}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Offset GL account" />
          </SelectTrigger>
          <SelectContent>
            {offsets.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.code} {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={!selected.length || !offsetAccountId || bulkM.isPending}
          onClick={() => bulkM.mutate()}
        >
          Post selected ({summary.count})
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!selected.length || excludeM.isPending}
          onClick={() => {
            if (confirm(`Exclude ${selected.length} transaction(s) without posting?`)) {
              excludeM.mutate();
            }
          }}
        >
          Exclude selected
        </Button>
      </div>

      <p className="mb-3 text-sm text-muted-foreground">
        Selected {summary.count} · Money in {fromMinorUnits(summary.moneyIn, currency)} · Money out{" "}
        {fromMinorUnits(summary.moneyOut, currency)}
      </p>

      {txnsQ.isPending ? (
        <LoadingState />
      ) : txnsQ.isError ? (
        <ErrorState title="Could not load" description={friendlyAuthError(txnsQ.error)} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing to code" description="No uncategorised transactions." />
      ) : (
        <div className="overflow-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={selected.length > 0 && selected.length === rows.length}
                    onCheckedChange={(on) => setSelected(on ? rows.map((r) => r.id) : [])}
                  />
                </TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.includes(t.id)}
                      onCheckedChange={(on) =>
                        setSelected((prev) =>
                          on ? [...prev, t.id] : prev.filter((id) => id !== t.id),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{t.txn_date}</TableCell>
                  <TableCell>{t.description ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fromMinorUnits(t.amount_minor, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
