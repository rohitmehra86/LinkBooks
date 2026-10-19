import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listSuppliers, saveAndAuthoriseCreditNote } from "@/lib/purchases/purchases.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/purchases/credit-notes/new")({
  component: NewCreditNote,
});

function NewCreditNote() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const save = useServerFn(saveAndAuthoriseCreditNote);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const [contactId, setContactId] = useState("");
  const [creditDate, setCreditDate] = useState(today);
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [net, setNet] = useState("0.00");
  const [tax, setTax] = useState("0.00");

  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const accounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>).filter(
    (a) => a.is_active && a.is_postable,
  );

  const mutation = useMutation({
    mutationFn: (authorise: boolean) =>
      save({
        data: {
          companyId: companyId!,
          contactId,
          creditDate,
          currencyCode: currency,
          authorise,
          lines: [
            {
              description,
              accountId,
              netMinor: Number(toMinorUnits(net || "0", currency)),
              taxMinor: Number(toMinorUnits(tax || "0", currency)),
            },
          ],
        },
      }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["credits", companyId] });
      toast.success(r.journalId ? "Credit note authorised and posted" : "Draft credit note saved");
      navigate({ to: "/purchases/credit-notes" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (suppliersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader title="New credit note" description="Reduce AP and reverse expense/tax on authorise." />
      <div className="grid max-w-lg gap-4">
        <div className="space-y-2">
          <Label>Supplier</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
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
        <div className="space-y-2">
          <Label>Date</Label>
          <Input type="date" value={creditDate} onChange={(e) => setCreditDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Account</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Net</Label>
            <Input value={net} onChange={(e) => setNet(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Tax</Label>
            <Input value={tax} onChange={(e) => setTax(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate(false)}>
            Save draft
          </Button>
          <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Authorise & post
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/credit-notes">Cancel</Link>
          </Button>
        </div>
      </div>
    </>
  );
}
