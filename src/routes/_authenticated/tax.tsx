import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  getTaxSettings,
  listTaxCodes,
  listTaxRates,
  saveTaxCode,
  saveTaxRate,
  seedTaxPack,
  updateTaxSettings,
} from "@/lib/tax/tax.functions";
import { SUPPORTED_TAX_PACKS } from "@/lib/tax/tax-math";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  const today = new Date().toISOString().slice(0, 10);

  const fetchSettings = useServerFn(getTaxSettings);
  const saveSettings = useServerFn(updateTaxSettings);
  const fetchRates = useServerFn(listTaxRates);
  const fetchCodes = useServerFn(listTaxCodes);
  const doSaveRate = useServerFn(saveTaxRate);
  const doSaveCode = useServerFn(saveTaxCode);
  const doSeed = useServerFn(seedTaxPack);
  const fetchAccounts = useServerFn(listAccounts);

  const settingsQ = useQuery({
    queryKey: ["tax-settings", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSettings({ data: { companyId: companyId! } }),
  });
  const ratesQ = useQuery({
    queryKey: ["tax-rates", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchRates({ data: { companyId: companyId! } }),
  });
  const codesQ = useQuery({
    queryKey: ["tax-codes", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCodes({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const [regime, setRegime] = useState("none");
  const [jurisdiction, setJurisdiction] = useState("");
  const [regNumber, setRegNumber] = useState("");
  const [includeTax, setIncludeTax] = useState(false);
  const [basis, setBasis] = useState("invoice");
  const [outputAcc, setOutputAcc] = useState("");
  const [inputAcc, setInputAcc] = useState("");

  const [rateName, setRateName] = useState("");
  const [rateBps, setRateBps] = useState("2000");
  const [rateFrom, setRateFrom] = useState(today);
  const [code, setCode] = useState("");
  const [codeName, setCodeName] = useState("");
  const [codeRateId, setCodeRateId] = useState("");

  useEffect(() => {
    const s = settingsQ.data as {
      tax_regime: string;
      registration_number: string | null;
      prices_include_tax: boolean;
      tax_basis: string;
      jurisdiction_code: string | null;
      output_tax_account_id: string | null;
      input_tax_account_id: string | null;
    } | null;
    if (!s) return;
    setRegime(s.tax_regime ?? "none");
    setJurisdiction(s.jurisdiction_code ?? "");
    setRegNumber(s.registration_number ?? "");
    setIncludeTax(Boolean(s.prices_include_tax));
    setBasis(s.tax_basis ?? "invoice");
    setOutputAcc(s.output_tax_account_id ?? "");
    setInputAcc(s.input_tax_account_id ?? "");
  }, [settingsQ.data]);

  const settingsM = useMutation({
    mutationFn: () =>
      saveSettings({
        data: {
          companyId: companyId!,
          taxRegime: regime,
          registrationNumber: regNumber,
          pricesIncludeTax: includeTax,
          taxBasis: basis,
          jurisdictionCode: jurisdiction || null,
          outputTaxAccountId: outputAcc || null,
          inputTaxAccountId: inputAcc || null,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-settings", companyId] });
      toast.success("Tax settings saved. Posted history is not rewritten.");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rateM = useMutation({
    mutationFn: () =>
      doSaveRate({
        data: {
          companyId: companyId!,
          name: rateName,
          rateBps: Number(rateBps),
          effectiveFrom: rateFrom,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-rates", companyId] });
      toast.success("Tax rate saved");
      setRateName("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const codeM = useMutation({
    mutationFn: () =>
      doSaveCode({
        data: {
          companyId: companyId!,
          code,
          name: codeName,
          taxRateId: codeRateId,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      toast.success("Tax code saved");
      setCode("");
      setCodeName("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const seedM = useMutation({
    mutationFn: () => doSeed({ data: { companyId: companyId! } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-rates", companyId] });
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      toast.success("Default pack seeded (if regime allows and no rates existed)");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (isPending) return <LoadingState />;
  if (!companyId) {
    return <EmptyState title="No organisation" description="Select an organisation to configure tax." />;
  }
  if (settingsQ.isPending) return <LoadingState />;
  if (settingsQ.isError) {
    return (
      <ErrorState title="Could not load tax settings" description={friendlyAuthError(settingsQ.error)} />
    );
  }

  const liabilityAccounts = ((accountsQ.data ?? []) as Array<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    is_postable: boolean;
    is_active: boolean;
  }>).filter((a) => a.is_active && a.is_postable);

  return (
    <>
      <PageHeader
        title="Tax configuration"
        description="Organisation-specific rates, codes and GL mappings. Changing rates does not rewrite posted journals."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/reports">Tax report</Link>
          </Button>
        }
      />

      <Alert className="mb-6">
        <AlertTitle>Not a filing product</AlertTitle>
        <AlertDescription>
          LinkBooks stores configurable rates and reports tax control movements. It does not claim MTD, BAS, IRS, or
          other filing compliance. Review jurisdiction packs below before relying on seeded rates.
        </AlertDescription>
      </Alert>

      <div className="mb-8 grid max-w-2xl gap-4 rounded-md border p-4">
        <h2 className="text-sm font-medium">Organisation tax settings</h2>
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
            <Label>Tax basis</Label>
            <Select value={basis} onValueChange={setBasis}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="invoice">Invoice (accrual)</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={includeTax} onCheckedChange={setIncludeTax} />
          <Label>Prices include tax (inclusive treatment on documents)</Label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Output tax account</Label>
            <Select value={outputAcc} onValueChange={setOutputAcc}>
              <SelectTrigger>
                <SelectValue placeholder="Default 2100" />
              </SelectTrigger>
              <SelectContent>
                {liabilityAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Input tax account</Label>
            <Select value={inputAcc} onValueChange={setInputAcc}>
              <SelectTrigger>
                <SelectValue placeholder="Optional" />
              </SelectTrigger>
              <SelectContent>
                {liabilityAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={settingsM.isPending} onClick={() => settingsM.mutate()}>
            Save settings
          </Button>
          <Button size="sm" variant="outline" disabled={seedM.isPending} onClick={() => seedM.mutate()}>
            Seed default pack for regime
          </Button>
        </div>
      </div>

      <h2 className="mb-2 text-sm font-medium">Supported packs (limitations)</h2>
      <ul className="mb-8 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {SUPPORTED_TAX_PACKS.map((p) => (
          <li key={p.regime}>
            <strong>{p.label}</strong> [{p.jurisdictions.join(", ")}]: {p.notes}
          </li>
        ))}
      </ul>

      <div className="mb-8 grid max-w-xl gap-3 rounded-md border p-4">
        <Label>Add tax rate (basis points; 2000 = 20%)</Label>
        <Input placeholder="Name" value={rateName} onChange={(e) => setRateName(e.target.value)} />
        <Input placeholder="Rate bps" value={rateBps} onChange={(e) => setRateBps(e.target.value)} />
        <Input type="date" value={rateFrom} onChange={(e) => setRateFrom(e.target.value)} />
        <Button size="sm" disabled={rateM.isPending || !rateName} onClick={() => rateM.mutate()}>
          Save rate
        </Button>
      </div>

      {ratesQ.isPending ? (
        <LoadingState />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead>Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {((ratesQ.data ?? []) as Array<{
              id: string;
              name: string;
              rate_bps: number;
              effective_from: string;
              effective_to: string | null;
              is_active: boolean;
            }>).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.name}</TableCell>
                <TableCell>{(r.rate_bps / 100).toFixed(2)}%</TableCell>
                <TableCell>
                  {r.effective_from}
                  {r.effective_to ? ` → ${r.effective_to}` : " →"}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{r.is_active ? "yes" : "no"}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="mb-8 mt-8 grid max-w-xl gap-3 rounded-md border p-4">
        <Label>Add tax code</Label>
        <Input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
        <Input placeholder="Name" value={codeName} onChange={(e) => setCodeName(e.target.value)} />
        <Select value={codeRateId} onValueChange={setCodeRateId}>
          <SelectTrigger>
            <SelectValue placeholder="Tax rate" />
          </SelectTrigger>
          <SelectContent>
            {((ratesQ.data ?? []) as Array<{ id: string; name: string }>).map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={codeM.isPending || !code || !codeName || !codeRateId}
          onClick={() => codeM.mutate()}
        >
          Save code
        </Button>
      </div>

      {codesQ.isPending ? (
        <LoadingState />
      ) : (codesQ.data ?? []).length === 0 ? (
        <EmptyState title="No tax codes" description="Add a rate, then a code — or seed a pack." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead>Applies</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {((codesQ.data ?? []) as Array<{
              id: string;
              code: string;
              name: string;
              applies_to: string;
              tax_rates: { name: string; rate_bps: number } | null;
            }>).map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.code}</TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell>
                  {c.tax_rates
                    ? `${c.tax_rates.name} (${(c.tax_rates.rate_bps / 100).toFixed(2)}%)`
                    : "—"}
                </TableCell>
                <TableCell>{c.applies_to}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
