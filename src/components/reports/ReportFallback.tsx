import { Link } from "@tanstack/react-router";
import type { ReportDef } from "@/lib/reports/catalog";
import { PageHeader } from "@/components/common/states";
import { Button } from "@/components/ui/button";

/** Reports that already exist as a dedicated screen elsewhere: one click through, no fake runner. */
export function ReportShellFallbackLink({ report }: { report: ReportDef }) {
  if (!report.linkTo) return null;
  return (
    <div className="space-y-4">
      <PageHeader title={report.title} description={report.description} />
      <Button asChild>
        <Link to={report.linkTo}>Open</Link>
      </Button>
      <Button asChild variant="outline">
        <Link to="/reports">Back to Reports Centre</Link>
      </Button>
    </div>
  );
}
