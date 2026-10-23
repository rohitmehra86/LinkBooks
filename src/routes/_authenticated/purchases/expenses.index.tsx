import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listExpenses } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { ListToolbar, useListSearch } from "@/components/common/ListTools";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ExpenseRow = {
  id: string;
  expense_date: string;
  payee_name: string;
  status: string;
  total_minor: number;
};

export const Route = createFileRoute("/_authenticated/purchases/expenses/")({
  head: () => ({ meta: [{ title: "Expenses — LinkBooks" }] }),
  component: ExpensesList,
});

function ExpensesList() {
  const { company } = useActiveCompany();
  const fetchExpenses = useServerFn(listExpenses);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const query = useQuery({
    queryKey: ["expenses", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchExpenses({ data: { companyId: companyId! } }),
  });
  const rows = (query.data ?? []) as ExpenseRow[];
  const list = useListSearch(rows, (e) => `${e.expense_date} ${e.payee_name} ${e.status}`);

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
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load expenses"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No expenses" description="Record a direct expense paid from bank." />
      ) : (
        <>
          <ListToolbar
            query={list.query}
            onQuery={list.setQuery}
            shown={list.filtered.length}
            total={rows.length}
            placeholder="Search expenses"
            exportCsv={{
              company: company?.name ?? "",
              title: "Direct expenses",
              currency,
              headers: ["Date", "Payee", "Status", "Total"],
              rows: list.filtered.map((r) => [
                r.expense_date,
                r.payee_name,
                r.status,
                fromMinorUnits(BigInt(r.total_minor), currency),
              ]),
            }}
          />
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
              {list.filtered.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link
                      className="hover:underline"
                      to="/purchases/expenses/$expenseId"
                      params={{ expenseId: e.id }}
                    >
                      {e.expense_date}
                    </Link>
                  </TableCell>
                  <TableCell>{e.payee_name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {e.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {fromMinorUnits(BigInt(e.total_minor), currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  );
}
