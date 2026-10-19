import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Printer } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getCustomerStatement, listCustomers } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/statements")({
  head: () => ({ meta: [{ title: "Customer statements — LinkBooks" }] }),
  component: Statements,
});

function Statements() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const fetchCustomers = useServerFn(listCustomers);
  const fetchStatement = useServerFn(getCustomerStatement);
  const [contactId, setContactId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const customersQ = useQuery({ queryKey: ["customers", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }) });
  const stmtQ = useQuery({
    queryKey: ["customer-statement", companyId, contactId, from, to],
    enabled: Boolean(companyId && contactId),
    queryFn: () => fetchStatement({
      data: { companyId: companyId!, contactId, ...(from ? { from } : {}), ...(to ? { to } : {}) },
    }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Customer statements"
        description="Transaction history and outstanding balances. Print / PDF for delivery — no email provider configured."
        actions={<Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="mr-1 size-4" /> Print / PDF</Button>} />
      <div className="mb-6 flex flex-wrap gap-3">
        <div className="space-y-1">
          <Label>Customer</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>{((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1"><Label>From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1"><Label>To</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {!contactId ? (
        <EmptyState title="Choose a customer" description="Select a customer to view their statement." />
      ) : stmtQ.isPending ? <LoadingState /> : stmtQ.isError ? (
        <ErrorState title="Could not load statement" description={friendlyAuthError(stmtQ.error)} />
      ) : (
        <>
          <p className="mb-4 text-sm font-medium">
            Outstanding {fromMinorUnits(stmtQ.data!.outstandingMinor, currency)}
          </p>
          <h3 className="mb-2 text-sm text-muted-foreground">Invoices</h3>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Number</TableHead><TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(stmtQ.data!.invoices as Array<{ id: string; invoice_date: string; invoice_number: string | null; status: string; total_minor: number }>).map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.invoice_date}</TableCell>
                  <TableCell>{i.invoice_number ?? "—"}</TableCell>
                  <TableCell>{i.status}</TableCell>
                  <TableCell className="text-right">{fromMinorUnits(i.total_minor, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <h3 className="mb-2 mt-6 text-sm text-muted-foreground">Receipts</h3>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Reference</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(stmtQ.data!.receipts as Array<{ id: string; receipt_date: string; reference: string | null; amount_minor: number }>).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.receipt_date}</TableCell>
                  <TableCell>{r.reference ?? "—"}</TableCell>
                  <TableCell className="text-right">{fromMinorUnits(r.amount_minor, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  );
}
