import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listTaxCodes, listTaxRates, saveTaxCode } from "@/lib/tax/tax.functions";
import { filterTaxAccountPicker, type PickerAccount } from "@/lib/tax/account-pickers";
import { bpsToPercentLabel } from "@/lib/tax/tax-math";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AccountLookup, LookupSelect } from "@/components/lookup";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type CodeRow = {
  id: string;
  code: string;
  name: string;
  tax_rate_id: string;
  tax_account_id: string | null;
  applies_to: string;
  is_recoverable: boolean;
  is_active: boolean;
  tax_rates: { name: string; rate_bps: number } | null;
};

type Draft = {
  id?: string;
  code: string;
  name: string;
  rateId: string;
  accountId: string;
  appliesTo: "sales" | "purchases" | "both";
  recoverable: boolean;
  active: boolean;
};

function asApplies(v: string): Draft["appliesTo"] {
  return v === "sales" || v === "purchases" ? v : "both";
}

/** TX-05 / TX-06: tax codes with edit and deactivate, and an account picker filtered by type. */
export function TaxCodesPanel({
  companyId,
  accounts,
}: {
  companyId: string;
  accounts: PickerAccount[];
}) {
  const qc = useQueryClient();
  const fetchCodes = useServerFn(listTaxCodes);
  const fetchRates = useServerFn(listTaxRates);
  const doSave = useServerFn(saveTaxCode);
  const [draft, setDraft] = useState<Draft | null>(null);

  const codesQ = useQuery({
    queryKey: ["tax-codes", companyId],
    queryFn: () => fetchCodes({ data: { companyId } }),
  });
  const ratesQ = useQuery({
    queryKey: ["tax-rates", companyId],
    queryFn: () => fetchRates({ data: { companyId } }),
  });
  const rows = (codesQ.data ?? []) as unknown as CodeRow[];
  const rates = (ratesQ.data ?? []) as Array<{ id: string; name: string; is_active: boolean }>;
  const pickable = useMemo(() => filterTaxAccountPicker(accounts, "code_account"), [accounts]);

  const save = useMutation({
    mutationFn: (d: Draft) =>
      doSave({
        data: {
          companyId,
          ...(d.id ? { id: d.id } : {}),
          code: d.code,
          name: d.name,
          taxRateId: d.rateId,
          taxAccountId: d.accountId || null,
          appliesTo: d.appliesTo,
          isRecoverable: d.recoverable,
          isActive: d.active,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      toast.success("Tax code saved");
      setDraft(null);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const fromRow = (c: CodeRow): Draft => ({
    id: c.id,
    code: c.code,
    name: c.name,
    rateId: c.tax_rate_id,
    accountId: c.tax_account_id ?? "",
    appliesTo: asApplies(c.applies_to),
    recoverable: c.is_recoverable,
    active: c.is_active,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A tax code links a rate to where it can be used. Deactivate a code to stop new use. Posted
          documents keep the code they were issued with.
        </p>
        <Button
          size="sm"
          disabled={rates.length === 0}
          onClick={() =>
            setDraft({
              code: "",
              name: "",
              rateId: "",
              accountId: "",
              appliesTo: "both",
              recoverable: true,
              active: true,
            })
          }
        >
          Add code
        </Button>
      </div>

      {codesQ.isPending ? (
        <LoadingState />
      ) : codesQ.isError ? (
        <ErrorState
          title="Could not load tax codes"
          description={friendlyAuthError(codesQ.error)}
          onRetry={() => codesQ.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No tax codes" description="Add a rate, then a code, or apply a pack." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead>Applies to</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono">{c.code}</TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell>
                  {c.tax_rates
                    ? `${c.tax_rates.name} (${bpsToPercentLabel(c.tax_rates.rate_bps)})`
                    : "—"}
                </TableCell>
                <TableCell className="capitalize">{c.applies_to}</TableCell>
                <TableCell>
                  <Badge variant={c.is_active ? "default" : "outline"}>
                    {c.is_active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell className="space-x-1 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setDraft(fromRow(c))}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ ...fromRow(c), active: !c.is_active })}
                  >
                    {c.is_active ? "Deactivate" : "Reactivate"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => (o ? null : setDraft(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit tax code" : "Add tax code"}</DialogTitle>
            <DialogDescription>
              The tax account is optional. When empty, the organisation&apos;s output or input tax
              account from GL mappings is used.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="code-code">Code</Label>
                  <Input
                    id="code-code"
                    maxLength={20}
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="code-name">Name</Label>
                  <Input
                    id="code-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Tax rate</Label>
                <LookupSelect
                  ariaLabel="Tax rate"
                  allowClear={false}
                  value={draft.rateId}
                  onChange={(v) => setDraft({ ...draft, rateId: v })}
                  placeholder="Choose a rate"
                  searchPlaceholder="Search tax rate"
                  options={rates.map((r) => ({
                    id: r.id,
                    name: r.name,
                    label: r.name,
                    status: r.is_active ? null : "Inactive",
                    disabled: !r.is_active && r.id !== draft.rateId,
                    keywords: r.name,
                  }))}
                />
              </div>
              <div className="space-y-1">
                <Label>Applies to</Label>
                <Select
                  value={draft.appliesTo}
                  onValueChange={(v) => setDraft({ ...draft, appliesTo: asApplies(v) })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">Sales and purchases</SelectItem>
                    <SelectItem value="sales">Sales only</SelectItem>
                    <SelectItem value="purchases">Purchases only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Tax account (liability or asset)</Label>
                <AccountLookup
                  ariaLabel="Tax account"
                  accounts={pickable}
                  value={draft.accountId}
                  onChange={(v) => setDraft({ ...draft, accountId: v })}
                  companyId={companyId}
                  placeholder="Use the organisation default"
                  allowClear
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="code-recoverable"
                  checked={draft.recoverable}
                  onCheckedChange={(v) => setDraft({ ...draft, recoverable: v })}
                />
                <Label htmlFor="code-recoverable">Recoverable on purchases</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="code-active"
                  checked={draft.active}
                  onCheckedChange={(v) => setDraft({ ...draft, active: v })}
                />
                <Label htmlFor="code-active">Active</Label>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              disabled={save.isPending || !draft?.code || !draft?.name || !draft?.rateId}
              onClick={() => draft && save.mutate(draft)}
            >
              Save code
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
