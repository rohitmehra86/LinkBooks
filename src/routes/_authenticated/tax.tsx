import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  getTaxSettings,
  listTaxCountryPacks,
  seedTaxPack,
  updateTaxSettings,
} from "@/lib/tax/tax.functions";
import { filterTaxAccountPicker, type PickerAccount } from "@/lib/tax/account-pickers";
import { TaxCodesPanel } from "@/components/tax/TaxCodesPanel";
import { TaxRatesPanel } from "@/components/tax/TaxRatesPanel";
import { TaxReturnsPanel } from "@/components/tax/TaxReturnsPanel";
import {
  packsForCountry,
  suggestedRegimeForCountry,
  verificationStatusLabel,
} from "@/lib/tax/country-packs";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/tax")({
  head: () => ({
    meta: [
      { title: "Tax configuration — LinkBooks" },
      {
        name: "description",
        content: "Organisation tax rates, codes and account mappings.",
      },
    ],
  }),
  component: TaxConfigPage,
});

function TaxConfigPage() {
  const { company, isPending } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();

  const fetchSettings = useServerFn(getTaxSettings);
  const saveSettings = useServerFn(updateTaxSettings);
  const doSeed = useServerFn(seedTaxPack);
  const fetchPacks = useServerFn(listTaxCountryPacks);
  const fetchAccounts = useServerFn(listAccounts);
  const orgCountry = company?.country_code ?? "GB";
  const [regDate, setRegDate] = useState("");
  const [selectedPack, setSelectedPack] = useState("");

  const settingsQ = useQuery({
    queryKey: ["tax-settings", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSettings({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const packsQ = useQuery({
    queryKey: ["tax-packs", companyId, orgCountry],
    enabled: Boolean(companyId),
    queryFn: () => fetchPacks({ data: { companyId: companyId!, countryCode: orgCountry } }),
  });

  const [regime, setRegime] = useState("none");
  const [jurisdiction, setJurisdiction] = useState("");
  const [regNumber, setRegNumber] = useState("");
  const [includeTax, setIncludeTax] = useState(false);
  const [basis, setBasis] = useState("invoice");
  const [filing, setFiling] = useState("");
  const [outputAcc, setOutputAcc] = useState("");
  const [inputAcc, setInputAcc] = useState("");
  const [nonRecAcc, setNonRecAcc] = useState("");

  useEffect(() => {
    const s = settingsQ.data as {
      tax_regime: string;
      registration_number: string | null;
      prices_include_tax: boolean;
      tax_basis: string;
      jurisdiction_code: string | null;
      output_tax_account_id: string | null;
      input_tax_account_id: string | null;
      non_recoverable_tax_account_id: string | null;
      filing_frequency: string | null;
    } | null;
    if (!s) return;
    setRegime(s.tax_regime ?? "none");
    setJurisdiction(s.jurisdiction_code ?? "");
    setRegNumber(s.registration_number ?? "");
    setIncludeTax(Boolean(s.prices_include_tax));
    setBasis(s.tax_basis ?? "invoice");
    setOutputAcc(s.output_tax_account_id ?? "");
    setInputAcc(s.input_tax_account_id ?? "");
    setNonRecAcc(s.non_recoverable_tax_account_id ?? "");
    setFiling(s.filing_frequency ?? "");
    setRegDate((s as { registration_date?: string | null }).registration_date ?? "");
  }, [settingsQ.data]);

  // TX-02: each form sends only its own fields. The server updates just those columns, so saving
  // registration never wipes the account mappings or default codes (and the reverse).
  const registrationM = useMutation({
    mutationFn: () =>
      saveSettings({
        data: {
          companyId: companyId!,
          taxRegime: regime,
          registrationNumber: regNumber,
          pricesIncludeTax: includeTax,
          taxBasis: basis,
          jurisdictionCode: jurisdiction || null,
          registrationDate: regDate || null,
          filingFrequency: filing || null,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-settings", companyId] });
      toast.success("Registration saved. Posted history is not rewritten.");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const mappingsM = useMutation({
    mutationFn: () =>
      saveSettings({
        data: {
          companyId: companyId!,
          outputTaxAccountId: outputAcc || null,
          inputTaxAccountId: inputAcc || null,
          nonRecoverableTaxAccountId: nonRecAcc || null,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-settings", companyId] });
      toast.success("Account mappings saved. Posted history is not rewritten.");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const seedM = useMutation({
    mutationFn: (packId?: string) =>
      doSeed({
        data: {
          companyId: companyId!,
          ...(packId || selectedPack ? { packId: packId || selectedPack } : {}),
        },
      }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["tax-rates", companyId] });
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      await qc.invalidateQueries({ queryKey: ["tax-settings", companyId] });
      const detail = res.result
        ? ` Added ${res.result.added_rates ?? 0} rates, ${res.result.added_codes ?? 0} codes.`
        : "";
      toast.success(`Pack applied (idempotent — existing codes kept).${detail}`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (isPending) return <LoadingState />;
  if (!companyId) {
    return (
      <EmptyState title="No organisation" description="Select an organisation to configure tax." />
    );
  }
  if (settingsQ.isPending) return <LoadingState />;
  if (settingsQ.isError) {
    return (
      <ErrorState
        title="Could not load tax settings"
        description={friendlyAuthError(settingsQ.error)}
      />
    );
  }

  const allAccounts = (accountsQ.data ?? []) as unknown as PickerAccount[];
  const outputAccounts = filterTaxAccountPicker(allAccounts, "output");
  const inputAccounts = filterTaxAccountPicker(allAccounts, "input");
  const nonRecAccounts = filterTaxAccountPicker(allAccounts, "non_recoverable");

  return (
    <>
      <PageHeader
        title="Tax"
        description={`Country-aware configuration and return figures for ${orgCountry}. Rates, codes, GL mappings and VAT/GST returns.`}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/reports/$reportId" params={{ reportId: "tax-summary" }}>
              Tax summary report
            </Link>
          </Button>
        }
      />

      <Alert className="mb-6">
        <AlertTitle>Calculation &amp; reporting, not e-filing</AlertTitle>
        <AlertDescription>
          LinkBooks calculates tax on documents and reports control-account movements. It does not
          claim MTD, BAS, GSTN, IRS, or electronic filing. Country packs are configuration scaffolds
          — verify rates against official sources. Changing settings never rewrites posted journals.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="registration">
        <TabsList className="mb-4 flex h-auto flex-wrap">
          <TabsTrigger value="registration">Registration</TabsTrigger>
          <TabsTrigger value="returns">Returns</TabsTrigger>
          <TabsTrigger value="rates">Rates</TabsTrigger>
          <TabsTrigger value="codes">Codes</TabsTrigger>
          <TabsTrigger value="mappings">GL mappings</TabsTrigger>
          <TabsTrigger value="packs">Country packs</TabsTrigger>
        </TabsList>

        <TabsContent value="registration" className="space-y-4">
          <div className="grid max-w-2xl gap-4 rounded-md border p-4">
            <h2 className="text-sm font-medium">Organisation tax settings</h2>
            <p className="text-xs text-muted-foreground">
              Suggested regime for {orgCountry}:{" "}
              <strong>{suggestedRegimeForCountry(orgCountry)}</strong>. Country alone does not
              determine tax treatment — set jurisdiction, registration and codes explicitly.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Regime</Label>
                <Select value={regime} onValueChange={setRegime}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="vat">VAT</SelectItem>
                    <SelectItem value="gst">GST</SelectItem>
                    <SelectItem value="sales_tax">Sales tax</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Jurisdiction code</Label>
                <Input
                  placeholder="e.g. GB, AU"
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Registration number</Label>
                <Input value={regNumber} onChange={(e) => setRegNumber(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Registration date</Label>
                <Input type="date" value={regDate} onChange={(e) => setRegDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Tax basis (reporting preference)</Label>
                <Select value={basis} onValueChange={setBasis}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="invoice">Invoice (accrual)</SelectItem>
                    <SelectItem value="cash">
                      Cash (stored; report uses posted journals by date)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Filing frequency</Label>
                <Select
                  value={filing || "unset"}
                  onValueChange={(v) => setFiling(v === "unset" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unset">Not set</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="bi_monthly">Every 2 months</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="semi_annually">Every 6 months</SelectItem>
                    <SelectItem value="annually">Annually</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={includeTax} onCheckedChange={setIncludeTax} />
              <Label>Prices include tax (inclusive treatment on documents)</Label>
            </div>
            <Button
              size="sm"
              disabled={registrationM.isPending}
              onClick={() => registrationM.mutate()}
            >
              Save registration &amp; defaults
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="mappings" className="space-y-4">
          <div className="grid max-w-2xl gap-4 rounded-md border p-4">
            <h2 className="text-sm font-medium">GL mappings</h2>
            <p className="text-xs text-muted-foreground">
              Posting uses these accounts when set; otherwise falls back to CoA codes 2100 (output)
              / 1200 (input). Each list only shows accounts of a suitable type (output tax:
              liabilities; input tax: assets or liabilities; non-recoverable tax: expenses or
              assets).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Output tax liability</Label>
                <Select
                  value={outputAcc || "none"}
                  onValueChange={(v) => setOutputAcc(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Fallback 2100" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Use fallback (2100)</SelectItem>
                    {outputAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Recoverable input tax</Label>
                <Select
                  value={inputAcc || "none"}
                  onValueChange={(v) => setInputAcc(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Fallback 1200" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Use fallback (1200)</SelectItem>
                    {inputAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Non-recoverable tax (cost)</Label>
                <Select
                  value={nonRecAcc || "none"}
                  onValueChange={(v) => setNonRecAcc(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not set</SelectItem>
                    {nonRecAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button size="sm" disabled={mappingsM.isPending} onClick={() => mappingsM.mutate()}>
              Save mappings
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="packs" className="space-y-4">
          <div className="rounded-md border p-4">
            <h2 className="mb-2 text-sm font-medium">Country packs for {orgCountry}</h2>
            <p className="mb-4 text-xs text-muted-foreground">{packsQ.data?.disclaimer}</p>
            <ul className="mb-4 space-y-3 text-sm">
              {(packsQ.data?.packs ?? packsForCountry(orgCountry)).map((p) => (
                <li key={p.id} className="rounded-md border p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <strong>{p.label}</strong>
                    <Badge variant="secondary">
                      {verificationStatusLabel(p.verificationStatus)}
                    </Badge>
                    <Badge variant="outline">Filing: {p.filingStatus}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{p.sourceEffectiveNote}</p>
                  <p className="mt-1 text-xs">Limitations: {p.knownLimitations.join("; ")}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={seedM.isPending}
                    onClick={() => {
                      setSelectedPack(p.id);
                      seedM.mutate(p.id);
                    }}
                  >
                    Apply pack (idempotent)
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </TabsContent>

        <TabsContent value="returns" className="space-y-4">
          <TaxReturnsPanel
            companyId={companyId}
            companyName={company?.name ?? ""}
            accounts={allAccounts}
          />
        </TabsContent>

        <TabsContent value="rates" className="space-y-4">
          <TaxRatesPanel companyId={companyId} />
        </TabsContent>

        <TabsContent value="codes" className="space-y-4">
          <TaxCodesPanel companyId={companyId} accounts={allAccounts} />
        </TabsContent>
      </Tabs>
    </>
  );
}
