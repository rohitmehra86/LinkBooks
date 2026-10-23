import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  type ReturnSummary,
  deleteDraftTaxReturn,
  fileTaxReturn,
  getReturnDefaults,
  getTaxReturn,
  listTaxReturns,
  postTaxReturnSettlement,
  previewTaxReturn,
  saveTaxReturnDraft,
} from "@/lib/tax/tax-return.functions";
import { filingAmountMinor, type BoxKey, type BoxLine } from "@/lib/tax/vat-return";
import { filterTaxAccountPicker, type PickerAccount } from "@/lib/tax/account-pickers";
import { decimalPlacesFor } from "@/lib/accounting/money";
import { csvFilename, csvMoney, downloadCsv, toCsv } from "@/lib/reports/csv";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { useFormat } from "@/hooks/use-format";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type Warning = { tone: "info" | "warn"; text: string };

function warningsFor(s: Partial<ReturnSummary>, regime: string): Warning[] {
  const n = (k: keyof ReturnSummary): number => s[k] ?? 0;
  const out: Warning[] = [];
  if (regime === "none")
    out.push({
      tone: "warn",
      text: "The tax regime is set to None. Set it under Registration if this organisation files returns.",
    });
  if (n("uncodedLines") > 0)
    out.push({
      tone: "warn",
      text: `${n("uncodedLines")} line(s) have no tax code. They are counted by their amounts: any tax is treated as standard tax, and the net value goes in sales or purchases.`,
    });
  if (n("reverseChargeLines") > 0)
    out.push({
      tone: "warn",
      text: `${n("reverseChargeLines")} reverse-charge line(s) are included at their stored tax. Reverse-charge tax on both sides (boxes 1 and 4) is not calculated.`,
    });
  if (n("skippedNoRate") > 0)
    out.push({
      tone: "warn",
      text: `${n("skippedNoRate")} foreign-currency document(s) have no exchange rate on their journal and were left out.`,
    });
  if (n("outOfScopeLines") > 0)
    out.push({
      tone: "info",
      text: `${n("outOfScopeLines")} out-of-scope line(s) are left out of every box.`,
    });
  if (n("nonRecoverableTaxMinor") !== 0)
    out.push({
      tone: "info",
      text: "Tax on purchases that cannot be reclaimed is treated as a cost and is not in box 4.",
    });
  return out;
}

