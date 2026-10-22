import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  getWorkflowSettings,
  upsertWorkflowSettings,
} from "@/lib/settings/workflow-settings.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState } from "@/components/common/states";
import { CompanyEmptyState } from "@/components/common/company-empty";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/_authenticated/sales/settings")({
  head: () => ({ meta: [{ title: "Sales settings — LinkBooks" }] }),
  component: SalesSettingsPage,
});

function SalesSettingsPage() {
  const { company, isPending } = useActiveCompany();
  if (isPending) return <LoadingState />;
  if (!company) {
    return <CompanyEmptyState title="No organisation" description="Select a company first." />;
  }
  return (
    <>
      <PageHeader
        title="Sales settings"
        description="Defaults for payment terms, quotes and invoice notes. Document sequences are managed in Settings → Documents."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings" search={{ section: "overview" }}>
              Organisation settings
            </Link>
          </Button>
        }
      />
      <SalesSettingsForm companyId={company.id} />
    </>
  );
}

function SalesSettingsForm({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const fetch = useServerFn(getWorkflowSettings);
  const save = useServerFn(upsertWorkflowSettings);
  const q = useQuery({
    queryKey: ["workflow-settings", companyId],
    queryFn: () => fetch({ data: { companyId } }),
  });
  const [terms, setTerms] = useState("30");
  const [quoteDays, setQuoteDays] = useState("30");
  const [notes, setNotes] = useState("");
  const [instructions, setInstructions] = useState("");
  const [inclusive, setInclusive] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setTerms(String(q.data.sales_default_payment_terms_days));
    setQuoteDays(String(q.data.sales_quote_validity_days));
    setNotes(q.data.sales_default_notes ?? "");
    setInstructions(q.data.sales_payment_instructions ?? "");
    setInclusive(q.data.sales_prices_include_tax);
  }, [q.data]);

  const mut = useMutation({
    mutationFn: () => {
      const data: Parameters<typeof save>[0]["data"] = {
        companyId,
        salesDefaultPaymentTermsDays: Number(terms),
        salesQuoteValidityDays: Number(quoteDays),
        salesDefaultNotes: notes,
        salesPaymentInstructions: instructions,
        salesPricesIncludeTax: inclusive,
      };
      if (q.data) {
        data.purchasesDefaultPaymentTermsDays = q.data.purchases_default_payment_terms_days;
        if (q.data.purchases_default_notes) data.purchasesDefaultNotes = q.data.purchases_default_notes;
        data.purchasesRequirePo = q.data.purchases_require_po;
        data.bankingCsvDateFormat = q.data.banking_csv_date_format;
        data.accountingRequireJournalMemo = q.data.accounting_require_journal_memo;
      }
      return save({ data });
    },
    onSuccess: async () => {
      toast.success("Sales settings saved");
      await queryClient.invalidateQueries({ queryKey: ["workflow-settings", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (q.isPending) return <LoadingState />;

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Sales defaults</CardTitle>
        <CardDescription>Applies to new documents — does not rewrite posted history.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-1">
          <Label>Default payment terms (days)</Label>
          <Input type="number" value={terms} onChange={(e) => setTerms(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label>Quote validity (days)</Label>
          <Input type="number" value={quoteDays} onChange={(e) => setQuoteDays(e.target.value)} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="inc-tax">Prices include tax by default</Label>
          <Switch id="inc-tax" checked={inclusive} onCheckedChange={setInclusive} />
        </div>
        <div className="grid gap-1">
          <Label>Default invoice notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </div>
        <div className="grid gap-1">
          <Label>Payment instructions</Label>
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
        </div>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? "Saving…" : "Save sales settings"}
        </Button>
      </CardContent>
    </Card>
  );
}
