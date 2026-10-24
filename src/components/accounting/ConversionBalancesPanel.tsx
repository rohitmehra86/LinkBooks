import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  getConversionOverview,
  getConversionSetup,
  postConversionBalances,
  reverseConversionBalances,
} from "@/lib/accounting/conversion.functions";
import {
  buildConversionPayload,
  isDocumentControlAccount,
  validateConversion,
  type OpeningDoc,
  type TbEntry,
} from "@/lib/accounting/conversion-balances";
import { toMinorUnits } from "@/lib/accounting/money";
import { ContactLookup } from "@/components/lookup";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { useFormat } from "@/hooks/use-format";
import { ErrorState, LoadingState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type DocRow = {
  key: number;
  contactId: string;
  reference: string;
  documentDate: string;
  dueDate: string;
  currencyCode: string;
  fxRate: string;
  amount: string;
};

function safeMinor(value: string, currency: string): bigint {
  const v = value.trim().replace(/,/g, "");
  if (!v) return 0n;
  try {
    return toMinorUnits(v, currency);
  } catch {
    return -1n; // flagged as a negative amount => validation error
  }
}

/** AC-02: guided conversion date + opening balances. Posts through `post_conversion_balances` → `post_journal`. */
export function ConversionBalancesPanel({
  companyId,
  currency,
}: {
  companyId: string;
  currency: string;
}) {
  const qc = useQueryClient();
  const f = useFormat();
  const fetchOverview = useServerFn(getConversionOverview);
  const fetchSetup = useServerFn(getConversionSetup);
  const doPost = useServerFn(postConversionBalances);
  const doReverse = useServerFn(reverseConversionBalances);

  const [conversionDate, setConversionDate] = useState("");
  const [tbInput, setTbInput] = useState<Record<string, { debit: string; credit: string }>>({});
  const [invoices, setInvoices] = useState<DocRow[]>([]);
  const [bills, setBills] = useState<DocRow[]>([]);
  const [acceptDifference, setAcceptDifference] = useState(false);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const [reason, setReason] = useState("");
  const [nextKey, setNextKey] = useState(1);

  const overview = useQuery({
    queryKey: ["conversion-overview", companyId],
    queryFn: () => fetchOverview({ data: { companyId } }),
  });
  const setup = useQuery({
    queryKey: ["conversion-setup", companyId],
    queryFn: () => fetchSetup({ data: { companyId } }),
    enabled: overview.data?.available === true && !overview.data.active,
  });

  const tbAccounts = useMemo(
    () => (setup.data?.accounts ?? []).filter((a) => !isDocumentControlAccount(a)),
    [setup.data],
  );

  const tb: TbEntry[] = useMemo(
    () =>
      tbAccounts.map((a) => ({
        accountId: a.id,
        debitMinor: safeMinor(tbInput[a.id]?.debit ?? "", currency),
        creditMinor: safeMinor(tbInput[a.id]?.credit ?? "", currency),
      })),
    [tbAccounts, tbInput, currency],
  );

  const toDoc = (r: DocRow): OpeningDoc => ({
    contactId: r.contactId,
    reference: r.reference,
    documentDate: r.documentDate,
    dueDate: r.dueDate || undefined,
    currencyCode: (r.currencyCode || currency).toUpperCase(),
    fxRate: r.fxRate || undefined,
    amountMinor: safeMinor(r.amount, r.currencyCode || currency),
  });

  const input = useMemo(
    () => ({
      conversionDate,
      baseCurrency: currency,
      tb,
      invoices: invoices.map(toDoc),
      bills: bills.map(toDoc),
      acceptDifference,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversionDate, currency, tb, invoices, bills, acceptDifference],
  );
  const validation = useMemo(() => validateConversion(input), [input]);
  const s = validation.summary;
  const nothingEntered = s.tbLineCount + s.invoiceCount + s.billCount === 0;

  const post = useMutation({
    mutationFn: () =>
      doPost({
        data: { payload: buildConversionPayload(companyId, input, note.trim() || undefined) },
      }),
    onSuccess: async () => {
      toast.success("Conversion balances posted");
      await qc.invalidateQueries({ queryKey: ["conversion-overview", companyId] });
      await qc.invalidateQueries({ queryKey: ["journals", companyId] });
      await qc.invalidateQueries({ queryKey: ["lock-policy", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const reverse = useMutation({
    mutationFn: () => doReverse({ data: { companyId, reason } }),
    onSuccess: async () => {
      toast.success("Conversion balances reversed");
      setReason("");
      await qc.invalidateQueries({ queryKey: ["conversion-overview", companyId] });
      await qc.invalidateQueries({ queryKey: ["journals", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (overview.isPending) return <LoadingState />;
  if (overview.isError)
    return (
      <ErrorState
        description={friendlyAuthError(overview.error)}
        onRetry={() => void overview.refetch()}
      />
    );
  const ov = overview.data;

  if (!ov.available) {
    return (
      <Alert>
        <AlertTitle>Unavailable</AlertTitle>
        <AlertDescription>{ov.unavailableReason}</AlertDescription>
      </Alert>
    );
  }

  if (ov.active) {
    const b = ov.active;
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Conversion balances <Badge>Posted</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Books start on <strong>{f.date(b.conversion_date)}</strong>. Opening journals are
              dated {f.date(b.opening_date)} ({b.journal_ids.length} journal
              {b.journal_ids.length === 1 ? "" : "s"}).
            </p>
            <p>
              Debits {f.money(b.total_debit_minor)} · Credits {f.money(b.total_credit_minor)} ·{" "}
              {b.invoice_count} opening invoice(s) · {b.bill_count} opening bill(s)
              {b.plug_to_opening_equity_minor
                ? ` · ${f.money(b.plug_to_opening_equity_minor)} posted to Opening Balance Equity`
                : ""}
            </p>
            <p className="text-muted-foreground">
              Postings dated before the conversion date are blocked unless you hold the conversion
              override permission.
            </p>
          </CardContent>
        </Card>
        {ov.canManage ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reverse conversion balances</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Reversal posts mirror journals and cancels the opening invoices and bills. It is
                refused if any opening document has already been paid or credited.
              </p>
              <Label htmlFor="conv-reason">Reason</Label>
              <Input id="conv-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button
                variant="destructive"
                disabled={!reason.trim() || reverse.isPending}
                onClick={() => reverse.mutate()}
              >
                {reverse.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Reverse
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    );
  }

  if (!ov.canManage) {
    return (
      <Alert>
        <AlertTitle>No permission</AlertTitle>
        <AlertDescription>
          Only owners, admins and accountants can enter conversion balances.
          {ov.conversionDate ? ` Current conversion date: ${f.date(ov.conversionDate)}.` : ""}
        </AlertDescription>
      </Alert>
    );
  }

  const addDoc = (kind: "invoices" | "bills") => {
    const row: DocRow = {
      key: nextKey,
      contactId: "",
      reference: "",
      documentDate: "",
      dueDate: "",
      currencyCode: currency,
      fxRate: "",
      amount: "",
    };
    setNextKey(nextKey + 1);
    (kind === "invoices" ? setInvoices : setBills)((rows) => [...rows, row]);
  };

  const renderDocs = (kind: "invoices" | "bills") => {
    const rows = kind === "invoices" ? invoices : bills;
    const setRows = kind === "invoices" ? setInvoices : setBills;
    const contacts = (kind === "invoices" ? setup.data?.customers : setup.data?.suppliers) ?? [];
    const patch = (key: number, p: Partial<DocRow>) =>
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
    return (
      <div className="space-y-2">
        {rows.map((r) => {
          const foreign = (r.currencyCode || currency).toUpperCase() !== currency.toUpperCase();
          return (
            <div
              key={r.key}
              className="grid grid-cols-2 gap-2 rounded-md border p-2 md:grid-cols-8"
            >
              <ContactLookup
                ariaLabel={kind === "invoices" ? "Customer" : "Supplier"}
                contacts={contacts}
                value={r.contactId}
                onChange={(contactId) => patch(r.key, { contactId })}
                companyId={companyId}
                placeholder={kind === "invoices" ? "Customer…" : "Supplier…"}
                allowClear
              />
              <Input
                placeholder="Reference"
                aria-label="Reference"
                value={r.reference}
                onChange={(e) => patch(r.key, { reference: e.target.value })}
              />
              <Input
                type="date"
                aria-label="Document date"
                value={r.documentDate}
                onChange={(e) => patch(r.key, { documentDate: e.target.value })}
              />
              <Input
                type="date"
                aria-label="Due date"
                value={r.dueDate}
                onChange={(e) => patch(r.key, { dueDate: e.target.value })}
              />
              <Input
                placeholder="Currency"
                aria-label="Currency"
                maxLength={3}
                value={r.currencyCode}
                onChange={(e) => patch(r.key, { currencyCode: e.target.value.toUpperCase() })}
              />
              <Input
                placeholder={foreign ? "Rate to base" : "—"}
                aria-label="Exchange rate to base currency"
                disabled={!foreign}
                value={r.fxRate}
                onChange={(e) => patch(r.key, { fxRate: e.target.value })}
              />
              <div className="flex gap-1">
                <Input
                  placeholder="Outstanding"
                  aria-label="Outstanding amount"
                  inputMode="decimal"
                  value={r.amount}
                  onChange={(e) => patch(r.key, { amount: e.target.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remove row"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
        <Button size="sm" variant="outline" onClick={() => addDoc(kind)}>
          <Plus className="size-4" /> Add {kind === "invoices" ? "invoice" : "bill"}
        </Button>
      </div>
    );
  };

  const visibleAccounts = tbAccounts.filter((a) => {
    const q = filter.trim().toLowerCase();
    return !q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>How this works</AlertTitle>
        <AlertDescription>
          Pick the day your books in LinkBooks start (the conversion date). Enter the closing trial
          balance from your old system as at the day before, then the unpaid customer invoices and
          supplier bills. One balanced opening journal is posted via the posting engine; postings
          before the conversion date are then blocked.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Conversion date</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="conv-date">Books start on</Label>
          <Input
            id="conv-date"
            type="date"
            className="max-w-xs"
            value={conversionDate}
            onChange={(e) => setConversionDate(e.target.value)}
          />
          {s.openingDate ? (
            <p className="text-sm text-muted-foreground">
              Opening balances are dated {f.date(s.openingDate)}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Trial balance ({currency})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Receivables and payables are entered below as invoices and bills per contact, so they
            are not listed here.
          </p>
          <Input
            placeholder="Filter accounts"
            aria-label="Filter accounts"
            className="max-w-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {setup.isPending ? <LoadingState /> : null}
          <div className="max-h-96 overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-left">
                <tr>
                  <th className="p-2">Account</th>
                  <th className="w-40 p-2">Debit</th>
                  <th className="w-40 p-2">Credit</th>
                </tr>
              </thead>
              <tbody>
                {visibleAccounts.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="p-2">
                      <span className="font-mono text-xs text-muted-foreground">{a.code}</span>{" "}
                      {a.name}
                    </td>
                    {(["debit", "credit"] as const).map((side) => (
                      <td key={side} className="p-1">
                        <Input
                          aria-label={`${side} for ${a.code}`}
                          inputMode="decimal"
                          value={tbInput[a.id]?.[side] ?? ""}
                          onChange={(e) =>
                            setTbInput((cur) => ({
                              ...cur,
                              [a.id]: {
                                debit: cur[a.id]?.debit ?? "",
                                credit: cur[a.id]?.credit ?? "",
                                [side]: e.target.value,
                              },
                            }))
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. Unpaid customer invoices</CardTitle>
        </CardHeader>
        <CardContent>{renderDocs("invoices")}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. Unpaid supplier bills</CardTitle>
        </CardHeader>
        <CardContent>{renderDocs("bills")}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. Check and post</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid max-w-md grid-cols-2 gap-1">
            <span>Total debits</span>
            <span className="text-right tabular-nums">{f.money(s.debits)}</span>
            <span>Total credits</span>
            <span className="text-right tabular-nums">{f.money(s.credits)}</span>
            <span className="font-medium">Difference</span>
            <span
              className={`text-right font-medium tabular-nums ${s.balanced ? "text-green-600" : "text-destructive"}`}
            >
              {f.money(s.difference)}
            </span>
          </div>
          {!nothingEntered && !s.balanced ? (
            <div className="space-y-1">
              <p className="text-destructive">
                Debits and credits differ. Fix the entries, or post the difference to Opening
                Balance Equity.
              </p>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={acceptDifference}
                  onCheckedChange={(v) => setAcceptDifference(v === true)}
                />
                Post the {f.money(s.difference < 0n ? -s.difference : s.difference)} difference to
                Opening Balance Equity
              </label>
            </div>
          ) : null}
          {validation.errors.length ? (
            <ul className="list-disc pl-5 text-destructive">
              {validation.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
          <div className="max-w-md space-y-1">
            <Label htmlFor="conv-note">Note (optional)</Label>
            <Input id="conv-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button
            disabled={!validation.canPost || nothingEntered || post.isPending}
            onClick={() => post.mutate()}
          >
            {post.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Post conversion balances
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
