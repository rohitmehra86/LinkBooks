import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listSuppliers, savePurchaseOrder } from "@/lib/purchases/purchases.functions";
import { parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import { useCan } from "@/hooks/use-can";
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

export const Route = createFileRoute("/_authenticated/purchases/orders/new")({
  component: NewOrder,
});

export function NewOrder() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const save = useServerFn(savePurchaseOrder);
  const { can } = useCan();
  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const [contactId, setContactId] = useState("");
  const [orderDate, setOrderDate] = useState(today);
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("0.00");
  const [taxBps, setTaxBps] = useState("0");

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

  const supplierCurrency = (
    (suppliersQ.data ?? []) as Array<{ id: string; default_currency: string | null }>
  ).find((s) => s.id === contactId)?.default_currency;
  const currency = (supplierCurrency || baseCurrency).toUpperCase();
  const priceInvalid = tryParseMinor(price || "0", currency) === null;

  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId: companyId!,
          contactId,
          orderDate,
          currencyCode: currency,
          lines: [
            {
              description,
              accountId,
              quantity: Number(qty),
              unitPriceMinor: Number(parseMinorOrThrow(price || "0", currency, "Price")),
              taxRateBps: Number(taxBps || 0),
            },
          ],
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["orders", companyId] });
      toast.success("Purchase order saved (no ledger impact)");
      navigate({ to: "/purchases/orders" });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (suppliersQ.isPending || accountsQ.isPending) return <LoadingState />;

  const accounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>).filter(
    (a) => a.is_active && a.is_postable,
  );

  return (
    <>
      <PageHeader title="New purchase order" description="Does not post to the ledger." />
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
          <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Line description</Label>
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
        <div className="grid grid-cols-3 gap-2">
          <Input placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
          <Input
            placeholder={`Price (${currency})`}
            inputMode="decimal"
            aria-invalid={priceInvalid}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <Input
            placeholder="Tax rate in bps (2000 = 20%)"
            title="Tax rate in basis points: 2000 = 20%"
            value={taxBps}
            onChange={(e) => setTaxBps(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={mutation.isPending || priceInvalid || !can("purchases.draft")}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save order
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/orders">Cancel</Link>
          </Button>
        </div>
      </div>
    </>
  );
}
