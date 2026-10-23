import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, CircleSlash, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { toast } from "sonner";
import { listPeriods, lockPeriod } from "@/lib/accounting/accounting.functions";
import { getPeriodCloseFacts } from "@/lib/accounting/period-close.functions";
import {
  buildCloseChecklist,
  summariseChecklist,
  type CloseCheckStatus,
} from "@/lib/accounting/period-close";
import { getAgedPayables, getAgedReceivables } from "@/lib/reports/report.functions";
import { postYearEndClose, previewYearEndClose } from "@/lib/reports/year-end.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { useFormat } from "@/hooks/use-format";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";

const ICON: Record<CloseCheckStatus, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: TriangleAlert,
  fail: XCircle,
  na: CircleSlash,
};
const TONE: Record<CloseCheckStatus, string> = {
  pass: "text-emerald-600",
  warn: "text-amber-600",
  fail: "text-destructive",
  na: "text-muted-foreground",
};
const WORD: Record<CloseCheckStatus, string> = {
  pass: "Passed",
  warn: "Needs attention",
  fail: "Blocking",
  na: "Not applicable",
};

/** AC-09: one place to check, optionally close the year, and lock a period. */
export function PeriodClosePanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const f = useFormat();
  const fetchPeriods = useServerFn(listPeriods);
  const fetchFacts = useServerFn(getPeriodCloseFacts);
  const fetchAr = useServerFn(getAgedReceivables);
  const fetchAp = useServerFn(getAgedPayables);
  const doLock = useServerFn(lockPeriod);
  const doPreview = useServerFn(previewYearEndClose);
  const doClose = useServerFn(postYearEndClose);

  const [periodId, setPeriodId] = useState<string>("");
  const [ack, setAck] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const periods = useQuery({
    queryKey: ["periods", companyId],
    queryFn: () => fetchPeriods({ data: { companyId } }),
  });
  const openPeriods = useMemo(
    () => (periods.data ?? []).filter((p) => p.status === "open"),
    [periods.data],
  );
  useEffect(() => {
    const first = openPeriods[0];
    if (!periodId && first) setPeriodId(first.id);
  }, [openPeriods, periodId]);
  const period = openPeriods.find((p) => p.id === periodId);
  const end = period?.end_date;

  const facts = useQuery({
    queryKey: ["period-close-facts", companyId, end],
    enabled: Boolean(end),
    queryFn: () => fetchFacts({ data: { companyId, periodEnd: end as string } }),
  });
  const ar = useQuery({
    queryKey: ["period-close-ar", companyId, end],
    enabled: Boolean(end),
    queryFn: () => fetchAr({ data: { companyId, asOf: end as string } }),
  });
  const ap = useQuery({
    queryKey: ["period-close-ap", companyId, end],
    enabled: Boolean(end),
    queryFn: () => fetchAp({ data: { companyId, asOf: end as string } }),
  });

  const items = useMemo(() => {
    if (!facts.data || !ar.data || !ap.data || !end) return null;
    const a = ar.data as { controlAccountFound: boolean; varianceMinor: number };
    const p = ap.data as { controlAccountFound: boolean; varianceMinor: number };
    return buildCloseChecklist({
      periodEnd: end,
      unreconciledBankLines: facts.data.unreconciledBankLines,
      draftDocuments: facts.data.draftDocuments,
      ar: { found: a.controlAccountFound, variance: a.varianceMinor },
      ap: { found: p.controlAccountFound, variance: p.varianceMinor },
      openingBalanceMinor: facts.data.openingBalanceMinor,
      taxReturn: facts.data.taxReturn,
      yearEnd: facts.data.yearEnd ? { closed: facts.data.yearEnd.closed } : null,
    });
  }, [facts.data, ar.data, ap.data, end]);
  const summary = items ? summariseChecklist(items) : null;

  const preview = useQuery({
    queryKey: ["year-end-preview", companyId, facts.data?.yearEnd?.fyEnd],
    enabled: Boolean(facts.data?.yearEnd && !facts.data.yearEnd.closed),
    queryFn: () =>
      doPreview({ data: { companyId, fyEnd: (facts.data?.yearEnd?.fyEnd ?? "") as string } }),
    retry: false,
  });

  const lock = useMutation({
    mutationFn: () => doLock({ data: { periodId } }),
    onSuccess: async () => {
      toast.success("Period locked");
      setAck(false);
      setPeriodId("");
      await qc.invalidateQueries({ queryKey: ["periods", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const close = useMutation({
    mutationFn: () =>
      doClose({ data: { companyId, fyEnd: facts.data?.yearEnd?.fyEnd ?? "", confirm: true } }),
    onSuccess: async () => {
      toast.success("Closing journal posted");
      setConfirmClose(false);
      await qc.invalidateQueries({ queryKey: ["period-close-facts", companyId] });
      await qc.invalidateQueries({ queryKey: ["year-end-preview", companyId] });
      await qc.invalidateQueries({ queryKey: ["journals", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (periods.isPending) return <LoadingState />;
  if (periods.isError)
    return (
      <ErrorState
        title="Could not load periods"
        description={friendlyAuthError(periods.error)}
        onRetry={() => periods.refetch()}
      />
    );
  if (openPeriods.length === 0)
    return (
      <EmptyState
        title="No open period to close"
        description="Every period is locked, or none exists yet. Add a financial year on the Financial years tab."
      />
    );

  const needsAck = summary ? !summary.clean : true;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period close</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-sm space-y-1">
            <Label>Period</Label>
            <Select
              value={periodId}
              onValueChange={(v) => {
                setPeriodId(v);
                setAck(false);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a period" />
              </SelectTrigger>
              <SelectContent>
                {openPeriods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({f.date(p.start_date)} → {f.date(p.end_date)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {facts.isError || ar.isError || ap.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not run the checks</AlertTitle>
              <AlertDescription>
                {friendlyAuthError(facts.error ?? ar.error ?? ap.error)}
              </AlertDescription>
            </Alert>
          ) : !items ? (
            <LoadingState />
          ) : (
            <ul className="divide-y rounded-md border">
              {items.map((c) => {
                const Icon = ICON[c.status];
                return (
                  <li key={c.id} className="flex items-start gap-3 px-3 py-3">
                    <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", TONE[c.status])} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {c.label} <span className="sr-only">— {WORD[c.status]}</span>
                      </div>
                      <div className="text-sm text-muted-foreground">{c.detail}</div>
                    </div>
                    {c.href && c.status !== "pass" && c.status !== "na" ? (
                      <Button asChild size="sm" variant="outline">
                        <Link to={c.href as never}>Review</Link>
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {facts.data?.yearEnd && !facts.data.yearEnd.closed ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Year-end closing journal (optional)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Reports already include this year&apos;s profit in equity without it. Posting the
              journal moves profit to retained earnings and zeroes the income and expense accounts
              for the next year. It is posted once, for this year end, and can be reversed.
            </p>
            {preview.isPending ? (
              <LoadingState />
            ) : preview.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Preview unavailable</AlertTitle>
                <AlertDescription>{friendlyAuthError(preview.error)}</AlertDescription>
              </Alert>
            ) : preview.data.alreadyClosedJournalId ? (
              <p className="text-sm">
                Already closed in journal #{preview.data.alreadyClosedJournalNumber}.
              </p>
            ) : preview.data.lines.length === 0 ? (
              <p className="text-sm">No income or expense balances to close for this year.</p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.data.lines.map((l) => (
                      <TableRow key={l.account_id}>
                        <TableCell>
                          {l.code} {l.name}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {l.debit_minor ? f.amount(l.debit_minor) : ""}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {l.credit_minor ? f.amount(l.credit_minor) : ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-sm">
                  Net profit moved to {preview.data.retainedEarnings.code}{" "}
                  {preview.data.retainedEarnings.name}:{" "}
                  <strong>{f.money(preview.data.netProfitMinor)}</strong>
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="confirm-close"
                    checked={confirmClose}
                    onCheckedChange={(v) => setConfirmClose(v === true)}
                  />
                  <Label htmlFor="confirm-close" className="text-sm">
                    I have reviewed this journal and want to post it.
                  </Label>
                </div>
                <Button disabled={!confirmClose || close.isPending} onClick={() => close.mutate()}>
                  {close.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Post closing journal
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lock the period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            A locked period rejects new postings. An owner or accountant can unlock it again from
            the Financial years tab.
          </p>
          {summary && !summary.clean ? (
            <div className="flex items-center gap-2">
              <Checkbox id="ack-lock" checked={ack} onCheckedChange={(v) => setAck(v === true)} />
              <Label htmlFor="ack-lock" className="text-sm">
                I understand {summary.blockers} blocking and {summary.warnings} other item
                {summary.blockers + summary.warnings === 1 ? "" : "s"} remain, and I want to lock
                anyway.
              </Label>
            </div>
          ) : null}
          <Button
            variant="outline"
            disabled={!summary || lock.isPending || (needsAck && !ack)}
            onClick={() => lock.mutate()}
          >
            {lock.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Lock period
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
