import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useFormat } from "@/hooks/use-format";
import { listExpenses } from "@/lib/purchases/purchases.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, ListSkeleton, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { TableCard } from "@/components/common/table-card";
import { StatusBadge } from "@/components/common/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/purchases/expenses/")({
  head: () => ({ meta: [{ title: "Expenses — LinkBooks" }] }),
  component: ExpensesList,
});

function ExpensesList() {
  const { company } = useActiveCompany();
  const fmt = useFormat();
  const fetchExpenses = useServerFn(listExpenses);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const query = useQuery({
    queryKey: ["expenses", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchExpenses({ data: { companyId: companyId! } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Direct expenses"
        description="Paid immediately from a bank/cash account — not supplier bills on AP. Distinct from employee claims."
        actions={
          <Button size="sm" asChild>
            <Link to="/purchases/expenses/new">New expense</Link>
          </Button>
        }
      />
      {query.isPending ? (
        <ListSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="Could not load expenses"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No expenses" description="Record a direct expense paid from bank." />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Payee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(
                query.data as Array<{
                  id: string;
                  expense_date: string;
                  payee_name: string;
                  status: string;
                  total_minor: number;
                }>
              ).map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link
                      className="hover:underline"
                      to="/purchases/expenses/$expenseId"
                      params={{ expenseId: e.id }}
                    >
                      {fmt.date(e.expense_date)}
                    </Link>
                  </TableCell>
                  <TableCell>{e.payee_name}</TableCell>
                  <TableCell>
                    <StatusBadge status={e.status} />
                  </TableCell>
                  <TableCell className="money">{fmt.money(e.total_minor, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
    </>
  );
}
