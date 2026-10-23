import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import {
  listReminderCandidates,
  saveReminderSettings,
  sendReminders,
} from "@/lib/documents/documents.functions";
import {
  REMINDER_REASON_TEXT,
  normaliseReminderSettings,
  type ReminderSettings,
} from "@/lib/documents/reminders";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { EMAIL_NOT_CONFIGURED_TEXT } from "@/lib/documents/ui";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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

export const Route = createFileRoute("/_authenticated/sales/reminders")({
  head: () => ({ meta: [{ title: "Payment reminders — LinkBooks" }] }),
  component: RemindersPage,
});

function RemindersPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const { can } = useCan();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const fetchCandidates = useServerFn(listReminderCandidates);
  const doSend = useServerFn(sendReminders);
  const doSave = useServerFn(saveReminderSettings);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [results, setResults] = useState<
    Array<{ invoiceId: string; sent: boolean; message: string }>
  >([]);

  const q = useQuery({
    queryKey: ["reminder-candidates", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchCandidates({ data: { companyId: companyId! } }),
  });

  useEffect(() => {
    if (q.data && !settings) setSettings(q.data.settings);
  }, [q.data, settings]);

  const sendM = useMutation({
    mutationFn: (ids: string[]) => doSend({ data: { companyId: companyId!, invoiceIds: ids } }),
    onSuccess: async (r) => {
      setResults(r.results);
      setSelected(new Set());
      const ok = r.results.filter((x) => x.sent).length;
      if (ok) toast.success(`${ok} reminder${ok === 1 ? "" : "s"} sent`);
      if (r.results.some((x) => !x.sent))
        toast.warning("Some reminders were not sent — see the list below.");
      await queryClient.invalidateQueries({ queryKey: ["reminder-candidates", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const saveM = useMutation({
    mutationFn: (s: ReminderSettings) => doSave({ data: { companyId: companyId!, ...s } }),
    onSuccess: async () => {
      toast.success("Reminder settings saved");
      await queryClient.invalidateQueries({ queryKey: ["reminder-candidates", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const dueIds = useMemo(
    () => rows.filter((r) => r.due && r.customerEmail).map((r) => r.invoiceId),
    [rows],
  );

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (q.isPending) return <LoadingState />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not load reminders"
        description={friendlyAuthError(q.error)}
        onRetry={() => q.refetch()}
      />
    );

  const data = q.data;
  const canSend = can("sales.draft") && data.emailConfigured && data.blockedReason === null;
  const canEditSettings = can("company.settings.edit");
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <PageHeader
        title="Payment reminders"
        description="Overdue invoices and whether the next reminder is due under your schedule. Reminders are sent only when you press send — nothing is sent automatically."
      />
      {!data.emailConfigured ? (
        <p className="mb-4 rounded border border-border bg-muted/40 p-3 text-sm">
          {EMAIL_NOT_CONFIGURED_TEXT} You can still open any invoice and use “Open in my email
          program”.
        </p>
      ) : data.blockedReason === "demo" ? (
        <p className="mb-4 rounded border border-border bg-muted/40 p-3 text-sm">
          Email sending is switched off in the Demo Company so sample customers are never emailed.
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!canSend || selected.size === 0 || sendM.isPending}
          onClick={() => sendM.mutate([...selected].slice(0, 20))}
        >
          {sendM.isPending ? (
            <Loader2 className="mr-1 size-4 animate-spin" />
          ) : (
            <Send className="mr-1 size-4" />
          )}
          Send reminder to selected ({selected.size})
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={dueIds.length === 0}
          onClick={() => setSelected(new Set(dueIds.slice(0, 20)))}
        >
          Select all due ({Math.min(dueIds.length, 20)})
        </Button>
        <span className="text-xs text-muted-foreground">Up to 20 per batch.</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing overdue"
          description="No invoices are past their due date with an amount owing."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Invoice</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Days overdue</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead>Reminders</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const selectable = r.due && Boolean(r.customerEmail);
              return (
                <TableRow key={r.invoiceId}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select invoice ${r.invoiceNumber ?? ""}`}
                      disabled={!selectable}
                      checked={selected.has(r.invoiceId)}
                      onCheckedChange={() => toggle(r.invoiceId)}
                    />
                  </TableCell>
                  <TableCell>
                    <a className="underline" href={`/sales/invoices/${r.invoiceId}`}>
                      {r.invoiceNumber ?? "(no number)"}
                    </a>
                  </TableCell>
                  <TableCell>
                    {r.customerName}
                    {!r.customerEmail ? (
                      <span className="block text-xs text-muted-foreground">No email address</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{fmt.date(r.dueDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.daysOverdue}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.money(r.outstandingMinor, r.currency)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.remindersSent} sent
                    {r.lastReminderDate ? ` · last ${fmt.date(r.lastReminderDate)}` : ""}
                  </TableCell>
                  <TableCell>
                    {r.due ? (
                      <Badge variant="destructive">Reminder due</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {r.reason
                          ? ((REMINDER_REASON_TEXT as Record<string, string>)[r.reason] ?? r.reason)
                          : ""}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {results.length > 0 ? (
        <ul className="mt-4 space-y-1 text-sm">
          {results.map((r) => {
            const row = rows.find((x) => x.invoiceId === r.invoiceId);
            return (
              <li key={r.invoiceId} className={r.sent ? "" : "text-destructive"}>
                {row?.invoiceNumber ?? r.invoiceId.slice(0, 8)}: {r.message}
              </li>
            );
          })}
        </ul>
      ) : null}

      {settings ? (
        <Card className="mt-8 max-w-xl">
          <CardHeader>
            <CardTitle className="text-base">Reminder schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <NumberField
              label="First reminder (days after due date)"
              value={settings.firstAfterDays}
              disabled={!canEditSettings}
              onChange={(v) => setSettings({ ...settings, firstAfterDays: v })}
            />
            <NumberField
              label="Repeat every (days)"
              value={settings.repeatEveryDays}
              disabled={!canEditSettings}
              onChange={(v) => setSettings({ ...settings, repeatEveryDays: v })}
            />
            <NumberField
              label="Maximum reminders per invoice"
              value={settings.maxReminders}
              disabled={!canEditSettings}
              onChange={(v) => setSettings({ ...settings, maxReminders: v })}
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id="rem-bank"
                checked={settings.includeBankDetails}
                disabled={!canEditSettings}
                onCheckedChange={(c) =>
                  setSettings({ ...settings, includeBankDetails: c === true })
                }
              />
              <Label htmlFor="rem-bank">Include bank details in reminders</Label>
            </div>
            {canEditSettings ? (
              <Button
                size="sm"
                disabled={saveM.isPending}
                onClick={() => saveM.mutate(normaliseReminderSettings(settings))}
              >
                Save schedule
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only an administrator can change the schedule.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const id = `n-${props.label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        className="w-28"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      />
    </div>
  );
}
