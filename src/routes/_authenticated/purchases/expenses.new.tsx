import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  listPaymentAccounts,
  saveAndPostExpense,
} from "@/lib/purchases/purchases.functions";
import { parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import { useCanDo } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/purchases/expenses/new")({
  head: () => ({ meta: [{ title: "New expense — LinkBooks" }] }),
  component: NewExpense,
});

export function NewExpense() {
  const { company } = useActiveCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fetchAccounts = useServerFn(listAccounts);
  const fetchPaymentAccounts = useServerFn(listPaymentAccounts);
  const saveExpense = useServerFn(saveAndPostExpense);
  const canPost = useCanDo("purchases.authorise");
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const accounts = (accountsQ.data ?? []) as Array<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    is_postable: boolean;
    is_active: boolean;
  }>;
  const expenseAccounts = accounts.filter(
    (a) => a.is_active && a.is_postable && a.account_type === "expense",
  );
  // Bank / cash accounts only - receivables, VAT and fixed assets are not valid "paid from" accounts.
  const paymentAccountsQ = useQuery({
    queryKey: ["payment-accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchPaymentAccounts({ data: { companyId: companyId! } }),
  });
  const bankAccounts = (paymentAccountsQ.data ?? []) as Array<{
    id: string;
    code: string;
    name: string;
  }>;

  const [payeeName, setPayeeName] = useState("");
  const [expenseDate, setExpenseDate] = useState(today);
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amount, setAmount] = useState("0.00");
  const [tax, setTax] = useState("0.00");
  const [reference, setReference] = useState("");
  const [memo, setMemo] = useState("");
  const amountInvalid = tryParseMinor(amount || "0", currency) === null;
  const taxInvalid = tryParseMinor(tax || "0", currency) === null;

  const mutation = useMutation({
    mutationFn: (post: boolean) =>
      saveExpense({
        data: {
          companyId: companyId!,
          payeeName,
          expenseDate,
          expenseAccountId,
          paymentAccountId,
          currencyCode: currency,
          netMinor: Number(parseMinorOrThrow(amount || "0", currency, "Net amount")),
          taxMinor: Number(parseMinorOrThrow(tax || "0", currency, "Tax")),
          reference,
          memo,
          post,
        },
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["expenses", companyId] });
      toast.success(result.journalId ? "Expense posted to ledger" : "Expense draft saved");
      navigate({ to: "/purchases/expenses/$expenseId", params: { expenseId: result.id } });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (accountsQ.isPending || paymentAccountsQ.isPending) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="New direct expense"
        description="Pays immediately (DR expense / CR bank). Use Bills for supplier invoices paid later."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/purchases/expenses">Back</Link>
          </Button>
        }
      />
      <div className="grid max-w-lg gap-4">
        <div className="space-y-2">
          <Label>Payee</Label>
          <Input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Date</Label>
          <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Expense account</Label>
          <Select value={expenseAccountId} onValueChange={setExpenseAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {expenseAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Payment account (bank)</Label>
          <Select value={paymentAccountId} onValueChange={setPaymentAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {bankAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Net ({currency})</Label>
            <Input
              value={amount}
              inputMode="decimal"
              aria-invalid={amountInvalid}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Tax ({currency})</Label>
            <Input
              value={tax}
              inputMode="decimal"
              aria-invalid={taxInvalid}
              onChange={(e) => setTax(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Memo</Label>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={mutation.isPending || amountInvalid || taxInvalid}
            onClick={() => mutation.mutate(false)}
          >
            Save draft
          </Button>
          <Button
            size="sm"
            disabled={mutation.isPending || amountInvalid || taxInvalid || !canPost}
            title={canPost ? undefined : "You do not have permission to post expenses"}
            onClick={() => mutation.mutate(true)}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save & post
          </Button>
        </div>
      </div>
    </>
  );
}
