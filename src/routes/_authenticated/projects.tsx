import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { getProjectProfitability } from "@/lib/projects/projects.functions";
import { budgetUsedPercent, marginPercent, totalsOf } from "@/lib/projects/projects";
import { ProjectPanel } from "@/components/create-new/ProjectPanel";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({ meta: [{ title: "Projects — LinkBooks" }] }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const base = company?.base_currency ?? "GBP";
  const fetchReport = useServerFn(getProjectProfitability);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const query = useQuery({
    queryKey: ["project-profitability", companyId, from, to],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetchReport({ data: { companyId: companyId!, from: from || null, to: to || null } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = query.data?.rows ?? [];
  const totals = totalsOf(rows);
  const money = (n: number) => fromMinorUnits(n, base);

  return (
    <>
      <PageHeader
        title="Projects"
        description={`Profit by project in ${base}, from posted figures. Tag invoices, bills and bank lines to a project from their own screens. Untagged activity is not included.`}
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="pp-from">From</Label>
          <Input id="pp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pp-to">To</Label>
          <Input id="pp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState title="Could not load projects" description={friendlyAuthError(query.error)} />
      ) : !query.data.available ? (
        <Alert className="mb-6">
          <AlertDescription>
            The project report needs a database update that has not been applied yet.
          </AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create one below, then tag documents to it."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Costs</TableHead>
              <TableHead className="text-right">Profit</TableHead>
              <TableHead className="text-right">Margin</TableHead>
              <TableHead className="text-right">Budget used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const margin = marginPercent(r);
              const used = budgetUsedPercent(r);
              return (
                <TableRow key={r.projectId}>
                  <TableCell>
                    {r.code} — {r.name}
                    {r.unconvertedDocuments > 0 ? (
                      <span className="block text-xs text-destructive">
                        {r.unconvertedDocuments} foreign-currency document
                        {r.unconvertedDocuments === 1 ? "" : "s"} left out: no exchange rate stored.
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.status.replace(/_/g, " ")}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{money(r.revenueMinor)}</TableCell>
                  <TableCell className="text-right font-mono">{money(r.costMinor)}</TableCell>
                  <TableCell className="text-right font-mono">{money(r.profitMinor)}</TableCell>
                  <TableCell className="text-right">
                    {margin === null ? "—" : `${margin}%`}
                  </TableCell>
                  <TableCell className="text-right">{used === null ? "—" : `${used}%`}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={2}>Total</TableCell>
              <TableCell className="text-right font-mono">{money(totals.revenueMinor)}</TableCell>
              <TableCell className="text-right font-mono">{money(totals.costMinor)}</TableCell>
              <TableCell className="text-right font-mono">{money(totals.profitMinor)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </TableFooter>
        </Table>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Revenue and costs use net amounts (before tax) of authorised documents, less credit notes.
        Bank lines and Create-New documents tagged to a project count their income and expense
        postings. Drafts and voided documents are excluded.{" "}
        <Link to="/reports" className="underline">
          All reports
        </Link>
      </p>

      <div className="mt-8 max-w-md">
        <h2 className="mb-2 text-lg font-semibold">New project</h2>
        <ProjectPanel />
      </div>
    </>
  );
}
