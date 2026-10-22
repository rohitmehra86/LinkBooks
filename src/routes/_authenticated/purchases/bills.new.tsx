import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, Loader2, MoreHorizontal, Paperclip, Printer } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  listSuppliers,
  upsertSupplier,
  saveBillDraft,
  authoriseBill,
  checkDuplicateSupplierBill,
  listPaymentTerms,
  createPaymentTerm,
  listBillAttachments,
  uploadBillAttachment,
  deleteBillAttachment,
  downloadBillAttachment,
  listBillNotes,
  addBillNote,
  listBillActivity,
  resolveFxRateForBill,
  saveRecurringBill,
} from "@/lib/purchases/purchases.functions";
import { listProducts, upsertProduct } from "@/lib/products/products.functions";
import { listTaxCodes, saveTaxRate, saveTaxCode } from "@/lib/tax/tax.functions";
import {
  listTrackingDimensions,
  upsertTrackingOption,
  upsertTrackingCategory,
} from "@/lib/settings/dimensions.functions";
import { getOrgExtendedSettings } from "@/lib/settings/org-settings.functions";
import { getWorkflowSettings } from "@/lib/settings/workflow-settings.functions";
import { listOrganisationFeatures } from "@/lib/settings/settings-centre.functions";
import {
  getBillWorkspacePrefs,
  saveBillWorkspacePrefs,
  DEFAULT_BILL_WORKSPACE_PREFS,
  type BillSidebarState,
  type BillWorkspacePrefs,
} from "@/lib/settings/ui-preferences.functions";
import { createManualAccount } from "@/lib/accounting/coa.functions";
import { listCustomers, upsertCustomer } from "@/lib/sales/sales.functions";
import { toMinorUnits, fromMinorUnits } from "@/lib/accounting/money";
import { convertMinorToBase } from "@/lib/accounting/fx";
import { friendlyAuthError } from "@/lib/auth-helpers";
import {
  calculateDueDate,
  CANCEL_UNSAVED_MESSAGE,
  canPreviewAttachment,
  computeBillTotals,
  hasUnsavedBillChanges,
  MAX_ATTACHMENT_BYTES,
  validateAttachmentFile,
  type BillFormSnapshot,
  type TaxCalculationMode,
} from "@/lib/purchases/bill-form-helpers";
import { cleanupBlankPurchaseLines, incompletePurchaseLines } from "@/lib/purchases/blank-lines";
import { LoadingState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import {
  PurchasesDocumentLines,
  emptyPurchaseLine,
  type PurchaseLineFormState,
} from "@/components/purchases/PurchasesDocumentLines";
import { BillWorkspaceLayout } from "@/components/purchases/BillWorkspaceLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Route = createFileRoute("/_authenticated/purchases/bills/new")({
  head: () => ({ meta: [{ title: "New bill — LinkBooks" }] }),
  component: NewBill,
});

