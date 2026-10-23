import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { ensureLedgerMasters } from "@/lib/accounting/accounting.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, EmptyState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartAccountsPanel } from "@/components/accounting/ChartAccountsPanel";
import { FinancialYearsPanel } from "@/components/accounting/FinancialYearsPanel";
import { IndustryCoaPanel } from "@/components/accounting/IndustryCoaPanel";
import { JournalsPanel } from "@/components/accounting/JournalsPanel";
import { PeriodClosePanel } from "@/components/accounting/PeriodClosePanel";
import { ManualJournalPanel } from "@/components/create-new/JournalPanels";

const ACCOUNTING_TABS = ["coa", "industry", "journals", "post", "periods", "close"] as const;
type AccountingTab = (typeof ACCOUNTING_TABS)[number];
type AccountingSearch = { tab?: AccountingTab | undefined; journal?: string | undefined };

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
  // `tab` and `journal` make report drill-downs, search hits and dashboard tasks deep-linkable.
  validateSearch: (raw: Record<string, unknown>): AccountingSearch => {
    const tab = raw["tab"];
    const journal = raw["journal"];
    return {
      tab: ACCOUNTING_TABS.find((t) => t === tab),
      journal: typeof journal === "string" && journal ? journal : undefined,
    };
  },
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
  const navigate = useNavigate({ from: "/accounting" });
  const search = Route.useSearch();
  const seedMasters = useServerFn(ensureLedgerMasters);
  const tab: AccountingTab = search.tab ?? (search.journal ? "journals" : "coa");

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
        description="Authoritative double-entry ledger: chart of accounts, journals, financial years and period close."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/recurring-journals">Recurring journals</Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={seedMutation.isPending}
              onClick={() => seedMutation.mutate()}
            >
              {seedMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Ensure CoA & periods
            </Button>
          </div>
        }
      />

      <Alert className="mb-6">
        <AlertTitle>Single posting engine</AlertTitle>
        <AlertDescription>
          All posts go through the server/database <code>post_journal</code> RPC (balanced minor
          units, period locks, idempotency). Posted history is immutable — correct via reversal.
        </AlertDescription>
      </Alert>

      <Tabs
        value={tab}
        onValueChange={(v) =>
          void navigate({
            search: { tab: v as AccountingTab },
            replace: true,
          })
        }
      >
        <TabsList className="flex-wrap">
          <TabsTrigger value="coa">Chart of accounts</TabsTrigger>
          <TabsTrigger value="industry">Industry library</TabsTrigger>
          <TabsTrigger value="journals">Journals</TabsTrigger>
          <TabsTrigger value="post">Post manual journal</TabsTrigger>
          <TabsTrigger value="periods">Financial years</TabsTrigger>
          <TabsTrigger value="close">Period close</TabsTrigger>
        </TabsList>

        <TabsContent value="coa" className="mt-4">
          <ChartAccountsPanel companyId={companyId} currency={currency} />
        </TabsContent>

        <TabsContent value="industry" className="mt-4">
          <IndustryCoaPanel companyId={companyId} />
        </TabsContent>

        <TabsContent value="journals" className="mt-4">
          <JournalsPanel
            companyId={companyId}
            currency={currency}
            initialOpenJournalId={search.journal}
          />
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
          <FinancialYearsPanel companyId={companyId} />
        </TabsContent>

        <TabsContent value="close" className="mt-4">
          <PeriodClosePanel companyId={companyId} />
        </TabsContent>
      </Tabs>
    </>
  );
}
