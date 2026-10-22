import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany, companyContextKey } from "@/hooks/use-active-company";
import {
  getCompanyDetails,
  listCompanyMembers,
  updateCompany,
} from "@/lib/company.functions";
import {
  createExchangeRate,
  getOrgExtendedSettings,
  listCompanyAuditEvents,
  resetDemoCompany,
  setEnabledCurrencies,
  updateDocumentSequence,
  updateLocalization,
  updateMemberRole,
  upsertBranding,
  voidExchangeRate,
} from "@/lib/settings/org-settings.functions";
import {
  canManageCompany,
  countries,
  currencies,
  months,
  roleLabels,
  taxRegimes,
  timezones,
  type CompanyRole,
} from "@/lib/company-constants";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { categoryMeta, type SettingsCategory } from "@/lib/settings/registry";
import { ErrorState, LoadingState, PageHeader } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SettingsDimensionsPanel } from "@/components/settings/SettingsDimensionsPanel";
import {
  SettingsAutomationPanel,
  SettingsIntegrationsPanel,
  SettingsInvitationsPanel,
} from "@/components/settings/SettingsGovernanceExtras";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsOverviewPanel } from "@/components/settings/SettingsOverviewPanel";
import { SettingsFeatureManager } from "@/components/settings/SettingsFeatureManager";
import { SettingsAccountingLocksPanel } from "@/components/settings/SettingsAccountingLocksPanel";
import { SettingsCategoryConfigPanel } from "@/components/settings/SettingsCategoryConfigPanel";
import { SettingsUnavailablePanel } from "@/components/settings/SettingsUnavailablePanel";
import { SettingsCommandPalette } from "@/components/settings/SettingsCommandPalette";
import { maxFiscalYearEndDay, formatDocumentNumberPreview } from "@/lib/settings/dimension-helpers";

const LEGACY_TAB_BY_SECTION: Partial<Record<SettingsCategory, string>> = {
  organisation: "organisation",
  accounting: "financial",
  dimensions: "dimensions",
  documents: "documents",
  currencies: "currencies",
  users: "users",
  automation: "automation",
  integrations: "integrations",
  audit: "audit",
  demo: "demo",
};

const CONFIG_SECTIONS: SettingsCategory[] = [
  "sales",
  "purchases",
  "banking",
  "tax",
  "products",
  "reports",
  "contacts",
  "expenses",
  "notifications",
  "import_migration",
  "accountant",
];

const UNAVAILABLE_SECTIONS: SettingsCategory[] = [
  "subscription",
  "portals",
  "fixed_assets",
];

