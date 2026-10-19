import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getSupplierStatement, listSuppliers } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/purchases/statements")({
  component: StatementsPage,
});

function StatementsPage() {
  const { company } = useActiveCompany();
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchStatement = useServerFn(getSupplierStatement);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const [contactId, setContactId] = useState("");

  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId! } }),
  });

  const statementQ = useQuery({
    queryKey: ["supplier-statement", companyId, contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () =>
      fetchStatement({ data: { companyId: companyId!, contactId } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Supplier statements"
        description="Outstanding bill balances by supplier — must remain consistent with Accounts Payable after posting."
      />
      <div className="mb-4 max-w-sm space-y-2">
        <Label>Supplier</Label>
        <Select value={contactId} onValueChange={setContactId}>
          <SelectTrigger>
            <SelectValue placeholder="Select supplier" />
          </SelectTrigger>
          <SelectContent>
            {((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!contactId ? (
        <EmptyState title="Choose a supplier" description="Select a supplier to view their statement." />
      ) : statementQ.isPending ? (
        <LoadingState />
      ) : statementQ.isError ? (
        <ErrorState
          title="Could not load statement"
          description={friendlyAuthError(statementQ.error)}
        />
      ) : (
        <>
          <p className="mb-3 text-sm font-medium">
            Open balance{" "}
            {fromMinorUnits(BigInt(statementQ.data.openBalanceMinor), currency)}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Invoice #</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statementQ.data.bills.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{b.bill_date}</TableCell>
                  <TableCell>{b.supplier_invoice_number ?? "—"}</TableCell>
                  <TableCell className="capitalize">{b.status}</TableCell>
                  <TableCell className="text-right">
                    {fromMinorUnits(BigInt(b.total_minor), currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {fromMinorUnits(BigInt(b.outstanding_minor), currency)}
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
