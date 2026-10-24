import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  createTransfer,
  listBankAccounts,
  listBankTransfers,
  voidTransfer,
  type BankTransferListRow,
} from "@/lib/banking/banking.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { ConfirmButton } from "@/components/banking/ConfirmButton";
import { MoneyField, moneyFieldMinor } from "@/components/banking/MoneyField";
import {
  DocumentRecordPanel,
  type DocumentRecordHandle,
} from "@/components/documents/DocumentRecordPanel";
import { BankLookup } from "@/components/lookup";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Search = { bankAccountId?: string; amount?: string; direction?: "in" | "out" };

export const Route = createFileRoute("/_authenticated/banking/transfers")({
  // Prefill from "Create transfer from this line": the statement line's account is the destination for money in
  // and the source for money out.
  validateSearch: (s: Record<string, unknown>): Search => {
    const out: Search = {};
    if (typeof s["bankAccountId"] === "string" && s["bankAccountId"])
      out.bankAccountId = s["bankAccountId"];
    if (typeof s["amount"] === "string" && s["amount"]) out.amount = s["amount"];
    if (s["direction"] === "in" || s["direction"] === "out") out.direction = s["direction"];
    return out;
  },
  head: () => ({ meta: [{ title: "Transfers — LinkBooks" }] }),
  component: Transfers,
});

