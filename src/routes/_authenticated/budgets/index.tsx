import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCanDo } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { fiscalYearStart, todayIso } from "@/lib/accounting/fiscal-year";
import { deleteBudget, listBudgets, saveBudget } from "@/lib/budgets/budgets.functions";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/budgets/")({
  head: () => ({ meta: [{ title: "Budgets — LinkBooks" }] }),
  component: BudgetsPage,
});

function BudgetsPage() {
  const { company } = useActiveCompany();
  const fmt = useFormat();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = useCanDo("accounts.manage");
  const listFn = useServerFn(listBudgets);
  const saveFn = useServerFn(saveBudget);
  const deleteFn = useServerFn(deleteBudget);
  const companyId = company?.id;

  const defaultStart = useMemo(
    () =>
      company
        ? fiscalYearStart(
            todayIso(),
            company.fiscal_year_end_month,
            company.fiscal_year_end_day ?? 28,
          )
        : todayIso(),
    [company],
  );
  const [name, setName] = useState("");
  const [start, setStart] = useState<string | null>(null);
  const fyStart = start ?? defaultStart;

  const query = useQuery({
    queryKey: ["budgets", companyId],
    enabled: Boolean(companyId),
    queryFn: () => listFn({ data: { companyId: companyId! } }),
  });

  const create = useMutation({
    mutationFn: () =>
      saveFn({ data: { companyId: companyId!, name: name.trim(), fiscalYearStart: fyStart } }),
    onSuccess: async ({ id }) => {
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["budgets", companyId] });
      toast.success("Budget created");
      void navigate({ to: "/budgets/$budgetId", params: { budgetId: id } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const remove = useMutation({
    mutationFn: (budgetId: string) => deleteFn({ data: { companyId: companyId!, budgetId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["budgets", companyId] });
      toast.success("Budget deleted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Plan income and expenses by account and month for a financial year, then compare with actuals."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/reports/$reportId" params={{ reportId: "budget-vs-actual" }}>
              Budget versus Actual report
            </Link>
          </Button>
        }
      />

      <div className="mb-6 grid max-w-xl gap-3 rounded-md border border-border p-4">
        <div className="space-y-2">
          <Label htmlFor="budget-name">Name</Label>
          <Input
            id="budget-name"
            value={name}
            placeholder="e.g. FY budget"
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="budget-start">Financial year starts</Label>
          <Input
            id="budget-start"
            type="date"
            value={fyStart}
            onChange={(e) => e.target.value && setStart(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The budget covers the twelve months from the month this date falls in. It cannot be
            changed once amounts are entered.
          </p>
        </div>
        <Button
          size="sm"
          disabled={create.isPending || name.trim().length < 1 || !canManage}
          title={canManage ? undefined : "You do not have permission to manage budgets"}
          onClick={() => create.mutate()}
        >
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Create budget
        </Button>
      </div>

      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load budgets"
          description={friendlyAuthError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : !query.data.available ? (
        <Alert>
          <AlertDescription>
            Budgets are not available yet: the database update that adds them has not been applied.
          </AlertDescription>
        </Alert>
      ) : query.data.budgets.length === 0 ? (
        <EmptyState
          title="No budgets yet"
          description="Create your first budget above, then fill in the monthly amounts."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Financial year from</TableHead>
              <TableHead>Last changed</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.budgets.map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <Link
                    to="/budgets/$budgetId"
                    params={{ budgetId: b.id }}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {b.name}
                  </Link>
                </TableCell>
                <TableCell>{fmt.date(b.fiscal_year_start)}</TableCell>
                <TableCell>{fmt.dateTime(b.updated_at)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${b.name}`}
                    disabled={!canManage || remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete budget "${b.name}" and all its amounts?`)) {
                        remove.mutate(b.id);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
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
