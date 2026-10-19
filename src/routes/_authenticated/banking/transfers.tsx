import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { createTransfer, listBankAccounts } from "@/lib/banking/banking.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/banking/transfers")({
  head: () => ({ meta: [{ title: "Transfers — LinkBooks" }] }),
  component: Transfers,
});

function Transfers() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listBankAccounts);
  const doTransfer = useServerFn(createTransfer);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const mutation = useMutation({
    mutationFn: () => doTransfer({
      data: {
        companyId: companyId!,
        fromBankAccountId: fromId,
        toBankAccountId: toId,
        transferDate: date,
        amountMinor: Number(toMinorUnits(amount || "0", currency)),
        currencyCode: currency,
        memo,
      },
    }),
    onSuccess: (r) => {
      toast.success(`Transfer posted (journal ${r.journalId.slice(0, 8)}…). One journal only.`);
      setAmount(""); setMemo("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (accountsQ.isPending) return <LoadingState />;

  const accounts = (accountsQ.data ?? []) as Array<{ id: string; name: string }>;

  return (
    <>
      <PageHeader title="Transfers"
        description="Moves money between bank/cash accounts with a single DR/CR journal. No duplicate ledger entries." />
      <div className="grid max-w-md gap-3">
        <div className="space-y-1"><Label>From</Label>
          <Select value={fromId} onValueChange={setFromId}>
            <SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1"><Label>To</Label>
          <Select value={toId} onValueChange={setToId}>
            <SelectTrigger><SelectValue placeholder="Destination" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1"><Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1"><Label>Amount</Label>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
        <div className="space-y-1"><Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Post transfer
        </Button>
      </div>
    </>
  );
}