export const Route = createFileRoute("/_authenticated/settings")({
  validateSearch: (search: Record<string, unknown>): { section: string } => {
    const raw = search["section"];
    return {
      section: typeof raw === "string" && raw.length > 0 ? raw : "overview",
    };
  },
  head: () => ({
    meta: [
      { title: "Settings — LinkBooks" },
      {
        name: "description",
        content:
          "Settings Centre: organisation governance, feature manager, lock dates, dimensions, documents, FX, users and audit.",
      },
      { property: "og:title", content: "Settings — LinkBooks" },
      {
        property: "og:description",
        content:
          "Settings Centre: organisation governance, feature manager, lock dates, dimensions, documents, FX, users and audit.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { company, isPending: companyPending } = useActiveCompany();
  const companyId = company?.id ?? null;

  if (companyPending) return <LoadingState />;
  if (!companyId) {
    return (
      <>
        <PageHeader title="Settings" description="Choose or create an organisation first." />
        <Alert>
          <AlertTitle>No organisation selected</AlertTitle>
          <AlertDescription>
            <Link className="underline" to="/onboarding">
              Create an organisation
            </Link>{" "}
            to manage settings.
          </AlertDescription>
        </Alert>
      </>
    );
  }

  return <SettingsForCompany companyId={companyId} />;
}

function SettingsForCompany({ companyId }: { companyId: string }) {
  const navigate = useNavigate({ from: "/settings" });
  const { section: sectionRaw } = Route.useSearch();
  const section = (sectionRaw || "overview") as SettingsCategory;
  const [navFilter, setNavFilter] = useState("");
  const [cmdOpen, setCmdOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectSection = (id: string) => {
    void navigate({ search: { section: id } });
  };

  const fetchDetails = useServerFn(getCompanyDetails);
  const saveCompany = useServerFn(updateCompany);
  const fetchMembers = useServerFn(listCompanyMembers);
  const fetchExtended = useServerFn(getOrgExtendedSettings);
  const saveLocalization = useServerFn(updateLocalization);
  const saveBranding = useServerFn(upsertBranding);
  const saveSequence = useServerFn(updateDocumentSequence);
  const saveCurrencies = useServerFn(setEnabledCurrencies);
  const addRate = useServerFn(createExchangeRate);
  const voidRate = useServerFn(voidExchangeRate);
  const changeRole = useServerFn(updateMemberRole);
  const doDemoReset = useServerFn(resetDemoCompany);
  const fetchAudit = useServerFn(listCompanyAuditEvents);
  const queryClient = useQueryClient();

  const detailsQuery = useQuery({
    queryKey: ["company-details", companyId],
    queryFn: () => fetchDetails({ data: { companyId } }),
  });

  const membersQuery = useQuery({
    queryKey: ["company-members", companyId],
    queryFn: () => fetchMembers({ data: { companyId } }),
  });

  const extendedQuery = useQuery({
    queryKey: ["org-extended", companyId],
    queryFn: () => fetchExtended({ data: { companyId } }),
  });

  const [auditAction, setAuditAction] = useState("");
  const [auditEntity, setAuditEntity] = useState("");

  const auditQuery = useQuery({
    queryKey: ["org-audit", companyId, auditAction, auditEntity],
    queryFn: () =>
      fetchAudit({
        data: {
          companyId,
          limit: 80,
          ...(auditAction ? { action: auditAction } : {}),
          ...(auditEntity ? { entityType: auditEntity } : {}),
        },
      }),
  });

  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [countryCode, setCountryCode] = useState("GB");
  const [currency, setCurrency] = useState("GBP");
  const [timezone, setTimezone] = useState("Europe/London");
  const [fyMonth, setFyMonth] = useState("3");
  const [fyDay, setFyDay] = useState("31");
  const [taxRegime, setTaxRegime] = useState("none");
  const [regNumber, setRegNumber] = useState("");
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false);

  const [locale, setLocale] = useState("en-GB");
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [invoiceFooter, setInvoiceFooter] = useState("");
  const [themeColor, setThemeColor] = useState("#0F766E");
  const [tradingName, setTradingName] = useState("");
  const [letterhead, setLetterhead] = useState("");
  const [invoiceEmail, setInvoiceEmail] = useState("");
  const [invoicePhone, setInvoicePhone] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [enabledFx, setEnabledFx] = useState<string[]>([]);
  const [rateFrom, setRateFrom] = useState("USD");
  const [rateDate, setRateDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rateValue, setRateValue] = useState("1.25");

  useEffect(() => {
    const d = detailsQuery.data;
    if (!d) return;
    setName(d.name);
    setLegalName(d.legal_name ?? "");
    setCountryCode(d.country_code);
    setCurrency(d.base_currency);
    setTimezone(d.timezone);
    setFyMonth(String(d.fiscal_year_end_month));
    setFyDay(String(d.fiscal_year_end_day));
    setTaxRegime(d.tax?.tax_regime ?? "none");
    setRegNumber(d.tax?.registration_number ?? "");
    setPricesIncludeTax(Boolean(d.tax?.prices_include_tax));
  }, [detailsQuery.data]);

  useEffect(() => {
    const e = extendedQuery.data;
    if (!e?.company) return;
    setLocale(e.company.locale || "en-GB");
    setDateFormat(e.company.date_format || "DD/MM/YYYY");
    setInvoiceFooter(e.company.invoice_footer || "");
    setThemeColor(e.company.document_theme_color || "#0F766E");
    setTradingName(e.branding.trading_name ?? "");
    setLetterhead(e.branding.letterhead_line ?? "");
    setInvoiceEmail(e.branding.invoice_email ?? "");
    setInvoicePhone(e.branding.invoice_phone ?? "");
    setLogoUrl(e.branding.logo_url ?? "");
    setEnabledFx(e.enabledCurrencies);
  }, [extendedQuery.data]);

  const canEdit = canManageCompany(detailsQuery.data?.role);
  const isDemo = Boolean(detailsQuery.data?.is_demo);
  const maxDay = useMemo(() => maxFiscalYearEndDay(Number(fyMonth)), [fyMonth]);
  const baseCurrency = detailsQuery.data?.base_currency ?? "GBP";

  const saveMutation = useMutation({
    mutationFn: () =>
      saveCompany({
        data: {
          companyId,
          name,
          legal_name: legalName,
          country_code: countryCode,
          base_currency: currency,
          fiscal_year_end_month: Number(fyMonth),
          fiscal_year_end_day: Number(fyDay),
          timezone,
          tax_regime: taxRegime,
          registration_number: regNumber,
          prices_include_tax: pricesIncludeTax,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["company-details", companyId] });
      await queryClient.invalidateQueries({ queryKey: companyContextKey });
      toast.success("Organisation settings saved");
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const localizationM = useMutation({
    mutationFn: () =>
      saveLocalization({
        data: {
          companyId,
          locale,
          date_format: dateFormat,
          invoice_footer: invoiceFooter,
          document_theme_color: themeColor,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["org-extended", companyId] });
      toast.success("Localization saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const brandingM = useMutation({
    mutationFn: () =>
      saveBranding({
        data: {
          companyId,
          trading_name: tradingName,
          letterhead_line: letterhead,
          invoice_email: invoiceEmail,
          invoice_phone: invoicePhone,
          logo_url: logoUrl,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["org-extended", companyId] });
      toast.success("Document branding saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const currenciesM = useMutation({
    mutationFn: () => saveCurrencies({ data: { companyId, currencies: enabledFx } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["org-extended", companyId] });
      toast.success("Enabled currencies saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rateM = useMutation({
    mutationFn: () =>
      addRate({
        data: {
          companyId,
          from_currency: rateFrom,
          to_currency: baseCurrency,
          rate_date: rateDate,
          rate: rateValue,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["org-extended", companyId] });
      toast.success("Exchange rate recorded (immutable)");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const demoResetM = useMutation({
    mutationFn: () => doDemoReset({ data: { companyId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.success("Demo Company reset — transactional data cleared and masters reseeded");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (detailsQuery.isPending) return <LoadingState />;
  if (detailsQuery.isError) {
    return (
      <ErrorState
        title="Could not load organisation settings"
        description={friendlyAuthError(detailsQuery.error)}
        onRetry={() => detailsQuery.refetch()}
      />
    );
  }

  const legacyTab = LEGACY_TAB_BY_SECTION[section];
  const sectionMeta = categoryMeta.find((c) => c.id === section);
  const showLegacy = Boolean(legacyTab);

  return (
    <>
      <PageHeader
        title="Settings Centre"
        description="Organisation configuration — search with Ctrl/Cmd+K. Preferences never override posting, period locks or journal immutability."
        actions={
          <Button variant="outline" size="sm" onClick={() => setCmdOpen(true)}>
            <Search className="mr-1.5 size-3.5" />
            Search
            <kbd className="ml-2 hidden rounded border px-1 text-[10px] sm:inline">⌘K</kbd>
          </Button>
        }
      />

      <SettingsCommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        onSelectSection={selectSection}
      />

      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Input
            value={navFilter}
            onChange={(e) => setNavFilter(e.target.value)}
            placeholder="Filter categories…"
            aria-label="Filter settings categories"
          />
          <SettingsNav
            section={section}
            onSelect={selectSection}
            showDemo={isDemo}
            filter={navFilter}
          />
        </aside>

        <div className="min-w-0 space-y-4">
          {section === "overview" ? (
            <SettingsOverviewPanel companyId={companyId} onNavigate={selectSection} />
          ) : null}
          {section === "features" ? (
            <SettingsFeatureManager companyId={companyId} canEdit={canEdit} />
          ) : null}
          {UNAVAILABLE_SECTIONS.includes(section) && sectionMeta ? (
            <SettingsUnavailablePanel meta={sectionMeta} />
          ) : null}
          {CONFIG_SECTIONS.includes(section) ? (
            <SettingsCategoryConfigPanel
              companyId={companyId}
              category={section}
              canEdit={canEdit}
            />
          ) : null}

          {showLegacy ? (
            <Tabs
              value={legacyTab}
              onValueChange={(v) => {
                const entry = Object.entries(LEGACY_TAB_BY_SECTION).find(([, tab]) => tab === v);
                if (entry) selectSection(entry[0]);
              }}
            >
              <TabsList className="flex h-auto flex-wrap gap-1">
                <TabsTrigger value="organisation">Organisation</TabsTrigger>
                <TabsTrigger value="financial">Financial</TabsTrigger>
                <TabsTrigger value="dimensions">Dimensions</TabsTrigger>
                <TabsTrigger value="documents">Documents</TabsTrigger>
                <TabsTrigger value="currencies">Currencies</TabsTrigger>
                <TabsTrigger value="users">Users</TabsTrigger>
                <TabsTrigger value="automation">Automation</TabsTrigger>
                <TabsTrigger value="integrations">Integrations</TabsTrigger>
                <TabsTrigger value="audit">Audit</TabsTrigger>
                {isDemo ? <TabsTrigger value="demo">Demo</TabsTrigger> : null}
              </TabsList>

              {section === "accounting" ? (
                <div className="mt-4">
                  <SettingsAccountingLocksPanel
                    companyId={companyId}
                    canEdit={canEdit}
                    canLock={canEdit}
                  />
                </div>
              ) : null}

        <TabsContent value="organisation" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Organisation details</CardTitle>
              <CardDescription>Legal profile shown on invoices and reports.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="org-name">Organisation name</Label>
                <Input
                  id="org-name"
                  value={name}
                  disabled={!canEdit || saveMutation.isPending}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-legal">Legal name</Label>
                <Input
                  id="org-legal"
                  value={legalName}
                  disabled={!canEdit || saveMutation.isPending}
                  onChange={(e) => setLegalName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-country">Country</Label>
                <Select
                  value={countryCode}
                  disabled={!canEdit || saveMutation.isPending}
                  onValueChange={setCountryCode}
                >
                  <SelectTrigger id="org-country">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {countries.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Tax regime</Label>
                <Select
                  value={taxRegime}
                  disabled={!canEdit || saveMutation.isPending}
                  onValueChange={setTaxRegime}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {taxRegimes.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="tax-reg">Tax registration number</Label>
                <Input
                  id="tax-reg"
                  value={regNumber}
                  disabled={!canEdit || saveMutation.isPending}
                  onChange={(e) => setRegNumber(e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between gap-4 sm:col-span-2">
                <Label className="font-normal">Prices include tax by default</Label>
                <Switch
                  checked={pricesIncludeTax}
                  disabled={!canEdit || saveMutation.isPending}
                  onCheckedChange={setPricesIncludeTax}
                />
              </div>
              <div className="sm:col-span-2">
                {canEdit ? (
                  <Button size="sm" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                    {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save changes
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Only owners and administrators can edit organisation settings.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Localization</CardTitle>
              <CardDescription>Display preferences only — ledger dates remain ISO.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Locale</Label>
                <Select value={locale} disabled={!canEdit} onValueChange={setLocale}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(extendedQuery.data?.locales ?? ["en-GB"]).map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date format</Label>
                <Select value={dateFormat} disabled={!canEdit} onValueChange={setDateFormat}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(extendedQuery.data?.dateFormats ?? ["DD/MM/YYYY"]).map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Document theme colour</Label>
                <Input value={themeColor} disabled={!canEdit} onChange={(e) => setThemeColor(e.target.value)} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Default invoice footer</Label>
                <Input
                  value={invoiceFooter}
                  disabled={!canEdit}
                  onChange={(e) => setInvoiceFooter(e.target.value)}
                />
              </div>
              {canEdit ? (
                <Button size="sm" disabled={localizationM.isPending} onClick={() => localizationM.mutate()}>
                  Save localization
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="financial" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Financial settings</CardTitle>
              <CardDescription>
                Base currency, financial year and time zone. Period locks are managed under Accounting.
                Base currency cannot change after journals are posted.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Base currency</Label>
                <Select
                  value={currency}
                  disabled={!canEdit || saveMutation.isPending}
                  onValueChange={setCurrency}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Time zone</Label>
                <Select
                  value={timezone}
                  disabled={!canEdit || saveMutation.isPending}
                  onValueChange={setTimezone}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timezones.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Financial year end month</Label>
                <Select
                  value={fyMonth}
                  disabled={!canEdit || saveMutation.isPending}
                  onValueChange={(m) => {
                    setFyMonth(m);
                    const max = maxFiscalYearEndDay(Number(m));
                    if (Number(fyDay) > max) setFyDay(String(max));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="fy-day">Financial year end day</Label>
                <Input
                  id="fy-day"
                  type="number"
                  min={1}
                  max={maxDay}
                  value={fyDay}
                  disabled={!canEdit || saveMutation.isPending}
                  onChange={(e) => setFyDay(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2 space-y-2 text-sm text-muted-foreground">
                <p>
                  Tax rates and codes:{" "}
                  <Link className="underline" to="/tax">
                    Tax settings
                  </Link>
                  . Accounting periods:{" "}
                  <Link className="underline" to="/accounting">
                    Accounting
                  </Link>
                  .
                </p>
              </div>
              <div className="sm:col-span-2">
                {canEdit ? (
                  <Button size="sm" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                    {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save financial settings
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="dimensions" className="mt-4">
          <SettingsDimensionsPanel companyId={companyId} canEdit={canEdit} currency={baseCurrency} />
        </TabsContent>

        <TabsContent value="documents" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Document branding</CardTitle>
              <CardDescription>Letterhead and contact details for customer-facing documents.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Trading name</Label>
                <Input value={tradingName} disabled={!canEdit} onChange={(e) => setTradingName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Letterhead line</Label>
                <Input value={letterhead} disabled={!canEdit} onChange={(e) => setLetterhead(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Invoice email</Label>
                <Input value={invoiceEmail} disabled={!canEdit} onChange={(e) => setInvoiceEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Invoice phone</Label>
                <Input value={invoicePhone} disabled={!canEdit} onChange={(e) => setInvoicePhone(e.target.value)} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Logo URL</Label>
                <Input
                  value={logoUrl}
                  disabled={!canEdit}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://… (no file upload integration yet)"
                />
              </div>
              {canEdit ? (
                <Button size="sm" disabled={brandingM.isPending} onClick={() => brandingM.mutate()}>
                  Save branding
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Invoice and bill numbering</CardTitle>
              <CardDescription>
                Prefix, next number and zero-padding per document type. Allocation uses a concurrency-safe
                database function when creating invoices/bills without a manual number. Changing next
                number never renumbers historical documents.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {extendedQuery.isPending ? (
                <LoadingState rows={3} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Prefix</TableHead>
                      <TableHead>Next</TableHead>
                      <TableHead>Padding</TableHead>
                      <TableHead>Preview</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(extendedQuery.data?.sequences ?? []).map((seq) => (
                      <SequenceRow
                        key={seq.document_type}
                        seq={seq}
                        disabled={!canEdit}
                        onSave={(patch) =>
                          saveSequence({
                            data: { companyId, ...seq, ...patch },
                          }).then(async () => {
                            await queryClient.invalidateQueries({ queryKey: ["org-extended", companyId] });
                            toast.success("Sequence updated");
                          })
                        }
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="currencies" className="mt-4 space-y-4">
          <Alert>
            <AlertTitle>FX policy</AlertTitle>
            <AlertDescription>
              Rates are append-only. Posted journals keep their snapshot{" "}
              <code className="text-xs">fx_rate_to_base</code>. Void a rate to stop new lookups —
              historical journals are never rewritten. See{" "}
              <span className="font-medium">docs/settings-fx-firm/FX_ACCOUNTING_POLICY.md</span>.
            </AlertDescription>
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Enabled transaction currencies</CardTitle>
              <CardDescription>Base currency {baseCurrency} is always available.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-3">
                {currencies
                  .filter((c) => c !== baseCurrency)
                  .map((c) => (
                    <label key={c} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={enabledFx.includes(c)}
                        disabled={!canEdit}
                        onChange={(e) => {
                          setEnabledFx((prev) =>
                            e.target.checked ? [...prev, c] : prev.filter((x) => x !== c),
                          );
                        }}
                      />
                      {c}
                    </label>
                  ))}
              </div>
              {canEdit ? (
                <Button size="sm" disabled={currenciesM.isPending} onClick={() => currenciesM.mutate()}>
                  Save currencies
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recorded exchange rates</CardTitle>
              <CardDescription>
                Rate = units of {baseCurrency} per 1 unit of foreign currency, as-of date.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {canEdit ? (
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="space-y-1">
                    <Label>From</Label>
                    <Select value={rateFrom} onValueChange={setRateFrom}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {currencies
                          .filter((c) => c !== baseCurrency)
                          .map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Date</Label>
                    <Input type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>Rate → {baseCurrency}</Label>
                    <Input value={rateValue} onChange={(e) => setRateValue(e.target.value)} />
                  </div>
                  <div className="flex items-end">
                    <Button size="sm" disabled={rateM.isPending} onClick={() => rateM.mutate()}>
                      Record rate
                    </Button>
                  </div>
                </div>
              ) : null}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Pair</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(extendedQuery.data?.exchangeRates ?? []).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.rate_date}</TableCell>
                      <TableCell>
                        {r.from_currency}/{r.to_currency}
                      </TableCell>
                      <TableCell>{r.rate}</TableCell>
                      <TableCell>{r.voided_at ? "Voided" : "Active"}</TableCell>
                      <TableCell>
                        {canEdit && !r.voided_at ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              voidRate({ data: { rateId: r.id } }).then(async () => {
                                await queryClient.invalidateQueries({ queryKey: ["org-extended", companyId] });
                                toast.success("Rate voided");
                              })
                            }
                          >
                            Void
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Users and roles</CardTitle>
              <CardDescription>
                Least-privilege roles. Last owner is protected. Permissions are enforced server-side.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {membersQuery.isPending ? (
                <LoadingState rows={3} />
              ) : membersQuery.isError ? (
                <ErrorState
                  title="Could not load members"
                  description={friendlyAuthError(membersQuery.error)}
                  onRetry={() => membersQuery.refetch()}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(membersQuery.data ?? []).map((m) => (
                      <TableRow key={m.user_id}>
                        <TableCell>
                          {m.full_name || "—"}
                          {m.is_you ? " (you)" : ""}
                        </TableCell>
                        <TableCell>{m.email || "—"}</TableCell>
                        <TableCell>
                          {canEdit && !m.is_you ? (
                            <Select
                              value={m.role}
                              onValueChange={(role) =>
                                changeRole({
                                  data: { companyId, userId: m.user_id, role: role as CompanyRole },
                                })
                                  .then(async () => {
                                    await queryClient.invalidateQueries({
                                      queryKey: ["company-members", companyId],
                                    });
                                    toast.success("Role updated");
                                  })
                                  .catch((e) => toast.error(friendlyAuthError(e)))
                              }
                            >
                              <SelectTrigger className="w-40">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(Object.keys(roleLabels) as CompanyRole[]).map((r) => (
                                  <SelectItem key={r} value={r}>
                                    {roleLabels[r]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            roleLabels[m.role] ?? m.role
                          )}
                        </TableCell>
                        <TableCell className="capitalize">{m.status}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <SettingsInvitationsPanel companyId={companyId} canEdit={canEdit} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="automation" className="mt-4 space-y-4">
          <SettingsAutomationPanel companyId={companyId} canEdit={canEdit} />
        </TabsContent>

        <TabsContent value="integrations" className="mt-4">
          <SettingsIntegrationsPanel />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Audit history</CardTitle>
              <CardDescription>
                Append-only financial and administrative actions. Filter to reduce noise from
                journal.posted / demo.seed bursts. Secrets are stripped server-side.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  placeholder="Filter action (e.g. settings, members, journal)"
                  value={auditAction}
                  onChange={(e) => setAuditAction(e.target.value)}
                />
                <Input
                  placeholder="Entity type (e.g. company, exchange_rate)"
                  value={auditEntity}
                  onChange={(e) => setAuditEntity(e.target.value)}
                />
              </div>
              {auditQuery.isPending ? (
                <LoadingState rows={4} />
              ) : auditQuery.isError ? (
                <ErrorState
                  title="Could not load audit"
                  description={friendlyAuthError(auditQuery.error)}
                  onRetry={() => auditQuery.refetch()}
                />
              ) : (auditQuery.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No events match these filters.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Actor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(auditQuery.data ?? []).map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(a.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell>{a.action}</TableCell>
                        <TableCell className="text-xs">
                          {a.entity_type}
                          {a.entity_id ? ` · ${a.entity_id.slice(0, 8)}…` : ""}
                        </TableCell>
                        <TableCell className="text-xs">{a.actor_user_id?.slice(0, 8) ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {isDemo ? (
          <TabsContent value="demo" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Demo Company reset & reseed</CardTitle>
                <CardDescription>
                  Clears transactional data for this demo organisation only, reseeds chart of
                  accounts / periods, then posts the canonical sample ledger through the real
                  PostingEngine (invoices, bills, bank, journals). Cannot target non-demo
                  organisations or touch production customer data.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  After reset, Trial Balance / P&amp;L / Balance Sheet should match the known demo
                  dataset (see docs/demo/).
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={demoResetM.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Reset and reseed Demo Company? Sample journals and documents will be replaced. Live organisations are never affected.",
                      )
                    ) {
                      demoResetM.mutate();
                    }
                  }}
                >
                  {demoResetM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Reset & reseed demo data
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        ) : null}
      </Tabs>
          ) : null}
        </div>
      </div>
    </>
  );
}

function SequenceRow({
  seq,
  disabled,
  onSave,
}: {
  seq: { document_type: string; prefix: string; next_number: number; padding: number };
  disabled: boolean;
  onSave: (patch: { prefix: string; next_number: number; padding: number }) => Promise<unknown>;
}) {
  const [prefix, setPrefix] = useState(seq.prefix);
  const [next, setNext] = useState(String(seq.next_number));
  const [pad, setPad] = useState(String(seq.padding));
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setPrefix(seq.prefix);
    setNext(String(seq.next_number));
    setPad(String(seq.padding));
  }, [seq]);

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{seq.document_type}</TableCell>
      <TableCell>
        <Input className="h-8 w-24" value={prefix} disabled={disabled} onChange={(e) => setPrefix(e.target.value)} />
      </TableCell>
      <TableCell>
        <Input className="h-8 w-20" value={next} disabled={disabled} onChange={(e) => setNext(e.target.value)} />
      </TableCell>
      <TableCell>
        <Input className="h-8 w-16" value={pad} disabled={disabled} onChange={(e) => setPad(e.target.value)} />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {formatDocumentNumberPreview(prefix, Number(next) || 1, Number(pad) || 4)}
      </TableCell>
      <TableCell>
        {disabled ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                await onSave({
                  prefix,
                  next_number: Number(next),
                  padding: Number(pad),
                });
              } catch (e) {
                toast.error(friendlyAuthError(e));
              } finally {
                setPending(false);
              }
            }}
          >
            Save
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
