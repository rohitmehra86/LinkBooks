import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listCustomers, saveCreditNoteDraft, authoriseCreditNote } from "@/lib/sales/sales.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/sales/credit-notes/new")({
  head: () => ({ meta: [{ title: "New credit note — LinkBooks" }] }),
  component: NewCredit,
});

function NewCredit() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const saveDraft = useServerFn(saveCreditNoteDraft);
  const authorise = useServerFn(authoriseCreditNote);

  const [contactId, setContactId] = useState("");
  const [creditDate, setCreditDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState([{ description: "", accountId: "", quantity: "1", unitPrice: "0.00", taxRateBps: "0" }]);

  const customersQ = useQuery({ queryKey: ["customers", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }) });
  const accountsQ = useQuery({ queryKey: ["accounts", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }) });
  const incomeAccounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; account_type: string; is_postable: boolean; is_active: boolean }>)
    .filter((a) => a.is_active && a.is_postable && a.account_type === "income");

  const mutation = useMutation({
    mutationFn: async (alsoAuthorise: boolean) => {
      if (!companyId || !contactId) throw new Error("Customer required");
      const saved = await saveDraft({
        data: {
          companyId, contactId, creditDate, memo, currencyCode: currency,
          lines: lines.map((l) => ({
            description: l.description, accountId: l.accountId, quantity: Number(l.quantity),
            unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
            taxRateBps: Number(l.taxRateBps || 0),
          })),
        },
      });
      if (alsoAuthorise) await authorise({ data: { companyId, creditNoteId: saved.id } });
      return saved;
    },
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ["sales-credits", companyId] });
      toast.success("Credit note saved");
      navigate({ to: "/sales/credit-notes/$creditNoteId", params: { creditNoteId: saved.id } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (customersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader title="New credit note" description="Authorise to post DR revenue / CR AR."
        actions={<Button variant="outline" size="sm" asChild><Link to="/sales/credit-notes">Back</Link></Button>} />
      <div className="grid max-w-3xl gap-4">
        <div className="space-y-2"><Label>Customer</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger><SelectValue placeholder="Customer" /></SelectTrigger>
            <SelectContent>{((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2"><Label>Date</Label>
          <Input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} /></div>
        <div className="space-y-2"><Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
        {lines.map((line, idx) => (
          <div key={idx} className="grid gap-2 rounded-md border p-3 sm:grid-cols-4">
            <Input placeholder="Description" value={line.description}
              onChange={(e) => { const n = [...lines]; n[idx] = { ...line, description: e.target.value }; setLines(n); }} />
            <Select value={line.accountId} onValueChange={(v) => { const n = [...lines]; n[idx] = { ...line, accountId: v }; setLines(n); }}>
              <SelectTrigger><SelectValue placeholder="Account" /></SelectTrigger>
              <SelectContent>{incomeAccounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
            </Select>
            <Input value={line.quantity} onChange={(e) => { const n = [...lines]; n[idx] = { ...line, quantity: e.target.value }; setLines(n); }} />
            <Input value={line.unitPrice} onChange={(e) => { const n = [...lines]; n[idx] = { ...line, unitPrice: e.target.value }; setLines(n); }} />
          </div>
        ))}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate(false)}>Save draft</Button>
          <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Save & authorise
          </Button>
        </div>
      </div>
    </>
  );
}
