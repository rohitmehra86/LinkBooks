import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Printer } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getCustomerStatement, listCustomers } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/statements")({
  head: () => ({ meta: [{ title: "Customer statements — LinkBooks" }] }),
  component: Statements,
});

export function Statements() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const fetchCustomers = useServerFn(listCustomers);
  const fetchStatement = useServerFn(getCustomerStatement);
  const [contactId, setContactId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const stmtQ = useQuery({
    queryKey: ["customer-statement", companyId, contactId, from, to],
    enabled: Boolean(companyId && contactId),
    queryFn: () =>
      fetchStatement({
        data: {
          companyId: companyId!,
          contactId,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      }),
  });

  const customerOptions = useMemo(
    () =>
      ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customersQ.data],
  );

  const customerName =
    ((customersQ.data ?? []) as Array<{ id: string; name: string }>).find((c) => c.id === contactId)
      ?.name ?? "Customer";

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Customer statements"
        description="Chronological activity from posted invoices, receipts and credit notes. Print/PDF only — email delivery is not configured."
        actions={
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="mr-1 size-4" /> Print / PDF
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap gap-3">
        <div className="w-64 space-y-1">
          <Label>Customer</Label>
          <EntityCombobox
            options={customerOptions}
            value={contactId}
            onChange={setContactId}
            placeholder="Search customers"
            allowClear={false}
          />
        </div>
        <div className="space-y-1">
          <Label>From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {!contactId ? (
        <EmptyState title="Choose a customer" description="Select a customer to view their statement." />
      ) : stmtQ.isPending ? (
        <LoadingState />
      ) : stmtQ.isError ? (
        <ErrorState title="Could not load statement" description={friendlyAuthError(stmtQ.error)} />
      ) : (
        <div className="space-y-4 print:space-y-2">
          <div>
            <h2 className="text-lg font-semibold">{company.name ?? "Organisation"}</h2>
            <p className="text-sm text-muted-foreground">Statement for {customerName}</p>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              Invoice outstanding{" "}
              <strong>{fromMinorUnits(stmtQ.data!.outstandingMinor, currency)}</strong>
            </span>
            <span>
              Unapplied credits{" "}
              <strong>
                {fromMinorUnits((stmtQ.data as { unappliedCreditMinor?: number }).unappliedCreditMinor ?? 0, currency)}
              </strong>
            </span>
            <span>
              Unapplied receipts{" "}
              <strong>
                {fromMinorUnits((stmtQ.data as { unappliedReceiptMinor?: number }).unappliedReceiptMinor ?? 0, currency)}
              </strong>
            </span>
            <span>
              Closing (activity){" "}
              <strong>
                {fromMinorUnits((stmtQ.data as { closingBalanceMinor?: number }).closingBalanceMinor ?? 0, currency)}
              </strong>
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(
                (stmtQ.data as {
                  lines?: Array<{
                    date: string;
                    type: string;
                    id: string;
                    reference: string | null;
                    debit_minor: number;
                    credit_minor: number;
                    balance_minor: number;
                  }>;
                }).lines ?? []
              ).map((l) => (
                <TableRow key={`${l.type}-${l.id}`}>
                  <TableCell>{l.date}</TableCell>
                  <TableCell className="capitalize">{l.type.replace("_", " ")}</TableCell>
                  <TableCell>{l.reference ?? l.id.slice(0, 8)}</TableCell>
                  <TableCell className="text-right">
                    {l.debit_minor ? fromMinorUnits(l.debit_minor, currency) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {l.credit_minor ? fromMinorUnits(l.credit_minor, currency) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {fromMinorUnits(l.balance_minor, currency)}
                  </TableCell>
                </TableRow>
              ))}
              {(stmtQ.data as { lines?: unknown[] }).lines?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No posted activity in this period.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground">
            Opening balance for activity-only statements starts at zero for the selected window.
            Outstanding is derived from open invoices; unapplied amounts are reported separately.
          </p>
        </div>
      )}
    </>
  );
}
