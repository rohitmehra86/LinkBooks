import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getReportById } from "@/lib/reports/catalog";
import { parseReportSearch, type ReportSearch } from "@/lib/reports/search";
import { fiscalYearStart, todayIso } from "@/lib/accounting/fiscal-year";
import { ReportShellFallbackLink } from "@/components/reports/ReportFallback";
import type { ReportCtx } from "@/components/reports/ReportShell";
import {
  AccountTransactionsView,
  AgedView,
  AuditView,
  GeneralLedgerAllView,
  JournalReportView,
  TaxSummaryView,
} from "@/components/reports/LedgerViews";
import {
  BalanceSheetView,
  CashFlowView,
  EquityView,
  ProfitLossView,
  TrialBalanceView,
} from "@/components/reports/StatementViews";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingState, PageHeader } from "@/components/common/states";

export const Route = createFileRoute("/_authenticated/reports/$reportId")({
  validateSearch: (raw: Record<string, unknown>): ReportSearch => parseReportSearch(raw),
  head: ({ params }) => {
    const report = getReportById(params.reportId);
    return {
      meta: [
        { title: `${report?.title ?? "Report"} — LinkBooks` },
        {
          name: "description",
          content: report?.description ?? "Financial report from the posted ledger.",
        },
      ],
    };
  },
  component: ReportPage,
});

function ReportPage() {
  const { reportId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { company, isPending } = useActiveCompany();
  const report = getReportById(reportId);

  const today = useMemo(() => todayIso(), []);
  const defaultFrom = company
    ? fiscalYearStart(today, company.fiscal_year_end_month, company.fiscal_year_end_day ?? 28)
    : today;

  if (isPending) return <LoadingState />;
  if (!company) {
    return (
      <EmptyState
        title="No organisation selected"
        description="Open an organisation to run ledger reports."
      />
    );
  }

  if (!report) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Report not found"
          description={`No catalogue entry for “${reportId}”.`}
        />
        <Button asChild variant="outline">
          <Link to="/reports">Back to Reports Centre</Link>
        </Button>
      </div>
    );
  }

  if (report.runner === "link" && report.linkTo) {
    return <ReportShellFallbackLink report={report} />;
  }

  if (report.status !== "ready" || report.runner === "none") {
    return (
      <div className="space-y-4">
        <PageHeader title={report.title} description={report.description} />
        <Alert>
          <AlertTitle>Not available yet</AlertTitle>
          <AlertDescription>
            {report.dependency ?? "This report depends on a module that is not implemented."}
          </AlertDescription>
        </Alert>
        <Button asChild variant="outline">
          <Link to="/reports">Back to Reports Centre</Link>
        </Button>
      </div>
    );
  }

  const ctx: ReportCtx = {
    companyId: company.id,
    companyName: company.name,
    currency: company.base_currency,
    from: search.from ?? defaultFrom,
    to: search.to ?? today,
    search,
    setSearch: (patch) => {
      void navigate({
        search: (prev: ReportSearch) => {
          const next: Record<string, unknown> = { ...prev, ...patch };
          for (const k of Object.keys(next))
            if (next[k] === undefined || next[k] === "") delete next[k];
          return parseReportSearch(next);
        },
        replace: true,
      });
    },
  };

  switch (report.runner) {
    case "trial_balance":
      return <TrialBalanceView ctx={ctx} />;
    case "profit_loss":
      return <ProfitLossView ctx={ctx} />;
    case "balance_sheet":
      return <BalanceSheetView ctx={ctx} />;
    case "cash_flow":
      return <CashFlowView ctx={ctx} />;
    case "equity":
      return <EquityView ctx={ctx} />;
    case "general_ledger":
      return <AccountTransactionsView ctx={ctx} />;
    case "general_ledger_all":
      return <GeneralLedgerAllView ctx={ctx} />;
    case "journals":
      return <JournalReportView ctx={ctx} />;
    case "aged_receivables":
      return <AgedView ctx={ctx} kind="ar" />;
    case "aged_payables":
      return <AgedView ctx={ctx} kind="ap" />;
    case "tax":
      return <TaxSummaryView ctx={ctx} />;
    case "audit":
      return <AuditView ctx={ctx} />;
    default:
      return <EmptyState title="Report unavailable" description="This report has no runner." />;
  }
}
