"use client";

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  getRecurringBillWorkspaceDetail,
  listRecurringOccurrenceHistory,
  previewRecurringSchedule,
  skipNextRecurringBillOccurrence,
  updateRecurringBillWorkspace,
} from "@/lib/recurring/recurring-api.functions";
import {
  generateRecurringBill,
  getRecurringBill,
  setRecurringBillActive,
} from "@/lib/purchases/purchases.functions";
import { NewBill, type RecurringBillSeed } from "@/routes/_authenticated/purchases/bills.new";
import { friendlyAuthError } from "@/lib/auth-helpers";

type Props = {
  companyId: string;
  recurringBillId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: string;
};

export function RecurringBillOverlay({
  companyId,
  recurringBillId,
  open,
  onOpenChange,
  initialTab = "details",
}: Props) {
  const qc = useQueryClient();
  const fetchDetail = useServerFn(getRecurringBillWorkspaceDetail);
  const fetchHistory = useServerFn(listRecurringOccurrenceHistory);
  const fetchPreview = useServerFn(previewRecurringSchedule);
  const save = useServerFn(updateRecurringBillWorkspace);
  const skipNext = useServerFn(skipNextRecurringBillOccurrence);
  const generate = useServerFn(generateRecurringBill);
  const setActive = useServerFn(setRecurringBillActive);

  const fetchTemplate = useServerFn(getRecurringBill);
  const templateQ = useQuery({
    queryKey: ["recurring-template", companyId, recurringBillId],
    enabled: open && Boolean(companyId),
    queryFn: () => fetchTemplate({ data: { companyId, recurringId: recurringBillId } }),
  });

  const detailQ = useQuery({
    queryKey: ["recurring-detail", companyId, recurringBillId],
    enabled: open && Boolean(companyId),
    queryFn: () =>
      fetchDetail({ data: { companyId, recurringBillId } }),
  });

  const historyQ = useQuery({
    queryKey: ["recurring-history", companyId, recurringBillId],
    enabled: open && Boolean(companyId),
    queryFn: () =>
      fetchHistory({ data: { companyId, recurringBillId } }),
  });

  const previewQ = useQuery({
    queryKey: ["recurring-preview", companyId, recurringBillId],
    enabled: open && Boolean(companyId),
    queryFn: () =>
      fetchPreview({ data: { companyId, recurringBillId, count: 12 } }),
  });

  const bill = detailQ.data?.bill as {
    name: string;
    next_due_date: string;
    frequency: string;
    auto_authorise: boolean;
    is_active: boolean;
    last_error: string | null;
    template: { lines?: Array<{ description: string }> };
    contacts: { name: string } | null;
  } | undefined;

  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [autoAuthorise, setAutoAuthorise] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!bill) return;
    setName(bill.name);
    setNextDue(bill.next_due_date);
    setFrequency(bill.frequency);
    setAutoAuthorise(bill.auto_authorise);
    setDirty(false);
  }, [bill, recurringBillId]);

  const saveM = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId,
          recurringBillId,
          name,
          nextDueDate: nextDue,
          frequency: frequency as "weekly" | "monthly" | "quarterly" | "yearly",
          autoAuthorise,
        },
      }),
    onSuccess: async () => {
      toast.success("Saved");
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ["recurring-detail", companyId, recurringBillId] });
      await qc.invalidateQueries({ queryKey: ["recurring-workspace", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const genM = useMutation({
    mutationFn: () => generate({ data: { companyId, recurringId: recurringBillId } }),
    onSuccess: async (r) => {
      toast.success(r.authorised ? "Bill generated and authorised" : "Draft bill generated");
      await qc.invalidateQueries({ queryKey: ["recurring-history", companyId, recurringBillId] });
      await qc.invalidateQueries({ queryKey: ["recurring-workspace", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const skipM = useMutation({
    mutationFn: () => skipNext({ data: { companyId, recurringBillId } }),
    onSuccess: async (r) => {
      toast.success(`Next occurrence moved to ${r.nextDueDate}`);
      await detailQ.refetch();
      await previewQ.refetch();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const pauseM = useMutation({
    mutationFn: (isActive: boolean) =>
      setActive({ data: { companyId, recurringId: recurringBillId, isActive } }),
    onSuccess: async () => {
      await detailQ.refetch();
      await qc.invalidateQueries({ queryKey: ["recurring-workspace", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const handleClose = (next: boolean) => {
    if (!next && dirty) {
      if (!window.confirm("You have unsaved changes. Close anyway?")) return;
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(90vw,960px)] max-w-none flex-col gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{bill?.name ?? "Recurring bill"}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {bill?.contacts?.name ?? "Supplier"} · Next {bill?.next_due_date ?? "—"}
          </p>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-6 mt-3 w-auto justify-start overflow-x-auto">
            <TabsTrigger value="details">Bill details</TabsTrigger>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="automation">Automation</TabsTrigger>
            <TabsTrigger value="approvals">Approvals</TabsTrigger>
            <TabsTrigger value="attachments">Attachments</TabsTrigger>
            <TabsTrigger value="history">History & audit</TabsTrigger>
            <TabsTrigger value="forecast">Forecast & preview</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {detailQ.isPending ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : detailQ.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not load</AlertTitle>
                <AlertDescription>{friendlyAuthError(detailQ.error)}</AlertDescription>
              </Alert>
            ) : (
              <>
                <TabsContent value="details" className="mt-0 space-y-4">
                  {templateQ.data ? (
                    <NewBill
                      key={recurringBillId}
                      mode="template"
                      seed={templateQ.data as RecurringBillSeed}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">Loading the bill template…</p>
                  )}
                </TabsContent>

                <TabsContent value="schedule" className="mt-0 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Next occurrence</Label>
                      <Input
                        type="date"
                        value={nextDue}
                        onChange={(e) => {
                          setNextDue(e.target.value);
                          setDirty(true);
                        }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Frequency</Label>
                      <Select
                        value={frequency}
                        onValueChange={(v) => {
                          setFrequency(v);
                          setDirty(true);
                        }}
                      >
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
                  {previewQ.data?.dates?.length ? (
                    <ul className="text-sm text-muted-foreground">
                      {previewQ.data.dates.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  ) : null}
                </TabsContent>

                <TabsContent value="automation" className="mt-0 space-y-4">
                  <div className="flex items-center justify-between">
                    <Label>Auto-authorise (requires recurring.auto_authorise)</Label>
                    <Switch
                      checked={autoAuthorise}
                      onCheckedChange={(v) => {
                        setAutoAuthorise(v);
                        setDirty(true);
                      }}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Default: save generated documents as <strong>draft</strong>. Email delivery and
                    payment auto-charge: <strong>Unavailable</strong> (no outbound email / payments).
                  </p>
                </TabsContent>

                <TabsContent value="approvals" className="mt-0">
                  <Alert>
                    <AlertTitle>Bill approval workflow</AlertTitle>
                    <AlertDescription>
                      Generated bills can use Purchases approval when not auto-authorised. Threshold
                      rules and multi-level approval for templates: configure under Purchases settings
                      and company roles.
                    </AlertDescription>
                  </Alert>
                </TabsContent>

                <TabsContent value="attachments" className="mt-0">
                  <Alert>
                    <AlertTitle>Unavailable</AlertTitle>
                    <AlertDescription>
                      Recurring template attachments are not yet linked to document_attachments.
                    </AlertDescription>
                  </Alert>
                </TabsContent>

                <TabsContent value="history" className="mt-0">
                  <ul className="space-y-2 text-sm">
                    {(historyQ.data?.rows ?? []).map(
                      (o: {
                        id: string;
                        scheduled_date: string;
                        status: string;
                        purchase_bill_id: string | null;
                        error_message: string | null;
                      }) => (
                        <li key={o.id} className="flex justify-between gap-2 border-b pb-2">
                          <span>
                            {o.scheduled_date} · {o.status}
                            {o.error_message ? ` — ${o.error_message}` : ""}
                          </span>
                          {o.purchase_bill_id ? (
                            <Link
                              to="/purchases/bills/$billId"
                              params={{ billId: o.purchase_bill_id }}
                              className="underline"
                            >
                              Open bill
                            </Link>
                          ) : null}
                        </li>
                      ),
                    )}
                  </ul>
                </TabsContent>

                <TabsContent value="forecast" className="mt-0">
                  <p className="text-sm text-muted-foreground mb-2">
                    Commitment preview for this schedule (not posted actuals).
                  </p>
                  <ul className="text-sm">
                    {(previewQ.data?.dates ?? []).map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>

        <div className="flex flex-wrap gap-2 border-t border-border px-6 py-4">
          <Button size="sm" disabled={saveM.isPending || !dirty} onClick={() => saveM.mutate()}>
            Save
          </Button>
          <Button size="sm" variant="secondary" disabled={genM.isPending} onClick={() => genM.mutate()}>
            Generate now
          </Button>
          <Button size="sm" variant="outline" disabled={skipM.isPending} onClick={() => skipM.mutate()}>
            Skip next
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pauseM.isPending}
            onClick={() => pauseM.mutate(!bill?.is_active)}
          >
            {bill?.is_active ? "Pause" : "Resume"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => handleClose(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
