import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { getJournalDetail } from "@/lib/banking/journal.functions";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/banking/journal/$journalId")({
  head: () => ({ meta: [{ title: "Journal — LinkBooks" }] }),
  component: JournalDetail,
});

function JournalDetail() {
  const { journalId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fetchJournal = useServerFn(getJournalDetail);
  const q = useQuery({
    queryKey: ["journal-detail", companyId, journalId],
    enabled: Boolean(companyId),
    queryFn: () => fetchJournal({ data: { companyId: companyId!, journalId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return <ErrorState title="Could not load journal" description={friendlyAuthError(q.error)} />;

  const { journal, lines } = q.data;
  const currency = journal.currency_code ?? company?.base_currency ?? "GBP";
  const debit = lines.reduce((a, l) => a + BigInt(l.debit_minor), 0n);
  const credit = lines.reduce((a, l) => a + BigInt(l.credit_minor), 0n);

  return (
    <>
      <PageHeader
        title={`Journal #${journal.journal_number}`}
        description={`${journal.journal_date} · ${journal.source_type.replace(/_/g, " ")}${journal.memo ? ` · ${journal.memo}` : ""}`}
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/banking/transactions">Back to transactions</Link>
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Badge variant="outline">{journal.status}</Badge>
        {journal.reversed_by_journal_id ? (
          <Link
            to="/banking/journal/$journalId"
            params={{ journalId: journal.reversed_by_journal_id }}
            className="text-sm underline underline-offset-4"
          >
            Reversed by another journal
          </Link>
        ) : null}
        {journal.reverses_journal_id ? (
          <Link
            to="/banking/journal/$journalId"
            params={{ journalId: journal.reverses_journal_id }}
            className="text-sm underline underline-offset-4"
          >
            Reverses another journal
          </Link>
        ) : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.accounts ? `${l.accounts.code} ${l.accounts.name}` : "—"}</TableCell>
              <TableCell>{l.description ?? ""}</TableCell>
              <TableCell className="money">
                {l.debit_minor ? fromMinorUnits(l.debit_minor, currency) : ""}
              </TableCell>
              <TableCell className="money">
                {l.credit_minor ? fromMinorUnits(l.credit_minor, currency) : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Total ({currency})</TableCell>
            <TableCell className="money">
              {fromMinorUnits(debit, currency)}
            </TableCell>
            <TableCell className="money">
              {fromMinorUnits(credit, currency)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </>
  );
}
