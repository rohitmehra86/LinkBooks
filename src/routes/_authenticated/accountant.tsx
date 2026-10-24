import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getAccountantChecklist } from "@/lib/accountant/accountant.functions";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { postTaxAdjustment } from "@/lib/tax/tax.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { AccountLookup } from "@/components/lookup";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Alert, AlertDescription } from "@/components/ui/alert";

export const Route = createFileRoute("/_authenticated/accountant")({
  head: () => ({
    meta: [{ title: "Accountant tools — LinkBooks" }],
  }),
  component: AccountantTools,
});

function AccountantTools() {
  const { company, isPending } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetch = useServerFn(getAccountantChecklist);
  const fetchAccounts = useServerFn(listAccounts);
  const doAdjust = useServerFn(postTaxAdjustment);

  const query = useQuery({
    queryKey: ["accountant-checklist", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetch({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const [adjDate, setAdjDate] = useState(today);
  const [taxAcc, setTaxAcc] = useState("");
  const [offsetAcc, setOffsetAcc] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"increase_payable" | "decrease_payable">(
    "increase_payable",
  );
  const [adjKey, setAdjKey] = useState(`adj-${today}`);
  const [memo, setMemo] = useState("");

  const adjustM = useMutation({
    mutationFn: () =>
      doAdjust({
        data: {
          companyId: companyId!,
          journalDate: adjDate,
          taxAccountId: taxAcc,
          offsetAccountId: offsetAcc,
          amountMinor: Number(toMinorUnits(amount || "0", currency)),
          direction,
          adjustmentKey: adjKey,
          currencyCode: currency,
          memo,
        },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["accountant-checklist", companyId] });
      toast.success(`Tax adjustment posted (journal ${r.journalId.slice(0, 8)}…)`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (isPending) return <LoadingState />;
  if (!companyId) {
    return (
      <EmptyState
        title="No organisation"
        description="Select a client organisation to review period-end readiness."
      />
    );
  }

  const accounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter((a) => a.is_active && a.is_postable);

  return (
    <>
      <PageHeader
        title="Accountant tools"
        description="Period-end checklist, journal review, reconciliation queues and tax adjustments."
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState title="Could not load checklist" description={friendlyAuthError(query.error)} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CheckCard
              title="Unlocked periods"
              count={query.data!.unlockedPeriods}
              href="/accounting"
            />
            <CheckCard
              title="Draft invoices"
              count={query.data!.draftInvoices}
              href="/sales/invoices"
            />
            <CheckCard title="Draft bills" count={query.data!.draftBills} href="/purchases/bills" />
            <CheckCard
              title="Uncategorised bank"
              count={query.data!.uncategorisedBank}
              href="/banking/transactions"
            />
            <CheckCard
              title="Matched, not reconciled"
              count={query.data!.matchedAwaitingReconcile}
              href="/banking/reconcile"
            />
            <CheckCard
              title="Open recon sessions"
              count={query.data!.openReconciliationSessions}
              href="/banking/reconcile"
            />
          </div>

          <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">
            Tax adjustment (period-end)
          </h2>
          <Alert className="mb-3">
            <AlertDescription>
              Posts a single balanced <code>tax_adjustment</code> journal via the shared posting
              engine. Idempotent by adjustment key. Not a filed return.
            </AlertDescription>
          </Alert>
          <div className="mb-8 grid max-w-xl gap-3 rounded-md border p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Date</Label>
                <Input type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Idempotency key</Label>
                <Input value={adjKey} onChange={(e) => setAdjKey(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Tax control account</Label>
              <AccountLookup
                ariaLabel="Tax control account"
                accounts={accounts}
                value={taxAcc}
                onChange={setTaxAcc}
                companyId={companyId}
                placeholder="e.g. 2100 Tax Payable"
                allowClear={false}
              />
            </div>
            <div className="space-y-1">
              <Label>Offset account</Label>
              <AccountLookup
                ariaLabel="Offset account"
                accounts={accounts}
                value={offsetAcc}
                onChange={setOffsetAcc}
                companyId={companyId}
                placeholder="Expense / equity"
                allowClear={false}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Amount</Label>
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1">
                <Label>Direction</Label>
                <Select
                  value={direction}
                  onValueChange={(v) => setDirection(v as typeof direction)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="increase_payable">Increase tax payable</SelectItem>
                    <SelectItem value="decrease_payable">Decrease tax payable</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Memo</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
            <Button
              size="sm"
              disabled={adjustM.isPending || !taxAcc || !offsetAcc || !amount}
              onClick={() => adjustM.mutate()}
            >
              Post tax adjustment
            </Button>
          </div>

          <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">Recent journals</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Memo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(
                query.data!.recentJournals as Array<{
                  id: string;
                  journal_number: number;
                  journal_date: string;
                  status: string;
                  source_type: string;
                  memo: string | null;
                }>
              ).map((j) => (
                <TableRow key={j.id}>
                  <TableCell>{j.journal_number}</TableCell>
                  <TableCell>{j.journal_date}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{j.status}</Badge>
                  </TableCell>
                  <TableCell>{j.source_type}</TableCell>
                  <TableCell>{j.memo ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/reports">Open reports</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/firm">Firm &amp; clients</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/tax">Tax configuration</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/accounting">Lock periods</Link>
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function CheckCard({ title, count, href }: { title: string; count: number; href: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <span className="text-2xl font-semibold">{count}</span>
        <Button size="sm" variant="outline" asChild>
          <Link to={href}>Review</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
