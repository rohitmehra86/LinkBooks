import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCanDo } from "@/hooks/use-can";
import {
  listRecurringJournals,
  runDueRecurringJournals,
  setRecurringJournalActive,
  type RecurringJournalRow,
} from "@/lib/create-new/recurring-journals.functions";
import { generateRecurringJournal } from "@/lib/create-new/money-documents.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/recurring-journals")({
  head: () => ({ meta: [{ title: "Recurring journals — LinkBooks" }] }),
  component: RecurringJournalsPage,
});

function everyLabel(months: number) {
  if (months === 1) return "Monthly";
  if (months === 3) return "Quarterly";
  if (months === 12) return "Yearly";
  return `Every ${months} months`;
}

function RecurringJournalsPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const qc = useQueryClient();
  const canPost = useCanDo("journals.manual");
  const list = useServerFn(listRecurringJournals);
  const runDue = useServerFn(runDueRecurringJournals);
  const postNow = useServerFn(generateRecurringJournal);
  const setActive = useServerFn(setRecurringJournalActive);

  const query = useQuery({
    queryKey: ["recurring-journals", companyId],
    enabled: Boolean(companyId),
    queryFn: () => list({ data: { companyId: companyId! } }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["recurring-journals", companyId] });

  const runMutation = useMutation({
    mutationFn: () => runDue({ data: { companyId: companyId! } }),
    onSuccess: async (r) => {
      await refresh();
      await qc.invalidateQueries({ queryKey: ["journals", companyId] });
      if (r.failed.length > 0) {
        toast.error(`${r.posted} posted, ${r.failed.length} failed: ${r.failed[0]!.message}`);
      } else {
        toast.success(r.posted === 0 ? "Nothing is due" : `${r.posted} journal(s) posted`);
      }
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const nowMutation = useMutation({
    mutationFn: (templateId: string) => postNow({ data: { companyId: companyId!, templateId } }),
    onSuccess: async (r) => {
      await refresh();
      toast.success(`Journal posted for ${r.occurrenceDate}`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const activeMutation = useMutation({
    mutationFn: (v: { templateId: string; active: boolean }) =>
      setActive({ data: { companyId: companyId!, ...v } }),
    onSuccess: refresh,
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = (query.data ?? []) as RecurringJournalRow[];
  const today = new Date().toISOString().slice(0, 10);
  const dueCount = rows.filter((r) => r.is_active && r.next_date <= today).length;

  return (
    <>
      <PageHeader
        title="Recurring journals"
        description="Manual journals that repeat on a schedule (rent, depreciation, accruals)."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/accounting">Accounting</Link>
            </Button>
            <Button
              size="sm"
              disabled={!canPost || runMutation.isPending || dueCount === 0}
              onClick={() => runMutation.mutate()}
            >
              {runMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Run due now{dueCount > 0 ? ` (${dueCount})` : ""}
            </Button>
          </div>
        }
      />
      <Alert className="mb-4">
        <AlertTitle>Scheduling</AlertTitle>
        <AlertDescription>
          Journals are only posted when you press “Run due now” or when a scheduler calls the
          database function <code>process_all_due_recurring_journals</code> (daily via pg_cron or
          the cron endpoint). Nothing runs on its own until a scheduler is enabled. Every occurrence
          posts through the normal posting engine and cannot post twice.
        </AlertDescription>
      </Alert>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load recurring journals"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No recurring journals"
          description="Create one from Create new → Recurring journal."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Repeats</TableHead>
              <TableHead>Next date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Posted</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="font-medium">{r.name}</div>
                  {r.last_error ? (
                    <div className="text-xs text-destructive">Last run failed: {r.last_error}</div>
                  ) : null}
                </TableCell>
                <TableCell>{everyLabel(r.interval_months)}</TableCell>
                <TableCell>
                  {r.next_date}
                  {r.is_active && r.next_date <= today ? (
                    <Badge variant="outline" className="ml-2">
                      Due
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(BigInt(r.total_debit_minor), currency)}
                </TableCell>
                <TableCell>
                  {r.occurrences}
                  {r.max_occurrences ? ` / ${r.max_occurrences}` : ""}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{r.is_active ? "Active" : "Paused / ended"}</Badge>
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canPost || !r.is_active || nowMutation.isPending}
                    onClick={() => nowMutation.mutate(r.id)}
                  >
                    Post next now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canPost || activeMutation.isPending}
                    onClick={() =>
                      activeMutation.mutate({ templateId: r.id, active: !r.is_active })
                    }
                  >
                    {r.is_active ? "Pause" : "Resume"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
