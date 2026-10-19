import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listCustomers, listInvoices, recordReceipt } from "@/lib/sales/sales.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/sales/receipts/new")({
  head: () => ({ meta: [{ title: "Record receipt — LinkBooks" }] }),
  component: NewReceipt,
});

function NewReceipt() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchInvoices = useServerFn(listInvoices);
  const doRecord = useServerFn(recordReceipt);

  const [contactId, setContactId] = useState("");
  const [receiptDate, setReceiptDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [allocInvoiceId, setAllocInvoiceId] = useState("");
  const [allocAmount, setAllocAmount] = useState("");

  const customersQ = useQuery({ queryKey: ["customers", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }) });
  const accountsQ = useQuery({ queryKey: ["accounts", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }) });
  const invoicesQ = useQuery({
    queryKey: ["sales-invoices-open", companyId, contactId],
    enabled: Boolean(companyId && contactId),
    queryFn: () => fetchInvoices({ data: { companyId: companyId! } }),
  });

  const bankAccounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; account_type: string; is_postable: boolean; is_active: boolean }>)
    .filter((a) => a.is_active && a.is_postable && a.account_type === "asset");

  const openInvoices = ((invoicesQ.data?.rows ?? []) as Array<{
    id: string; status: string; total_minor: number; amount_paid_minor: number; amount_credited_minor: number;
    invoice_number: string | null; contact_id: string; contacts: { name: string } | null;
  }>).filter((i) => i.contact_id === contactId && ["authorised", "partly_paid"].includes(i.status));

  const mutation = useMutation({
    mutationFn: async () => {
      if (!companyId) throw new Error("No organisation");
      const amountMinor = Number(toMinorUnits(amount || "0", currency));
      const allocations = [];
      if (allocInvoiceId && allocAmount) {
        allocations.push({ invoiceId: allocInvoiceId, amountMinor: Number(toMinorUnits(allocAmount, currency)) });
      }
      return doRecord({
        data: {
          companyId, contactId, receiptDate, amountMinor, bankAccountId,
          currencyCode: currency, reference, allocations,
        },
      });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-receipts", companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      toast.success(
        r.unallocatedMinor > 0
          ? `Receipt posted. Unallocated overpayment: ${fromMinorUnits(r.unallocatedMinor, currency)}`
          : "Receipt posted and allocated",
      );
      navigate({ to: "/sales/receipts" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (customersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader title="Record receipt" description="Posts DR bank / CR AR once. Allocations update invoice balances without a second journal."
        actions={<Button variant="outline" size="sm" asChild><Link to="/sales/receipts">Back</Link></Button>} />
      <div className="grid max-w-xl gap-4">
        <div className="space-y-2"><Label>Customer</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger><SelectValue placeholder="Customer" /></SelectTrigger>
            <SelectContent>{((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label>Date</Label>
            <Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} /></div>
          <div className="space-y-2"><Label>Amount</Label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
        </div>
        <div className="space-y-2"><Label>Bank / cash GL</Label>
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger><SelectValue placeholder="Deposit account" /></SelectTrigger>
            <SelectContent>{bankAccounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
            ))}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2"><Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div className="rounded-md border p-3 space-y-3">
          <Label>Allocate to invoice (optional — remainder stays unallocated)</Label>
          <Select value={allocInvoiceId || "none"} onValueChange={(v) => setAllocInvoiceId(v === "none" ? "" : v)}>
            <SelectTrigger><SelectValue placeholder="Invoice" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No allocation</SelectItem>
              {openInvoices.map((i) => {
                const out = i.total_minor - i.amount_paid_minor - i.amount_credited_minor;
                return (
                  <SelectItem key={i.id} value={i.id}>
                    {i.invoice_number ?? i.id.slice(0, 8)} · owed {fromMinorUnits(out, currency)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {allocInvoiceId ? (
            <Input placeholder="Allocation amount" value={allocAmount} onChange={(e) => setAllocAmount(e.target.value)} />
          ) : null}
        </div>
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Post receipt
        </Button>
      </div>
    </>
  );
}
