import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  generateRecurringInvoice, listCustomers, listRecurringInvoices, saveRecurringInvoice,
} from "@/lib/sales/sales.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/sales/recurring")({
  head: () => ({ meta: [{ title: "Recurring invoices — LinkBooks" }] }),
  component: RecurringInvoices,
});

function RecurringInvoices() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetchList = useServerFn(listRecurringInvoices);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const save = useServerFn(saveRecurringInvoice);
  const generate = useServerFn(generateRecurringInvoice);

  const listQ = useQuery({ queryKey: ["sales-recurring", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchList({ data: { companyId: companyId! } }) });
  const customersQ = useQuery({ queryKey: ["customers", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }) });
  const accountsQ = useQuery({ queryKey: ["accounts", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }) });

  const [name, setName] = useState("");
  const [contactId, setContactId] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [nextDue, setNextDue] = useState(today);
  const [autoAuth, setAutoAuth] = useState(false);
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [unitPrice, setUnitPrice] = useState("0.00");

  const incomeAccounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; account_type: string; is_postable: boolean; is_active: boolean }>)
    .filter((a) => a.is_active && a.is_postable && a.account_type === "income");

  const createM = useMutation({
    mutationFn: () => save({
      data: {
        companyId: companyId!, contactId, name, frequency, nextDueDate: nextDue,
        currencyCode: currency, autoAuthorise: autoAuth,
        lines: [{
          description, accountId, quantity: 1,
          unitPriceMinor: Number(toMinorUnits(unitPrice || "0", currency)),
        }],
      },
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-recurring", companyId] });
      toast.success("Recurring invoice created");
      setName(""); setDescription("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const genM = useMutation({
    mutationFn: (recurringId: string) => generate({ data: { companyId: companyId!, recurringId } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-recurring", companyId] });
      toast.success(`Generated invoice ${r.invoiceId.slice(0, 8)}… next due ${r.nextDueDate}`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader title="Recurring invoices"
        description="Generates draft invoices on demand. Auto-authorise posts only when you have sales.authorise." />
      <div className="mb-8 grid max-w-xl gap-3 rounded-md border p-4">
        <Label>Create schedule</Label>
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={contactId} onValueChange={setContactId}>
          <SelectTrigger><SelectValue placeholder="Customer" /></SelectTrigger>
          <SelectContent>{((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
          ))}</SelectContent>
        </Select>
        <div className="grid grid-cols-2 gap-2">
          <Select value={frequency} onValueChange={setFrequency}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
        </div>
        <Input placeholder="Line description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger><SelectValue placeholder="Revenue account" /></SelectTrigger>
          <SelectContent>{incomeAccounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
        </Select>
        <Input placeholder="Unit price" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoAuth} onChange={(e) => setAutoAuth(e.target.checked)} />
          Auto-authorise when generated
        </label>
        <Button size="sm" disabled={createM.isPending} onClick={() => createM.mutate()}>
          {createM.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Create
        </Button>
      </div>
      {listQ.isPending ? <LoadingState /> : listQ.isError ? (
        <ErrorState title="Could not load" description={friendlyAuthError(listQ.error)} />
      ) : (listQ.data ?? []).length === 0 ? (
        <EmptyState title="No recurring invoices" description="Create a schedule above." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Customer</TableHead><TableHead>Next due</TableHead>
            <TableHead>Active</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(listQ.data as Array<{ id: string; name: string; next_due_date: string; is_active: boolean; last_error: string | null; contacts: { name: string } | null }>).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.name}</TableCell>
                <TableCell>{r.contacts?.name ?? "—"}</TableCell>
                <TableCell>{r.next_due_date}</TableCell>
                <TableCell><Badge variant="secondary">{r.is_active ? "active" : "paused"}</Badge>
                  {r.last_error ? <span className="ml-2 text-xs text-destructive">{r.last_error}</span> : null}
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="outline" disabled={genM.isPending} onClick={() => genM.mutate(r.id)}>
                    Generate now
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