export function Transfers() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const search = Route.useSearch();
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const fetchAccounts = useServerFn(listBankAccounts);
  const fetchTransfers = useServerFn(listBankTransfers);
  const doTransfer = useServerFn(createTransfer);
  const doVoid = useServerFn(voidTransfer);
  const [fromId, setFromId] = useState(
    search.direction === "out" ? (search.bankAccountId ?? "") : "",
  );
  const [toId, setToId] = useState(search.direction === "in" ? (search.bankAccountId ?? "") : "");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(search.amount ?? "");
  const [memo, setMemo] = useState("");
  const [received, setReceived] = useState("");
  const [recordId, setRecordId] = useState<string | null>(null);
  const recordRef = useRef<DocumentRecordHandle>(null);

  useEffect(() => {
    if (search.direction === "out" && search.bankAccountId) setFromId(search.bankAccountId);
    if (search.direction === "in" && search.bankAccountId) setToId(search.bankAccountId);
    if (search.amount) setAmount(search.amount);
  }, [search.bankAccountId, search.direction, search.amount]);

  const accountsQ = useQuery({
    queryKey: ["bank-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const transfersQ = useQuery({
    queryKey: ["bank-transfers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchTransfers({ data: { companyId: companyId! } }),
  });

  const accounts = accountsQ.data ?? [];
  const fromAcc = accounts.find((a) => a.id === fromId);
  const toAcc = accounts.find((a) => a.id === toId);
  const currency = fromAcc?.currency_code ?? company?.base_currency ?? "GBP";
  const currencyMismatch = Boolean(
    fromAcc && toAcc && fromAcc.currency_code !== toAcc.currency_code,
  );
  const amountMinor = moneyFieldMinor(amount, currency, { allowNegative: false });
  const toCurrency = toAcc?.currency_code ?? currency;
  const receivedMinor = moneyFieldMinor(received, toCurrency, { allowNegative: false });
  const canPost =
    Boolean(fromId && toId && fromId !== toId) &&
    amountMinor !== null &&
    amountMinor > 0n &&
    (!currencyMismatch || (receivedMinor !== null && receivedMinor > 0n));

  const mutation = useMutation({
    mutationFn: () =>
      doTransfer({
        data: {
          companyId: companyId!,
          fromBankAccountId: fromId,
          toBankAccountId: toId,
          transferDate: date,
          amountMinor: Number(amountMinor),
          currencyCode: currency,
          toAmountMinor: currencyMismatch && receivedMinor !== null ? Number(receivedMinor) : null,
          memo,
        },
      }),
    onSuccess: async (result) => {
      try {
        await recordRef.current?.flush(result.id);
      } catch (e) {
        toast.error(
          `Transfer posted, but notes or files could not be stored: ${friendlyAuthError(e)}`,
        );
      }
      setRecordId(result.id);
      toast.success("Transfer posted. One journal only.");
      setAmount("");
      setReceived("");
      setMemo("");
      await qc.invalidateQueries({ queryKey: ["bank-transfers", companyId] });
      await qc.invalidateQueries({ queryKey: ["bank-account-summaries", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const voidM = useMutation({
    mutationFn: (transferId: string) => doVoid({ data: { companyId: companyId!, transferId } }),
    onSuccess: async () => {
      toast.success("Transfer voided via reversal journal");
      await qc.invalidateQueries({ queryKey: ["bank-transfers", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (accountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="Transfers"
        description="Moves money between your bank/cash accounts with a single DR/CR journal, so nothing is counted twice. Match the statement lines on both accounts to it afterwards."
      />
      <div className="grid max-w-md gap-3">
        <div className="space-y-1">
          <Label>From</Label>
          <BankLookup
            ariaLabel="From account"
            accounts={accounts}
            value={fromId}
            onChange={setFromId}
            companyId={companyId}
            excludeId={toId || undefined}
            placeholder="Source"
            allowClear={false}
          />
        </div>
        <div className="space-y-1">
          <Label>To</Label>
          <BankLookup
            ariaLabel="To account"
            accounts={accounts}
            value={toId}
            onChange={setToId}
            companyId={companyId}
            excludeId={fromId || undefined}
            placeholder="Destination"
            allowClear={false}
          />
        </div>
        {currencyMismatch ? (
          <p className="text-sm text-muted-foreground">
            These accounts are in different currencies. Enter what each side shows on the statement.
            The difference against the stored exchange rates is posted to FX gain/loss.
          </p>
        ) : null}
        <div className="space-y-1">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Amount ({currency})</Label>
          <MoneyField
            label="Transfer amount"
            value={amount}
            currency={currency}
            options={{ allowNegative: false }}
            onChange={setAmount}
          />
        </div>
        {currencyMismatch ? (
          <div className="space-y-1">
            <Label>Amount received ({toCurrency})</Label>
            <MoneyField
              label="Amount received"
              value={received}
              currency={toCurrency}
              options={{ allowNegative: false }}
              onChange={setReceived}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label>Memo</Label>
          <Input value={memo} maxLength={500} onChange={(e) => setMemo(e.target.value)} />
        </div>
        <DocumentRecordPanel
          ref={recordRef}
          entityType="bank_transfer"
          entityId={recordId}
          audience="internal"
        />
        <Button
          size="sm"
          disabled={mutation.isPending || !canPost}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Post transfer
        </Button>
      </div>

      <h2 className="mb-2 mt-8 text-lg font-semibold">Transfer history</h2>
      {transfersQ.isPending ? (
        <LoadingState />
      ) : (transfersQ.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No transfers yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Memo</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(transfersQ.data as BankTransferListRow[]).map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.transfer_date}</TableCell>
                <TableCell>{t.from_name}</TableCell>
                <TableCell>{t.to_name}</TableCell>
                <TableCell className="money">
                  {fromMinorUnits(t.amount_minor, t.currency_code || currency)} {t.currency_code}
                  {t.to_amount_minor != null && t.to_currency_code !== t.currency_code ? (
                    <span className="block text-xs text-muted-foreground">
                      received {fromMinorUnits(t.to_amount_minor, t.to_currency_code ?? currency)}{" "}
                      {t.to_currency_code}
                      {t.fx_difference_minor !== 0
                        ? `, FX ${fromMinorUnits(t.fx_difference_minor, company?.base_currency ?? currency)}`
                        : ""}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{t.memo ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{t.status}</Badge>
                </TableCell>
                <TableCell>
                  {t.status === "posted" ? (
                    <ConfirmButton
                      title="Void this transfer?"
                      description="A reversing journal is posted and the transfer is marked void."
                      confirmLabel="Void"
                      disabled={voidM.isPending}
                      onConfirm={() => voidM.mutate(t.id)}
                    >
                      Void
                    </ConfirmButton>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
