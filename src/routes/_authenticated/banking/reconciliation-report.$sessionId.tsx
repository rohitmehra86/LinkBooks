import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Printer } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { getBankReconciliationReport } from "@/lib/banking/reconcile.functions";
import { LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/banking/reconciliation-report/$sessionId")({
  head: () => ({ meta: [{ title: "Bank reconciliation report — LinkBooks" }] }),
  component: ReconciliationReport,
});

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #recon-report, #recon-report * { visibility: visible !important; }
  #recon-report { position: absolute; left: 0; top: 0; width: 100%; padding: 16px; }
  .no-print { display: none !important; }
}
`;

function ReconciliationReport() {
  const { sessionId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fetchReport = useServerFn(getBankReconciliationReport);
  const q = useQuery({
    queryKey: ["bank-recon-report", companyId, sessionId],
    enabled: Boolean(companyId),
    queryFn: () => fetchReport({ data: { companyId: companyId!, sessionId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState title="Could not load report" description={friendlyAuthError(q.error)} />;

  const r = q.data;
  const ccy = r.bankAccount.currencyCode;
  const money = (v: number) => fromMinorUnits(v, ccy);
  const Section = ({ title, items }: { title: string; items: typeof r.outstanding }) => (
    <>
      <h3 className="mb-1 mt-4 text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Journal</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={i.lineId}>
                <TableCell>{i.date}</TableCell>
                <TableCell>
                  #{i.journalNumber} · {i.description || i.source}
                </TableCell>
                <TableCell className="money">{money(i.amountMinor)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="no-print mb-4 flex gap-2">
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="mr-1 size-4" /> Print
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/banking/reconcile" search={{ bankAccountId: r.bankAccount.id } as never}>
            Back to reconcile
          </Link>
        </Button>
      </div>
      <div id="recon-report" className="max-w-3xl">
        <h1 className="text-2xl font-semibold">Bank reconciliation report</h1>
        <p className="text-sm text-muted-foreground">
          {company?.name} · {r.bankAccount.name} ({ccy}) · statement date {r.session.statementDate}
        </p>

        {r.legacyNoLines ? (
          <Alert className="my-3">
            <AlertTitle>Older reconciliation</AlertTitle>
            <AlertDescription>
              This reconciliation was completed before item-level tracking, so outstanding items
              cannot be listed.
            </AlertDescription>
          </Alert>
        ) : null}

        <Table className="mt-4">
          <TableBody>
            <TableRow>
              <TableCell>Balance per bank statement</TableCell>
              <TableCell className="money">
                {money(r.totals.statementBalance)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <Section
          title="Add: outstanding receipts (in the ledger, not yet on the statement)"
          items={r.outstanding}
        />
        <p className="mt-1 money text-sm">
          Total {money(r.totals.outstandingReceipts)}
        </p>
        <Section
          title="Less: outstanding payments (in the ledger, not yet on the statement)"
          items={r.outstandingPaymentsList}
        />
        <p className="mt-1 money text-sm">
          Total {money(r.totals.outstandingPayments)}
        </p>

        <Table className="mt-4">
          <TableBody>
            <TableRow>
              <TableCell className="font-semibold">Expected balance per books</TableCell>
              <TableCell className="money">
                {money(r.totals.expectedBookBalance)}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-semibold">
                Balance per ledger at {r.session.statementDate}
              </TableCell>
              <TableCell className="money">{money(r.totals.bookBalance)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell
                className={
                  r.totals.unexplainedDifference === 0 ? "text-emerald-700" : "text-destructive"
                }
              >
                Unexplained difference
              </TableCell>
              <TableCell className="money">
                {money(r.totals.unexplainedDifference)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        {r.totals.unexplainedDifference !== 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            A difference usually means ledger entries dated before your opening balance, or activity
            added after the reconciliation was completed.
          </p>
        ) : null}
        {r.session.notes ? <p className="mt-3 text-sm">Notes: {r.session.notes}</p> : null}
        <p className="mt-6 text-xs text-muted-foreground">
          Opening{" "}
          {r.session.openingBalanceMinor === null ? "n/a" : money(r.session.openingBalanceMinor)} ·
          cleared in this session{" "}
          {r.session.clearedTotalMinor === null ? "n/a" : money(r.session.clearedTotalMinor)}
        </p>
      </div>
    </>
  );
}
