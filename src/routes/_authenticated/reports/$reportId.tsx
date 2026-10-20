import { createFileRoute, Link } from "@tanstack/react-router";
import {
  FinancialReportsWorkspace,
  type ReportTabId,
} from "@/components/reports/FinancialReportsWorkspace";
import { getReportById } from "@/lib/reports/catalog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/states";

const RUNNER_TO_TAB: Record<string, ReportTabId> = {
  trial_balance: "tb",
  profit_loss: "pl",
  balance_sheet: "bs",
  general_ledger: "gl",
  cash_flow: "cf",
  aged_receivables: "ar",
  aged_payables: "ap",
  journals: "journals",
  tax: "tax",
  audit: "audit",
};

export const Route = createFileRoute("/_authenticated/reports/$reportId")({
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
  const report = getReportById(reportId);

  if (!report) {
    return (
      <div className="space-y-4">
        <PageHeader title="Report not found" description={`No catalogue entry for “${reportId}”.`} />
        <Button asChild variant="outline">
          <Link to="/reports">Back to Reports Centre</Link>
        </Button>
      </div>
    );
  }

  if (report.status !== "ready" || report.runner === "none") {
    return (
      <div className="space-y-4">
        <PageHeader title={report.title} description={report.description} />
        <Alert>
          <AlertTitle>Not available yet</AlertTitle>
          <AlertDescription>{report.dependency ?? "This report depends on a module that is not implemented."}</AlertDescription>
        </Alert>
        <Button asChild variant="outline">
          <Link to="/reports">Back to Reports Centre</Link>
        </Button>
      </div>
    );
  }

  const tab = RUNNER_TO_TAB[report.runner] ?? "tb";

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        <Link to="/reports" className="underline-offset-4 hover:underline">
          Reports Centre
        </Link>
        {" / "}
        {report.title}
      </p>
      <FinancialReportsWorkspace initialTab={tab} />
    </div>
  );
}
