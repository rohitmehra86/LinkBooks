import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getExpense } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/purchases/expenses/$expenseId")({
  component: ExpenseDetail,
});

function ExpenseDetail() {
  const { expenseId } = Route.useParams();
  const { company } = useActiveCompany();
  const fetchExpense = useServerFn(getExpense);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const query = useQuery({
    queryKey: ["expense", companyId, expenseId],
    enabled: Boolean(companyId),
    queryFn: () => fetchExpense({ data: { companyId: companyId!, expenseId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError) {
    return (
      <ErrorState title="Expense not found" description={friendlyAuthError(query.error)} />
    );
  }

  const e = query.data as {
    payee_name: string;
    expense_date: string;
    status: string;
    net_minor: number;
    tax_minor: number;
    total_minor: number;
    reference: string | null;
    memo: string | null;
    posted_journal_id: string | null;
  };

  return (
    <>
      <PageHeader
        title={e.payee_name}
        description={`Direct expense · ${e.expense_date}`}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/expenses">Back</Link>
          </Button>
        }
      />
      <div className="space-y-2 text-sm">
        <Badge variant="outline" className="capitalize">
          {e.status}
        </Badge>
        <p>Net {fromMinorUnits(BigInt(e.net_minor), currency)}</p>
        <p>Tax {fromMinorUnits(BigInt(e.tax_minor), currency)}</p>
        <p>Total {fromMinorUnits(BigInt(e.total_minor), currency)}</p>
        {e.reference ? <p>Ref {e.reference}</p> : null}
        {e.memo ? <p>{e.memo}</p> : null}
        {e.posted_journal_id ? (
          <p className="font-mono text-xs text-muted-foreground">
            Journal {e.posted_journal_id}
          </p>
        ) : (
          <p className="text-muted-foreground">Not posted yet (draft).</p>
        )}
      </div>
    </>
  );
}
