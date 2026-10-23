import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, Paperclip, Printer } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  addBillNote,
  authoriseBill,
  checkDuplicateSupplierBill,
  listPaymentTerms,
  deleteDraftBill,
  downloadBillAttachment,
  getBill,
  getBillNeighbors,
  listBillActivity,
  listBillNotes,
  listSuppliers,
  rejectBillApproval,
  saveBillDraft,
  submitBillForApproval,
  voidBill,
} from "@/lib/purchases/purchases.functions";
import { listProducts } from "@/lib/products/products.functions";
import { listTaxCodes } from "@/lib/tax/tax.functions";
import { listTrackingDimensions } from "@/lib/settings/dimensions.functions";
import { listCustomers } from "@/lib/sales/sales.functions";
import { useCan } from "@/hooks/use-can";
import { calculateDueDate, type TaxCalculationMode } from "@/lib/purchases/bill-form-helpers";
import {
  billEditorSnapshot,
  billEditorStateFromBill,
  buildBillSavePayload,
  isBillEditorDirty,
  type BillEditorAddress,
  type BillEditorState,
} from "@/lib/purchases/bill-save-payload";
import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import {
  formatHistoryTimestamp,
  historyTimeZoneLabel,
  presentBillHistory,
} from "@/lib/purchases/bill-history";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import {
  BillAttachmentsButton,
  BillRelatedFilesOverlay,
} from "@/components/purchases/BillRelatedFilesOverlay";
import {
  BillMakePaymentPanel,
  type BillPaymentAllocation,
} from "@/components/purchases/BillMakePaymentPanel";
import {
  PurchasesDocumentLines,
  emptyPurchaseLine,
  type PurchaseLineFormState,
} from "@/components/purchases/PurchasesDocumentLines";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatusBadge } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import { DocumentActions } from "@/components/documents/DocumentActions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type BillSearch = { fromTab?: string; files?: boolean };

export const Route = createFileRoute("/_authenticated/purchases/bills/$billId")({
  validateSearch: (s: Record<string, unknown>): BillSearch => {
    const out: BillSearch = {};
    if (typeof s["fromTab"] === "string" && s["fromTab"]) out.fromTab = s["fromTab"];
    if (s["files"] === true || s["files"] === "1" || s["files"] === "true") out.files = true;
    return out;
  },
  head: () => ({ meta: [{ title: "Bill — LinkBooks" }] }),
  component: BillDocumentWorkspace,
});

type BillPayload = {
  id: string;
  status: string;
  bill_date: string;
  due_date: string;
  bill_number: string | null;
  supplier_invoice_number: string | null;
  display_reference: string | null;
  memo: string | null;
  currency_code: string;
  fx_rate_to_base: number | null;
  payment_terms_days: number | null;
  payment_term_id?: string | null;
  due_date_manual_override?: boolean | null;
  tax_calculation?: string | null;
  duplicate_override?: boolean | null;
  supplier_address_line1?: string | null;
  supplier_address_line2?: string | null;
  supplier_address_city?: string | null;
  supplier_address_region?: string | null;
  supplier_address_postal?: string | null;
  supplier_address_country?: string | null;
  total_minor: number;
  tax_minor: number;
  subtotal_minor: number;
  amount_paid_minor: number;
  amount_credited_minor: number;
  balance_due_minor: number;
  document_total_minor: number;
  posted_journal_id: string | null;
  contact_id: string;
  approval_comment: string | null;
  rejection_reason: string | null;
  submitted_for_approval_at: string | null;
  contacts: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    account_number: string | null;
    tax_number: string | null;
    billing_address_line1: string | null;
    billing_city: string | null;
    billing_country: string | null;
  } | null;
  purchase_bill_lines: Array<{
    id: string;
    description: string;
    quantity: number;
    unit_price_minor: number;
    discount_minor: number;
    net_minor: number;
    tax_minor: number;
    tax_rate_bps: number;
    account_id: string | null;
    product_id?: string | null;
    tax_code_id?: string | null;
    class_option_id?: string | null;
    location_option_id?: string | null;
    project_option_id?: string | null;
    customer_contact_id?: string | null;
    is_billable?: boolean;
    class_id?: string | null;
    location_id?: string | null;
    project_id?: string | null;
  }>;
  attachments: Array<{
    id: string;
    file_name: string;
    content_type: string | null;
    size_bytes: number | null;
    created_at: string;
  }>;
  payment_allocations: BillPaymentAllocation[];
};

