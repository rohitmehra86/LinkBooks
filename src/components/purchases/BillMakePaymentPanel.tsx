"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  createAndPostPayment,
  reverseSupplierPayment,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits, toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export type BillPaymentAllocation = {
  id: string;
  amount_minor: number;
  payment_id?: string;
  supplier_payments:
    | {
        id: string;
        payment_date: string;
        reference: string | null;
        memo?: string | null;
        amount_minor?: number;
        status: string;
        posted_journal_id?: string | null;
        bank_account_id?: string;
      }
    | Array<{
        id: string;
        payment_date: string;
        reference: string | null;
        memo?: string | null;
        amount_minor?: number;
        status: string;
        posted_journal_id?: string | null;
        bank_account_id?: string;
      }>
    | null;
};

type Props = {
  companyId: string;
  billId: string;
  contactId: string;
  currency: string;
  billStatus: string;
  outstandingMinor: number;
  allocations: BillPaymentAllocation[];
};

function paymentLabel(status: string) {
  if (status === "void") return "Voided";
  if (status === "paid") return "Posted";
  return status.replace(/_/g, " ");
}

/**
 * Fully functional Make a payment panel for authorised / partly paid bills.
 * Posts through createAndPostPayment → shared ledger (DR AP / CR bank).
 */
export function BillMakePaymentPanel({
  companyId,
  billId,
  contactId,
  currency,
  billStatus,
  outstandingMinor,
  allocations,
}: Props) {
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listAccounts);
  const postPayment = useServerFn(createAndPostPayment);
  const reversePayment = useServerFn(reverseSupplierPayment);

  const today = new Date().toISOString().slice(0, 10);
  const canPay =
    ["authorised", "partly_paid"].includes(billStatus) && outstandingMinor > 0;

  const [amount, setAmount] = useState(() =>
    fromMinorUnits(BigInt(Math.max(0, outstandingMinor)), currency),
  );
  const [paymentDate, setPaymentDate] = useState(today);
  const [bankAccountId, setBankAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setAmount(fromMinorUnits(BigInt(Math.max(0, outstandingMinor)), currency));
  }, [outstandingMinor, currency, billId]);

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId) && canPay,
    queryFn: () => fetchAccounts({ data: { companyId } }),
  });

  const bankOptions = useMemo(() => {
    const rows = (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>;
    return rows
      .filter((a) => a.is_active && a.is_postable && a.account_type === "asset")
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }));
  }, [accountsQ.data]);

  const amountMinor = Number(toMinorUnits(amount || "0", currency));
  const overpay = amountMinor > outstandingMinor;

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["bill", companyId, billId] });
    await qc.invalidateQueries({ queryKey: ["bills", companyId] });
    await qc.invalidateQueries({ queryKey: ["bills-workspace-summary", companyId] });
    await qc.invalidateQueries({ queryKey: ["payments", companyId] });
  };

  const payM = useMutation({
    mutationFn: async () => {
      setFormError(null);
      if (!canPay) throw new Error("This bill cannot accept payments");
      if (!bankAccountId) throw new Error("Select a bank or cash account");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) throw new Error("Payment date required");
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw new Error("Enter a payment amount greater than zero");
      }
      if (amountMinor > outstandingMinor) {
        throw new Error("Amount exceeds outstanding balance — overpayment blocked");
      }
      return postPayment({
        data: {
          companyId,
          contactId,
          paymentDate,
          bankAccountId,
          currencyCode: currency,
          amountMinor,
          allocations: [{ billId, amountMinor }],
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(notes.trim() ? { memo: notes.trim() } : {}),
        },
      });
    },
    onSuccess: async (result) => {
      await invalidate();
      toast.success(
        result.journalId
          ? "Payment recorded — AP and bank journal posted"
          : "Payment recorded",
      );
      setReference("");
      setNotes("");
    },
    onError: (e) => {
      const msg = friendlyAuthError(e);
      setFormError(msg);
      toast.error(msg);
    },
  });

  const reverseM = useMutation({
    mutationFn: (paymentId: string) =>
      reversePayment({
        data: {
          companyId,
          paymentId,
          reason: "Reversed from bill payment history",
        },
      }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Payment reversed — journal voided and balance restored");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const history = allocations
    .map((a) => {
      const payRaw = a.supplier_payments;
      const pay = Array.isArray(payRaw) ? payRaw[0] : payRaw;
      return { allocId: a.id, amount_minor: a.amount_minor, pay };
    })
    .filter((r) => r.pay);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-background p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Payment history</h2>
          <p className="text-xs text-muted-foreground">
            Outstanding{" "}
            <strong className="tabular-nums text-foreground">
              {fromMinorUnits(BigInt(Math.max(0, outstandingMinor)), currency)}
            </strong>
          </p>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments recorded on this bill yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Allocated</TableHead>
                <TableHead className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map(({ allocId, amount_minor, pay }) => (
                <TableRow key={allocId}>
                  <TableCell>{pay!.payment_date}</TableCell>
                  <TableCell>{pay!.reference ?? "—"}</TableCell>
                  <TableCell className="max-w-[12rem] truncate text-muted-foreground">
                    {pay!.memo ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {paymentLabel(pay!.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fromMinorUnits(BigInt(amount_minor), currency)}
                  </TableCell>
                  <TableCell>
                    {pay!.status !== "void" && pay!.posted_journal_id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={reverseM.isPending}
                        onClick={() => {
                          if (
                            confirm(
                              "Reverse this payment? The bank/AP journal will be voided and the bill balance restored.",
                            )
                          ) {
                            reverseM.mutate(pay!.id);
                          }
                        }}
                      >
                        Reverse
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Recording a payment updates Accounts Payable and the bank account via the shared ledger.
          This does not transmit funds to a bank — it records the payment in LinkBooks.
        </p>
      </section>

      {canPay ? (
        <section className="rounded-lg border border-emerald-600/30 bg-emerald-50/40 p-4 dark:bg-emerald-950/20">
          <h2 className="mb-1 text-base font-semibold tracking-tight">Make a payment</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Record a full or partial payment against this bill. Multiple payments are allowed until
            the balance is cleared.
          </p>

          {formError ? (
            <Alert variant="destructive" className="mb-3">
              <AlertTitle>Payment not recorded</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="pay-amount">Amount paid ({currency})</Label>
              <Input
                id="pay-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={overpay}
              />
              {overpay ? (
                <p className="text-xs text-destructive">
                  Max {fromMinorUnits(BigInt(outstandingMinor), currency)}
                </p>
              ) : (
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-2 hover:underline"
                  onClick={() =>
                    setAmount(fromMinorUnits(BigInt(outstandingMinor), currency))
                  }
                >
                  Pay full balance
                </button>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-date">Date paid</Label>
              <Input
                id="pay-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Paid from</Label>
              <EntityCombobox
                options={bankOptions}
                value={bankAccountId}
                onChange={setBankAccountId}
                placeholder="Bank or cash account"
                allowClear={false}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="pay-ref">Reference</Label>
              <Input
                id="pay-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Cheque no. / transfer ref"
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="pay-notes">Payment notes</Label>
              <Textarea
                id="pay-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional note for the payment record"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              className="bg-emerald-700 text-white hover:bg-emerald-800"
              disabled={payM.isPending || overpay || accountsQ.isPending}
              onClick={() => payM.mutate()}
            >
              {payM.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Record payment
            </Button>
            <span className="text-xs text-muted-foreground">
              Will post DR Accounts Payable / CR bank for{" "}
              <strong className="tabular-nums text-foreground">
                {fromMinorUnits(BigInt(Math.max(0, amountMinor)), currency)}
              </strong>
            </span>
          </div>
        </section>
      ) : billStatus === "paid" ? (
        <Alert>
          <AlertTitle>Paid in full</AlertTitle>
          <AlertDescription>
            No outstanding balance. Reverse a payment above if you need a controlled correction.
          </AlertDescription>
        </Alert>
      ) : billStatus === "void" ? (
        <Alert>
          <AlertTitle>Voided bill</AlertTitle>
          <AlertDescription>Payments cannot be recorded against voided bills.</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
