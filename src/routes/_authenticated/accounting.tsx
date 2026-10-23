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
  listPeriods,
  lockPeriod,
  unlockPeriod,
} from "@/lib/accounting/accounting.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { ChartAccountsPanel } from "@/components/accounting/ChartAccountsPanel";
import { IndustryCoaPanel } from "@/components/accounting/IndustryCoaPanel";
import { JournalsPanel } from "@/components/accounting/JournalsPanel";
import { ManualJournalPanel } from "@/components/create-new/JournalPanels";

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

export function AccountingWorkspace({
  companyId,
  currency,
}: {
  companyId: string;
  currency: string;
}) {
  const queryClient = useQueryClient();
  const fetchAccounts = useServerFn(listAccounts);
  const fetchPeriods = useServerFn(listPeriods);
  const seedMasters = useServerFn(ensureLedgerMasters);
  const doLock = useServerFn(lockPeriod);
  const doUnlock = useServerFn(unlockPeriod);

  const accountsQuery = useQuery({
    queryKey: ["accounts", companyId],
    queryFn: () => fetchAccounts({ data: { companyId } }),
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
          <ChartAccountsPanel companyId={companyId} currency={currency} />
        </TabsContent>

        <TabsContent value="industry" className="mt-4">
          <IndustryCoaPanel companyId={companyId} />
        </TabsContent>

        <TabsContent value="journals" className="mt-4">
          <JournalsPanel companyId={companyId} currency={currency} />
        </TabsContent>

        <TabsContent value="post" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Manual journal</CardTitle>
            </CardHeader>
            <CardContent className="max-w-4xl">
              <ManualJournalPanel />
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