function BillDocumentWorkspace() {
  const { billId } = Route.useParams();
  const search = Route.useSearch();
  const { company } = useActiveCompany();
  const fetchBill = useServerFn(getBill);
  const fetchNeighbors = useServerFn(getBillNeighbors);
  const fetchNotes = useServerFn(listBillNotes);
  const fetchActivity = useServerFn(listBillActivity);
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const fetchTaxCodes = useServerFn(listTaxCodes);
  const fetchDimensions = useServerFn(listTrackingDimensions);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchTerms = useServerFn(listPaymentTerms);
  const checkDup = useServerFn(checkDuplicateSupplierBill);
  const { can } = useCan();
  const saveDraft = useServerFn(saveBillDraft);
  const doAuthorise = useServerFn(authoriseBill);
  const doVoid = useServerFn(voidBill);
  const doSubmit = useServerFn(submitBillForApproval);
  const doReject = useServerFn(rejectBillApproval);
  const doDelete = useServerFn(deleteDraftBill);
  const doAddNote = useServerFn(addBillNote);
  const doDownload = useServerFn(downloadBillAttachment);
  const queryClient = useQueryClient();
  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";

  const [supplierOpen, setSupplierOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [noteDraft, setNoteDraft] = useState("");
  const [approvalComment, setApprovalComment] = useState("");
  const [filesOpen, setFilesOpen] = useState(Boolean(search.files));
  const [formError, setFormError] = useState<string | null>(null);

  const [contactId, setContactId] = useState("");
  const [billDate, setBillDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<PurchaseLineFormState[]>([emptyPurchaseLine()]);
  const [dueDateManualOverride, setDueDateManualOverride] = useState(false);
  const [paymentTermId, setPaymentTermId] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState<number | null>(null);
  const [taxCalculation, setTaxCalculation] = useState<TaxCalculationMode>("exclusive");
  const [fxRate, setFxRate] = useState("");
  const [acknowledgeDuplicate, setAcknowledgeDuplicate] = useState(false);
  const [address, setAddress] = useState<BillEditorAddress>({
    line1: "",
    line2: "",
    city: "",
    region: "",
    postal: "",
    country: "",
  });
  const [hydrated, setHydrated] = useState(false);
  // Snapshot of what is saved, so Authorise / Submit only re-save when something changed.
  const baselineRef = useRef<string | null>(null);

  useEffect(() => {
    if (search.files) setFilesOpen(true);
  }, [search.files]);

  const query = useQuery({
    queryKey: ["bill", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBill({ data: { companyId: companyId!, billId } }),
  });

  const bill = query.data as BillPayload | undefined;
  const canEdit = bill?.status === "draft" || bill?.status === "awaiting_approval";

  const neighborsQ = useQuery({
    queryKey: ["bill-neighbors", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchNeighbors({ data: { companyId: companyId!, billId } }),
  });

  const notesQ = useQuery({
    queryKey: ["bill-notes", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchNotes({ data: { companyId: companyId!, billId } }),
  });

  const activityQ = useQuery({
    queryKey: ["bill-activity", companyId, billId],
    enabled: Boolean(companyId),
    queryFn: () => fetchActivity({ data: { companyId: companyId!, billId } }),
  });

  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId],
    enabled: Boolean(companyId) && Boolean(canEdit),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId! } }),
  });

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId) && Boolean(canEdit),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const productsQ = useQuery({
    queryKey: ["products", companyId],
    enabled: Boolean(companyId) && Boolean(canEdit),
    queryFn: () => fetchProducts({ data: { companyId: companyId!, limit: 200 } }),
  });

  const taxCodesQ = useQuery({
    queryKey: ["tax-codes", companyId],
    enabled: Boolean(companyId) && Boolean(canEdit),
    queryFn: () => fetchTaxCodes({ data: { companyId: companyId! } }),
  });
  const dimsQ = useQuery({
    queryKey: ["tracking-dimensions", companyId],
    enabled: Boolean(companyId) && Boolean(canEdit),
    queryFn: () => fetchDimensions({ data: { companyId: companyId! } }),
  });
  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled: Boolean(companyId) && Boolean(canEdit),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const termsQ = useQuery({
    queryKey: ["payment-terms", companyId],
    enabled: Boolean(companyId) && Boolean(canEdit),
    queryFn: () => fetchTerms({ data: { companyId: companyId! } }),
  });
  const dupQ = useQuery({
    queryKey: ["bill-dup", companyId, contactId, supplierInvoiceNumber, billId],
    enabled: Boolean(companyId && canEdit && contactId && supplierInvoiceNumber.trim()),
    queryFn: () =>
      checkDup({
        data: {
          companyId: companyId!,
          contactId,
          supplierInvoiceNumber,
          excludeBillId: billId,
        },
      }),
  });

  // Reset hydration when switching bills
  useEffect(() => {
    setHydrated(false);
  }, [billId]);

  useEffect(() => {
    if (!bill || hydrated) return;
    if (bill.status !== "draft" && bill.status !== "awaiting_approval") {
      setHydrated(true);
      return;
    }
    // Every saved field is loaded, not just the ones shown at the top of the form.
    const editor = billEditorStateFromBill(
      {
        ...bill,
        purchase_bill_lines: bill.purchase_bill_lines,
      } as never,
      baseCurrency,
    );
    setContactId(editor.contactId);
    setBillDate(editor.billDate);
    setDueDate(editor.dueDate);
    setSupplierInvoiceNumber(editor.supplierInvoiceNumber);
    setMemo(editor.memo);
    setDueDateManualOverride(editor.dueDateManualOverride);
    setPaymentTermId(editor.paymentTermId);
    setPaymentTermsDays(editor.paymentTermsDays);
    setTaxCalculation(editor.taxCalculation);
    setFxRate(editor.fxRate);
    setAcknowledgeDuplicate(editor.acknowledgeDuplicate);
    setAddress(editor.address);
    setLines(editor.lines);
    baselineRef.current = billEditorSnapshot(editor);
    setHydrated(true);
  }, [bill, hydrated, baseCurrency]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["bill", companyId, billId] });
    await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
    await queryClient.invalidateQueries({ queryKey: ["bills-workspace-summary", companyId] });
    await queryClient.invalidateQueries({ queryKey: ["bill-notes", companyId, billId] });
    await queryClient.invalidateQueries({ queryKey: ["bill-activity", companyId, billId] });
  };

  const editorState: BillEditorState = {
    contactId,
    billDate,
    dueDate,
    dueDateManualOverride,
    paymentTermId,
    paymentTermsDays,
    supplierInvoiceNumber,
    memo,
    currencyCode: (bill?.currency_code || baseCurrency).toUpperCase(),
    taxCalculation,
    fxRate,
    acknowledgeDuplicate,
    address,
    lines,
  };
  const isDirty = canEdit && hydrated && isBillEditorDirty(editorState, baselineRef.current);

  const buildSavePayload = () => {
    if (!companyId) throw new Error("No organisation");
    return buildBillSavePayload({ companyId, billId, state: editorState, baseCurrency });
  };

  /** Save only when something changed since the last load/save (P-02). */
  const saveIfDirty = async () => {
    if (!canEdit) return;
    if (!isBillEditorDirty(editorState, baselineRef.current)) return;
    await saveDraft({ data: buildSavePayload() });
    baselineRef.current = billEditorSnapshot(editorState);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      const result = await saveDraft({ data: buildSavePayload() });
      baselineRef.current = billEditorSnapshot(editorState);
      return result;
    },
    onSuccess: async () => {
      setHydrated(false);
      await invalidate();
      toast.success("Bill saved");
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  const authoriseMutation = useMutation({
    mutationFn: async () => {
      await saveIfDirty();
      return doAuthorise({ data: { companyId: companyId!, billId } });
    },
    onSuccess: async () => {
      setHydrated(false);
      await invalidate();
      toast.success("Bill authorised — journal posted");
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  const voidMutation = useMutation({
    mutationFn: () => doVoid({ data: { companyId: companyId!, billId } }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Bill voided (reversing journal if posted)");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      await saveIfDirty();
      return doSubmit({
        data: {
          companyId: companyId!,
          billId,
          ...(approvalComment.trim() ? { comment: approvalComment.trim() } : {}),
        },
      });
    },
    onSuccess: async () => {
      setHydrated(false);
      await invalidate();
      toast.success("Submitted for approval");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      doReject({
        data: {
          companyId: companyId!,
          billId,
          reason: approvalComment || "Returned for correction",
        },
      }),
    onSuccess: async () => {
      setHydrated(false);
      await invalidate();
      toast.success("Returned to draft");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => doDelete({ data: { companyId: companyId!, billId } }),
    onSuccess: async () => {
      toast.success("Draft deleted");
      window.location.href = "/purchases/bills";
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const noteMutation = useMutation({
    mutationFn: () => doAddNote({ data: { companyId: companyId!, billId, body: noteDraft } }),
    onSuccess: async () => {
      setNoteDraft("");
      await queryClient.invalidateQueries({ queryKey: ["bill-notes", companyId, billId] });
      await queryClient.invalidateQueries({ queryKey: ["bill-activity", companyId, billId] });
      toast.success("Note added");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const supplierOptions = useMemo(
    () =>
      ((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    [suppliersQ.data],
  );

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

  const terms = (termsQ.data ?? []) as Array<{
    id: string;
    name: string;
    days: number;
    calculation_method: "days_after_bill_date" | "due_on_receipt" | "days_after_month_end";
  }>;
  const taxCodes = (
    (taxCodesQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      applies_to: string;
      is_active: boolean;
      tax_rates: { rate_bps: number } | { rate_bps: number }[] | null;
    }>
  )
    .filter((t) => t.is_active)
    .map((t) => {
      const rate = Array.isArray(t.tax_rates) ? t.tax_rates[0] : t.tax_rates;
      return {
        id: t.id,
        code: t.code,
        name: t.name,
        rateBps: rate?.rate_bps ?? 0,
        appliesTo: t.applies_to,
      };
    });
  const dims = dimsQ.data as
    | {
        categories: Array<{ id: string; dimension_kind: string; is_active: boolean }>;
        options: Array<{ id: string; category_id: string; name: string; is_active: boolean }>;
      }
    | undefined;
  const optionsForKind = (kind: string) => {
    if (!dims) return [];
    const catIds = new Set(
      dims.categories.filter((c) => c.is_active && c.dimension_kind === kind).map((c) => c.id),
    );
    return dims.options
      .filter((o) => o.is_active && catIds.has(o.category_id))
      .map((o) => ({ id: o.id, name: o.name, categoryId: o.category_id }));
  };
  const customerOptions = ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map(
    (c) => ({ id: c.id, name: c.name }),
  );

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (query.isPending) return <LoadingState />;
  if (query.isError || !bill) {
    return (
      <ErrorState
        title="Bill not found"
        description={friendlyAuthError(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }

  if (canEdit && (!hydrated || suppliersQ.isPending || accountsQ.isPending)) {
    return <LoadingState />;
  }

  const currency = bill.currency_code || baseCurrency;
  const historyRows = presentBillHistory(
    (activityQ.data ?? []) as Array<{
      id: string;
      created_at: string;
      actor_name?: string | null;
      action: string;
      details?: Record<string, unknown> | null;
    }>,
    (notesQ.data ?? []) as Array<{
      id: string;
      body: string;
      created_at: string;
      created_by_name?: string | null;
    }>,
    {
      currency,
      supplierName: bill.contacts?.name ?? null,
      totalMinor: bill.total_minor,
      creditedMinor: bill.amount_credited_minor,
    },
  );
  const historyZone = historyTimeZoneLabel(company?.timezone || "UTC");
  const outstanding =
    bill.status === "draft" || bill.status === "awaiting_approval"
      ? 0
      : (bill.balance_due_minor ??
        Math.max(0, bill.total_minor - bill.amount_paid_minor - bill.amount_credited_minor));
  const backSearch =
    search.fromTab && search.fromTab !== "all" ? { tab: search.fromTab as never } : {};
  const neighbors = neighborsQ.data;

  const applyDueFromTerms = (date: string, termId: string, force = false) => {
    if (dueDateManualOverride && !force) return;
    const term = terms.find((t) => t.id === termId);
    if (!term || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    setDueDate(calculateDueDate(date, term));
  };

  const downloadAttachment = async (attachmentId: string) => {
    try {
      const file = await doDownload({ data: { companyId, attachmentId } });
      const bin = atob(file.contentBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: file.contentType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(friendlyAuthError(e));
    }
  };

  return (
    <div className="space-y-4">
      <header className="rounded-xl border border-border/80 bg-gradient-to-br from-background to-muted/30 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Purchase bill{canEdit ? " · editing" : ""}
            </p>
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {bill.contacts?.name ?? "Supplier"}
              {bill.display_reference ? (
                <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
                  {bill.display_reference}
                </span>
              ) : null}
            </h1>
            <p className="text-sm text-muted-foreground">
              {canEdit
                ? "All fields below are editable. Save before leaving."
                : `Bill ${bill.bill_date} · Due ${bill.due_date}${
                    bill.bill_number ? ` · Internal ${bill.bill_number}` : ""
                  }`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/purchases/bills" search={backSearch}>
                Back to Bills
              </Link>
            </Button>
            {neighbors?.previousId ? (
              <Button variant="outline" size="sm" asChild>
                <Link
                  to="/purchases/bills/$billId"
                  params={{ billId: neighbors.previousId }}
                  search={search}
                >
                  <ChevronLeft className="size-4" />
                  Previous
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                <ChevronLeft className="size-4" />
                Previous
              </Button>
            )}
            {neighbors?.nextId ? (
              <Button variant="outline" size="sm" asChild>
                <Link
                  to="/purchases/bills/$billId"
                  params={{ billId: neighbors.nextId }}
                  search={search}
                >
                  Next
                  <ChevronRight className="size-4" />
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next
                <ChevronRight className="size-4" />
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1 size-4" />
              Print / PDF
            </Button>
            <BillAttachmentsButton
              count={bill.attachments?.length ?? 0}
              onClick={() => setFilesOpen(true)}
            />
            {canEdit ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saveMutation.isPending || !can("purchases.draft")}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save{isDirty ? " *" : ""}
                </Button>
                {bill.status === "draft" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={submitMutation.isPending || !can("purchases.draft")}
                    onClick={() => submitMutation.mutate()}
                  >
                    Submit for approval
                  </Button>
                ) : null}
                {bill.status === "awaiting_approval" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rejectMutation.isPending || !can("purchases.authorise")}
                    onClick={() => rejectMutation.mutate()}
                  >
                    Return for correction
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={authoriseMutation.isPending || !can("purchases.authorise")}
                  title={
                    can("purchases.authorise")
                      ? undefined
                      : "You do not have permission to authorise bills"
                  }
                  onClick={() => authoriseMutation.mutate()}
                >
                  {authoriseMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {bill.status === "awaiting_approval" ? "Approve & authorise" : "Authorise & post"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleteMutation.isPending || !can("purchases.draft")}
                  onClick={() => {
                    if (confirm("Delete this unposted bill?")) deleteMutation.mutate();
                  }}
                >
                  Delete
                </Button>
              </>
            ) : (
              <>
                {["authorised", "partly_paid"].includes(bill.status) &&
                outstanding > 0 &&
                can("purchases.payment") ? (
                  <Button
                    size="sm"
                    className="bg-emerald-700 text-white hover:bg-emerald-800"
                    onClick={() => {
                      document.getElementById("make-payment")?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                    }}
                  >
                    Make a payment
                  </Button>
                ) : null}
                {bill.status !== "void" &&
                bill.status !== "paid" &&
                bill.amount_paid_minor === 0 &&
                bill.amount_credited_minor === 0 &&
                can("purchases.authorise") ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={voidMutation.isPending}
                    onClick={() => {
                      if (confirm("Void this bill? Posted journals will be reversed.")) {
                        voidMutation.mutate();
                      }
                    }}
                  >
                    Void
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={bill.status} />
          <span>
            Document total{" "}
            <strong className="tabular-nums">
              {fromMinorUnits(BigInt(bill.document_total_minor ?? bill.total_minor), currency)}
            </strong>
          </span>
          <span>
            Paid{" "}
            <strong className="tabular-nums">
              {fromMinorUnits(BigInt(bill.amount_paid_minor), currency)}
            </strong>
          </span>
          <span>
            Balance due{" "}
            <strong className="tabular-nums">
              {canEdit ? "— (unposted)" : fromMinorUnits(BigInt(outstanding), currency)}
            </strong>
          </span>
          {bill.posted_journal_id ? (
            <span className="font-mono text-xs text-muted-foreground">
              Journal {bill.posted_journal_id.slice(0, 8)}…
            </span>
          ) : null}
          {neighbors?.position ? (
            <span className="text-xs text-muted-foreground">
              {neighbors.position} of {neighbors.total}
            </span>
          ) : null}
        </div>
      </header>

      {formError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      {!bill.supplier_invoice_number?.trim() && !canEdit ? (
        <Alert>
          <AlertTitle>Missing supplier invoice number</AlertTitle>
          <AlertDescription>
            This bill has no supplier invoice # stored. Historical numbers are not fabricated.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          {canEdit ? (
            <section className="space-y-4 rounded-lg border border-border bg-background p-4">
              <h2 className="text-sm font-semibold">Bill details</h2>
              <div className="space-y-2">
                <Label htmlFor="bill-supplier">Supplier</Label>
                <EntityCombobox
                  options={supplierOptions}
                  value={contactId}
                  onChange={setContactId}
                  allowClear={false}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="bill-date">Bill date</Label>
                  <Input
                    id="bill-date"
                    type="date"
                    value={billDate}
                    onChange={(e) => {
                      setBillDate(e.target.value);
                      applyDueFromTerms(e.target.value, paymentTermId);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="due-date">
                    Due date
                    {dueDateManualOverride ? (
                      <span className="ml-2 text-xs font-normal text-amber-700">
                        (manual override)
                      </span>
                    ) : null}
                  </Label>
                  <Input
                    id="due-date"
                    type="date"
                    value={dueDate}
                    onChange={(e) => {
                      setDueDate(e.target.value);
                      setDueDateManualOverride(true);
                    }}
                  />
                  {dueDateManualOverride && paymentTermId ? (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs"
                      onClick={() => {
                        setDueDateManualOverride(false);
                        applyDueFromTerms(billDate, paymentTermId, true);
                      }}
                    >
                      Return to automatic calculation
                    </Button>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="supplier-invoice">Supplier invoice #</Label>
                  <Input
                    id="supplier-invoice"
                    value={supplierInvoiceNumber}
                    onChange={(e) => {
                      setSupplierInvoiceNumber(e.target.value);
                      setAcknowledgeDuplicate(false);
                    }}
                    placeholder="Supplier's invoice reference"
                  />
                </div>
              </div>

              {dupQ.data?.duplicate ? (
                <Alert variant="destructive">
                  <AlertTitle>Possible duplicate supplier bill</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>
                      Another bill uses supplier invoice # <strong>{supplierInvoiceNumber}</strong>{" "}
                      for this supplier.
                    </p>
                    <ul className="list-disc pl-5 text-sm">
                      {dupQ.data.matches.map((m) => (
                        <li key={m.id}>
                          <Link
                            to="/purchases/bills/$billId"
                            params={{ billId: m.id }}
                            className="underline"
                          >
                            {m.bill_number ?? m.id.slice(0, 8)} — {m.status} — {m.bill_date}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={acknowledgeDuplicate}
                        onChange={(e) => setAcknowledgeDuplicate(e.target.checked)}
                      />
                      I have reviewed the existing bill and want to keep this as a separate bill
                    </label>
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Payment terms</Label>
                  <EntityCombobox
                    options={terms.map((t) => ({
                      value: t.id,
                      label: t.name,
                      description: `${t.days}d · ${t.calculation_method}`,
                    }))}
                    value={paymentTermId}
                    onChange={(id) => {
                      setPaymentTermId(id);
                      const t = terms.find((x) => x.id === id);
                      setPaymentTermsDays(t ? t.days : null);
                      applyDueFromTerms(billDate, id);
                    }}
                    placeholder="Select terms"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Amounts are</Label>
                  <Select
                    value={taxCalculation}
                    onValueChange={(v) => setTaxCalculation(v as TaxCalculationMode)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="exclusive">Tax exclusive</SelectItem>
                      <SelectItem value="inclusive">Tax inclusive</SelectItem>
                      <SelectItem value="none">No tax</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Input value={currency} disabled readOnly />
                  {currency.toUpperCase() !== baseCurrency.toUpperCase() ? (
                    <div className="space-y-1">
                      <Label htmlFor="bill-fx" className="text-xs text-muted-foreground">
                        Rate ({currency} → {baseCurrency})
                      </Label>
                      <Input
                        id="bill-fx"
                        inputMode="decimal"
                        value={fxRate}
                        onChange={(e) => setFxRate(e.target.value)}
                        placeholder="e.g. 1.2650"
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              <Collapsible>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    Supplier address on this bill
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["line1", "Address line 1"],
                      ["line2", "Address line 2"],
                      ["city", "City"],
                      ["region", "Region"],
                      ["postal", "Postal code"],
                      ["country", "Country"],
                    ] as const
                  ).map(([key, label]) => (
                    <Input
                      key={key}
                      placeholder={label}
                      aria-label={label}
                      value={address[key]}
                      onChange={(e) => setAddress((a) => ({ ...a, [key]: e.target.value }))}
                    />
                  ))}
                </CollapsibleContent>
              </Collapsible>
              <div className="space-y-2">
                <Label htmlFor="bill-memo">Memo / notes</Label>
                <Input
                  id="bill-memo"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="Optional memo"
                />
              </div>

              <Separator />

              <h2 className="text-sm font-semibold">Line items</h2>
              <PurchasesDocumentLines
                lines={lines}
                onChange={setLines}
                products={(productsQ.data ?? []) as never}
                accounts={expenseAccounts}
                currency={currency}
                taxCalculation={taxCalculation}
                taxCodes={taxCodes}
                classOptions={optionsForKind("class")}
                locationOptions={optionsForKind("location")}
                projectOptions={optionsForKind("project")}
                customers={customerOptions}
                showClass={optionsForKind("class").length > 0}
                showLocation={optionsForKind("location").length > 0}
                showProject={optionsForKind("project").length > 0}
                showCustomer={customerOptions.length > 0}
                toMinor={(d) => toMinorUnits(d, currency)}
              />

              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  size="sm"
                  disabled={saveMutation.isPending || !can("purchases.draft")}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save changes
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/purchases/bills" search={backSearch}>
                    Cancel
                  </Link>
                </Button>
              </div>
            </section>
          ) : (
            <section className="rounded-lg border border-border bg-background p-4">
              <h2 className="mb-3 text-sm font-semibold">Line items</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit</TableHead>
                    <TableHead className="text-right">Discount</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Tax</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bill.purchase_bill_lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <div>{l.description}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fromMinorUnits(BigInt(l.unit_price_minor ?? 0), currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fromMinorUnits(BigInt(l.discount_minor ?? 0), currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fromMinorUnits(BigInt(l.net_minor), currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fromMinorUnits(BigInt(l.tax_minor), currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4 flex flex-col items-end gap-1 text-sm">
                <div className="flex w-56 justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">
                    {fromMinorUnits(BigInt(bill.subtotal_minor), currency)}
                  </span>
                </div>
                <div className="flex w-56 justify-between">
                  <span className="text-muted-foreground">Tax</span>
                  <span className="tabular-nums">
                    {fromMinorUnits(BigInt(bill.tax_minor), currency)}
                  </span>
                </div>
                <div className="flex w-56 justify-between font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {fromMinorUnits(BigInt(bill.total_minor), currency)}
                  </span>
                </div>
              </div>
              {bill.memo ? (
                <p className="mt-4 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                  {bill.memo}
                </p>
              ) : null}
            </section>
          )}

          <div id="make-payment" className={can("purchases.payment") ? undefined : "hidden"}>
            <BillMakePaymentPanel
              companyId={companyId}
              billId={billId}
              contactId={bill.contact_id}
              currency={currency}
              billStatus={bill.status}
              outstandingMinor={outstanding}
            />
          </div>

          <section className="rounded-lg border border-border bg-background p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Paperclip className="size-4" />
                Attachments ({bill.attachments?.length ?? 0})
              </h2>
              <Button size="sm" variant="outline" onClick={() => setFilesOpen(true)}>
                Open related files
              </Button>
            </div>
            {(bill.attachments ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No attachments.</p>
            ) : (
              <ul className="space-y-2">
                {bill.attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setFilesOpen(true)}
                    >
                      <p className="truncate font-medium underline-offset-2 hover:underline">
                        {a.file_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {a.content_type ?? "file"}
                        {a.size_bytes != null ? ` · ${Math.round(a.size_bytes / 1024)} KB` : ""}
                        {" · click to preview"}
                      </p>
                    </button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void downloadAttachment(a.id)}
                    >
                      Download
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
            <section className="overflow-hidden rounded-lg border border-border bg-background">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left text-sm font-semibold"
                  >
                    <ChevronDown
                      className={`size-4 text-muted-foreground transition-transform ${historyOpen ? "" : "-rotate-90"}`}
                    />
                    History and notes
                  </button>
                </CollapsibleTrigger>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!noteDraft.trim() || noteMutation.isPending}
                  onClick={() => noteMutation.mutate()}
                >
                  Add note
                </Button>
              </div>
              <CollapsibleContent>
                <div className="border-b border-border bg-muted/20 px-4 py-3">
                  <Textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Add an internal note…"
                    rows={2}
                    className="min-h-16 bg-background"
                  />
                </div>
                {activityQ.isPending ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground">Loading history…</p>
                ) : activityQ.isError ? (
                  <p className="px-4 py-6 text-sm text-destructive">History could not be loaded.</p>
                ) : historyRows.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground">No history yet.</p>
                ) : (
                  <div className="max-h-[32rem] overflow-auto">
                    <Table className="min-w-[44rem]">
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-[13rem] text-xs font-medium tracking-wide text-muted-foreground">
                            Date ({historyZone})
                          </TableHead>
                          <TableHead className="w-[11rem] text-xs font-medium tracking-wide text-muted-foreground">
                            User
                          </TableHead>
                          <TableHead className="w-[9rem] text-xs font-medium tracking-wide text-muted-foreground">
                            Action
                          </TableHead>
                          <TableHead className="text-xs font-medium tracking-wide text-muted-foreground">
                            Detail
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historyRows.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="whitespace-nowrap align-top text-sm text-muted-foreground">
                              {formatHistoryTimestamp(row.at, company?.timezone || "UTC")}
                            </TableCell>
                            <TableCell className="align-top text-sm font-medium">
                              {row.user}
                            </TableCell>
                            <TableCell className="align-top text-sm font-medium text-emerald-700 dark:text-emerald-400">
                              {row.action}
                            </TableCell>
                            <TableCell className="align-top text-sm leading-relaxed">
                              {row.paymentId ? (
                                <Link
                                  to="/purchases/payments/$paymentId"
                                  params={{ paymentId: row.paymentId }}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary underline-offset-2 hover:underline"
                                >
                                  {row.detail || "Open payment"}
                                </Link>
                              ) : (
                                row.detail || "—"
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CollapsibleContent>
            </section>
          </Collapsible>
        </div>

        <aside className="space-y-3">
          <Collapsible open={supplierOpen} onOpenChange={setSupplierOpen}>
            <div className="rounded-lg border border-border bg-background p-4">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between text-left text-sm font-semibold"
                >
                  Supplier
                  <span className="text-xs font-normal text-muted-foreground">
                    {supplierOpen ? "Hide" : "Show"}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-2 text-sm">
                <p className="font-medium">{bill.contacts?.name ?? "—"}</p>
                {bill.contacts?.email ? <p>{bill.contacts.email}</p> : null}
                {bill.contacts?.phone ? <p>{bill.contacts.phone}</p> : null}
                {bill.contact_id ? (
                  <Button variant="link" className="h-auto p-0" asChild>
                    <Link to="/contacts/$contactId" params={{ contactId: bill.contact_id }}>
                      Open contact
                    </Link>
                  </Button>
                ) : null}
              </CollapsibleContent>
            </div>
          </Collapsible>

          <div className="rounded-lg border border-border bg-background p-4 text-sm">
            <h3 className="font-semibold">Document details</h3>
            <dl className="mt-2 space-y-2">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Currency</dt>
                <dd>{currency}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Internal #</dt>
                <dd className="font-mono text-xs">{bill.bill_number ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Internal ID</dt>
                <dd className="max-w-[9rem] truncate font-mono text-xs" title={bill.id}>
                  {bill.id.slice(0, 8)}…
                </dd>
              </div>
            </dl>
          </div>

          {canEdit ? (
            <div className="rounded-lg border border-border bg-background p-4 text-sm">
              <h3 className="font-semibold">Approval</h3>
              <Input
                className="mt-2"
                placeholder="Comment / reason"
                value={approvalComment}
                onChange={(e) => setApprovalComment(e.target.value)}
              />
              {bill.approval_comment ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Last comment: {bill.approval_comment}
                </p>
              ) : null}
              {bill.rejection_reason ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  Rejection: {bill.rejection_reason}
                </p>
              ) : null}
            </div>
          ) : null}

          {bill.status === "void" ? (
            <Alert>
              <AlertTitle>Voided</AlertTitle>
              <AlertDescription>
                Historical read-only. Posted journals were reversed.
              </AlertDescription>
            </Alert>
          ) : null}
        </aside>
      </div>

      <DocumentActions kind="purchase_bill" id={billId} />

      <BillRelatedFilesOverlay
        open={filesOpen}
        onOpenChange={setFilesOpen}
        companyId={companyId}
        billId={billId}
        attachments={bill.attachments ?? []}
        canUpload={canEdit}
      />
    </div>
  );
}
