import { useEffect, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  ensureDemoSeeded,
  getDemoLedgerSnapshot,
  getDemoModuleStatus,
} from "@/lib/demo/demo.functions";
import { getDashboardSnapshot } from "@/lib/dashboard/dashboard.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, ErrorState, LoadingState, CardGridSkeleton } from "@/components/common/states";
import { CompanyEmptyState } from "@/components/common/company-empty";
import {
  AgeingWidget,
  ApprovalsWidget,
  BankAccountsWidget,
  CashFlowWidget,
  GettingStarted,
  KpiRow,
  ProfitWidget,
  QuickActions,
  ReconcileAction,
  TasksWidget,
  WatchlistWidget,
} from "@/components/dashboard/DashboardWidgets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Dashboard — LinkBooks" },
      {
        name: "description",
        content: "Cash position, receivables, payables and recent activity in LinkBooks.",
      },
      { property: "og:title", content: "Dashboard — LinkBooks" },
      {
        property: "og:description",
        content: "Cash position, receivables, payables and recent activity in LinkBooks.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { company, isPending } = useActiveCompany();
  const companyId = company?.id ?? null;
  const isDemo = Boolean(company?.is_demo);
  const queryClient = useQueryClient();
  const fetchDashboard = useServerFn(getDashboardSnapshot);
  // The canonical demo snapshot is kept only to verify the demo dataset and to auto-seed it.
  const fetchDemoSnap = useServerFn(getDemoLedgerSnapshot);
  const fetchModules = useServerFn(getDemoModuleStatus);
  const doEnsureSeed = useServerFn(ensureDemoSeeded);
  const seedAttempted = useRef<string | null>(null);

  const dashQ = useQuery({
    queryKey: ["dashboard-snapshot", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchDashboard({ data: { companyId: companyId! } }),
  });

  const demoSnapQ = useQuery({
    queryKey: ["ledger-snapshot", companyId],
    enabled: Boolean(companyId) && isDemo,
    queryFn: () => fetchDemoSnap({ data: { companyId: companyId! } }),
  });

  const modulesQ = useQuery({
    queryKey: ["demo-modules"],
    enabled: isDemo,
    queryFn: () => fetchModules(),
  });

  // Auto-seed Demo when its ledger is empty (previous seeds failed on period dates)
  useEffect(() => {
    if (!isDemo || !companyId || demoSnapQ.isPending || demoSnapQ.isError) return;
    if ((demoSnapQ.data?.journalLineCount ?? 0) > 0) return;
    if (seedAttempted.current === companyId) return;
    seedAttempted.current = companyId;
    void (async () => {
      try {
        const result = await doEnsureSeed({ data: { companyId } });
        if (result.seeded) {
          toast.success("Demo sample ledger seeded");
          await queryClient.invalidateQueries({ queryKey: ["ledger-snapshot", companyId] });
          await queryClient.invalidateQueries({ queryKey: ["dashboard-snapshot", companyId] });
        }
      } catch (e) {
        toast.error(friendlyAuthError(e));
      }
    })();
  }, [
    isDemo,
    companyId,
    demoSnapQ.isPending,
    demoSnapQ.isError,
    demoSnapQ.data?.journalLineCount,
    doEnsureSeed,
    queryClient,
  ]);

  if (isPending) return <LoadingState />;
  if (!companyId) {
    return (
      <>
        <PageHeader title="Dashboard" description="Select or create an organisation to begin." />
        <CompanyEmptyState
          title="No organisation selected"
          description="Create a company or open Demo Company from the switcher."
        />
      </>
    );
  }

  const data = dashQ.data;
  const demoSnap = demoSnapQ.data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          isDemo
            ? "Demo Company — sample data only. Every figure is read from the posted ledger and your documents."
            : "Where your money stands today, from your posted ledger and documents."
        }
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/reports">Reports</Link>
            </Button>
            {data ? <ReconcileAction data={data} /> : null}
            <QuickActions />
          </>
        }
      />

      {isDemo ? (
        <Alert className="mb-6 border-warning/40 bg-warning/10">
          <AlertTitle className="flex items-center gap-2">
            <Badge variant="outline">Demo Company</Badge>
            Sample data — not real financial records
          </AlertTitle>
          <AlertDescription>
            Same database structure, posting engine and permissions as live organisations. Reset /
            reseed from Settings → Demo.{" "}
            {demoSnap?.matchesCanonicalDemoExpected
              ? "Canonical demo totals verified against the known dataset."
              : (demoSnap?.journalLineCount ?? 0) > 0
                ? "Ledger present — open Reports to review TB / P&L / BS."
                : "No journals yet — open Settings → Demo and reset to seed sample data."}
          </AlertDescription>
        </Alert>
      ) : null}

      {dashQ.isPending ? (
        <div className="space-y-6">
          <CardGridSkeleton />
          <LoadingState rows={6} />
        </div>
      ) : dashQ.isError ? (
        <ErrorState
          title="Could not load the dashboard"
          description={friendlyAuthError(dashQ.error)}
          onRetry={() => void dashQ.refetch()}
        />
      ) : data ? (
        <div className="space-y-6">
          <GettingStarted data={data} />
          <KpiRow data={data} />
          <div className="grid gap-6 lg:grid-cols-3">
            <CashFlowWidget data={data} />
            <BankAccountsWidget data={data} />
            <AgeingWidget kind="receivables" data={data} />
            <AgeingWidget kind="payables" data={data} />
            <ProfitWidget data={data} />
            <ApprovalsWidget data={data} />
            <WatchlistWidget data={data} />
            <TasksWidget data={data} />
            {isDemo ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Module coverage</CardTitle>
                  <CardDescription>Honest status of each area in demo</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
                    {(modulesQ.data?.modules ?? []).map((m) => (
                      <li key={m.path} className="flex items-start justify-between gap-2">
                        <Link className="underline-offset-2 hover:underline" to={m.path}>
                          {m.label}
                        </Link>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {m.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
