import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  QUICK_REPORT_IDS,
  REPORT_CATALOG,
  REPORT_CATEGORIES,
  searchReports,
  type ReportCategoryId,
} from "@/lib/reports/catalog";
import { PageHeader, EmptyState, LoadingState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/reports/")({
  head: () => ({
    meta: [
      { title: "Reports Centre — LinkBooks" },
      {
        name: "description",
        content: "Searchable catalogue of financial and operational reports from the posted ledger.",
      },
    ],
  }),
  component: ReportsCentre,
});

function ReportsCentre() {
  const { company, isPending } = useActiveCompany();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ReportCategoryId | "all">("all");

  const filtered = useMemo(() => {
    let rows = searchReports(q);
    if (category !== "all") rows = rows.filter((r) => r.category === category);
    return rows;
  }, [q, category]);

  const readyCount = REPORT_CATALOG.filter((r) => r.status === "ready").length;

  if (isPending) return <LoadingState />;
  if (!company) {
    return (
      <EmptyState
        title="No organisation selected"
        description="Open an organisation to use the Reports Centre."
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports Centre"
        description={`Professional financial reports for ${company.name}. ${readyCount} operational reports — dependent modules are labelled honestly, never faked.`}
      />

      <div className="flex flex-wrap gap-2">
        {QUICK_REPORT_IDS.map((id) => {
          const r = REPORT_CATALOG.find((x) => x.id === id);
          if (!r) return null;
          return (
            <Button key={id} asChild variant="secondary" size="sm">
              <Link to="/reports/$reportId" params={{ reportId: id }}>
                {r.title}
              </Link>
            </Button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-2">
          <Label htmlFor="report-search">Search reports</Label>
          <Input
            id="report-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Profit and loss, aged receivables, tax…"
          />
        </div>
        <div className="w-full space-y-2 sm:w-64">
          <Label>Category</Label>
          <select
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as ReportCategoryId | "all")}
          >
            <option value="all">All categories</option>
            {REPORT_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((report) => (
          <Card key={report.id} className={report.status === "depends" ? "opacity-90" : undefined}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">{report.title}</CardTitle>
                <Badge variant={report.status === "ready" ? "secondary" : "outline"}>
                  {report.status === "ready" ? "Ready" : "Depends"}
                </Badge>
              </div>
              <CardDescription>{report.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {REPORT_CATEGORIES.find((c) => c.id === report.category)?.label}
              </p>
              {report.status === "depends" ? (
                <p className="text-sm text-amber-700 dark:text-amber-400">{report.dependency}</p>
              ) : (
                <Button asChild size="sm">
                  <Link to="/reports/$reportId" params={{ reportId: report.id }}>
                    Open report
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No matching reports"
          description="Try another search term or clear the category filter."
        />
      ) : null}
    </div>
  );
}
