import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listCustomers, saveQuoteDraft } from "@/lib/sales/sales.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { computeLineAmounts, sumLines } from "@/lib/purchases/line-math";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/sales/quotes/new")({
  head: () => ({ meta: [{ title: "New quote — LinkBooks" }] }),
  component: NewQuote,
});

function NewQuote() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const saveDraft = useServerFn(saveQuoteDraft);

  const customersQ = useQuery({ queryKey: ["customers", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }) });
  const accountsQ = useQuery({ queryKey: ["accounts", companyId], enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }) });

  const [contactId, setContactId] = useState("");
  const [quoteDate, setQuoteDate] = useState(today);
  const [expiryDate, setExpiryDate] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState([{ description: "", accountId: "", quantity: "1", unitPrice: "0.00", taxRateBps: "0" }]);

  const incomeAccounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; account_type: string; is_postable: boolean; is_active: boolean }>)
    .filter((a) => a.is_active && a.is_postable && a.account_type === "income");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!companyId || !contactId) throw new Error("Customer is required");
      return saveDraft({
        data: {
          companyId, contactId, quoteDate, expiryDate, memo, currencyCode: currency,
          lines: lines.map((l) => ({
            description: l.description, accountId: l.accountId, quantity: Number(l.quantity),
            unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
            taxRateBps: Number(l.taxRateBps || 0),
          })),
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-quotes", companyId] });
      toast.success("Quote saved");
      navigate({ to: "/sales/quotes" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (customersQ.isPending || accountsQ.isPending) return <LoadingState />;

  const preview = (() => {
    try {
      return sumLines(lines.map((l) => computeLineAmounts({
        quantity: Number(l.quantity), unit_price_minor: toMinorUnits(l.unitPrice || "0", currency),
        tax_rate_bps: Number(l.taxRateBps || 0),
      })));
    } catch { return null; }
  })();

  return (
    <>
      <PageHeader title="New quote" description="Quotes are non-posting until converted to an invoice."
        actions={<Button variant="outline" size="sm" asChild><Link to="/sales/quotes">Back</Link></Button>} />
      <div className="grid max-w-3xl gap-4">
        <div className="space-y-2">
          <Label>Customer</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
            <SelectContent>
              {((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label>Quote date</Label>
            <Input type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} /></div>
          <div className="space-y-2"><Label>Expiry</Label>
            <Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></div>
        </div>
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
        {preview ? <p className="text-sm text-muted-foreground">Total {fromMinorUnits(preview.total_minor, currency)}</p> : null}
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Save quote
        </Button>
      </div>
    </>
  );
}
