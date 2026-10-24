import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  approveAndReimburseClaim,
  listEmployeeClaims,
  listPaymentAccounts,
  rejectEmployeeClaim,
  submitEmployeeClaim,
} from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { parseMinorOrThrow, tryParseMinor } from "@/lib/purchases/money-input";
import { useCan } from "@/hooks/use-can";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { AccountLookup } from "@/components/lookup";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
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

export const Route = createFileRoute("/_authenticated/purchases/employee-expenses")({
  component: EmployeeExpensesPage,
});

export function EmployeeExpensesPage() {
  const { company } = useActiveCompany();
  const queryClient = useQueryClient();
  const fetchClaims = useServerFn(listEmployeeClaims);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchPaymentAccounts = useServerFn(listPaymentAccounts);
  const { can } = useCan();
  const submit = useServerFn(submitEmployeeClaim);
  const approve = useServerFn(approveAndReimburseClaim);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const claimsQ = useQuery({
    queryKey: ["claims", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchClaims({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const paymentAccountsQ = useQuery({
    queryKey: ["payment-accounts", companyId],
    enabled: Boolean(companyId) && can("expenses.approve"),
    queryFn: () => fetchPaymentAccounts({ data: { companyId: companyId! } }),
  });
  const [tax, setTax] = useState("0.00");
  const [description, setDescription] = useState("");
  const [claimDate, setClaimDate] = useState(today);
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [amount, setAmount] = useState("0.00");
  const [paymentAccountId, setPaymentAccountId] = useState("");

  const accounts = (accountsQ.data ?? []) as Array<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    is_postable: boolean;
    is_active: boolean;
  }>;

  const submitMutation = useMutation({
    mutationFn: () =>
      submit({
        data: {
          companyId: companyId!,
          claimDate,
          description,
          expenseAccountId,
          currencyCode: currency,
          amountMinor: Number(parseMinorOrThrow(amount || "0", currency, "Amount")),
          taxMinor: Number(parseMinorOrThrow(tax || "0", currency, "Tax")),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["claims", companyId] });
      toast.success("Claim submitted");
      setDescription("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const amountInvalid = tryParseMinor(amount || "0", currency) === null;
  const taxInvalid = tryParseMinor(tax || "0", currency) === null;
  const doReject = useServerFn(rejectEmployeeClaim);

  const approveMutation = useMutation({
    mutationFn: (claimId: string) =>
      approve({ data: { companyId: companyId!, claimId, paymentAccountId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["claims", companyId] });
      toast.success("Claim approved and reimbursed (ledger posted)");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rejectMutation = useMutation({
    mutationFn: (claimId: string) => doReject({ data: { companyId: companyId!, claimId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["claims", companyId] });
      toast.success("Claim rejected (no ledger posting)");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Employee expenses"
        description="Staff submit claims; approvers reimburse via the shared posting engine (DR expense / CR bank)."
      />

      <div className="mb-6 grid max-w-xl gap-3 rounded-md border border-border p-4">
        <div className="space-y-2">
          <Label>Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Date</Label>
          <Input type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Expense account</Label>
          <AccountLookup
            ariaLabel="Expense account"
            purpose="expense"
            accounts={accounts.filter(
              (a) => a.is_active && a.is_postable && a.account_type === "expense",
            )}
            value={expenseAccountId}
            onChange={setExpenseAccountId}
            companyId={companyId}
            placeholder="Select"
            allowClear={false}
          />
        </div>
        <div className="space-y-2">
          <Label>Net amount ({currency})</Label>
          <Input
            value={amount}
            inputMode="decimal"
            aria-invalid={amountInvalid}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Recoverable tax ({currency}, added on top of the net amount)</Label>
          <Input
            value={tax}
            inputMode="decimal"
            aria-invalid={taxInvalid}
            onChange={(e) => setTax(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={
            submitMutation.isPending || amountInvalid || taxInvalid || !can("expenses.submit")
          }
          onClick={() => submitMutation.mutate()}
        >
          {submitMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Submit claim
        </Button>
      </div>

      {can("expenses.approve") ? (
        <div className="mb-4 max-w-sm space-y-2">
          <Label>Reimbursement payment account (for approvals)</Label>
          <AccountLookup
            ariaLabel="Reimbursement payment account"
            purpose="bank"
            accounts={
              (paymentAccountsQ.data ?? []) as Array<{ id: string; code: string; name: string }>
            }
            value={paymentAccountId}
            onChange={setPaymentAccountId}
            companyId={companyId}
            placeholder="Bank or cash account"
            allowClear={false}
          />
        </div>
      ) : null}

      {claimsQ.isPending ? (
        <LoadingState />
      ) : claimsQ.isError ? (
        <ErrorState title="Could not load claims" description={friendlyAuthError(claimsQ.error)} />
      ) : (claimsQ.data ?? []).length === 0 ? (
        <EmptyState title="No claims" description="Submit an employee expense claim." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Claimant</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              claimsQ.data as Array<{
                id: string;
                claim_date: string;
                description: string;
                status: string;
                amount_minor: number;
                claimant_name: string | null;
                is_mine: boolean;
              }>
            ).map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.claim_date}</TableCell>
                <TableCell>{c.is_mine ? "You" : (c.claimant_name ?? "—")}</TableCell>
                <TableCell>{c.description}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(BigInt(c.amount_minor), currency)}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  {c.status === "submitted" && c.is_mine && can("expenses.approve") ? (
                    <span className="text-xs text-muted-foreground">Needs another approver</span>
                  ) : null}
                  {c.status === "submitted" && !c.is_mine && can("expenses.approve") ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate(c.id)}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={approveMutation.isPending || !paymentAccountId}
                        onClick={() => approveMutation.mutate(c.id)}
                      >
                        Approve & reimburse
                      </Button>
                    </>
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
