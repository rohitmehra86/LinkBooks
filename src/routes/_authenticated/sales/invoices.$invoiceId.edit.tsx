import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { getInvoice, listCustomers, saveInvoiceDraft } from "@/lib/sales/sales.functions";
import { listProducts } from "@/lib/products/products.functions";
import { getWorkflowSettings } from "@/lib/settings/workflow-settings.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState, ErrorState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import {
  SalesDocumentLines,
  emptySalesLine,
  type SalesLineFormState,
} from "@/components/sales/SalesDocumentLines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/sales/invoices/$invoiceId/edit")({
  head: () => ({ meta: [{ title: "Edit invoice — LinkBooks" }] }),
  component: EditInvoice,
});

function EditInvoice() {
  const { invoiceId } = Route.useParams();
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const fetchInvoice = useServerFn(getInvoice);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const fetchSettings = useServerFn(getWorkflowSettings);
  const saveDraft = useServerFn(saveInvoiceDraft);

  const invQ = useQuery({
    queryKey: ["sales-invoice", companyId, invoiceId],
    enabled: Boolean(companyId),
    queryFn: () => fetchInvoice({ data: { companyId: companyId!, invoiceId } }),
  });
  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
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
  const settingsQ = useQuery({
    queryKey: ["workflow-settings", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSettings({ data: { companyId: companyId! } }),
  });

  const [contactId, setContactId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<SalesLineFormState[]>([emptySalesLine()]);
  const [hydrated, setHydrated] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const invoicePayload = invQ.data;
  useEffect(() => {
    if (hydrated || !invoicePayload) return;
    const inv = invoicePayload as {
      status: string;
      contact_id: string;
      invoice_date: string;
      due_date: string;
      invoice_number: string | null;
      memo: string | null;
      sales_invoice_lines: Array<{
        description: string;
        account_id: string;
        quantity: number;
        unit_price_minor: number;
        discount_minor: number;
        tax_rate_bps: number;
        product_id: string | null;
      }>;
    };
    if (inv.status !== "draft") return;
    setContactId(inv.contact_id);
    setInvoiceDate(inv.invoice_date);
    setDueDate(inv.due_date);
    setInvoiceNumber(inv.invoice_number ?? "");
    setMemo(inv.memo ?? "");
    setLines(
      (inv.sales_invoice_lines ?? []).map((l) => ({
        productId: l.product_id ?? "",
        description: l.description,
        accountId: l.account_id,
        quantity: String(l.quantity),
        unitPrice: fromMinorUnits(l.unit_price_minor, currency),
        discount: fromMinorUnits(l.discount_minor, currency),
        taxRateBps: String(l.tax_rate_bps),
      })),
    );
    setHydrated(true);
  }, [invoicePayload, hydrated, currency]);

  const incomeAccounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  ).filter(
    (a) => a.is_active && a.is_postable && (a.account_type === "income" || a.code.startsWith("4")),
  );

  const treatment = settingsQ.data?.sales_prices_include_tax ? "inclusive" : "exclusive";
  const customerOptions = useMemo(
    () =>
      ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    [customersQ.data],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      if (!companyId) throw new Error("No organisation");
      return saveDraft({
        data: {
          companyId,
          invoiceId,
          contactId,
          invoiceDate,
          dueDate,
          invoiceNumber,
          memo,
          currencyCode: currency,
          lines: lines.map((l) => ({
            description: l.description,
            accountId: l.accountId,
            quantity: Number(l.quantity),
            unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currency)),
            discountMinor: Number(toMinorUnits(l.discount || "0", currency)),
            taxRateBps: Number(l.taxRateBps || 0),
            productId: l.productId || null,
          })),
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-invoice", companyId, invoiceId] });
      toast.success("Draft invoice updated");
      navigate({ to: "/sales/invoices/$invoiceId", params: { invoiceId } });
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (invQ.isPending || customersQ.isPending || accountsQ.isPending) return <LoadingState />;
  if (invQ.isError) {
    return (
      <ErrorState
        title="Invoice not found"
        description={friendlyAuthError(invQ.error)}
        onRetry={() => invQ.refetch()}
      />
    );
  }
  if ((invQ.data as { status: string }).status !== "draft") {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Only drafts can be edited"
          description="Posted invoices must be corrected via void or credit note."
        />
        <Button asChild size="sm">
          <Link to="/sales/invoices/$invoiceId" params={{ invoiceId }}>
            Back to invoice
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Edit draft invoice"
        description="Changes replace line items. Authorisation still posts through the shared engine."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/sales/invoices/$invoiceId" params={{ invoiceId }}>
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
          <Label>Customer</Label>
          <EntityCombobox
            options={customerOptions}
            value={contactId}
            onChange={setContactId}
            allowClear={false}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Invoice date</Label>
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Due date</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Invoice #</Label>
            <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        <SalesDocumentLines
          lines={lines}
          onChange={setLines}
          products={(productsQ.data ?? []) as never}
          accounts={incomeAccounts}
          currency={currency}
          treatment={treatment}
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
