import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listSuppliers, saveBillDraft, authoriseBill } from "@/lib/purchases/purchases.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { computeLineAmounts, sumLines } from "@/lib/purchases/line-math";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

export const Route = createFileRoute("/_authenticated/purchases/bills/new")({
  head: () => ({ meta: [{ title: "New bill — LinkBooks" }] }),
  component: NewBill,
});

type LineState = {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxRateBps: string;
};

function NewBill() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const saveDraft = useServerFn(saveBillDraft);
  const authorise = useServerFn(authoriseBill);

  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

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

  const [contactId, setContactId] = useState("");
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState(today);
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineState[]>([
    { description: "", accountId: "", quantity: "1", unitPrice: "0.00", taxRateBps: "0" },
  ]);
  const [formError, setFormError] = useState<string | null>(null);

  const expenseAccounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; account_type: string; is_postable: boolean; is_active: boolean }>).filter(
    (a) => a.is_active && a.is_postable && (a.account_type === "expense" || a.account_type === "asset"),
  );

  const preview = (() => {
    try {
      const computed = lines.map((l) =>
        computeLineAmounts({
          quantity: Number(l.quantity),
          unit_price_minor: toMinorUnits(l.unitPrice || "0", currency),
          tax_rate_bps: Number(l.taxRateBps || 0),
        }),
      );
      return sumLines(computed);
    } catch {
      return null;
    }
  })();

  const mutation = useMutation({
    mutationFn: async (alsoAuthorise: boolean) => {
      setFormError(null);
      if (!companyId) throw new Error("No organisation");
      if (!contactId) throw new Error("Choose a supplier");
      const payloadLines = lines.map((l) => ({
        description: l.description,
        accountId: l.accountId,
        quantity: Number(l.quantity),
        unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
        taxRateBps: Number(l.taxRateBps || 0),
      }));
      const saved = await saveDraft({
        data: {
          companyId,
          contactId,
          billDate,
          dueDate,
          supplierInvoiceNumber,
          memo,
          currencyCode: currency,
          lines: payloadLines,
        },
      });
      if (alsoAuthorise) {
        await authorise({ data: { companyId, billId: saved.id } });
      }
      return { id: saved.id, authorised: alsoAuthorise };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success(result.authorised ? "Bill authorised and posted to ledger" : "Draft bill saved");
      navigate({ to: "/purchases/bills/$billId", params: { billId: result.id } });
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (suppliersQ.isPending || accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="New bill"
        description="Save as draft, or authorise to post AP + expense/tax through the shared posting engine."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/bills">Back</Link>
          </Button>
        }
      />

      {formError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid max-w-3xl gap-4">
        <div className="space-y-2">
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
          {(suppliersQ.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No suppliers yet.{" "}
              <Link className="underline" to="/purchases/suppliers">
                Create one
              </Link>
              .
            </p>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Bill date</Label>
            <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Due date</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Supplier invoice #</Label>
            <Input
              value={supplierInvoiceNumber}
              onChange={(e) => setSupplierInvoiceNumber(e.target.value)}
              placeholder="Unique per supplier"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>

        <div className="space-y-3">
          <Label>Lines</Label>
          {lines.map((line, idx) => (
            <div key={idx} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-5">
              <Input
                className="sm:col-span-2"
                placeholder="Description"
                value={line.description}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...line, description: e.target.value };
                  setLines(next);
                }}
              />
              <Select
                value={line.accountId}
                onValueChange={(v) => {
                  const next = [...lines];
                  next[idx] = { ...line, accountId: v };
                  setLines(next);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Account" />
                </SelectTrigger>
                <SelectContent>
                  {expenseAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...line, quantity: e.target.value };
                  setLines(next);
                }}
              />
              <Input
                placeholder={`Price (${currency})`}
                value={line.unitPrice}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...line, unitPrice: e.target.value };
                  setLines(next);
                }}
              />
              <Input
                placeholder="Tax bps"
                value={line.taxRateBps}
                onChange={(e) => {
                  const next = [...lines];
                  next[idx] = { ...line, taxRateBps: e.target.value };
                  setLines(next);
                }}
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setLines([
                ...lines,
                { description: "", accountId: "", quantity: "1", unitPrice: "0.00", taxRateBps: "0" },
              ])
            }
          >
            Add line
          </Button>
        </div>

        {preview ? (
          <p className="text-sm text-muted-foreground">
            Subtotal {fromMinorUnits(preview.subtotal_minor, currency)} · Tax{" "}
            {fromMinorUnits(preview.tax_minor, currency)} · Total{" "}
            {fromMinorUnits(preview.total_minor, currency)}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(false)}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save draft
          </Button>
          <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save & authorise (post)
          </Button>
        </div>
      </div>
    </>
  );
}
