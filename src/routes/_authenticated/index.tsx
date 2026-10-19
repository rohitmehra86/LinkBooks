import { useEffect, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Wallet, TrendingUp, FileWarning, Landmark } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  ensureDemoSeeded,
  getDemoLedgerSnapshot,
  getDemoModuleStatus,
} from "@/lib/demo/demo.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, EmptyState, LoadingState } from "@/components/common/states";
import { StatCard } from "@/components/common/stat-card";
import { CompanyEmptyState, NO_FIGURE } from "@/components/common/company-empty";
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

function formatMoney(minor: string | undefined, currency: string) {
  if (minor == null) return NO_FIGURE;
  try {
    return `${currency} ${fromMinorUnits(BigInt(minor), currency)}`;
  } catch {
    return NO_FIGURE;
  }
}

function Dashboard() {
  const { company, isPending } = useActiveCompany();
  const companyId = company?.id ?? null;
  const isDemo = Boolean(company?.is_demo);
  const queryClient = useQueryClient();
  const fetchSnap = useServerFn(getDemoLedgerSnapshot);
  const fetchModules = useServerFn(getDemoModuleStatus);
  const doEnsureSeed = useServerFn(ensureDemoSeeded);
  const seedAttempted = useRef<string | null>(null);

  const snapQ = useQuery({
    queryKey: ["ledger-snapshot", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSnap({ data: { companyId: companyId! } }),
  });

  const modulesQ = useQuery({
    queryKey: ["demo-modules"],
    enabled: isDemo,
    queryFn: () => fetchModules(),
  });

  // Auto-seed Demo when ledger is empty (previous seeds failed on period dates)
  useEffect(() => {
    if (!isDemo || !companyId || snapQ.isPending || snapQ.isError) return;
    if ((snapQ.data?.journalLineCount ?? 0) > 0) return;
    if (seedAttempted.current === companyId) return;
    seedAttempted.current = companyId;
    void (async () => {
      try {
        const result = await doEnsureSeed({ data: { companyId } });
        if (result.seeded) {
          toast.success("Demo sample ledger seeded");
          await queryClient.invalidateQueries({ queryKey: ["ledger-snapshot", companyId] });
        }
      } catch (e) {
        toast.error(friendlyAuthError(e));
      }
    })();
  }, [isDemo, companyId, snapQ.isPending, snapQ.isError, snapQ.data?.journalLineCount, doEnsureSeed, queryClient]);

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

  const snap = snapQ.data;
  const currency = snap?.currency ?? company?.base_currency ?? "GBP";
  const hasLedger = (snap?.journalLineCount ?? 0) > 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          isDemo
            ? "Demo Company — sample data only. Totals come from posted journals, not fabricated metrics."
            : "Summary of the selected company from its posted ledger."
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/reports">Reports</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/sales/invoices/new">New invoice</Link>
            </Button>
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
            {snap?.matchesCanonicalDemoExpected
              ? "Canonical demo totals verified against the known dataset."
              : hasLedger
                ? "Ledger present — open Reports to review TB / P&L / BS."
                : "No journals yet — open Settings → Demo and reset to seed sample data."}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Cash in bank"
          value={hasLedger ? formatMoney(snap?.bank, currency) : NO_FIGURE}
          hint={hasLedger ? "Account 1000 from posted journals" : "No posted bank activity"}
          icon={Wallet}
        />
        <StatCard
          label="Receivables"
          value={hasLedger ? formatMoney(snap?.receivables, currency) : NO_FIGURE}
          hint={hasLedger ? "AR control account" : "No invoices posted"}
          icon={TrendingUp}
        />
        <StatCard
          label="Payables"
          value={hasLedger ? formatMoney(snap?.payables, currency) : NO_FIGURE}
          hint={hasLedger ? "AP control account" : "No bills posted"}
          icon={FileWarning}
        />
        <StatCard
          label="Unreconciled items"
          value={snap ? String(snap.unreconciledBankTxns) : NO_FIGURE}
          hint="Bank transactions still uncategorised"
          icon={Landmark}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Ledger snapshot</CardTitle>
            <CardDescription>
              As of {snap?.asOf ?? "—"} · derived from posted journals only
            </CardDescription>
          </CardHeader>
          <CardContent>
            {snapQ.isPending ? (
              <LoadingState rows={3} />
            ) : !hasLedger ? (
              <EmptyState
                title="No posted activity"
                description="Post journals or seed Demo Company to see Trial Balance and P&L here."
              />
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Trial Balance</dt>
                  <dd>
                    {snap?.trialBalanceBalances ? "Balances" : "Out of balance"} · Dr{" "}
                    {formatMoney(snap?.trialBalanceDebit, currency)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Net profit (FY)</dt>
                  <dd>{formatMoney(snap?.netProfit, currency)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Assets</dt>
                  <dd>{formatMoney(snap?.assets, currency)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Liabilities + equity</dt>
                  <dd>
                    {formatMoney(
                      snap
                        ? String(BigInt(snap.liabilities) + BigInt(snap.equity))
                        : undefined,
                      currency,
                    )}{" "}
                    {snap?.equationHolds ? "(equation holds)" : "(check BS)"}
                  </dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{isDemo ? "Module coverage" : "Period close"}</CardTitle>
            <CardDescription>
              {isDemo ? "Honest status of each area in demo" : "Review tasks once periods are active."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isDemo ? (
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
            ) : (
              <EmptyState
                title="No open tasks"
                description="Close checklists appear under Accountant once you use periods."
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
