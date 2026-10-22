import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  ensureLedgerMasters,
  listAccounts,
  listJournals,
  listPeriods,
  lockPeriod,
  postManualJournal,
  reversePostedJournal,
  unlockPeriod,
} from "@/lib/accounting/accounting.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { IndustryCoaPanel } from "@/components/accounting/IndustryCoaPanel";

export const Route = createFileRoute("/_authenticated/accounting")({
  head: () => ({
    meta: [
      { title: "Accounting — LinkBooks" },
      {
        name: "description",
        content: "Chart of accounts, manual journals and the general ledger in LinkBooks.",
      },
    ],
  }),
  component: Accounting,
});

function Accounting() {
  const { company, isPending } = useActiveCompany();
  if (isPending) return <LoadingState />;
  if (!company) {
    return (
      <EmptyState
        title="No organisation selected"
        description="Create or open an organisation to use the ledger."
      />
    );
  }
  return <AccountingWorkspace companyId={company.id} currency={company.base_currency} />;
}

export function AccountingWorkspace({ companyId, currency }: { companyId: string; currency: string }) {
  const queryClient = useQueryClient();
  const fetchAccounts = useServerFn(listAccounts);
  const fetchJournals = useServerFn(listJournals);
  const fetchPeriods = useServerFn(listPeriods);
  const seedMasters = useServerFn(ensureLedgerMasters);
  const postJournal = useServerFn(postManualJournal);
  const reverseJournal = useServerFn(reversePostedJournal);
  const doLock = useServerFn(lockPeriod);
  const doUnlock = useServerFn(unlockPeriod);

  const accountsQuery = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => fetchAccounts({ data: { companyId } }),
  });
  const journalsQuery = useQuery({
    queryKey: ["journals", companyId],
    queryFn: () => fetchJournals({ data: { companyId } }),
  });
  const periodsQuery = useQuery({
    queryKey: ["periods", companyId],
    queryFn: () => fetchPeriods({ data: { companyId } }),
  });

  const seedMutation = useMutation({
    mutationFn: () => seedMasters({ data: { companyId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["accounts", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["periods", companyId] });
      toast.success("Chart of accounts and periods ready");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [journalDate, setJournalDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [debitAccount, setDebitAccount] = useState("");
  const [creditAccount, setCreditAccount] = useState("");
  const [amountMajor, setAmountMajor] = useState("100.00");

  const postMutation = useMutation({
    mutationFn: async () => {
      const { toMinorUnits } = await import("@/lib/accounting/money");
      const minor = Number(toMinorUnits(amountMajor, currency));
      const idem = `manual:${companyId}:${journalDate}:${debitAccount}:${creditAccount}:${minor}:${Date.now()}`;
      return postJournal({
        data: {
          companyId,
          journalDate,
          memo,
          idempotencyKey: idem,
          lines: [
            { accountId: debitAccount, debitMinor: minor, creditMinor: 0, description: memo },
            { accountId: creditAccount, debitMinor: 0, creditMinor: minor, description: memo },
          ],
        },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journals", companyId] });
      toast.success("Journal posted");
      setMemo("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const reverseMutation = useMutation({
    mutationFn: (journalId: string) => reverseJournal({ data: { journalId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journals", companyId] });
      toast.success("Reversing journal posted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const accounts = accountsQuery.data ?? [];
  const postable = accounts.filter((a) => a.is_active && a.is_postable);

  return (
    <>
      <PageHeader
        title="Accounting"
        description="Authoritative double-entry ledger: chart of accounts, journals, periods and audit-safe posting."
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={seedMutation.isPending}
            onClick={() => seedMutation.mutate()}
          >
            {seedMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Ensure CoA & periods
          </Button>
        }
      />

      <Alert className="mb-6">
        <AlertTitle>Single posting engine</AlertTitle>
        <AlertDescription>
          All posts go through the server/database <code>post_journal</code> RPC (balanced minor
          units, period locks, idempotency). Posted history is immutable — correct via reversal.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="coa">
        <TabsList>
          <TabsTrigger value="coa">Chart of accounts</TabsTrigger>
          <TabsTrigger value="industry">Industry library</TabsTrigger>
          <TabsTrigger value="journals">Journals</TabsTrigger>
          <TabsTrigger value="post">Post manual journal</TabsTrigger>
          <TabsTrigger value="periods">Periods</TabsTrigger>
        </TabsList>

        <TabsContent value="coa" className="mt-4">
          {accountsQuery.isPending ? (
            <LoadingState />
          ) : accountsQuery.isError ? (
            <ErrorState
              title="Could not load accounts"
              description={friendlyAuthError(accountsQuery.error)}
              onRetry={() => accountsQuery.refetch()}
            />
          ) : accounts.length === 0 ? (
            <EmptyState
              title="No chart of accounts"
              description="Seed the default chart for this organisation, then post journals."
              actionLabel="Ensure CoA & periods"
            />
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Section</TableHead>
                      <TableHead>Normal</TableHead>
                      <TableHead>Flags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono text-xs">{a.code}</TableCell>
                        <TableCell>{a.name}</TableCell>
                        <TableCell className="capitalize">{a.account_type}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatAccountSection(a.subtype, a.account_type)}
                        </TableCell>
                        <TableCell className="capitalize">{a.normal_balance}</TableCell>
                        <TableCell className="space-x-1">
                          {a.is_control ? <Badge variant="outline">Control</Badge> : null}
                          {a.is_system ? <Badge variant="secondary">System</Badge> : null}
                          {!a.is_active ? <Badge variant="destructive">Inactive</Badge> : null}
                          {!a.is_postable ? <Badge variant="outline">Non-postable</Badge> : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="industry" className="mt-4">
          <IndustryCoaPanel companyId={companyId} />
        </TabsContent>

        <TabsContent value="journals" className="mt-4">
          {journalsQuery.isPending ? (
            <LoadingState />
          ) : journalsQuery.isError ? (
            <ErrorState
              title="Could not load journals"
              description={friendlyAuthError(journalsQuery.error)}
              onRetry={() => journalsQuery.refetch()}
            />
          ) : (journalsQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="No journals yet"
              description="Post a balanced manual journal to populate the ledger."
            />
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Memo</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(journalsQuery.data ?? []).map((j) => (
                      <TableRow key={j.id}>
                        <TableCell>{j.journal_number}</TableCell>
                        <TableCell>{j.journal_date}</TableCell>
                        <TableCell className="capitalize">{j.status}</TableCell>
                        <TableCell>{j.source_type}</TableCell>
                        <TableCell className="max-w-[240px] truncate">{j.memo ?? "—"}</TableCell>
                        <TableCell>
                          {j.status === "posted" && j.source_type !== "reversal" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={reverseMutation.isPending}
                              onClick={() => reverseMutation.mutate(j.id)}
                            >
                              Reverse
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="post" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Post manual journal</CardTitle>
            </CardHeader>
            <CardContent className="grid max-w-xl gap-4">
              <div className="space-y-2">
                <Label htmlFor="j-date">Posting date</Label>
                <Input
                  id="j-date"
                  type="date"
                  value={journalDate}
                  onChange={(e) => setJournalDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="j-memo">Memo</Label>
                <Input id="j-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Debit account</Label>
                <Select value={debitAccount} onValueChange={setDebitAccount}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {postable.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Credit account</Label>
                <Select value={creditAccount} onValueChange={setCreditAccount}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {postable.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="j-amt">Amount ({currency})</Label>
                <Input
                  id="j-amt"
                  value={amountMajor}
                  onChange={(e) => setAmountMajor(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Stored as integer minor units (e.g. {fromMinorUnits(10000n, currency)} → 10000).
                </p>
              </div>
              <Button
                size="sm"
                disabled={
                  postMutation.isPending || !debitAccount || !creditAccount || debitAccount === creditAccount
                }
                onClick={() => postMutation.mutate()}
              >
                {postMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Post balanced journal
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="periods" className="mt-4">
          {periodsQuery.isPending ? (
            <LoadingState />
          ) : periodsQuery.isError ? (
            <ErrorState
              title="Could not load periods"
              description={friendlyAuthError(periodsQuery.error)}
              onRetry={() => periodsQuery.refetch()}
            />
          ) : (periodsQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="No accounting periods"
              description="Seed default periods for this organisation’s financial year."
            />
          ) : (
            <Card>
              <CardContent className="space-y-3 pt-6">
                {(periodsQuery.data ?? []).map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.start_date} → {p.end_date} · {p.status}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {p.status === "open" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              await doLock({ data: { periodId: p.id } });
                              await periodsQuery.refetch();
                              toast.success("Period locked");
                            } catch (e) {
                              toast.error(friendlyAuthError(e));
                            }
                          }}
                        >
                          Lock
                        </Button>
                      ) : null}
                      {p.status === "locked" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              await doUnlock({ data: { periodId: p.id } });
                              await periodsQuery.refetch();
                              toast.success("Period unlocked");
                            } catch (e) {
                              toast.error(friendlyAuthError(e));
                            }
                          }}
                        >
                          Unlock
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function formatAccountSection(subtype: string | null | undefined, accountType: string): string {
  const s = (subtype ?? "").toLowerCase();
  if (s.includes("non_current") && accountType === "asset") return "Non-current assets";
  if (s.includes("current") && accountType === "asset") return "Current assets";
  if (s.includes("non_current") && accountType === "liability") return "Non-current liabilities";
  if ((s.includes("current") || s.includes("payable") || s.includes("tax")) && accountType === "liability") {
    return "Current liabilities";
  }
  if (accountType === "equity") return "Equity";
  if (accountType === "income") return "Income";
  if (s === "cogs") return "Cost of sales";
  if (accountType === "expense") return "Expenses";
  return accountType;
}
