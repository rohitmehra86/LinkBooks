import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { getBill, listSuppliers, saveBillDraft } from "@/lib/purchases/purchases.functions";
import { listProducts } from "@/lib/products/products.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState, ErrorState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import {
  PurchasesDocumentLines,
  emptyPurchaseLine,
  type PurchaseLineFormState,
} from "@/components/purchases/PurchasesDocumentLines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/purchases/bills/$billId/edit")({
  head: () => ({ meta: [{ title: "Edit bill — LinkBooks" }] }),
  component: EditBill,
});

function EditBill() {
  const { billId } = Route.useParams();
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const fetchBill = useServerFn(getBill);
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const saveDraft = useServerFn(saveBillDraft);

  const billQ = useQuery({
    queryKey: ["bill", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBill({ data: { companyId: companyId!, billId } }),
  });
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
  const productsQ = useQuery({
    queryKey: ["products", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchProducts({ data: { companyId: companyId!, limit: 200 } }),
  });

  const [contactId, setContactId] = useState("");
  const [billDate, setBillDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<PurchaseLineFormState[]>([emptyPurchaseLine()]);
  const [hydrated, setHydrated] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const payload = billQ.data;
  useEffect(() => {
    if (hydrated || !payload) return;
    const bill = payload as {
      status: string;
      contact_id: string;
      bill_date: string;
      due_date: string;
      supplier_invoice_number: string | null;
      memo: string | null;
      purchase_bill_lines: Array<{
        description: string;
        account_id: string;
        quantity: number;
        unit_price_minor: number;
        discount_minor: number;
        tax_rate_bps: number;
      }>;
    };
    if (bill.status !== "draft") return;
    setContactId(bill.contact_id);
    setBillDate(bill.bill_date);
    setDueDate(bill.due_date);
    setSupplierInvoiceNumber(bill.supplier_invoice_number ?? "");
    setMemo(bill.memo ?? "");
    setLines(
      (bill.purchase_bill_lines ?? []).map((l) => {
        const row = l as typeof l & {
          product_id?: string | null;
          tax_code_id?: string | null;
          class_option_id?: string | null;
          location_option_id?: string | null;
          project_option_id?: string | null;
          customer_contact_id?: string | null;
          is_billable?: boolean;
        };
        return {
          ...emptyPurchaseLine(),
          productId: row.product_id ?? "",
          description: row.description,
          accountId: row.account_id,
          quantity: String(row.quantity),
          unitPrice: fromMinorUnits(row.unit_price_minor, currency),
          discount: fromMinorUnits(row.discount_minor ?? 0, currency),
          taxRateBps: String(row.tax_rate_bps ?? 0),
          taxCodeId: row.tax_code_id ?? "",
          classOptionId: row.class_option_id ?? "",
          locationOptionId: row.location_option_id ?? "",
          projectOptionId: row.project_option_id ?? "",
          customerContactId: row.customer_contact_id ?? "",
          isBillable: Boolean(row.is_billable),
        };
      }),
    );
    setHydrated(true);
  }, [payload, hydrated, currency]);

  const expenseAccounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter(
    (a) =>
      a.is_active &&
      a.is_postable &&
      (a.account_type === "expense" || a.account_type === "asset" || a.code.startsWith("5") || a.code.startsWith("6")),
  );

  const supplierOptions = useMemo(
    () =>
      ((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    [suppliersQ.data],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      if (!companyId) throw new Error("No organisation");
      return saveDraft({
        data: {
          companyId,
          billId,
          contactId,
          billDate,
          dueDate,
          supplierInvoiceNumber,
          memo,
          currencyCode: currency,
          lines: lines.map((l) => ({
            description: l.description,
            accountId: l.accountId,
            quantity: Number(l.quantity),
            unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
            discountMinor: Number(toMinorUnits(l.discount || "0", currency)),
            taxRateBps: Number(l.taxRateBps || 0),
          })),
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      toast.success("Draft bill updated");
      navigate({ to: "/purchases/bills/$billId", params: { billId } });
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (billQ.isPending || suppliersQ.isPending || accountsQ.isPending) return <LoadingState />;
  if (billQ.isError) {
    return (
      <ErrorState
        title="Bill not found"
        description={friendlyAuthError(billQ.error)}
        onRetry={() => billQ.refetch()}
      />
    );
  }
  if ((billQ.data as { status: string }).status !== "draft") {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Only drafts can be edited"
          description="Posted bills must be corrected via void or supplier credit."
        />
        <Button asChild size="sm">
          <Link to="/purchases/bills/$billId" params={{ billId }}>
            Back to bill
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Edit draft bill"
        description="Changes replace line items. Authorisation still posts through the shared engine."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/bills/$billId" params={{ billId }}>
              Cancel
            </Link>
          </Button>
        }
      />
      {formError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid max-w-4xl gap-4">
        <div className="space-y-2">
          <Label>Supplier</Label>
          <EntityCombobox
            options={supplierOptions}
            value={contactId}
            onChange={setContactId}
            allowClear={false}
          />
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
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        <PurchasesDocumentLines
          lines={lines}
          onChange={setLines}
          products={(productsQ.data ?? []) as never}
          accounts={expenseAccounts}
          currency={currency}
          taxCalculation="exclusive"
          toMinor={(d) => toMinorUnits(d, currency)}
        />
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save draft
        </Button>
      </div>
    </>
  );
}
