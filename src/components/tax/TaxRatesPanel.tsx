import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listTaxRates, saveTaxRate } from "@/lib/tax/tax.functions";
import { bpsToPercentLabel } from "@/lib/tax/tax-math";
import {
  RATE_STATUS_LABEL,
  rateStatus,
  validateRateEndDate,
  type RateStatus,
} from "@/lib/tax/rate-status";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { useFormat } from "@/hooks/use-format";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type TaxRateRow = {
  id: string;
  name: string;
  rate_bps: number;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
};

type Draft = {
  id?: string;
  name: string;
  percent: string;
  from: string;
  to: string;
  active: boolean;
};

const BADGE: Record<RateStatus, "default" | "secondary" | "outline"> = {
  current: "default",
  scheduled: "secondary",
  ended: "outline",
  inactive: "outline",
};

function percentToBps(percent: string): number {
  const n = Number(percent.trim());
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** TX-05: add, edit, end-date and deactivate tax rates. Posted documents keep their amounts. */
export function TaxRatesPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const f = useFormat();
  const today = new Date().toISOString().slice(0, 10);
  const fetchRates = useServerFn(listTaxRates);
  const doSave = useServerFn(saveTaxRate);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ending, setEnding] = useState<{ rate: TaxRateRow; date: string } | null>(null);

  const q = useQuery({
    queryKey: ["tax-rates", companyId],
    queryFn: () => fetchRates({ data: { companyId } }),
  });
  const rows = (q.data ?? []) as TaxRateRow[];

  const save = useMutation({
    mutationFn: (v: {
      id?: string;
      name: string;
      rateBps: number;
      effectiveFrom: string;
      effectiveTo: string | null;
      isActive: boolean;
    }) => doSave({ data: { companyId, ...v } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tax-rates", companyId] });
      await qc.invalidateQueries({ queryKey: ["tax-codes", companyId] });
      toast.success("Tax rate saved");
      setDraft(null);
      setEnding(null);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const submitDraft = () => {
    if (!draft) return;
    const bps = percentToBps(draft.percent);
    if (!draft.name.trim()) {
      toast.error("Give the rate a name.");
      return;
    }
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
      toast.error("Enter a rate between 0 and 100 percent.");
      return;
    }
    save.mutate({
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      rateBps: bps,
      effectiveFrom: draft.from,
      effectiveTo: draft.to || null,
      isActive: draft.active,
    });
  };

  const submitEnd = () => {
    if (!ending) return;
    const err = validateRateEndDate(ending.rate.effective_from, ending.date);
    if (err) {
      toast.error(err);
      return;
    }
    save.mutate({
      id: ending.rate.id,
      name: ending.rate.name,
      rateBps: ending.rate.rate_bps,
      effectiveFrom: ending.rate.effective_from,
      effectiveTo: ending.date,
      isActive: ending.rate.is_active,
    });
  };

  const toggleActive = (r: TaxRateRow) =>
    save.mutate({
      id: r.id,
      name: r.name,
      rateBps: r.rate_bps,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      isActive: !r.is_active,
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Rates apply by document date. To change a rate, end the old one and add the new one from
          its start date. That keeps history correct. Posted documents never change.
        </p>
        <Button
          size="sm"
          onClick={() => setDraft({ name: "", percent: "20", from: today, to: "", active: true })}
        >
          Add rate
        </Button>
      </div>

      {q.isPending ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState
          title="Could not load tax rates"
          description={friendlyAuthError(q.error)}
          onRetry={() => q.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No tax rates" description="Add a rate, or apply a country pack." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const st = rateStatus(r, today);
              return (
                <TableRow key={r.id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {bpsToPercentLabel(r.rate_bps)}
                  </TableCell>
                  <TableCell>
                    {f.date(r.effective_from)}
                    {r.effective_to ? ` → ${f.date(r.effective_to)}` : " → open ended"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={BADGE[st]}>{RATE_STATUS_LABEL[st]}</Badge>
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          id: r.id,
                          name: r.name,
                          percent: String(r.rate_bps / 100),
                          from: r.effective_from,
                          to: r.effective_to ?? "",
                          active: r.is_active,
                        })
                      }
                    >
                      Edit
                    </Button>
                    {st === "current" && !r.effective_to ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEnding({ rate: r, date: today })}
                      >
                        End date
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={save.isPending}
                      onClick={() => toggleActive(r)}
                    >
                      {r.is_active ? "Deactivate" : "Reactivate"}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => (o ? null : setDraft(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit tax rate" : "Add tax rate"}</DialogTitle>
            <DialogDescription>
              Changing the percentage of a rate already in use affects new documents that use it. To
              keep history, end this rate and add a new one instead.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-3">
              <div className="space-y-1">
                <Label htmlFor="rate-name">Name</Label>
                <Input
                  id="rate-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rate-pct">Rate (%)</Label>
                <Input
                  id="rate-pct"
                  inputMode="decimal"
                  value={draft.percent}
                  onChange={(e) => setDraft({ ...draft, percent: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="rate-from">Effective from</Label>
                  <Input
                    id="rate-from"
                    type="date"
                    value={draft.from}
                    onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rate-to">Effective to (optional)</Label>
                  <Input
                    id="rate-to"
                    type="date"
                    value={draft.to}
                    onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="rate-active"
                  checked={draft.active}
                  onCheckedChange={(v) => setDraft({ ...draft, active: v })}
                />
                <Label htmlFor="rate-active">Active</Label>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button disabled={save.isPending} onClick={submitDraft}>
              Save rate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={ending !== null} onOpenChange={(o) => (o ? null : setEnding(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End {ending?.rate.name}</DialogTitle>
            <DialogDescription>
              Documents dated after this day can no longer use the rate. Earlier documents are not
              changed.
            </DialogDescription>
          </DialogHeader>
          {ending ? (
            <div className="space-y-1">
              <Label htmlFor="end-date">Last day the rate applies</Label>
              <Input
                id="end-date"
                type="date"
                value={ending.date}
                onChange={(e) => setEnding({ ...ending, date: e.target.value })}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnding(null)}>
              Cancel
            </Button>
            <Button disabled={save.isPending} onClick={submitEnd}>
              End rate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
