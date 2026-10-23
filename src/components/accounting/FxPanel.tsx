import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  cancelAutoReversal,
  getFxOverview,
  previewFxRevaluation,
  postFxRevaluation,
  processDueAutoReversals,
  type RevaluationPreview,
} from "@/lib/accounting/fx.functions";
import { isPositiveRate, nextDay } from "@/lib/accounting/fx-reval";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { useFormat } from "@/hooks/use-format";
import { ErrorState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Foreign-currency gains and losses (AR-10) and auto-reversing journals (AC-05).
 * Rates are manual: nothing here fetches rates from the internet.
 */
export function FxPanel({ companyId, currency }: { companyId: string; currency: string }) {
  const qc = useQueryClient();
  const f = useFormat();
  const fetchOverview = useServerFn(getFxOverview);
  const doPreview = useServerFn(previewFxRevaluation);
  const doPost = useServerFn(postFxRevaluation);
  const doProcess = useServerFn(processDueAutoReversals);
  const doCancel = useServerFn(cancelAutoReversal);

  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<RevaluationPreview | null>(null);

  const overview = useQuery({
    queryKey: ["fx-overview", companyId],
    queryFn: () => fetchOverview({ data: { companyId } }),
  });

  const refreshAll = async () => {
    await qc.invalidateQueries({ queryKey: ["fx-overview", companyId] });
    await qc.invalidateQueries({ queryKey: ["journals", companyId] });
  };

  const previewM = useMutation({
    mutationFn: () => doPreview({ data: { companyId, asOfDate: asOf, rates } }),
    onSuccess: (r) => {
      setPreview(r);
      // Pre-fill the rate boxes from stored rates so the user sees (and can override) what is used.
      setRates((cur) => {
        const next = { ...cur };
        for (const l of r.lines) {
          if (next[l.currency_code] === undefined && l.rate != null) {
            next[l.currency_code] = String(l.rate);
          }
        }
        return next;
      });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const postM = useMutation({
    mutationFn: () => doPost({ data: { companyId, asOfDate: asOf, rates, note } }),
    onSuccess: async (r) => {
      if (r.posted) {
        toast.success(`Revaluation posted. It reverses on ${f.date(r.reverse_on)}.`);
      } else {
        toast.message(r.message ?? "Nothing to revalue.");
      }
      setPreview(null);
      await refreshAll();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const processM = useMutation({
    mutationFn: () => doProcess({ data: { companyId } }),
    onSuccess: async (r) => {
      if (r.failed > 0) toast.error(`${r.failed} reversal(s) failed. See the list for the reason.`);
      else toast.success(r.processed ? `${r.processed} reversal(s) posted` : "Nothing is due");
      await refreshAll();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const cancelM = useMutation({
    mutationFn: (journalId: string) => doCancel({ data: { companyId, journalId } }),
    onSuccess: async () => {
      toast.success("Auto-reversal cancelled");
      await refreshAll();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (overview.isPending) return <LoadingState />;
  if (overview.isError) {
    return (
      <ErrorState
        description={friendlyAuthError(overview.error)}
        onRetry={() => void overview.refetch()}
      />
    );
  }
  const ov = overview.data;
  if (!ov.available) {
    return (
      <Alert>
        <AlertTitle>Unavailable</AlertTitle>
        <AlertDescription>{ov.unavailableReason}</AlertDescription>
      </Alert>
    );
  }

  const ratesComplete =
    preview !== null &&
    preview.lines.length > 0 &&
    [...new Set(preview.lines.map((l) => l.currency_code))].every((c) => isPositiveRate(rates[c]));
  const toAdjust = preview?.lines.filter((l) => (l.adjustment_minor ?? 0) !== 0).length ?? 0;
  const dueCount = ov.autoReversals.filter(
    (r) => (r.status === "pending" || r.status === "failed") && r.reverse_on <= today,
  ).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unrealised FX revaluation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Revalues open foreign-currency receivables, payables and foreign bank accounts to the
            rates below. Rates are entered by you (or taken from your stored rates in Settings);
            there is no live rate feed. Each journal reverses on the next day (
            {nextDay(asOf) ? f.date(nextDay(asOf)) : "—"}). Realised gains and losses on payments
            are posted automatically when a receipt or payment is allocated.
          </p>
          {ov.canPost ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="fx-asof">Revalue as at</Label>
                  <Input
                    id="fx-asof"
                    type="date"
                    max={today}
                    value={asOf}
                    onChange={(e) => {
                      setAsOf(e.target.value);
                      setPreview(null);
                    }}
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={!asOf || previewM.isPending}
                  onClick={() => previewM.mutate()}
                >
                  {previewM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {preview ? "Recalculate" : "Preview"}
                </Button>
              </div>

              {preview ? (
                preview.lines.length === 0 ? (
                  <p>
                    There are no open foreign-currency balances as at {f.date(preview.as_of_date)}.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <div className="overflow-auto rounded-md border">
                      <table className="w-full">
                        <thead className="bg-muted text-left">
                          <tr>
                            <th className="p-2">Account</th>
                            <th className="p-2">Currency</th>
                            <th className="p-2 text-right">Balance</th>
                            <th className="p-2 text-right">Booked ({currency})</th>
                            <th className="p-2 text-right">At rate ({currency})</th>
                            <th className="p-2 text-right">Adjustment</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.lines.map((l) => (
                            <tr key={`${l.account_id}-${l.currency_code}`} className="border-t">
                              <td className="p-2">
                                <span className="font-mono text-xs text-muted-foreground">
                                  {l.account_code}
                                </span>{" "}
                                {l.account_name}
                              </td>
                              <td className="p-2">{l.currency_code}</td>
                              <td className="p-2 text-right tabular-nums">
                                {f.money(l.txn_net_minor, l.currency_code)}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {f.money(l.booked_base_minor)}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {l.closing_base_minor == null ? "—" : f.money(l.closing_base_minor)}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {l.adjustment_minor == null
                                  ? "Rate needed"
                                  : f.money(l.adjustment_minor)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      {[...new Set(preview.lines.map((l) => l.currency_code))].map((c) => {
                        const line = preview.lines.find((l) => l.currency_code === c);
                        return (
                          <div key={c} className="space-y-1">
                            <Label htmlFor={`fx-rate-${c}`}>
                              1 {c} in {currency}
                            </Label>
                            <Input
                              id={`fx-rate-${c}`}
                              inputMode="decimal"
                              className="w-36"
                              value={rates[c] ?? ""}
                              onChange={(e) => setRates((cur) => ({ ...cur, [c]: e.target.value }))}
                            />
                            <p className="text-xs text-muted-foreground">
                              {line?.rate_source === "exchange_rates"
                                ? `Stored rate of ${f.date(line.rate_date)}${line.stale ? " (over a month old)" : ""}`
                                : line?.rate_source === "manual"
                                  ? "Entered by you"
                                  : "No stored rate: enter one"}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    <div className="max-w-md space-y-1">
                      <Label htmlFor="fx-note">Note (optional)</Label>
                      <Input id="fx-note" value={note} onChange={(e) => setNote(e.target.value)} />
                    </div>

                    {preview.missing.length > 0 && !ratesComplete ? (
                      <p className="text-destructive">
                        Enter an exchange rate for {preview.missing.join(", ")}, then recalculate.
                      </p>
                    ) : null}
                    {toAdjust === 0 && ratesComplete ? (
                      <p>The balances already agree with these rates. Nothing to post.</p>
                    ) : null}

                    <div className="flex gap-2">
                      <Button
                        disabled={!ratesComplete || toAdjust === 0 || postM.isPending}
                        onClick={() => postM.mutate()}
                      >
                        {postM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                        Post revaluation
                      </Button>
                      <p className="self-center text-xs text-muted-foreground">
                        Recalculate after changing a rate to see the new adjustment.
                      </p>
                    </div>
                  </div>
                )
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">You can view revaluations but not post them.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            Auto-reversals
            {ov.canPost ? (
              <Button
                size="sm"
                variant="outline"
                disabled={processM.isPending}
                onClick={() => processM.mutate()}
              >
                {processM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Process due reversals{dueCount ? ` (${dueCount})` : ""}
              </Button>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Auto-reversing manual journals and revaluations wait here until their date. Nothing runs
            on its own inside the app: press the button, or have an administrator schedule{" "}
            <code>select public.process_due_auto_reversals_system();</code> daily (see the Wave 2 E
            notes).
          </p>
          {ov.autoReversals.length === 0 ? (
            <p>No auto-reversing journals yet.</p>
          ) : (
            <div className="overflow-auto rounded-md border">
              <table className="w-full">
                <thead className="bg-muted text-left">
                  <tr>
                    <th className="p-2">Journal</th>
                    <th className="p-2">Type</th>
                    <th className="p-2">Reverses on</th>
                    <th className="p-2">Status</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {ov.autoReversals.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="p-2">
                        #{r.journal_number ?? "—"} {f.date(r.journal_date)}
                        {r.memo ? (
                          <div className="text-xs text-muted-foreground">{r.memo}</div>
                        ) : null}
                      </td>
                      <td className="p-2">
                        {r.origin === "fx_revaluation" ? "FX revaluation" : "Manual"}
                      </td>
                      <td className="p-2">{f.date(r.reverse_on)}</td>
                      <td className="p-2">
                        <Badge
                          variant={
                            r.status === "failed"
                              ? "destructive"
                              : r.status === "done"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {r.status}
                        </Badge>
                        {r.last_error ? (
                          <div className="text-xs text-destructive">{r.last_error}</div>
                        ) : null}
                      </td>
                      <td className="p-2 text-right">
                        {ov.canPost && (r.status === "pending" || r.status === "failed") ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={cancelM.isPending}
                            onClick={() => cancelM.mutate(r.journal_id)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Realised FX on settlements</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {ov.realised.length === 0 ? (
            <p className="text-muted-foreground">
              None yet. A gain or loss is posted when a foreign-currency receipt or payment is
              allocated at a different rate from the invoice or bill.
            </p>
          ) : (
            <div className="overflow-auto rounded-md border">
              <table className="w-full">
                <thead className="bg-muted text-left">
                  <tr>
                    <th className="p-2">Date</th>
                    <th className="p-2">Settlement</th>
                    <th className="p-2 text-right">Amount</th>
                    <th className="p-2 text-right">Booked rate</th>
                    <th className="p-2 text-right">Settled rate</th>
                    <th className="p-2 text-right">Gain / (loss)</th>
                  </tr>
                </thead>
                <tbody>
                  {ov.realised.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2">{f.date(r.created_at)}</td>
                      <td className="p-2">
                        {r.kind === "sales" ? "Customer receipt" : "Supplier payment"}
                        {r.reversed_at ? " (reversed)" : ""}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {f.money(r.settled_minor, r.currency_code)}
                      </td>
                      <td className="p-2 text-right tabular-nums">{r.document_rate}</td>
                      <td className="p-2 text-right tabular-nums">{r.settlement_rate}</td>
                      <td className="p-2 text-right tabular-nums">
                        {f.money(r.gain_loss_base_minor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {ov.runs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revaluation history</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <ul className="space-y-1">
              {ov.runs.map((r) => (
                <li key={r.id}>
                  {f.date(r.as_of_date)} · gain {f.money(r.total_gain_minor)} · loss{" "}
                  {f.money(r.total_loss_minor)} · rates{" "}
                  {Object.entries(r.rates)
                    .map(([c, v]) => `${c} ${v}`)
                    .join(", ")}
                  {r.note ? ` · ${r.note}` : ""}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
