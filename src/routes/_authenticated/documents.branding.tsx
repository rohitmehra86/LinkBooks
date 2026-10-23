import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { getBrandingSettings, saveBrandingSettings } from "@/lib/documents/documents.functions";
import { safeAccentColor, textToLines } from "@/lib/documents/helpers";
import type { DocumentBranding, PrintDocument } from "@/lib/documents/types";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { DocumentSheet } from "@/components/documents/DocumentSheet";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/documents/branding")({
  head: () => ({ meta: [{ title: "Document branding — LinkBooks" }] }),
  component: BrandingPage,
});

const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

type FormState = {
  tradingName: string;
  letterheadLine: string;
  invoiceEmail: string;
  invoicePhone: string;
  addressText: string;
  taxNumber: string;
  bankDetails: string;
  paymentInstructions: string;
  defaultNotes: string;
  accentColor: string;
  footerText: string;
};

const EMPTY: FormState = {
  tradingName: "",
  letterheadLine: "",
  invoiceEmail: "",
  invoicePhone: "",
  addressText: "",
  taxNumber: "",
  bankDetails: "",
  paymentInstructions: "",
  defaultNotes: "",
  accentColor: "#0F766E",
  footerText: "",
};

function BrandingPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const { can } = useCan();
  const canEdit = can("company.settings.edit");
  const queryClient = useQueryClient();
  const fetchSettings = useServerFn(getBrandingSettings);
  const save = useServerFn(saveBrandingSettings);
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [logoPath, setLogoPath] = useState<string | null | undefined>(undefined);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["branding-settings", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSettings({ data: { companyId: companyId! } }),
  });

  useEffect(() => {
    if (!q.data || loaded) return;
    const d = q.data;
    setForm({
      tradingName: d.tradingName,
      letterheadLine: d.letterheadLine,
      invoiceEmail: d.invoiceEmail,
      invoicePhone: d.invoicePhone,
      addressText: d.addressText,
      taxNumber: d.taxNumber,
      bankDetails: d.bankDetails,
      paymentInstructions: d.paymentInstructions,
      defaultNotes: d.defaultNotes,
      accentColor: d.accentColor,
      footerText: d.footerText,
    });
    setLogoPreview(d.logoPreviewUrl);
    setLoaded(true);
  }, [q.data, loaded]);

  const set = (k: keyof FormState) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const saveM = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId: companyId!,
          ...form,
          ...(logoPath !== undefined ? { logoPath } : {}),
        },
      }),
    onSuccess: async () => {
      setError(null);
      setLogoPath(undefined);
      await queryClient.invalidateQueries({ queryKey: ["branding-settings", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["printable-document", companyId] });
      toast.success("Document branding saved");
    },
    onError: (e) => setError(friendlyAuthError(e)),
  });

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const ext = LOGO_TYPES[file.type];
      if (!ext) throw new Error("Logo must be a PNG, JPEG, WebP or GIF image.");
      if (file.size > LOGO_MAX_BYTES) throw new Error("Logo must be 2 MB or smaller.");
      const path = `${companyId}/logo-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("org-logos")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) {
        if (/row-level security|not authorized|unauthorized/i.test(upErr.message)) {
          throw new Error("You do not have permission to change the logo.");
        }
        throw new Error(upErr.message);
      }
      return { path, preview: URL.createObjectURL(file) };
    },
    onSuccess: ({ path, preview }) => {
      setError(null);
      setLogoPath(path);
      setLogoPreview(preview);
      toast.message("Logo ready — save to apply it to your documents.");
    },
    onError: (e) => setError(friendlyAuthError(e)),
  });

  const preview = useMemo(
    () => buildPreview(form, logoPreview, company?.name ?? ""),
    [form, logoPreview, company?.name],
  );

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not load branding"
        description={friendlyAuthError(q.error)}
        onRetry={() => q.refetch()}
      />
    );

  return (
    <>
      <PageHeader
        title="Document branding"
        description="Logo, colours, address, tax and bank details printed on invoices, credit notes, quotes, statements and other documents."
      />
      {q.data.extendedFieldsAvailable === false ? (
        <Alert className="mb-4">
          <AlertTitle>Database update needed</AlertTitle>
          <AlertDescription>
            Address, tax number, bank details and logo upload need migration 20261025200000. Ask an
            administrator to apply the latest migrations before saving.
          </AlertDescription>
        </Alert>
      ) : null}
      {!canEdit ? (
        <p className="mb-4 text-sm text-muted-foreground">
          You can view branding but only an administrator can change it.
        </p>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Logo</Label>
              <div className="flex items-center gap-3">
                {logoPreview ? (
                  <img
                    src={logoPreview}
                    alt="Current logo"
                    className="max-h-14 max-w-[160px] object-contain"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">No logo</span>
                )}
                {canEdit ? (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      hidden
                      accept={Object.keys(LOGO_TYPES).join(",")}
                      aria-label="Choose a logo image"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadM.mutate(f);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={uploadM.isPending}
                      onClick={() => fileRef.current?.click()}
                    >
                      {uploadM.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
                      {logoPreview ? "Replace" : "Upload logo"}
                    </Button>
                    {logoPreview ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setLogoPath(null);
                          setLogoPreview(null);
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 2 MB.</p>
            </div>
            <Field
              label="Trading name"
              value={form.tradingName}
              onChange={set("tradingName")}
              disabled={!canEdit}
            />
            <Field
              label="Letterhead line"
              value={form.letterheadLine}
              onChange={set("letterheadLine")}
              disabled={!canEdit}
            />
            <Area
              label="Address"
              rows={3}
              value={form.addressText}
              onChange={set("addressText")}
              disabled={!canEdit}
            />
            <Field
              label="Tax / VAT number"
              value={form.taxNumber}
              onChange={set("taxNumber")}
              disabled={!canEdit}
            />
            <p className="-mt-2 text-xs text-muted-foreground">
              Documents are titled “Tax invoice” only when a tax number is set.
            </p>
            <Field
              label="Invoice email"
              value={form.invoiceEmail}
              onChange={set("invoiceEmail")}
              disabled={!canEdit}
            />
            <Field
              label="Invoice phone"
              value={form.invoicePhone}
              onChange={set("invoicePhone")}
              disabled={!canEdit}
            />
            <Area
              label="Bank details"
              rows={3}
              value={form.bankDetails}
              onChange={set("bankDetails")}
              disabled={!canEdit}
            />
            <Area
              label="Payment instructions"
              rows={2}
              value={form.paymentInstructions}
              onChange={set("paymentInstructions")}
              disabled={!canEdit}
            />
            <Area
              label="Default notes"
              rows={2}
              value={form.defaultNotes}
              onChange={set("defaultNotes")}
              disabled={!canEdit}
            />
            <Area
              label="Footer text"
              rows={2}
              value={form.footerText}
              onChange={set("footerText")}
              disabled={!canEdit}
            />
            <div className="space-y-2">
              <Label htmlFor="accent">Accent colour</Label>
              <div className="flex items-center gap-3">
                <input
                  id="accent"
                  type="color"
                  value={safeAccentColor(form.accentColor)}
                  disabled={!canEdit}
                  onChange={(e) => set("accentColor")(e.target.value.toUpperCase())}
                  className="h-9 w-14 cursor-pointer rounded border border-input bg-background p-1"
                />
                <Input
                  className="w-28"
                  value={form.accentColor}
                  disabled={!canEdit}
                  onChange={(e) => set("accentColor")(e.target.value)}
                  aria-label="Accent colour hex"
                />
              </div>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {canEdit ? (
              <Button disabled={saveM.isPending} onClick={() => saveM.mutate()}>
                {saveM.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
                Save branding
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <div>
          <p className="mb-2 text-xs text-muted-foreground">
            Preview with sample data (not a real document).
          </p>
          <DocumentSheet
            document={preview.document}
            branding={preview.branding}
            locale="en-GB"
            dateFormat={null}
          />
        </div>
      </div>
    </>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const id = `f-${props.label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

function Area(props: {
  label: string;
  rows: number;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const id = `f-${props.label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{props.label}</Label>
      <Textarea
        id={id}
        rows={props.rows}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

function buildPreview(form: FormState, logoUrl: string | null, companyName: string) {
  const branding: DocumentBranding = {
    displayName: form.tradingName.trim() || companyName || "Your company",
    legalName: null,
    addressLines: textToLines(form.addressText),
    taxNumber: form.taxNumber.trim() || null,
    email: form.invoiceEmail.trim() || null,
    phone: form.invoicePhone.trim() || null,
    logoUrl,
    accentColor: safeAccentColor(form.accentColor),
    footerText: form.footerText.trim() || null,
    bankDetails: form.bankDetails.trim() || null,
    paymentInstructions: form.paymentInstructions.trim() || null,
    defaultNotes: form.defaultNotes.trim() || null,
    letterheadLine: form.letterheadLine.trim() || null,
  };
  const net = 120000;
  const tax = 24000;
  const document: PrintDocument = {
    kind: "sales_invoice",
    id: "preview",
    title: branding.taxNumber ? "Tax invoice" : "Invoice",
    number: "INV-0001",
    status: "authorised",
    mark: null,
    currency: "GBP",
    fxRateToBase: null,
    baseCurrency: "GBP",
    issueDate: "2026-10-23",
    dueDate: "2026-11-22",
    expiryDate: null,
    reference: "SAMPLE",
    party: {
      roleLabel: "Bill to",
      name: "Sample Customer Ltd",
      addressLines: ["1 Example Street", "London"],
      email: null,
      phone: null,
      taxNumber: null,
    },
    lines: [
      {
        description: "Consulting services (sample)",
        quantity: 10,
        unitPriceMinor: 12000,
        discountMinor: 0,
        taxRateBps: 2000,
        netMinor: net,
        taxMinor: tax,
        grossMinor: net + tax,
      },
    ],
    showLines: true,
    taxSummary: [{ rateBps: 2000, netMinor: net, taxMinor: tax }],
    totals: {
      subtotalMinor: net,
      taxMinor: tax,
      totalMinor: net + tax,
      paidMinor: 0,
      creditedMinor: 0,
      dueMinor: net + tax,
    },
    allocations: [],
    allocationsTitle: null,
    paymentAmountMinor: null,
    extraMeta: [],
    notes: branding.defaultNotes,
    showPaymentDetails: true,
    paymentTermsText: "Payment due within 30 days",
    partyEmail: null,
    partyId: null,
  };
  return { branding, document };
}
