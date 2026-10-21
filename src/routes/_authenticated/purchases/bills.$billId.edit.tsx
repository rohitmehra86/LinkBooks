import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  authoriseBill,
  getBill,
  listSuppliers,
  saveBillDraft,
  submitBillForApproval,
} from "@/lib/purchases/purchases.functions";
import { listProducts } from "@/lib/products/products.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { LoadingState, EmptyState, ErrorState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import {
  BillAttachmentsButton,
  BillRelatedFilesOverlay,
} from "@/components/purchases/BillRelatedFilesOverlay";
import {
  PurchasesDocumentLines,
  emptyPurchaseLine,
  type PurchaseLineFormState,
} from "@/components/purchases/PurchasesDocumentLines";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type EditSearch = { files?: boolean };

export const Route = createFileRoute("/_authenticated/purchases/bills/$billId/edit")({
  validateSearch: (s: Record<string, unknown>): EditSearch => {
    const out: EditSearch = {};
    if (s["files"] === true || s["files"] === "1" || s["files"] === "true") out.files = true;
    return out;
  },
  head: () => ({ meta: [{ title: "Edit bill — LinkBooks" }] }),
  component: EditBill,
});

function EditBill() {
  const { billId } = Route.useParams();
  const search = Route.useSearch();
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
  const doAuthorise = useServerFn(authoriseBill);
  const doSubmit = useServerFn(submitBillForApproval);

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
  const [filesOpen, setFilesOpen] = useState(Boolean(search.files));

  useEffect(() => {
    if (search.files) setFilesOpen(true);
  }, [search.files]);

  const payload = billQ.data;
  useEffect(() => {
    if (hydrated || !payload) return;
    const bill = payload as unknown as {
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
        product_id?: string | null;
        tax_code_id?: string | null;
        class_option_id?: string | null;
        location_option_id?: string | null;
        project_option_id?: string | null;
        customer_contact_id?: string | null;
        is_billable?: boolean;
      }>;
    };
    if (bill.status !== "draft" && bill.status !== "awaiting_approval") return;
    setContactId(bill.contact_id);
    setBillDate(bill.bill_date);
    setDueDate(bill.due_date);
    setSupplierInvoiceNumber(bill.supplier_invoice_number ?? "");
    setMemo(bill.memo ?? "");
    setLines(
      (bill.purchase_bill_lines ?? []).map((l) => ({
        ...emptyPurchaseLine(),
        productId: l.product_id ?? "",
        description: l.description,
        accountId: l.account_id,
        quantity: String(l.quantity),
        unitPrice: fromMinorUnits(l.unit_price_minor, currency),
        discount: fromMinorUnits(l.discount_minor ?? 0, currency),
        taxRateBps: String(l.tax_rate_bps ?? 0),
        taxCodeId: l.tax_code_id ?? "",
        classOptionId: l.class_option_id ?? "",
        locationOptionId: l.location_option_id ?? "",
        projectOptionId: l.project_option_id ?? "",
        customerContactId: l.customer_contact_id ?? "",
        isBillable: Boolean(l.is_billable),
      })),
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
      (a.account_type === "expense" ||
        a.account_type === "asset" ||
        a.code.startsWith("5") ||
        a.code.startsWith("6")),
  );

  const supplierOptions = useMemo(
    () =>
      ((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    [suppliersQ.data],
  );

  const billMeta = billQ.data as unknown as {
    status: string;
    display_reference: string | null;
    bill_number: string | null;
    contacts: { name: string } | null;
    attachments: Array<{
      id: string;
      file_name: string;
      content_type: string | null;
      size_bytes: number | null;
      created_at: string;
    }>;
  } | undefined;

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
      await qc.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success("Bill saved");
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  const saveAndClose = useMutation({
    mutationFn: () =>
      saveDraft({
        data: {
          companyId: companyId!,
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
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      toast.success("Bill saved");
      navigate({ to: "/purchases/bills/$billId", params: { billId } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const authoriseM = useMutation({
    mutationFn: async () => {
      await mutation.mutateAsync();
      return doAuthorise({ data: { companyId: companyId!, billId } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      toast.success("Bill authorised — journal posted");
      navigate({ to: "/purchases/bills/$billId", params: { billId } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const submitM = useMutation({
    mutationFn: async () => {
      await mutation.mutateAsync();
      return doSubmit({ data: { companyId: companyId!, billId } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      toast.success("Submitted for approval");
      navigate({ to: "/purchases/bills/$billId", params: { billId } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
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
  const editStatus = billMeta?.status ?? "";
  if (editStatus !== "draft" && editStatus !== "awaiting_approval") {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Only unposted bills can be edited here"
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

  const attachments = billMeta?.attachments ?? [];

  return (
    <div className="space-y-4">
      <header className="rounded-xl border border-border/80 bg-gradient-to-br from-background to-muted/30 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Purchase bill · editing
            </p>
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {billMeta?.contacts?.name ?? "Supplier"}
              {billMeta?.display_reference ? (
                <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
                  {billMeta.display_reference}
                </span>
              ) : null}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {editStatus.replace(/_/g, " ")}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Change fields below, then save. Drafts do not post to Accounts Payable.
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/purchases/bills">Back to Bills</Link>
            </Button>
            <BillAttachmentsButton count={attachments.length} onClick={() => setFilesOpen(true)} />
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={saveAndClose.isPending}
              onClick={() => saveAndClose.mutate()}
            >
              Save & Close
            </Button>
            {editStatus === "draft" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={submitM.isPending}
                onClick={() => submitM.mutate()}
              >
                Submit for approval
              </Button>
            ) : null}
            <Button size="sm" disabled={authoriseM.isPending} onClick={() => authoriseM.mutate()}>
              {authoriseM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {editStatus === "awaiting_approval" ? "Approve & authorise" : "Authorise & post"}
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/purchases/bills/$billId" params={{ billId }}>
                Cancel
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {formError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid max-w-5xl gap-4 rounded-lg border border-border bg-background p-4">
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
              placeholder="Supplier's invoice reference"
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
      </div>

      <BillRelatedFilesOverlay
        open={filesOpen}
        onOpenChange={setFilesOpen}
        companyId={companyId}
        billId={billId}
        attachments={attachments}
        canUpload
      />
    </div>
  );
}
