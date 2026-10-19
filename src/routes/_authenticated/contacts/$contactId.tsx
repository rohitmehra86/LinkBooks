import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getContact, getContactBalances } from "@/lib/contacts/contacts.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/contacts/$contactId")({
  head: () => ({ meta: [{ title: "Contact — LinkBooks" }] }),
  component: ContactDetail,
});

function ContactDetail() {
  const { contactId } = Route.useParams();
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const fetchContact = useServerFn(getContact);
  const fetchBalances = useServerFn(getContactBalances);

  const contactQ = useQuery({
    queryKey: ["contact", companyId, contactId],
    enabled: Boolean(companyId),
    queryFn: () => fetchContact({ data: { companyId: companyId!, contactId } }),
  });
  const balQ = useQuery({
    queryKey: ["contact-balances", companyId, contactId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBalances({ data: { companyId: companyId!, contactId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (contactQ.isPending) return <LoadingState />;
  if (contactQ.isError) {
    return <ErrorState title="Contact not found" description={friendlyAuthError(contactQ.error)} />;
  }

  const c = contactQ.data as {
    name: string; kind: string; email: string | null; phone: string | null;
    tax_number: string | null; payment_terms_days: number; notes: string | null;
  };

  return (
    <>
      <PageHeader title={c.name} description={`${c.kind} · terms ${c.payment_terms_days} days`}
        actions={<Button variant="outline" size="sm" asChild><Link to="/contacts">Back</Link></Button>} />
      <div className="mb-6 flex flex-wrap gap-3 text-sm">
        <Badge variant="outline">{c.kind}</Badge>
        <span>{c.email ?? "No email"}</span>
        <span>{c.phone ?? "No phone"}</span>
        <span>Tax # {c.tax_number ?? "—"}</span>
      </div>
      {balQ.isPending ? <LoadingState /> : balQ.isError ? (
        <ErrorState title="Could not load balances" description={friendlyAuthError(balQ.error)} />
      ) : (
        <>
          <p className="mb-4 text-sm">
            Receivable {fromMinorUnits(balQ.data!.receivableMinor, currency)} · Payable{" "}
            {fromMinorUnits(balQ.data!.payableMinor, currency)}
          </p>
          <h3 className="mb-2 text-sm text-muted-foreground">Sales invoices</h3>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Total</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(balQ.data!.invoices as Array<{ id: string; invoice_date: string; status: string; total_minor: number }>).map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <Link to="/sales/invoices/$invoiceId" params={{ invoiceId: i.id }} className="underline-offset-2 hover:underline">
                      {i.invoice_date}
                    </Link>
                  </TableCell>
                  <TableCell>{i.status}</TableCell>
                  <TableCell className="text-right">{fromMinorUnits(i.total_minor, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <h3 className="mb-2 mt-6 text-sm text-muted-foreground">Purchase bills</h3>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Total</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(balQ.data!.bills as Array<{ id: string; bill_date: string; status: string; total_minor: number }>).map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <Link to="/purchases/bills/$billId" params={{ billId: b.id }} className="underline-offset-2 hover:underline">
                      {b.bill_date}
                    </Link>
                  </TableCell>
                  <TableCell>{b.status}</TableCell>
                  <TableCell className="text-right">{fromMinorUnits(b.total_minor, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  );
}
