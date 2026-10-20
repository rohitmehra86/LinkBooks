import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import {
  generateRecurringBill,
  listRecurringBills,
  listSuppliers,
  saveRecurringBill,
  setRecurringBillActive,
} from "@/lib/purchases/purchases.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

export const Route = createFileRoute("/_authenticated/purchases/recurring")({
  component: RecurringPage,
});

function RecurringPage() {
  const { company } = useActiveCompany();
  const queryClient = useQueryClient();
  const fetchList = useServerFn(listRecurringBills);
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const save = useServerFn(saveRecurringBill);
  const generate = useServerFn(generateRecurringBill);
  const setActive = useServerFn(setRecurringBillActive);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const today = new Date().toISOString().slice(0, 10);

  const listQ = useQuery({
    queryKey: ["recurring", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchList({ data: { companyId: companyId! } }),
  });
  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });

  const [name, setName] = useState("");
  const [contactId, setContactId] = useState("");
  const [nextDue, setNextDue] = useState(today);
  const [frequency, setFrequency] = useState<"monthly" | "weekly" | "quarterly" | "yearly">("monthly");
  const [autoAuthorise, setAutoAuthorise] = useState(false);
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [price, setPrice] = useState("0.00");

  const saveMutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId: companyId!,
          contactId,
          name,
          frequency,
          nextDueDate: nextDue,
          currencyCode: currency,
          autoAuthorise,
          templateLines: [
            {
              description,
              accountId,
              quantity: 1,
              unitPriceMinor: Number(toMinorUnits(price || "0", currency)),
              taxRateBps: 0,
            },
          ],
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["recurring", companyId] });
      toast.success("Recurring bill schedule saved");
      setName("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const genMutation = useMutation({
    mutationFn: (recurringId: string) =>
      generate({ data: { companyId: companyId!, recurringId } }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["recurring", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["bills", companyId] });
      toast.success(
        r.authorised
          ? "Bill generated and authorised"
          : "Draft bill generated (not posted — policy default)",
      );
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const activeMutation = useMutation({
    mutationFn: (args: { recurringId: string; isActive: boolean }) =>
      setActive({ data: { companyId: companyId!, ...args } }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["recurring", companyId] });
      toast.success(r.is_active ? "Schedule resumed" : "Schedule paused");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const accounts = ((accountsQ.data ?? []) as Array<{ id: string; code: string; name: string; is_postable: boolean; is_active: boolean }>).filter(
    (a) => a.is_active && a.is_postable,
  );

  return (
    <>
      <PageHeader
        title="Recurring bills"
        description="Schedules generate bills on demand. Default policy creates drafts only; enable auto-authorise to post."
      />
      <Alert className="mb-4">
        <AlertTitle>No silent auto-post</AlertTitle>
        <AlertDescription>
          Generation fails clearly if a bill was already created for the same due date. Errors are stored on the schedule.
        </AlertDescription>
      </Alert>

      <div className="mb-6 grid max-w-xl gap-3 rounded-md border border-border p-4">
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Supplier</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {((suppliersQ.data ?? []) as Array<{ id: string; name: string }>).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Next due</Label>
            <Input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Frequency</Label>
            <Select value={frequency} onValueChange={(v) => setFrequency(v as typeof frequency)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label>Line description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Account</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Amount ({currency})</Label>
          <Input value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label className="font-normal">Auto-authorise generated bills</Label>
          <Switch checked={autoAuthorise} onCheckedChange={setAutoAuthorise} />
        </div>
        <Button size="sm" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save schedule
        </Button>
      </div>

      {listQ.isPending ? (
        <LoadingState />
      ) : listQ.isError ? (
        <ErrorState title="Could not load schedules" description={friendlyAuthError(listQ.error)} />
      ) : (listQ.data ?? []).length === 0 ? (
        <EmptyState title="No recurring bills" description="Create a schedule above." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Next due</TableHead>
              <TableHead>Last error</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              listQ.data as Array<{
                id: string;
                name: string;
                next_due_date: string;
                last_error: string | null;
                is_active: boolean;
                contacts: { name: string } | null;
              }>
            ).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.name}</TableCell>
                <TableCell>{r.contacts?.name ?? "—"}</TableCell>
                <TableCell>{r.next_due_date}</TableCell>
                <TableCell className="max-w-[200px] truncate text-destructive">
                  {r.last_error ?? "—"}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={activeMutation.isPending}
                    onClick={() =>
                      activeMutation.mutate({ recurringId: r.id, isActive: !r.is_active })
                    }
                  >
                    {r.is_active ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={genMutation.isPending || !r.is_active}
                    onClick={() => genMutation.mutate(r.id)}
                  >
                    Generate now
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
