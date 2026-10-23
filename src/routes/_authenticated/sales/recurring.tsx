import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listProducts } from "@/lib/products/products.functions";
import { listCustomers } from "@/lib/sales/sales.functions";
import {
  deleteRecurringInvoice,
  generateRecurringInvoice,
  getRecurringInvoice,
  listRecurringInvoices,
  saveRecurringInvoice,
  setRecurringActive,
} from "@/lib/sales/sales-recurring.functions";
import { getSalesDocumentConfig } from "@/lib/sales/sales-config.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { EntityCombobox } from "@/components/common/EntityCombobox";
import {
  SalesDocumentLines,
  emptySalesLine,
  type SalesLineFormState,
} from "@/components/sales/SalesDocumentLines";
import { lineFormToInput, lineRowToForm } from "@/components/sales/sales-form-utils";
import { Button } from "@/components/ui/button";
import { RunDueButton } from "@/components/recurring/RunDueButton";
import { runDueRecurringInvoices } from "@/lib/recurring/run-due.functions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/recurring")({
  head: () => ({ meta: [{ title: "Recurring invoices — LinkBooks" }] }),
  component: RecurringInvoices,
});

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

export function RecurringInvoices() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const enabled = Boolean(companyId);
  const fetchList = useServerFn(listRecurringInvoices);
  const runDue = useServerFn(runDueRecurringInvoices);
  const fetchOne = useServerFn(getRecurringInvoice);
  const fetchCustomers = useServerFn(listCustomers);
  const fetchAccounts = useServerFn(listAccounts);
  const fetchProducts = useServerFn(listProducts);
  const fetchConfig = useServerFn(getSalesDocumentConfig);
  const save = useServerFn(saveRecurringInvoice);
  const generate = useServerFn(generateRecurringInvoice);
  const setActive = useServerFn(setRecurringActive);
  const remove = useServerFn(deleteRecurringInvoice);

  const listQ = useQuery({
    queryKey: ["sales-recurring", companyId],
    enabled,
    queryFn: () => fetchList({ data: { companyId: companyId! } }),
  });
  const customersQ = useQuery({
    queryKey: ["customers", companyId],
    enabled,
    queryFn: () => fetchCustomers({ data: { companyId: companyId! } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled,
    queryFn: () => fetchAccounts({ data: { companyId: companyId! } }),
  });
  const productsQ = useQuery({
    queryKey: ["products", companyId],
    enabled,
    queryFn: () => fetchProducts({ data: { companyId: companyId!, limit: 200 } }),
  });
  const configQ = useQuery({
    queryKey: ["sales-doc-config", companyId],
    enabled,
    queryFn: () => fetchConfig({ data: { companyId: companyId! } }),
  });

  const base = configQ.data?.baseCurrency ?? company?.base_currency ?? "GBP";
  const today = configQ.data?.today ?? new Date().toISOString().slice(0, 10);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [contactId, setContactId] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [nextDue, setNextDue] = useState("");
  const [endDate, setEndDate] = useState("");
  const [maxOcc, setMaxOcc] = useState("");
  const [terms, setTerms] = useState("");
  const [memo, setMemo] = useState("");
  const [autoAuth, setAutoAuth] = useState(false);
  const [lines, setLines] = useState<SalesLineFormState[]>([emptySalesLine()]);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!nextDue && configQ.data) setNextDue(configQ.data.today);
  }, [nextDue, configQ.data]);

  const incomeAccounts = useMemo(
    () =>
      (
        (accountsQ.data ?? []) as Array<{
          id: string;
          code: string;
          name: string;
          account_type: string;
          is_postable: boolean;
          is_active: boolean;
        }>
      ).filter(
        (a) =>
          a.is_active && a.is_postable && (a.account_type === "income" || a.code.startsWith("4")),
      ),
    [accountsQ.data],
  );
  const customerOptions = ((customersQ.data ?? []) as Array<{ id: string; name: string }>).map(
    (c) => ({
      value: c.id,
      label: c.name,
    }),
  );

  const reset = () => {
    setEditingId(null);
    setFormOpen(false);
    setName("");
    setContactId("");
    setFrequency("monthly");
    setNextDue(today);
    setEndDate("");
    setMaxOcc("");
    setTerms("");
    setMemo("");
    setAutoAuth(false);
    setLines([emptySalesLine()]);
  };

  const startEdit = async (id: string) => {
    try {
      const r = await fetchOne({ data: { companyId: companyId!, recurringId: id } });
      setEditingId(id);
      setFormOpen(true);
      setName(r.name);
      setContactId(r.contact_id);
      setFrequency(r.frequency);
      setNextDue(r.next_due_date);
      setEndDate(r.end_date ?? "");
      setMaxOcc(r.max_occurrences ? String(r.max_occurrences) : "");
      setTerms(r.payment_terms_days !== null ? String(r.payment_terms_days) : "");
      setMemo(r.memo ?? "");
      setAutoAuth(r.auto_authorise);
      setLines(
        r.sales_recurring_invoice_lines.length
          ? r.sales_recurring_invoice_lines.map((l) => lineRowToForm(l, r.currency_code))
          : [emptySalesLine()],
      );
    } catch (e) {
      toast.error(friendlyAuthError(e));
    }
  };

  const saveM = useMutation({
    mutationFn: () => {
      if (!contactId) throw new Error("Choose a customer");
      return save({
        data: {
          companyId: companyId!,
          ...(editingId ? { recurringId: editingId } : {}),
          contactId,
          name,
          frequency,
          nextDueDate: nextDue,
          endDate: endDate || null,
          maxOccurrences: maxOcc ? Number(maxOcc) : null,
          paymentTermsDays: terms === "" ? null : Number(terms),
          currencyCode: base,
          autoAuthorise: autoAuth,
          memo,
          lines: lines.map((l) => lineFormToInput(l, base)),
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-recurring", companyId] });
      toast.success(editingId ? "Recurring invoice updated" : "Recurring invoice created");
      reset();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const genM = useMutation({
    mutationFn: (recurringId: string) => generate({ data: { companyId: companyId!, recurringId } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-recurring", companyId] });
      await qc.invalidateQueries({ queryKey: ["sales-invoices", companyId] });
      toast.success(
        `Generated invoice ${r.invoiceId.slice(0, 8)}…${r.nextDueDate ? ` next due ${r.nextDueDate}` : " — schedule finished"}`,
      );
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const activeM = useMutation({
    mutationFn: (args: { recurringId: string; isActive: boolean }) =>
      setActive({ data: { companyId: companyId!, ...args } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sales-recurring", companyId] });
      toast.success(r.is_active ? "Schedule resumed" : "Schedule paused");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  const deleteM = useMutation({
    mutationFn: (recurringId: string) => remove({ data: { companyId: companyId!, recurringId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sales-recurring", companyId] });
      setDeleteId(null);
      toast.success("Recurring invoice deleted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  const rows = listQ.data ?? [];

  return (
    <>
      <PageHeader
        title="Recurring invoices"
        description="Generates draft invoices on demand with customer terms and tax. Auto-authorise posts only when you have sales.authorise. Base currency only."
        actions={
          !formOpen ? (
            <div className="flex gap-2">
              <RunDueButton
                label="invoices"
                run={() => runDue({ data: { companyId: companyId! } })}
                invalidateKeys={[
                  ["sales-recurring", companyId],
                  ["sales-invoices", companyId],
                ]}
              />
              <Button size="sm" onClick={() => setFormOpen(true)}>
                New recurring invoice
              </Button>
            </div>
          ) : null
        }
      />
      {formOpen ? (
        <div className="mb-8 grid max-w-4xl gap-3 rounded-md border p-4">
          <Label className="text-base">{editingId ? "Edit schedule" : "Create schedule"}</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Customer</Label>
              <EntityCombobox
                aria-label="Customer"
                options={customerOptions}
                value={contactId}
                onChange={setContactId}
                placeholder="Search customers"
                allowClear={false}
              />
            </div>
            <div className="space-y-1">
              <Label>Frequency</Label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Next invoice date</Label>
              <Input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>End date (optional)</Label>
              <Input
                type="date"
                value={endDate}
                min={nextDue}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Stop after N invoices (optional)</Label>
              <Input
                value={maxOcc}
                inputMode="numeric"
                onChange={(e) => setMaxOcc(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Payment terms, days (blank = customer terms)</Label>
              <Input value={terms} inputMode="numeric" onChange={(e) => setTerms(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Memo</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>
          <SalesDocumentLines
            lines={lines}
            onChange={setLines}
            products={(productsQ.data ?? []) as never}
            accounts={incomeAccounts}
            currency={base}
            treatment={configQ.data?.treatment ?? "exclusive"}
            taxCodes={configQ.data?.taxCodes ?? []}
            toMinor={(d) => toMinorUnits(d, base)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoAuth}
              onChange={(e) => setAutoAuth(e.target.checked)}
            />
            Auto-authorise when generated
          </label>
          <div className="flex gap-2">
            <Button size="sm" disabled={saveM.isPending} onClick={() => saveM.mutate()}>
              {saveM.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {editingId ? "Save changes" : "Create"}
            </Button>
            <Button size="sm" variant="outline" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {listQ.isPending ? (
        <LoadingState />
      ) : listQ.isError ? (
        <ErrorState
          title="Could not load"
          description={friendlyAuthError(listQ.error)}
          onRetry={() => listQ.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No recurring invoices" description="Create a schedule to start." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Next due</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead>Generated</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const generated = r.occurrences_generated ?? 0;
              const neverRun = generated === 0 && !r.last_generated_on;
              const ended =
                (r.end_date !== null && r.next_due_date > r.end_date) ||
                (r.max_occurrences !== null && generated >= r.max_occurrences);
              return (
                <TableRow key={r.id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{r.contacts?.name ?? "—"}</TableCell>
                  <TableCell className="capitalize">{r.frequency}</TableCell>
                  <TableCell>{r.next_due_date}</TableCell>
                  <TableCell>
                    {r.end_date ?? (r.max_occurrences ? `after ${r.max_occurrences}` : "never")}
                  </TableCell>
                  <TableCell>{generated}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {ended ? "finished" : r.is_active ? "active" : "paused"}
                    </Badge>
                    {r.last_error ? (
                      <span className="ml-2 text-xs text-destructive">{r.last_error}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(r.id)}>
                      Edit
                    </Button>
                    {!ended ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={activeM.isPending}
                        onClick={() =>
                          activeM.mutate({ recurringId: r.id, isActive: !r.is_active })
                        }
                      >
                        {r.is_active ? "Pause" : "Resume"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={genM.isPending || !r.is_active || ended}
                      onClick={() => genM.mutate(r.id)}
                    >
                      Generate now
                    </Button>
                    {neverRun ? (
                      <Button size="sm" variant="ghost" onClick={() => setDeleteId(r.id)}>
                        Delete
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recurring invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              It has never generated an invoice. Templates that have run can only be paused.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteId && deleteM.mutate(deleteId)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