function NewBill() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const fetchSettings = useServerFn(getWorkflowSettings);
  const fetchOrg = useServerFn(getOrgExtendedSettings);
  const fetchTaxCodes = useServerFn(listTaxCodes);
  const fetchDimensions = useServerFn(listTrackingDimensions);
  const fetchTerms = useServerFn(listPaymentTerms);
  const fetchFx = useServerFn(resolveFxRateForBill);
  const fetchPrefs = useServerFn(getBillWorkspacePrefs);
  const persistPrefs = useServerFn(saveBillWorkspacePrefs);
  const fetchCustomers = useServerFn(listCustomers);
  const doCreateAccount = useServerFn(createManualAccount);
  const doSaveTaxRate = useServerFn(saveTaxRate);
  const doSaveTaxCode = useServerFn(saveTaxCode);
  const doUpsertDimOption = useServerFn(upsertTrackingOption);
  const doUpsertDimCategory = useServerFn(upsertTrackingCategory);
  const doUpsertCustomer = useServerFn(upsertCustomer);
  const saveDraft = useServerFn(saveBillDraft);
  const authorise = useServerFn(authoriseBill);
  const checkDup = useServerFn(checkDuplicateSupplierBill);
  const doUpsertSupplier = useServerFn(upsertSupplier);
  const doCreateTerm = useServerFn(createPaymentTerm);
  const doUpsertProduct = useServerFn(upsertProduct);
  const doListAttachments = useServerFn(listBillAttachments);
  const doUpload = useServerFn(uploadBillAttachment);
  const doDeleteAtt = useServerFn(deleteBillAttachment);
  const doDownload = useServerFn(downloadBillAttachment);
  const doListNotes = useServerFn(listBillNotes);
  const doAddNote = useServerFn(addBillNote);
  const doListActivity = useServerFn(listBillActivity);
  const doCreateRecurring = useServerFn(saveRecurringBill);

  const companyId = company?.id;
  const baseCurrency = company?.base_currency ?? "GBP";
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
  const orgQ = useQuery({
    queryKey: ["org-settings", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchOrg({ data: { companyId: companyId! } }),
  });
  const taxCodesQ = useQuery({
    queryKey: ["tax-codes", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchTaxCodes({ data: { companyId: companyId! } }),
  });
  const dimsQ = useQuery({
    queryKey: ["tracking-dimensions", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchDimensions({ data: { companyId: companyId! } }),
  });
  const fetchFeatures = useServerFn(listOrganisationFeatures);
  const featuresQ = useQuery({
    queryKey: ["organisation-features", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchFeatures({ data: { companyId: companyId! } }),
  });
  const termsQ = useQuery({
    queryKey: ["payment-terms", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchTerms({ data: { companyId: companyId! } }),
  });
  const prefsQ = useQuery({
    queryKey: ["bill-workspace-prefs", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchPrefs({ data: { companyId: companyId! } }),
  });
  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });

  const [billId, setBillId] = useState<string | null>(null);
  const [contactId, setContactId] = useState("");
  const [billDate, setBillDate] = useState(today);
  const [dueDate, setDueDate] = useState(today);
  const [dueDateManualOverride, setDueDateManualOverride] = useState(false);
  const [paymentTermId, setPaymentTermId] = useState("");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [currencyCode, setCurrencyCode] = useState(baseCurrency);
  const [taxCalculation, setTaxCalculation] = useState<TaxCalculationMode>("exclusive");
  const [fxRate, setFxRate] = useState<number | null>(1);
  const [fxSource, setFxSource] = useState<string>("base");
  const [acknowledgeDuplicate, setAcknowledgeDuplicate] = useState(false);
  const [addr, setAddr] = useState({
    line1: "",
    line2: "",
    city: "",
    region: "",
    postal: "",
    country: "",
  });
  const [lines, setLines] = useState<PurchaseLineFormState[]>([emptyPurchaseLine()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  const [baseline, setBaseline] = useState<BillFormSnapshot | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ fileName: string; contentType: string; contentBase64: string; sizeBytes: number }>
  >([]);
  const [internalNoteDraft, setInternalNoteDraft] = useState("");

  // Dialogs
  const [cancelOpen, setCancelOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [quickSupplierOpen, setQuickSupplierOpen] = useState(false);
  const [fullSupplierOpen, setFullSupplierOpen] = useState(false);
  const [newTermOpen, setNewTermOpen] = useState(false);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [newAccountOpen, setNewAccountOpen] = useState(false);
  const [newTaxOpen, setNewTaxOpen] = useState(false);
  const [newDimOpen, setNewDimOpen] = useState<"class" | "location" | "project" | null>(null);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarState, setSidebarState] = useState<BillSidebarState>(
    DEFAULT_BILL_WORKSPACE_PREFS.sidebarState,
  );
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_BILL_WORKSPACE_PREFS.sidebarWidthPx);
  const [sidebarTab, setSidebarTab] = useState(DEFAULT_BILL_WORKSPACE_PREFS.sidebarTab);
  const [viewMode, setViewMode] = useState<BillWorkspacePrefs["viewMode"]>("professional");
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [newAccount, setNewAccount] = useState({
    code: "",
    name: "",
    accountType: "expense" as "expense" | "asset",
  });
  const [newTax, setNewTax] = useState({ code: "", name: "", rateBps: "2000" });
  const [newDimName, setNewDimName] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");

  const [quickName, setQuickName] = useState("");
  const [fullSupplier, setFullSupplier] = useState({
    name: "",
    email: "",
    phone: "",
    taxNumber: "",
    paymentTermsDays: "30",
    billingAddressLine1: "",
    billingCity: "",
    billingRegion: "",
    billingPostal: "",
    billingCountry: "",
    defaultCurrency: baseCurrency,
  });
  const [newTerm, setNewTerm] = useState({
    name: "",
    days: "30",
    calculationMethod: "days_after_bill_date",
  });
  const [newItem, setNewItem] = useState({
    name: "",
    kind: "service",
    code: "",
    description: "",
    purchaseCost: "0",
    expenseAccountId: "",
    purchaseTaxBps: "0",
  });
  const [recurring, setRecurring] = useState({
    name: "",
    frequency: "monthly",
    nextDueDate: today,
    autoAuthorise: false,
  });

  const savingRef = useRef(false);

  const attachmentsQ = useQuery({
    queryKey: ["bill-attachments", companyId, billId],
    enabled: Boolean(companyId && billId),
    queryFn: () => doListAttachments({ data: { companyId: companyId!, billId: billId! } }),
  });
  const notesQ = useQuery({
    queryKey: ["bill-notes", companyId, billId],
    enabled: Boolean(companyId && billId),
    queryFn: () => doListNotes({ data: { companyId: companyId!, billId: billId! } }),
  });
  const activityQ = useQuery({
    queryKey: ["bill-activity", companyId, billId],
    enabled: Boolean(companyId && billId),
    queryFn: () => doListActivity({ data: { companyId: companyId!, billId: billId! } }),
  });

  const dupQ = useQuery({
    queryKey: ["bill-dup", companyId, contactId, supplierInvoiceNumber, billId],
    enabled: Boolean(companyId && contactId && supplierInvoiceNumber.trim()),
    queryFn: () =>
      checkDup({
        data: {
          companyId: companyId!,
          contactId,
          supplierInvoiceNumber,
          ...(billId ? { excludeBillId: billId } : {}),
        },
      }),
  });

  useEffect(() => {
    if (!companyId || currencyCode === baseCurrency) {
      setFxRate(1);
      setFxSource("base");
      return;
    }
    let cancelled = false;
    fetchFx({
      data: { companyId, currencyCode, onDate: billDate, baseCurrency },
    }).then((r) => {
      if (cancelled) return;
      setFxRate(r.rate);
      setFxSource(r.source);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, currencyCode, billDate, baseCurrency, fetchFx]);

  useEffect(() => {
    if (defaultsApplied || !settingsQ.data) return;
    const days = settingsQ.data.purchases_default_payment_terms_days ?? 30;
    if (!dueDateManualOverride) {
      setDueDate(calculateDueDate(today, { days, calculation_method: "days_after_bill_date" }));
    }
    // Optional fields stay blank — only apply org default notes when configured
    if (settingsQ.data.purchases_default_notes) setMemo(settingsQ.data.purchases_default_notes);
    setCurrencyCode(baseCurrency);
    setDefaultsApplied(true);
  }, [settingsQ.data, defaultsApplied, today, dueDateManualOverride, baseCurrency]);

  // Capture baseline after first paint so opening alone is not "dirty"
  useEffect(() => {
    if (!defaultsApplied || baseline) return;
    const t = window.setTimeout(() => setBaseline(snapshot()), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsApplied]);

  const suppliers = (suppliersQ.data ?? []) as Array<{
    id: string;
    name: string;
    payment_terms_days: number | null;
    default_currency: string | null;
    billing_address_line1: string | null;
    billing_address_line2: string | null;
    billing_city: string | null;
    billing_region: string | null;
    billing_postal: string | null;
    billing_country: string | null;
  }>;

  const expenseAccounts = (
    (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>
  )
    .filter(
      (a) =>
        a.is_active &&
        a.is_postable &&
        (a.account_type === "expense" ||
          a.account_type === "asset" ||
          a.code.startsWith("5") ||
          a.code.startsWith("6")),
    )
    .map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      account_type: a.account_type,
    }));

  const terms = (termsQ.data ?? []) as Array<{
    id: string;
    name: string;
    days: number;
    calculation_method: "days_after_bill_date" | "due_on_receipt" | "days_after_month_end";
  }>;

  const taxCodes = ((taxCodesQ.data ?? []) as Array<{
    id: string;
    code: string;
    name: string;
    applies_to: string;
    is_active: boolean;
    tax_rates: { rate_bps: number } | { rate_bps: number }[] | null;
  }>)
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
        categories: Array<{ id: string; name: string; dimension_kind: string; is_active: boolean }>;
        options: Array<{ id: string; category_id: string; name: string; is_active: boolean }>;
      }
    | undefined;

  const optionsForKind = (kind: string) => {
    if (!dims) return [];
    const cats = dims.categories.filter((c) => c.is_active && c.dimension_kind === kind);
    const catIds = new Set(cats.map((c) => c.id));
    return dims.options
      .filter((o) => o.is_active && catIds.has(o.category_id))
      .map((o) => ({ id: o.id, name: o.name, categoryId: o.category_id }));
  };

  const customersForLines = useMemo(
    () =>
      ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map((c) => ({
        id: c.id,
        name: c.name,
      })),
    [customersQ.data],
  );

  useEffect(() => {
    if (prefsHydrated || !prefsQ.data) return;
    setSidebarState(prefsQ.data.sidebarState);
    setSidebarWidth(prefsQ.data.sidebarWidthPx);
    setSidebarTab(prefsQ.data.sidebarTab);
    setViewMode(prefsQ.data.viewMode);
    setPrefsHydrated(true);
  }, [prefsQ.data, prefsHydrated]);

  const savePrefsPatch = useCallback(
    async (patch: Partial<BillWorkspacePrefs>) => {
      if (!companyId) return;
      if (patch.sidebarState) setSidebarState(patch.sidebarState);
      if (patch.sidebarWidthPx) setSidebarWidth(patch.sidebarWidthPx);
      if (patch.sidebarTab) setSidebarTab(patch.sidebarTab);
      if (patch.viewMode) setViewMode(patch.viewMode);
      try {
        await persistPrefs({ data: { companyId, prefs: patch } });
      } catch {
        /* non-blocking preference save */
      }
    },
    [companyId, persistPrefs],
  );

  const featureOn = useCallback(
    (key: string) => {
      const row = featuresQ.data?.find((f) => f.key === key);
      // Until features hydrate, keep prior behaviour (dimension kinds drive visibility).
      if (!featuresQ.data) return true;
      return row?.state === "enabled_operational" || row?.state === "enabled_needs_config";
    },
    [featuresQ.data],
  );
  const classEnabled = useMemo(() => {
    const cats = (dimsQ.data as { categories?: Array<{ dimension_kind: string; is_active: boolean }> } | undefined)
      ?.categories;
    return featureOn("classes") && Boolean(cats?.some((c) => c.is_active && c.dimension_kind === "class"));
  }, [dimsQ.data, featureOn]);
  const locationEnabled = useMemo(() => {
    const cats = (dimsQ.data as { categories?: Array<{ dimension_kind: string; is_active: boolean }> } | undefined)
      ?.categories;
    return featureOn("locations") && Boolean(cats?.some((c) => c.is_active && c.dimension_kind === "location"));
  }, [dimsQ.data, featureOn]);
  const projectEnabled = useMemo(() => {
    const cats = (dimsQ.data as { categories?: Array<{ dimension_kind: string; is_active: boolean }> } | undefined)
      ?.categories;
    return featureOn("projects") && Boolean(cats?.some((c) => c.is_active && c.dimension_kind === "project"));
  }, [dimsQ.data, featureOn]);
  const showClass = viewMode !== "basic" && classEnabled;
  const showLocation = viewMode !== "basic" && locationEnabled;
  const showProject = viewMode === "professional" || viewMode === "custom" ? projectEnabled : false;
  const showCustomer = viewMode !== "basic";
  const showBillable = viewMode !== "basic" && featureOn("billable_expenses");

  const enabledCurrencies = useMemo(() => {
    const list = orgQ.data?.enabledCurrencies ?? [];
    const set = new Set([baseCurrency, ...list]);
    return Array.from(set);
  }, [orgQ.data, baseCurrency]);

  const selectedTerm = terms.find((t) => t.id === paymentTermId);

  const applyDueFromTerms = useCallback(
    (date: string, termId: string) => {
      if (dueDateManualOverride) return;
      const term = terms.find((t) => t.id === termId);
      if (term) {
        setDueDate(calculateDueDate(date, term));
        return;
      }
      const days = settingsQ.data?.purchases_default_payment_terms_days ?? 30;
      setDueDate(calculateDueDate(date, { days, calculation_method: "days_after_bill_date" }));
    },
    [dueDateManualOverride, terms, settingsQ.data],
  );

  const onSupplierChange = (id: string) => {
    setContactId(id);
    setAcknowledgeDuplicate(false);
    const s = suppliers.find((x) => x.id === id);
    if (s) {
      setAddr({
        line1: s.billing_address_line1 ?? "",
        line2: s.billing_address_line2 ?? "",
        city: s.billing_city ?? "",
        region: s.billing_region ?? "",
        postal: s.billing_postal ?? "",
        country: s.billing_country ?? "",
      });
      if (s.default_currency && enabledCurrencies.includes(s.default_currency)) {
        setCurrencyCode(s.default_currency);
      }
      // Prefer matching payment term by days if present
      const match = terms.find((t) => t.days === (s.payment_terms_days ?? -1));
      if (match) {
        setPaymentTermId(match.id);
        applyDueFromTerms(billDate, match.id);
      } else if (!dueDateManualOverride) {
        setDueDate(
          calculateDueDate(billDate, {
            days: s.payment_terms_days ?? settingsQ.data?.purchases_default_payment_terms_days ?? 30,
            calculation_method: "days_after_bill_date",
          }),
        );
      }
    }
  };

  function snapshot(): BillFormSnapshot {
    return {
      contactId,
      billDate,
      dueDate,
      dueDateManualOverride,
      paymentTermId,
      supplierInvoiceNumber,
      memo,
      currencyCode,
      taxCalculation,
      addressLine1: addr.line1,
      addressLine2: addr.line2,
      addressCity: addr.city,
      addressRegion: addr.region,
      addressPostal: addr.postal,
      addressCountry: addr.country,
      lines: lines.map((l) => ({
        productId: l.productId,
        description: l.description,
        accountId: l.accountId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
        taxRateBps: l.taxRateBps,
        taxCodeId: l.taxCodeId,
        classOptionId: l.classOptionId,
        locationOptionId: l.locationOptionId,
        projectOptionId: l.projectOptionId,
        customerContactId: l.customerContactId,
        isBillable: l.isBillable,
      })),
      attachmentIds: [
        ...(attachmentsQ.data ?? []).map((a: { id: string }) => a.id),
        ...pendingAttachments.map((_, i) => `pending:${i}`),
      ],
      internalNoteDraft,
    };
  }

  const isDirty = hasUnsavedBillChanges(snapshot(), baseline);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const buildSavePayload = (forAuthorise = false) => {
    if (!companyId) throw new Error("No organisation");
    if (!contactId) throw new Error("Choose a supplier");
    if (currencyCode !== baseCurrency && (fxRate == null || !(fxRate > 0))) {
      throw new Error("No exchange rate available for this currency and date. Add a rate in Settings before saving.");
    }
    if (dupQ.data?.duplicate && !acknowledgeDuplicate) {
      throw new Error(
        "A bill with this supplier invoice number may already exist. Review it and acknowledge to continue.",
      );
    }
    const cleaned = cleanupBlankPurchaseLines(lines);
    setLines(cleaned.length ? cleaned : [emptyPurchaseLine()]);
    if (forAuthorise) {
      const bad = incompletePurchaseLines(cleaned);
      if (bad.length) {
        throw new Error(
          `Line ${bad.map((i) => i + 1).join(", ")}: complete description, account and quantity before authorising`,
        );
      }
    }
    return {
      companyId,
      ...(billId ? { billId } : {}),
      contactId,
      billDate,
      dueDate,
      supplierInvoiceNumber,
      memo,
      currencyCode,
      taxCalculation,
      paymentTermId: paymentTermId || null,
      paymentTermsDays: selectedTerm?.days ?? null,
      dueDateManualOverride,
      acknowledgeDuplicate,
      fxRateToBase: currencyCode === baseCurrency ? 1 : fxRate,
      supplierAddress: addr,
      lines: cleaned.map((l) => ({
        description: l.description,
        accountId: l.accountId,
        quantity: Number(l.quantity),
        unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currencyCode)),
        discountMinor: Number(toMinorUnits(l.discount || "0", currencyCode)),
        taxRateBps: Number(l.taxRateBps || 0),
        productId: l.productId || null,
        taxCodeId: l.taxCodeId || null,
        classOptionId: l.classOptionId || null,
        locationOptionId: l.locationOptionId || null,
        projectOptionId: l.projectOptionId || null,
        customerContactId: l.customerContactId || null,
        isBillable: l.isBillable,
      })),
    };
  };

  const persistDraft = async (forAuthorise = false): Promise<string> => {
    const saved = await saveDraft({ data: buildSavePayload(forAuthorise) });
    const id = saved.id;
    setBillId(id);
    // Flush pending attachments
    for (const file of pendingAttachments) {
      await doUpload({
        data: {
          companyId: companyId!,
          billId: id,
          fileName: file.fileName,
          contentType: file.contentType,
          contentBase64: file.contentBase64,
          sizeBytes: file.sizeBytes,
        },
      });
    }
    setPendingAttachments([]);
    if (internalNoteDraft.trim()) {
      await doAddNote({
        data: { companyId: companyId!, billId: id, body: internalNoteDraft.trim() },
      });
      setInternalNoteDraft("");
    }
    await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
    await queryClient.invalidateQueries({ queryKey: ["bill-attachments", companyId, id] });
    await queryClient.invalidateQueries({ queryKey: ["bill-notes", companyId, id] });
    await queryClient.invalidateQueries({ queryKey: ["bill-activity", companyId, id] });
    return id;
  };

  const mutation = useMutation({
    mutationFn: async (mode: "draft" | "authorise" | "add_another") => {
      if (savingRef.current) throw new Error("Save already in progress");
      savingRef.current = true;
      setFormError(null);
      try {
        const id = await persistDraft(mode === "authorise");
        if (mode === "authorise") {
          await authorise({ data: { companyId: companyId!, billId: id } });
        }
        return { id, mode };
      } finally {
        savingRef.current = false;
      }
    },
    onSuccess: async (result) => {
      toast.success(
        result.mode === "authorise"
          ? "Bill authorised and posted"
          : result.mode === "add_another"
            ? "Bill saved — starting another"
            : "Draft bill saved",
      );
      if (result.mode === "add_another") {
        resetForm();
        return;
      }
      setBaseline(snapshot());
      navigate({ to: "/purchases/bills/$billId", params: { billId: result.id } });
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  function resetForm() {
    setBillId(null);
    setContactId("");
    setBillDate(today);
    setDueDateManualOverride(false);
    setPaymentTermId("");
    setSupplierInvoiceNumber("");
    setMemo(settingsQ.data?.purchases_default_notes ?? "");
    setCurrencyCode(baseCurrency);
    setTaxCalculation("exclusive");
    setAcknowledgeDuplicate(false);
    setAddr({ line1: "", line2: "", city: "", region: "", postal: "", country: "" });
    setLines([emptyPurchaseLine()]);
    setPendingAttachments([]);
    setInternalNoteDraft("");
    setFormError(null);
    const days = settingsQ.data?.purchases_default_payment_terms_days ?? 30;
    setDueDate(calculateDueDate(today, { days, calculation_method: "days_after_bill_date" }));
    window.setTimeout(() => setBaseline(snapshot()), 0);
  }

  const handleCancel = () => {
    if (!isDirty) {
      navigate({ to: "/purchases/bills" });
      return;
    }
    setCancelOpen(true);
  };

  const saveAndExit = async () => {
    try {
      setFormError(null);
      const id = await persistDraft();
      setBaseline(snapshot());
      setCancelOpen(false);
      toast.success("Bill saved");
      navigate({ to: "/purchases/bills/$billId", params: { billId: id } });
    } catch (e) {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
      // Keep dialog open? Spec: keep user on form with error — close cancel dialog so they see form
      setCancelOpen(false);
    }
  };

  const onFilesSelected = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const next = [...pendingAttachments];
    for (const file of Array.from(fileList)) {
      const check = validateAttachmentFile({
        fileName: file.name,
        sizeBytes: file.size,
        contentType: file.type,
      });
      if (!check.ok) {
        toast.error(`${file.name}: ${check.error}`);
        continue;
      }
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const contentBase64 = btoa(binary);
      if (billId) {
        try {
          await doUpload({
            data: {
              companyId: companyId!,
              billId,
              fileName: file.name,
              contentType: file.type || "application/octet-stream",
              contentBase64,
              sizeBytes: file.size,
            },
          });
          await attachmentsQ.refetch();
          toast.success(`Uploaded ${file.name}`);
        } catch (e) {
          toast.error(friendlyAuthError(e));
        }
      } else {
        next.push({
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          contentBase64,
          sizeBytes: file.size,
        });
      }
    }
    if (!billId) setPendingAttachments(next);
  };

  const totalsPreview = (() => {
    try {
      return computeBillTotals(
        lines.map((l) => ({
          quantity: Number(l.quantity),
          unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currencyCode)),
          discountMinor: Number(toMinorUnits(l.discount || "0", currencyCode)),
          taxRateBps: Number(l.taxRateBps || 0),
        })),
        taxCalculation,
      );
    } catch {
      return null;
    }
  })();

  const baseEquivalent =
    totalsPreview && fxRate != null && fxRate > 0
      ? fromMinorUnits(
          convertMinorToBase(totalsPreview.total_minor, fxRate, currencyCode, baseCurrency),
          baseCurrency,
        )
      : null;

  const supplierOptions = useMemo(
    () => suppliers.map((s) => ({ value: s.id, label: s.name })),
    [suppliers],
  );

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (suppliersQ.isPending || accountsQ.isPending) return <LoadingState />;

  const headerBar: ReactNode = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">New bill</h1>
        <p className="text-xs text-muted-foreground">
          Draft · Status: {billId ? "Saved draft" : "Unsaved"} · View:{" "}
          <Select
            value={viewMode}
            onValueChange={(v) =>
              void savePrefsPatch({ viewMode: v as BillWorkspacePrefs["viewMode"] })
            }
          >
            <SelectTrigger className="inline-flex h-7 w-auto gap-1 border-0 px-1 text-xs shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="basic">Basic</SelectItem>
              <SelectItem value="professional">Professional</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <MoreHorizontal className="size-3.5" />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setPrintOpen(true)}>
            <Printer className="mr-2 size-3.5" /> Print / PDF
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRecurringOpen(true)}>Make recurring</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setClearOpen(true)}>Clear form</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/purchases/bills">Back to bills</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate("draft")}
      >
        {mutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Save draft
      </Button>
      <div className="flex">
        <Button
          size="sm"
          className="rounded-r-none"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate("authorise")}
        >
          Save &amp; authorise
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-2">
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => mutation.mutate("authorise")}>
              Save &amp; authorise (post)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => mutation.mutate("add_another")}>
              Save &amp; add another
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                try {
                  const id = await persistDraft(false);
                  setBaseline(snapshot());
                  toast.success("Draft saved");
                  navigate({ to: "/purchases/bills/$billId", params: { billId: id } });
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Save &amp; close
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button size="sm" variant="ghost" onClick={handleCancel}>
        Cancel
      </Button>
    </div>
  );

  return (
    <>
      <BillWorkspaceLayout
        companyId={companyId}
        contactId={contactId || null}
        currency={currencyCode}
        sidebarState={sidebarState}
        sidebarWidthPx={sidebarWidth}
        sidebarTab={sidebarTab}
        onSidebarStateChange={(s) => void savePrefsPatch({ sidebarState: s })}
        onSidebarWidthChange={(w) => {
          setSidebarWidth(w);
          void savePrefsPatch({ sidebarWidthPx: w });
        }}
        onSidebarTabChange={(t) => void savePrefsPatch({ sidebarTab: t })}
        attachments={(attachmentsQ.data ?? []).map(
          (a: { id: string; file_name: string; content_type: string | null }) => ({
            id: a.id,
            fileName: a.file_name,
            contentType: a.content_type,
          }),
        )}
        onDownloadAttachment={async (id) => {
          try {
            const file = await doDownload({ data: { companyId, attachmentId: id } });
            const bin = atob(file.contentBase64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes], { type: file.contentType || "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const aEl = document.createElement("a");
            aEl.href = url;
            aEl.download = file.fileName;
            aEl.click();
          } catch (e) {
            toast.error(friendlyAuthError(e));
          }
        }}
        header={headerBar}
      >
      {settingsQ.data?.purchases_require_po ? (
        <Alert className="mb-4">
          <AlertDescription>
            Organisation policy prefers a purchase order before bills. Link a PO from Orders when
            converting, or continue if this bill is independent.
          </AlertDescription>
        </Alert>
      ) : null}

      {dupQ.data?.duplicate ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Possible duplicate supplier bill</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Another bill uses supplier invoice # <strong>{supplierInvoiceNumber}</strong> for this
              supplier.
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
              I have reviewed the existing bill and want to save this as a separate bill
            </label>
          </AlertDescription>
        </Alert>
      ) : null}

      {currencyCode !== baseCurrency && fxSource === "missing" ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            No exchange rate found for {currencyCode} → {baseCurrency} on or before {billDate}. Add
            a rate in Settings before saving a foreign-currency bill.
          </AlertDescription>
        </Alert>
      ) : null}

      {formError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3">
        <div className="space-y-1.5">
          <Label>Supplier</Label>
          <EntityCombobox
            options={supplierOptions}
            value={contactId}
            onChange={onSupplierChange}
            placeholder="Search suppliers"
            searchPlaceholder="Search suppliers…"
            allowClear={false}
            onAddNew={() => setQuickSupplierOpen(true)}
            addNewLabel="+ Add new supplier…"
          />
          <button
            type="button"
            className="text-xs text-primary underline-offset-2 hover:underline"
            onClick={() => setFullSupplierOpen(true)}
          >
            Open full supplier details form…
          </button>
        </div>

        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs">
              <ChevronDown
                className={`mr-1 size-3.5 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
              />
              Additional details (address, currency, FX)
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
            <p className="sm:col-span-3 text-xs text-muted-foreground">
              Supplier address on this bill only — does not change the master contact.
            </p>
            <Input
              placeholder="Address line 1"
              value={addr.line1}
              onChange={(e) => setAddr((a) => ({ ...a, line1: e.target.value }))}
            />
            <Input
              placeholder="Address line 2"
              value={addr.line2}
              onChange={(e) => setAddr((a) => ({ ...a, line2: e.target.value }))}
            />
            <Input
              placeholder="City"
              value={addr.city}
              onChange={(e) => setAddr((a) => ({ ...a, city: e.target.value }))}
            />
            <Input
              placeholder="Region / state"
              value={addr.region}
              onChange={(e) => setAddr((a) => ({ ...a, region: e.target.value }))}
            />
            <Input
              placeholder="Postal code"
              value={addr.postal}
              onChange={(e) => setAddr((a) => ({ ...a, postal: e.target.value }))}
            />
            <Input
              placeholder="Country"
              value={addr.country}
              onChange={(e) => setAddr((a) => ({ ...a, country: e.target.value }))}
            />
          </CollapsibleContent>
        </Collapsible>

        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <div className="space-y-2">
            <Label>Bill date</Label>
            <Input
              type="date"
              value={billDate}
              onChange={(e) => {
                setBillDate(e.target.value);
                applyDueFromTerms(e.target.value, paymentTermId);
              }}
            />
          </div>
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
                applyDueFromTerms(billDate, id);
              }}
              placeholder="Select terms"
              onAddNew={() => setNewTermOpen(true)}
              addNewLabel="+ Add new payment terms…"
            />
          </div>
          <div className="space-y-2">
            <Label>
              Due date
              {dueDateManualOverride ? (
                <span className="ml-2 text-xs font-normal text-amber-700">(manual override)</span>
              ) : null}
            </Label>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value);
                setDueDateManualOverride(true);
              }}
            />
            {dueDateManualOverride ? (
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => {
                  setDueDateManualOverride(false);
                  applyDueFromTerms(billDate, paymentTermId);
                }}
              >
                Return to automatic calculation
              </Button>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Supplier invoice #</Label>
            <Input
              value={supplierInvoiceNumber}
              onChange={(e) => {
                setSupplierInvoiceNumber(e.target.value);
                setAcknowledgeDuplicate(false);
              }}
              placeholder="Supplier reference"
            />
          </div>
          <div className="space-y-2">
            <Label>Memo / internal reference</Label>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Currency</Label>
            <Select value={currencyCode} onValueChange={setCurrencyCode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enabledCurrencies.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currencyCode !== baseCurrency && fxRate != null ? (
              <p className="text-xs text-muted-foreground">
                Rate {fxRate} ({fxSource}) · {currencyCode} → {baseCurrency}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Tax calculation</Label>
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
        </div>

        <PurchasesDocumentLines
          lines={lines}
          onChange={setLines}
          products={(productsQ.data ?? []) as never}
          accounts={expenseAccounts}
          taxCodes={taxCodes}
          classOptions={optionsForKind("class")}
          locationOptions={optionsForKind("location")}
          projectOptions={optionsForKind("project")}
          customers={customersForLines}
          currency={currencyCode}
          taxCalculation={taxCalculation}
          toMinor={(d) => toMinorUnits(d, currencyCode)}
          onAddNewItem={() => setNewItemOpen(true)}
          onAddNewAccount={() => setNewAccountOpen(true)}
          onAddNewTax={() => setNewTaxOpen(true)}
          onAddNewClass={() => setNewDimOpen("class")}
          onAddNewLocation={() => setNewDimOpen("location")}
          onAddNewProject={() => setNewDimOpen("project")}
          onAddNewCustomer={() => setNewCustomerOpen(true)}
          showClass={showClass}
          showLocation={showLocation}
          showCustomer={showCustomer}
          showProject={showProject}
          showBillable={showBillable}
          showDiscount={viewMode !== "basic"}
          baseCurrencyEquivalent={
            currencyCode !== baseCurrency && baseEquivalent
              ? `${baseEquivalent} ${baseCurrency}`
              : null
          }
        />

        {/* Attachments */}
        <div className="space-y-2 rounded-md border border-border p-4">
          <div className="flex items-center gap-2">
            <Paperclip className="size-4" />
            <Label>Attachments</Label>
          </div>
          <p className="text-sm font-medium">Max file size: 20 MB</p>
          <div
            className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFilesSelected(e.dataTransfer.files);
            }}
          >
            Drag and drop files here, or{" "}
            <label className="cursor-pointer underline">
              browse
              <input
                type="file"
                className="sr-only"
                multiple
                onChange={(e) => void onFilesSelected(e.target.files)}
              />
            </label>
          </div>
          <ul className="space-y-1 text-sm">
            {(attachmentsQ.data ?? []).map((a: {
              id: string;
              file_name: string;
              size_bytes: number | null;
              content_type: string | null;
            }) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {a.file_name}{" "}
                  <span className="text-muted-foreground">
                    ({a.size_bytes != null ? `${Math.round(a.size_bytes / 1024)} KB` : "—"})
                  </span>
                </span>
                {canPreviewAttachment(a.file_name, a.content_type) ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={async () => {
                      try {
                        const file = await doDownload({
                          data: { companyId: companyId!, attachmentId: a.id },
                        });
                        const bin = atob(file.contentBase64);
                        const bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                        const blob = new Blob([bytes], {
                          type: file.contentType || "application/octet-stream",
                        });
                        const url = URL.createObjectURL(blob);
                        window.open(url, "_blank", "noopener,noreferrer");
                      } catch (e) {
                        toast.error(friendlyAuthError(e));
                      }
                    }}
                  >
                    Preview
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={async () => {
                      try {
                        const file = await doDownload({
                          data: { companyId: companyId!, attachmentId: a.id },
                        });
                        const bin = atob(file.contentBase64);
                        const bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                        const blob = new Blob([bytes], {
                          type: file.contentType || "application/octet-stream",
                        });
                        const url = URL.createObjectURL(blob);
                        const aEl = document.createElement("a");
                        aEl.href = url;
                        aEl.download = file.fileName;
                        aEl.click();
                      } catch (e) {
                        toast.error(friendlyAuthError(e));
                      }
                    }}
                  >
                    Download
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (!confirm(`Remove ${a.file_name}?`)) return;
                    try {
                      await doDeleteAtt({ data: { companyId: companyId!, attachmentId: a.id } });
                      await attachmentsQ.refetch();
                    } catch (e) {
                      toast.error(friendlyAuthError(e));
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
            {pendingAttachments.map((a, i) => (
              <li key={`p-${i}`} className="flex items-center gap-2 text-muted-foreground">
                {a.fileName} (pending save){" "}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingAttachments((p) => p.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Limit {MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB per file.</p>
        </div>

        <Tabs defaultValue="notes">
          <TabsList>
            <TabsTrigger value="notes">Internal notes</TabsTrigger>
            <TabsTrigger value="activity">Activity history</TabsTrigger>
          </TabsList>
          <TabsContent value="notes" className="space-y-2">
            <Textarea
              placeholder="Internal note (not printed on supplier documents)"
              value={internalNoteDraft}
              onChange={(e) => setInternalNoteDraft(e.target.value)}
              rows={3}
            />
            {(notesQ.data ?? []).length > 0 ? (
              <ul className="space-y-2 text-sm">
                {(notesQ.data as Array<{ id: string; body: string; created_at: string; created_by: string | null }>).map(
                  (n) => (
                    <li key={n.id} className="rounded border border-border p-2">
                      <p className="whitespace-pre-wrap">{n.body}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(n.created_at).toLocaleString()} · {n.created_by?.slice(0, 8) ?? "—"}
                      </p>
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {billId ? "No notes yet." : "Notes are saved with the bill draft."}
              </p>
            )}
          </TabsContent>
          <TabsContent value="activity">
            {!billId ? (
              <p className="text-sm text-muted-foreground">Activity appears after the first save.</p>
            ) : activityQ.isPending ? (
              <LoadingState />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1">Date &amp; time</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    (activityQ.data ?? []) as Array<{
                      id: string;
                      created_at: string;
                      actor_user_id: string | null;
                      action: string;
                      details: unknown;
                    }>
                  ).map((a) => (
                    <tr key={a.id} className="border-t">
                      <td className="py-1 whitespace-nowrap">
                        {new Date(a.created_at).toLocaleString()}
                      </td>
                      <td>{a.actor_user_id?.slice(0, 8) ?? "—"}</td>
                      <td>{a.action}</td>
                      <td className="max-w-xs truncate text-muted-foreground">
                        {typeof a.details === "object" ? JSON.stringify(a.details) : String(a.details ?? "")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TabsContent>
        </Tabs>

        <div className="flex flex-wrap gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          Keyboard: Tab between fields · Save actions also in the header.
        </div>
      </div>
      </BillWorkspaceLayout>

      {/* Cancel three-option dialog */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>{CANCEL_UNSAVED_MESSAGE}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void saveAndExit();
              }}
            >
              Save &amp; Exit
            </AlertDialogAction>
            <AlertDialogCancel
              onClick={() => {
                setCancelOpen(false);
                navigate({ to: "/purchases/bills" });
              }}
            >
              Discard Changes
            </AlertDialogCancel>
            <Button type="button" variant="outline" onClick={() => setCancelOpen(false)}>
              Continue Editing
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear confirmation */}
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear this form?</AlertDialogTitle>
            <AlertDialogDescription>
              {isDirty
                ? "This will abandon unsaved changes on the form. Previously saved bills are not deleted."
                : "Reset all fields on this form. Previously saved bills are not deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                resetForm();
                setClearOpen(false);
              }}
            >
              Clear form
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Quick add supplier */}
      <Dialog open={quickSupplierOpen} onOpenChange={setQuickSupplierOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quick add supplier</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Supplier name</Label>
            <Input value={quickName} onChange={(e) => setQuickName(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  const r = await doUpsertSupplier({
                    data: { companyId: companyId!, name: quickName.trim() },
                  });
                  await suppliersQ.refetch();
                  onSupplierChange(r.id);
                  setQuickSupplierOpen(false);
                  setQuickName("");
                  toast.success("Supplier created");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create &amp; select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full supplier */}
      <Dialog open={fullSupplierOpen} onOpenChange={setFullSupplierOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add supplier details</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            {(
              [
                ["name", "Name"],
                ["email", "Email"],
                ["phone", "Phone"],
                ["taxNumber", "Tax number"],
                ["paymentTermsDays", "Payment terms (days)"],
                ["billingAddressLine1", "Address line 1"],
                ["billingCity", "City"],
                ["billingRegion", "Region"],
                ["billingPostal", "Postal"],
                ["billingCountry", "Country"],
                ["defaultCurrency", "Currency"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label>{label}</Label>
                <Input
                  value={fullSupplier[key]}
                  onChange={(e) => setFullSupplier((s) => ({ ...s, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  const r = await doUpsertSupplier({
                    data: {
                      companyId: companyId!,
                      name: fullSupplier.name,
                      email: fullSupplier.email,
                      phone: fullSupplier.phone,
                      taxNumber: fullSupplier.taxNumber,
                      paymentTermsDays: Number(fullSupplier.paymentTermsDays) || 30,
                      billingAddressLine1: fullSupplier.billingAddressLine1,
                      billingCity: fullSupplier.billingCity,
                      billingRegion: fullSupplier.billingRegion,
                      billingPostal: fullSupplier.billingPostal,
                      billingCountry: fullSupplier.billingCountry,
                      defaultCurrency: fullSupplier.defaultCurrency,
                    },
                  });
                  await suppliersQ.refetch();
                  onSupplierChange(r.id);
                  setFullSupplierOpen(false);
                  toast.success("Supplier created");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create &amp; select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New payment term */}
      <Dialog open={newTermOpen} onOpenChange={setNewTermOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create payment term</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={newTerm.name}
                onChange={(e) => setNewTerm((t) => ({ ...t, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Due days</Label>
              <Input
                value={newTerm.days}
                onChange={(e) => setNewTerm((t) => ({ ...t, days: e.target.value }))}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1">
              <Label>Calculation method</Label>
              <Select
                value={newTerm.calculationMethod}
                onValueChange={(v) => setNewTerm((t) => ({ ...t, calculationMethod: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="days_after_bill_date">Days after bill date</SelectItem>
                  <SelectItem value="due_on_receipt">Due on receipt</SelectItem>
                  <SelectItem value="days_after_month_end">Days after month end</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  const r = await doCreateTerm({
                    data: {
                      companyId: companyId!,
                      name: newTerm.name,
                      days: Number(newTerm.days) || 0,
                      calculationMethod: newTerm.calculationMethod,
                    },
                  });
                  await termsQ.refetch();
                  setPaymentTermId(r.id);
                  applyDueFromTerms(billDate, r.id);
                  setNewTermOpen(false);
                  toast.success("Payment term created");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Save term
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New item */}
      <Dialog open={newItemOpen} onOpenChange={setNewItemOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create item / service</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={newItem.name}
                onChange={(e) => setNewItem((s) => ({ ...s, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Code</Label>
              <Input
                value={newItem.code}
                onChange={(e) => setNewItem((s) => ({ ...s, code: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Purchase cost</Label>
              <Input
                value={newItem.purchaseCost}
                onChange={(e) => setNewItem((s) => ({ ...s, purchaseCost: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Expense account</Label>
              <EntityCombobox
                options={expenseAccounts.map((a) => ({
                  value: a.id,
                  label: `${a.code} — ${a.name}`,
                }))}
                value={newItem.expenseAccountId}
                onChange={(v) => setNewItem((s) => ({ ...s, expenseAccountId: v }))}
                placeholder="Account"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  const r = await doUpsertProduct({
                    data: {
                      companyId: companyId!,
                      kind: newItem.kind,
                      name: newItem.name,
                      code: newItem.code,
                      description: newItem.description,
                      purchaseCostMinor: Number(toMinorUnits(newItem.purchaseCost || "0", currencyCode)),
                      ...(newItem.expenseAccountId
                        ? { expenseAccountId: newItem.expenseAccountId }
                        : {}),
                      purchaseTaxRateBps: Number(newItem.purchaseTaxBps) || 0,
                    },
                  });
                  await productsQ.refetch();
                  setLines((prev) => {
                    const next = [...prev];
                    const idx = next.findIndex((l) => !l.productId && !l.description.trim());
                    const target = idx >= 0 ? idx : next.length - 1;
                    const p = emptyPurchaseLine();
                    p.productId = r.id;
                    p.description = newItem.name;
                    p.accountId = newItem.expenseAccountId;
                    p.unitPrice = newItem.purchaseCost;
                    p.taxRateBps = newItem.purchaseTaxBps;
                    next[target] = p;
                    return next;
                  });
                  setNewItemOpen(false);
                  toast.success("Item created and selected");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create &amp; select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Make recurring */}
      <Dialog open={recurringOpen} onOpenChange={setRecurringOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make recurring</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Saves the current lines as a recurring template. Generated bills stay drafts unless
            auto-authorise is enabled for your organisation policy.
          </p>
          <div className="grid gap-2">
            <div className="space-y-1">
              <Label>Template name</Label>
              <Input
                value={recurring.name}
                onChange={(e) => setRecurring((r) => ({ ...r, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Frequency</Label>
              <Select
                value={recurring.frequency}
                onValueChange={(v) => setRecurring((r) => ({ ...r, frequency: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Next due date</Label>
              <Input
                type="date"
                value={recurring.nextDueDate}
                onChange={(e) => setRecurring((r) => ({ ...r, nextDueDate: e.target.value }))}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={recurring.autoAuthorise}
                onChange={(e) => setRecurring((r) => ({ ...r, autoAuthorise: e.target.checked }))}
              />
              Auto-authorise generated bills (organisation must permit)
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  if (!contactId) throw new Error("Choose a supplier first");
                  await doCreateRecurring({
                    data: {
                      companyId: companyId!,
                      contactId,
                      name: recurring.name,
                      frequency: recurring.frequency as
                        | "weekly"
                        | "monthly"
                        | "quarterly"
                        | "yearly",
                      nextDueDate: recurring.nextDueDate,
                      currencyCode,
                      autoAuthorise: recurring.autoAuthorise,
                      templateLines: lines.map((l) => ({
                        description: l.description,
                        accountId: l.accountId,
                        quantity: Number(l.quantity),
                        unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currencyCode)),
                        discountMinor: Number(toMinorUnits(l.discount || "0", currencyCode)),
                        taxRateBps: Number(l.taxRateBps || 0),
                      })),
                    },
                  });
                  setRecurringOpen(false);
                  toast.success("Recurring bill template created");
                  navigate({ to: "/purchases/recurring" });
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Print preview */}
      <Dialog open={printOpen} onOpenChange={setPrintOpen}>
        <DialogContent className="max-w-2xl print:max-w-none">
          <DialogHeader>
            <DialogTitle>Bill {billId ? "(saved)" : "(unsaved preview)"}</DialogTitle>
          </DialogHeader>
          <div id="bill-print-area" className="space-y-3 text-sm">
            <p className="text-lg font-semibold">{company?.name ?? "Organisation"}</p>
            <p>
              Supplier: {suppliers.find((s) => s.id === contactId)?.name ?? "—"}
              <br />
              {[addr.line1, addr.line2, addr.city, addr.region, addr.postal, addr.country]
                .filter(Boolean)
                .join(", ")}
            </p>
            <p>
              Bill date: {billDate} · Due: {dueDate} · Currency: {currencyCode}
              <br />
              Supplier invoice #: {supplierInvoiceNumber || "—"}
              <br />
              Reference: {memo || "—"}
            </p>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-1">Description</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b">
                    <td className="py-1">{l.description || "—"}</td>
                    <td>{l.quantity}</td>
                    <td>{l.unitPrice}</td>
                    <td className="text-right">
                      {(() => {
                        try {
                          const t = computeBillTotals(
                            [
                              {
                                quantity: Number(l.quantity),
                                unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currencyCode)),
                                discountMinor: Number(toMinorUnits(l.discount || "0", currencyCode)),
                                taxRateBps: Number(l.taxRateBps || 0),
                              },
                            ],
                            taxCalculation,
                          );
                          return fromMinorUnits(t.total_minor, currencyCode);
                        } catch {
                          return "—";
                        }
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalsPreview ? (
              <div className="text-right space-y-1">
                <p>Subtotal {fromMinorUnits(totalsPreview.subtotal_minor, currencyCode)}</p>
                <p>Tax {fromMinorUnits(totalsPreview.tax_minor, currencyCode)}</p>
                <p className="font-semibold">
                  Total {fromMinorUnits(totalsPreview.total_minor, currencyCode)}
                </p>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Internal notes and audit history are not included on this document.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                const el = document.getElementById("bill-print-area");
                if (!el) return;
                const w = window.open("", "_blank", "noopener,noreferrer");
                if (!w) return;
                w.document.write(
                  `<!doctype html><html><head><title>Bill</title><style>
                    body{font-family:system-ui,sans-serif;padding:24px;color:#111}
                    table{width:100%;border-collapse:collapse}
                    th,td{padding:4px 8px;border-bottom:1px solid #ddd;text-align:left}
                    @media print{body{padding:0}}
                  </style></head><body>${el.innerHTML}</body></html>`,
                );
                w.document.close();
                w.focus();
                w.print();
              }}
            >
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inline Add New — account */}
      <Dialog open={newAccountOpen} onOpenChange={setNewAccountOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add new account</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="space-y-1">
              <Label>Code</Label>
              <Input
                value={newAccount.code}
                onChange={(e) => setNewAccount((s) => ({ ...s, code: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={newAccount.name}
                onChange={(e) => setNewAccount((s) => ({ ...s, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Type</Label>
              <Select
                value={newAccount.accountType}
                onValueChange={(v) =>
                  setNewAccount((s) => ({ ...s, accountType: v as "expense" | "asset" }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="expense">Expense</SelectItem>
                  <SelectItem value="asset">Asset</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  const row = await doCreateAccount({
                    data: {
                      companyId: companyId!,
                      code: newAccount.code,
                      name: newAccount.name,
                      accountType: newAccount.accountType,
                    },
                  });
                  await accountsQ.refetch();
                  setLines((prev) => {
                    const next = [...prev];
                    const idx = next.findIndex((l) => !l.accountId);
                    const target = idx >= 0 ? idx : next.length - 1;
                    next[target] = { ...next[target]!, accountId: row.id };
                    return next;
                  });
                  setNewAccountOpen(false);
                  toast.success("Account created and selected");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create &amp; select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inline Add New — tax */}
      <Dialog open={newTaxOpen} onOpenChange={setNewTaxOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add new tax rate</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="space-y-1">
              <Label>Code</Label>
              <Input
                value={newTax.code}
                onChange={(e) => setNewTax((s) => ({ ...s, code: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={newTax.name}
                onChange={(e) => setNewTax((s) => ({ ...s, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Rate (basis points, 2000 = 20%)</Label>
              <Input
                value={newTax.rateBps}
                onChange={(e) => setNewTax((s) => ({ ...s, rateBps: e.target.value }))}
                inputMode="numeric"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  const rate = await doSaveTaxRate({
                    data: {
                      companyId: companyId!,
                      name: newTax.name || newTax.code,
                      rateBps: Number(newTax.rateBps) || 0,
                      effectiveFrom: billDate || today,
                    },
                  });
                  const code = await doSaveTaxCode({
                    data: {
                      companyId: companyId!,
                      code: newTax.code || newTax.name.slice(0, 8).toUpperCase(),
                      name: newTax.name || newTax.code,
                      taxRateId: rate.id,
                      appliesTo: "purchases",
                    },
                  });
                  await taxCodesQ.refetch();
                  setLines((prev) => {
                    const next = [...prev];
                    const idx = next.length - 1;
                    next[idx] = {
                      ...next[idx]!,
                      taxCodeId: code.id,
                      taxRateBps: String(Number(newTax.rateBps) || 0),
                    };
                    return next;
                  });
                  setNewTaxOpen(false);
                  toast.success("Tax rate created and selected");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create &amp; select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inline Add New — class / location / project */}
      <Dialog open={Boolean(newDimOpen)} onOpenChange={(o) => !o && setNewDimOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Add new {newDimOpen === "class" ? "class" : newDimOpen === "location" ? "location" : "project"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={newDimName} onChange={(e) => setNewDimName(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                if (!newDimOpen || !companyId) return;
                try {
                  const kind = newDimOpen;
                  let cats = (
                    dimsQ.data as {
                      categories: Array<{ id: string; dimension_kind: string; is_active: boolean }>;
                    } | undefined
                  )?.categories.filter((c) => c.is_active && c.dimension_kind === kind);
                  let categoryId = cats?.[0]?.id;
                  if (!categoryId) {
                    const created = await doUpsertDimCategory({
                      data: {
                        companyId,
                        name: kind === "class" ? "Class" : kind === "location" ? "Location" : "Project",
                        dimensionKind: kind,
                      },
                    });
                    categoryId = created.id;
                    await dimsQ.refetch();
                  }
                  const opt = await doUpsertDimOption({
                    data: { companyId, categoryId, name: newDimName.trim() },
                  });
                  await dimsQ.refetch();
                  setLines((prev) => {
                    const next = [...prev];
                    const idx = next.length - 1;
                    const patch =
                      kind === "class"
                        ? { classOptionId: opt.id }
                        : kind === "location"
                          ? { locationOptionId: opt.id }
                          : { projectOptionId: opt.id };
                    next[idx] = { ...next[idx]!, ...patch };
                    return next;
                  });
                  setNewDimName("");
                  setNewDimOpen(null);
                  toast.success("Created and selected");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create &amp; select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newCustomerOpen} onOpenChange={setNewCustomerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add new customer</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              value={newCustomerName}
              onChange={(e) => setNewCustomerName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={async () => {
                try {
                  const r = await doUpsertCustomer({
                    data: { companyId: companyId!, name: newCustomerName.trim() },
                  });
                  await customersQ.refetch();
                  setLines((prev) => {
                    const next = [...prev];
                    const idx = next.length - 1;
                    next[idx] = { ...next[idx]!, customerContactId: r.id };
                    return next;
                  });
                  setNewCustomerOpen(false);
                  setNewCustomerName("");
                  toast.success("Customer created and selected");
                } catch (e) {
                  toast.error(friendlyAuthError(e));
                }
              }}
            >
              Create &amp; select
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
