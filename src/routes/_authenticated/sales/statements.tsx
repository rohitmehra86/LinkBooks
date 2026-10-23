import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Printer } from "lucide-react";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listCustomers } from "@/lib/sales/sales.functions";
import { getCustomerStatement } from "@/lib/sales/sales-statements.functions";
import { money } from "@/components/sales/sales-form-utils";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
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

export const Route = createFileRoute("/_authenticated/sales/statements")({
  head: () => ({ meta: [{ title: "Customer statements — LinkBooks" }] }),
  component: Statements,
});

export function Statements() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
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
        <EmptyState
          title="Choose a customer"
          description="Select a customer to view their statement."
        />
      ) : stmtQ.isPending ? (
        <LoadingState />
      ) : stmtQ.isError ? (
        <ErrorState title="Could not load statement" description={friendlyAuthError(stmtQ.error)} />
      ) : (
        <div className="space-y-6 print:space-y-3">
          <div>
            <h2 className="text-lg font-semibold">{company.name ?? "Organisation"}</h2>
            <p className="text-sm text-muted-foreground">
              Statement for {customerName}
              {stmtQ.data.from || stmtQ.data.to
                ? ` · ${stmtQ.data.from ?? "start"} to ${stmtQ.data.to ?? "today"}`
                : ""}
            </p>
          </div>
          {stmtQ.data.currencies.length === 0 ? (
            <EmptyState title="No activity" description="No posted activity for this customer." />
          ) : null}
          {stmtQ.data.currencies.map((c) => {
            const pos = stmtQ.data.position.find((p) => p.currency_code === c.currency_code);
            return (
              <section key={c.currency_code} className="space-y-2">
                <h3 className="text-sm font-medium">{c.currency_code}</h3>
                <div className="flex flex-wrap gap-4 text-sm">
                  <span>
                    Opening balance{" "}
                    <strong>{money(c.opening_balance_minor, c.currency_code)}</strong>
                  </span>
                  <span>
                    Closing balance{" "}
                    <strong>{money(c.closing_balance_minor, c.currency_code)}</strong>
                  </span>
                  {pos ? (
                    <>
                      <span>
                        Invoices outstanding today{" "}
                        <strong>{money(pos.outstandingMinor, c.currency_code)}</strong>
                      </span>
                      <span>
                        Unapplied credits{" "}
                        <strong>{money(pos.unappliedCreditMinor, c.currency_code)}</strong>
                      </span>
                      <span>
                        Unallocated receipts{" "}
                        <strong>{money(pos.unappliedReceiptMinor, c.currency_code)}</strong>
                      </span>
                    </>
                  ) : null}
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
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground">
                        Opening balance
                      </TableCell>
                      <TableCell className="text-right">
                        {money(c.opening_balance_minor, c.currency_code)}
                      </TableCell>
                    </TableRow>
                    {c.lines.map((l) => (
                      <TableRow key={`${l.type}-${l.id}-${l.date}`}>
                        <TableCell>{l.date}</TableCell>
                        <TableCell className="capitalize">{l.type.replace("_", " ")}</TableCell>
                        <TableCell>{l.reference ?? l.id.slice(0, 8)}</TableCell>
                        <TableCell className="text-right">
                          {l.debit_minor ? money(l.debit_minor, c.currency_code) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {l.credit_minor ? money(l.credit_minor, c.currency_code) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(l.balance_minor, c.currency_code)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {c.lines.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No posted activity in this period.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </section>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Opening balance is everything owed before the start date. Each currency is shown on its
            own and never added to another.
          </p>
        </div>
      )}
    </>
  );
}