function BoxTable({
  lines,
  currency,
  isUk,
  jurisdiction,
}: {
  lines: BoxLine[];
  currency: string;
  isUk: boolean;
  jurisdiction: string | null;
}) {
  const f = useFormat();
  const decimals = decimalPlacesFor(currency);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">{isUk ? "Box" : "Line"}</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          {isUk ? <TableHead className="text-right">To enter on the HMRC form</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.box_key}>
            <TableCell className="font-mono">{l.box_key.replace("box", "")}</TableCell>
            <TableCell>
              {l.label}
              {l.box_key === "box5" ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {l.amount_minor > 0 ? "(payable)" : l.amount_minor < 0 ? "(refundable)" : ""}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {f.money(l.amount_minor, currency)}
            </TableCell>
            {isUk ? (
              <TableCell className="text-right tabular-nums">
                {f.money(
                  filingAmountMinor(l.box_key as BoxKey, l.amount_minor, decimals, jurisdiction),
                  currency,
                )}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** TX-01: calculate, save, file and settle VAT/GST returns from document tax lines. */
export function TaxReturnsPanel({
  companyId,
  companyName,
  accounts,
}: {
  companyId: string;
  companyName: string;
  accounts: PickerAccount[];
}) {
  const qc = useQueryClient();
  const f = useFormat();
  const fetchList = useServerFn(listTaxReturns);
  const fetchDefaults = useServerFn(getReturnDefaults);
  const doPreview = useServerFn(previewTaxReturn);
  const doSave = useServerFn(saveTaxReturnDraft);
  const doGet = useServerFn(getTaxReturn);
  const doFile = useServerFn(fileTaxReturn);
  const doDelete = useServerFn(deleteDraftTaxReturn);
  const doSettle = useServerFn(postTaxReturnSettlement);

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [basis, setBasis] = useState<"accrual" | "cash">("accrual");
  const [calc, setCalc] = useState<{
    start: string;
    end: string;
    basis: "accrual" | "cash";
  } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmFile, setConfirmFile] = useState(false);
  const [settleAccount, setSettleAccount] = useState("");
  const [settleDate, setSettleDate] = useState("");
  const [confirmSettle, setConfirmSettle] = useState(false);

  const list = useQuery({
    queryKey: ["tax-returns", companyId],
    queryFn: () => fetchList({ data: { companyId } }),
  });
  const defaults = useQuery({
    queryKey: ["tax-return-defaults", companyId],
    queryFn: () => fetchDefaults({ data: { companyId } }),
  });
  useEffect(() => {
    if (defaults.data && !start && !end) {
      setStart(defaults.data.start);
      setEnd(defaults.data.end);
      setBasis(defaults.data.basis);
    }
  }, [defaults.data, start, end]);

  const preview = useQuery({
    queryKey: ["tax-return-preview", companyId, calc?.start, calc?.end, calc?.basis],
    enabled: calc !== null,
    queryFn: () =>
      doPreview({
        data: { companyId, periodStart: calc!.start, periodEnd: calc!.end, basis: calc!.basis },
      }),
  });
  const detail = useQuery({
    queryKey: ["tax-return", companyId, openId],
    enabled: openId !== null,
    queryFn: () => doGet({ data: { companyId, returnId: openId! } }),
  });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["tax-returns", companyId] });
    await qc.invalidateQueries({ queryKey: ["tax-return", companyId] });
    await qc.invalidateQueries({ queryKey: ["tax-return-defaults", companyId] });
  };

  const saveDraft = useMutation({
    mutationFn: () =>
      doSave({
        data: { companyId, periodStart: calc!.start, periodEnd: calc!.end, basis: calc!.basis },
      }),
    onSuccess: async (r) => {
      toast.success("Draft saved");
      await refresh();
      setOpenId(r.id);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const file = useMutation({
    mutationFn: () => doFile({ data: { companyId, returnId: openId!, confirm: true } }),
    onSuccess: async () => {
      toast.success("Return filed and locked");
      setConfirmFile(false);
      await refresh();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const remove = useMutation({
    mutationFn: () => doDelete({ data: { companyId, returnId: openId! } }),
    onSuccess: async () => {
      toast.success("Draft deleted");
      setOpenId(null);
      await refresh();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const settle = useMutation({
    mutationFn: () =>
      doSettle({
        data: {
          companyId,
          returnId: openId!,
          settlementAccountId: settleAccount,
          journalDate: settleDate,
          confirm: true,
        },
      }),
    onSuccess: async () => {
      toast.success("Settlement journal posted");
      setConfirmSettle(false);
      await refresh();
      await qc.invalidateQueries({ queryKey: ["journals", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const settlementAccounts = useMemo(
    () =>
      filterTaxAccountPicker(accounts, "adjustment_offset").filter(
        (a) => a.account_type === "liability" || a.account_type === "asset",
      ),
    [accounts],
  );

  const exportCsv = (
    lines: BoxLine[],
    currency: string,
    period: string,
    basisLabel: string,
    isUk: boolean,
    jurisdiction: string | null,
  ) => {
    const decimals = decimalPlacesFor(currency);
    const rows = lines.map((l) => [
      l.box_key.replace("box", ""),
      l.label,
      csvMoney(l.amount_minor, currency),
      isUk
        ? csvMoney(
            filingAmountMinor(l.box_key as BoxKey, l.amount_minor, decimals, jurisdiction),
            currency,
          )
        : "",
    ]);
    const text = toCsv(
      {
        company: companyName,
        report: isUk ? "VAT return (VAT100 layout)" : "Tax return",
        period,
        currency,
        basis: basisLabel,
      },
      ["Box", "Description", "Amount", isUk ? "To enter on the HMRC form" : ""],
      rows,
    );
    downloadCsv(csvFilename("tax-return", period), text);
  };

  const d = detail.data;
  const pv = preview.data;

  return (
    <div className="space-y-6">
      <Alert>
        <AlertTitle>Calculated from your documents</AlertTitle>
        <AlertDescription>
          Boxes are totalled from the tax on each invoice, bill, credit note and expense, grouped by
          tax code. Tax settlement and adjustment journals are never counted. LinkBooks does not
          submit returns to a tax authority: copy the figures to your filing service, then mark the
          return as filed here to lock them.
        </AlertDescription>
      </Alert>

      {list.data && !list.data.available ? (
        <Alert variant="destructive">
          <AlertTitle>Returns are not set up yet</AlertTitle>
          <AlertDescription>
            The database update for tax returns (20261024130200) has not been applied. You can still
            calculate a return, but it cannot be saved or filed.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calculate a return</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="ret-start">From</Label>
              <Input
                id="ret-start"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ret-end">To</Label>
              <Input
                id="ret-end"
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Basis</Label>
              <Select
                value={basis}
                onValueChange={(v) => setBasis(v === "cash" ? "cash" : "accrual")}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="accrual">Invoice date (accrual)</SelectItem>
                  <SelectItem value="cash">Payment date (cash)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={!start || !end || start > end}
              onClick={() => setCalc({ start, end, basis })}
            >
              Calculate
            </Button>
          </div>
          {basis === "cash" ? (
            <p className="text-xs text-muted-foreground">
              Cash basis counts invoices and bills in proportion to payments dated in the period.
              Credit notes and expenses use their own date.
            </p>
          ) : null}

          {calc === null ? null : preview.isPending ? (
            <LoadingState />
          ) : preview.isError ? (
            <ErrorState
              title="Could not calculate the return"
              description={friendlyAuthError(preview.error)}
              onRetry={() => preview.refetch()}
            />
          ) : pv ? (
            <div className="space-y-3">
              {warningsFor(pv.summary, pv.regime).map((w) => (
                <Alert key={w.text} variant={w.tone === "warn" ? "destructive" : "default"}>
                  <AlertDescription>{w.text}</AlertDescription>
                </Alert>
              ))}
              <p className="text-sm text-muted-foreground">
                {f.date(pv.periodStart)} to {f.date(pv.periodEnd)} · {pv.summary.documents}{" "}
                documents · {pv.summary.lines} lines
              </p>
              <BoxTable
                lines={pv.lines}
                currency={pv.currency}
                isUk={pv.isUk}
                jurisdiction={pv.jurisdiction}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={saveDraft.isPending || (list.data ? !list.data.available : false)}
                  onClick={() => saveDraft.mutate()}
                >
                  {saveDraft.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save as draft
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    exportCsv(
                      pv.lines,
                      pv.currency,
                      `${pv.periodStart} to ${pv.periodEnd}`,
                      pv.basis,
                      pv.isUk,
                      pv.jurisdiction,
                    )
                  }
                >
                  <Download className="size-4" /> CSV
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Returns</CardTitle>
        </CardHeader>
        <CardContent>
          {list.isPending ? (
            <LoadingState />
          ) : list.isError ? (
            <ErrorState
              title="Could not load returns"
              description={friendlyAuthError(list.error)}
              onRetry={() => list.refetch()}
            />
          ) : list.data.returns.length === 0 ? (
            <EmptyState
              title="No saved returns"
              description="Calculate a period above and save it."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead className="text-right">Net tax</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.returns.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      {f.date(r.period_start)} → {f.date(r.period_end)}
                    </TableCell>
                    <TableCell className="capitalize">{r.basis}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.money(r.net_tax_minor, r.currency_code ?? undefined)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "filed" ? "default" : "secondary"}>
                        {r.status === "filed" ? "Filed" : "Draft"}
                      </Badge>
                      {r.settlement_journal_id ? (
                        <Badge variant="outline" className="ml-1">
                          Settled
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setOpenId(r.id);
                          setConfirmFile(false);
                          setConfirmSettle(false);
                        }}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {openId ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {d ? `Return ${f.date(d.period_start)} to ${f.date(d.period_end)}` : "Return"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {detail.isPending ? (
              <LoadingState />
            ) : detail.isError ? (
              <ErrorState
                title="Could not load the return"
                description={friendlyAuthError(detail.error)}
                onRetry={() => detail.refetch()}
              />
            ) : d ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={d.status === "filed" ? "default" : "secondary"}>
                    {d.status === "filed" ? "Filed and locked" : "Draft"}
                  </Badge>
                  <span className="capitalize text-muted-foreground">{d.basis} basis</span>
                  {d.filed_at ? (
                    <span className="text-muted-foreground">filed {f.dateTime(d.filed_at)}</span>
                  ) : null}
                </div>

                {warningsFor(d.summary, "vat").map((w) => (
                  <Alert key={w.text} variant={w.tone === "warn" ? "destructive" : "default"}>
                    <AlertDescription>{w.text}</AlertDescription>
                  </Alert>
                ))}

                {d.changedSinceFiling.length > 0 ? (
                  <Alert variant="destructive">
                    <AlertTitle>Figures have changed since this return was filed</AlertTitle>
                    <AlertDescription>
                      Documents dated in this period were added, changed or voided after filing.
                      Boxes affected:{" "}
                      {d.changedSinceFiling
                        .map(
                          (c) =>
                            `${c.box_key.replace("box", "")} (filed ${f.money(c.filed_minor, d.currency)}, now ${f.money(c.now_minor, d.currency)})`,
                        )
                        .join("; ")}
                      . The filed figures above are unchanged. Correct the difference in your next
                      return.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <BoxTable
                  lines={d.lines}
                  currency={d.currency}
                  isUk={d.isUk}
                  jurisdiction={d.jurisdiction}
                />

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      exportCsv(
                        d.lines,
                        d.currency,
                        `${d.period_start} to ${d.period_end}`,
                        d.basis,
                        d.isUk,
                        d.jurisdiction,
                      )
                    }
                  >
                    <Download className="size-4" /> CSV
                  </Button>
                </div>

                {d.status === "draft" ? (
                  <div className="space-y-3 rounded-md border p-3">
                    <p className="text-sm">
                      Filing locks these figures. It does not send anything to the tax authority and
                      does not post a journal.
                    </p>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="confirm-file"
                        checked={confirmFile}
                        onCheckedChange={(v) => setConfirmFile(v === true)}
                      />
                      <Label htmlFor="confirm-file" className="text-sm">
                        I have filed this return with the tax authority and want to lock it.
                      </Label>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        disabled={!confirmFile || file.isPending}
                        onClick={() => file.mutate()}
                      >
                        {file.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                        Mark as filed
                      </Button>
                      <Button
                        variant="outline"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate()}
                      >
                        Delete draft
                      </Button>
                    </div>
                  </div>
                ) : d.settlement_journal_id ? (
                  <p className="text-sm">
                    Settled by{" "}
                    <Link
                      to="/accounting"
                      search={{ tab: "journals", journal: d.settlement_journal_id }}
                      className="underline"
                    >
                      journal
                    </Link>
                    .
                  </p>
                ) : (
                  <div className="space-y-3 rounded-md border p-3">
                    <h3 className="text-sm font-medium">Settle the tax accounts (optional)</h3>
                    <p className="text-sm text-muted-foreground">
                      Posts one journal that clears output tax and input tax into the account you
                      choose, for example tax payable or the bank. Skip this if you settle through
                      bank reconciliation instead.
                    </p>
                    {!d.outputAccountId || !d.inputAccountId ? (
                      <Alert variant="destructive">
                        <AlertDescription>
                          Map separate output and input tax accounts under GL mappings first.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="space-y-1">
                            <Label>Settlement account</Label>
                            <Select value={settleAccount} onValueChange={setSettleAccount}>
                              <SelectTrigger className="w-72">
                                <SelectValue placeholder="Choose an account" />
                              </SelectTrigger>
                              <SelectContent>
                                {settlementAccounts.map((a) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.code} — {a.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="settle-date">Journal date</Label>
                            <Input
                              id="settle-date"
                              type="date"
                              value={settleDate}
                              onChange={(e) => setSettleDate(e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="confirm-settle"
                            checked={confirmSettle}
                            onCheckedChange={(v) => setConfirmSettle(v === true)}
                          />
                          <Label htmlFor="confirm-settle" className="text-sm">
                            Post the settlement journal for {f.money(d.net_tax_minor, d.currency)}{" "}
                            {d.net_tax_minor >= 0 ? "payable" : "refundable"}.
                          </Label>
                        </div>
                        <Button
                          disabled={
                            !confirmSettle || !settleAccount || !settleDate || settle.isPending
                          }
                          onClick={() => settle.mutate()}
                        >
                          {settle.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                          Post settlement journal
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
