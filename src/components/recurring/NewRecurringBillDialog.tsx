"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { listAccounts } from "@/lib/accounting/accounting.functions";
import { listSuppliers, saveRecurringBill } from "@/lib/purchases/purchases.functions";
import { toMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import type {
  RecurringCatchUpPolicy,
  RecurringTemplateMode,
} from "@/lib/recurring/recurring-schedule-options";

type LineDraft = {
  key: string;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxRateBps: string;
};

type Props = {
  companyId: string;
  currencyCode: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (recurringBillId: string) => void;
};

function emptyLine(): LineDraft {
  return {
    key: crypto.randomUUID(),
    description: "",
    accountId: "",
    quantity: "1",
    unitPrice: "0.00",
    taxRateBps: "0",
  };
}

export function NewRecurringBillDialog({
  companyId,
  currencyCode,
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const fetchSuppliers = useServerFn(listSuppliers);
  const fetchAccounts = useServerFn(listAccounts);
  const create = useServerFn(saveRecurringBill);

  const suppliersQ = useQuery({
    queryKey: ["suppliers", companyId],
    enabled: open && Boolean(companyId),
    queryFn: () => fetchSuppliers({ data: { companyId } }),
  });
  const accountsQ = useQuery({
    queryKey: ["accounts", companyId],
    enabled: open && Boolean(companyId),
    queryFn: () => fetchAccounts({ data: { companyId } }),
  });

  const expenseAccounts = useMemo(() => {
    const accounts = (accountsQ.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      is_postable: boolean;
      is_active: boolean;
    }>;
    return accounts.filter(
      (a) =>
        a.is_active &&
        a.is_postable &&
        (a.account_type === "expense" || a.account_type === "asset"),
    );
  }, [accountsQ.data]);

  const [name, setName] = useState("");
  const [contactId, setContactId] = useState("");
  const [frequency, setFrequency] = useState<
    "weekly" | "monthly" | "quarterly" | "yearly"
  >("monthly");
  const [firstBillDate, setFirstBillDate] = useState(today);
  const [endKind, setEndKind] = useState<"never" | "on_date" | "after_count">("never");
  const [endDate, setEndDate] = useState("");
  const [maxOccurrences, setMaxOccurrences] = useState("12");
  const [mode, setMode] = useState<RecurringTemplateMode>("scheduled");
  const [generateDaysInAdvance, setGenerateDaysInAdvance] = useState("0");
  const [catchUpPolicy, setCatchUpPolicy] = useState<RecurringCatchUpPolicy>("latest_only");
  const [dueDaysAfterBillDate, setDueDaysAfterBillDate] = useState("30");
  const [autoAuthorise, setAutoAuthorise] = useState(false);
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine()]);

  const resetForm = () => {
    setName("");
    setContactId("");
    setFrequency("monthly");
    setFirstBillDate(today);
    setEndKind("never");
    setEndDate("");
    setMaxOccurrences("12");
    setMode("scheduled");
    setGenerateDaysInAdvance("0");
    setCatchUpPolicy("latest_only");
    setDueDaysAfterBillDate("30");
    setAutoAuthorise(false);
    setMemo("");
    setLines([emptyLine()]);
  };

  const createM = useMutation({
    mutationFn: async () => {
      const scheduleOptions = {
        mode,
        generateDaysInAdvance: Number(generateDaysInAdvance || 0),
        endDate: endKind === "on_date" ? endDate || null : null,
        maxOccurrences: endKind === "after_count" ? Number(maxOccurrences || 0) : null,
        catchUpPolicy,
        dueDaysAfterBillDate: Number(dueDaysAfterBillDate || 0),
        memo: memo.trim() || undefined,
      };
      return create({
        data: {
          companyId,
          contactId,
          name,
          frequency,
          nextDueDate: firstBillDate,
          currencyCode,
          autoAuthorise,
          scheduleOptions,
          templateLines: lines.map((l) => ({
            description: l.description,
            accountId: l.accountId,
            quantity: Number(l.quantity),
            unitPriceMinor: Number(toMinorUnits(l.unitPrice || "0", currencyCode)),
            discountMinor: 0,
            taxRateBps: Number(l.taxRateBps || 0),
          })),
        },
      });
    },
    onSuccess: async (r) => {
      toast.success("Recurring bill template created");
      await qc.invalidateQueries({ queryKey: ["recurring-workspace", companyId] });
      resetForm();
      onOpenChange(false);
      onCreated(r.id);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const loading = suppliersQ.isPending || accountsQ.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[92vh] w-[min(92vw,720px)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>New recurring bill</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Like Xero/QBO repeating bills: template lines, schedule, and automation in one place.
          </p>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Template details</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <Label>Schedule name</Label>
                    <Input
                      placeholder="e.g. Cloud hosting monthly"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label>Supplier</Label>
                    <Select value={contactId} onValueChange={setContactId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select supplier" />
                      </SelectTrigger>
                      <SelectContent>
                        {(suppliersQ.data ?? []).map(
                          (s: { id: string; name: string }) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label>Default memo on generated bills</Label>
                    <Textarea
                      rows={2}
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      placeholder="Optional"
                    />
                  </div>
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Line items</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setLines((prev) => [...prev, emptyLine()])}
                  >
                    <Plus className="mr-1 size-4" />
                    Add line
                  </Button>
                </div>
                <div className="space-y-3">
                  {lines.map((line, index) => (
                    <div
                      key={line.key}
                      className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-12"
                    >
                      <div className="space-y-1 sm:col-span-12">
                        <Label>Description</Label>
                        <Input
                          value={line.description}
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l) =>
                                l.key === line.key ? { ...l, description: e.target.value } : l,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-6">
                        <Label>Account</Label>
                        <Select
                          value={line.accountId}
                          onValueChange={(v) =>
                            setLines((prev) =>
                              prev.map((l) => (l.key === line.key ? { ...l, accountId: v } : l)),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Expense / asset" />
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
                      <div className="space-y-1 sm:col-span-2">
                        <Label>Qty</Label>
                        <Input
                          value={line.quantity}
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l) =>
                                l.key === line.key ? { ...l, quantity: e.target.value } : l,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label>Unit ({currencyCode})</Label>
                        <Input
                          value={line.unitPrice}
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l) =>
                                l.key === line.key ? { ...l, unitPrice: e.target.value } : l,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-1">
                        <Label>Tax %</Label>
                        <Input
                          value={String(Number(line.taxRateBps) / 100)}
                          onChange={(e) => {
                            const pct = Number(e.target.value);
                            const bps = Number.isFinite(pct) ? Math.round(pct * 100) : 0;
                            setLines((prev) =>
                              prev.map((l) =>
                                l.key === line.key ? { ...l, taxRateBps: String(bps) } : l,
                              ),
                            );
                          }}
                        />
                      </div>
                      <div className="flex items-end sm:col-span-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={lines.length <= 1}
                          onClick={() =>
                            setLines((prev) => prev.filter((l) => l.key !== line.key))
                          }
                          aria-label={`Remove line ${index + 1}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Schedule</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>Repeat every</Label>
                    <Select value={frequency} onValueChange={(v) => setFrequency(v as typeof frequency)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="weekly">Week</SelectItem>
                        <SelectItem value="monthly">Month</SelectItem>
                        <SelectItem value="quarterly">Quarter (every 3 months)</SelectItem>
                        <SelectItem value="yearly">Year</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>First bill date</Label>
                    <Input
                      type="date"
                      value={firstBillDate}
                      onChange={(e) => setFirstBillDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Due (days after bill date)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      value={dueDaysAfterBillDate}
                      onChange={(e) => setDueDaysAfterBillDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Ends</Label>
                    <Select value={endKind} onValueChange={(v) => setEndKind(v as typeof endKind)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never</SelectItem>
                        <SelectItem value="on_date">On date</SelectItem>
                        <SelectItem value="after_count">After number of bills</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {endKind === "on_date" ? (
                    <div className="space-y-1">
                      <Label>End date</Label>
                      <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                    </div>
                  ) : null}
                  {endKind === "after_count" ? (
                    <div className="space-y-1">
                      <Label>Number of bills</Label>
                      <Input
                        type="number"
                        min={1}
                        max={9999}
                        value={maxOccurrences}
                        onChange={(e) => setMaxOccurrences(e.target.value)}
                      />
                    </div>
                  ) : null}
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Automation</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <Label>When due</Label>
                    <Select value={mode} onValueChange={(v) => setMode(v as RecurringTemplateMode)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="scheduled">
                          Create draft bills automatically (scheduled)
                        </SelectItem>
                        <SelectItem value="reminder">
                          Reminder only — no automatic document
                        </SelectItem>
                        <SelectItem value="on_demand">
                          Manual — generate from schedule when you choose
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Create bills in advance (days)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      value={generateDaysInAdvance}
                      onChange={(e) => setGenerateDaysInAdvance(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      0 = on the bill date. Scheduler honours this when cron is enabled.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label>If the app was offline (catch-up)</Label>
                    <Select
                      value={catchUpPolicy}
                      onValueChange={(v) => setCatchUpPolicy(v as RecurringCatchUpPolicy)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="latest_only">Create latest only</SelectItem>
                        <SelectItem value="all_missed">Create all missed</SelectItem>
                        <SelectItem value="review_each">Mark for review each</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <div>
                    <Label>Auto-authorise generated bills</Label>
                    <p className="text-xs text-muted-foreground">
                      Requires recurring.auto_authorise permission. Otherwise bills stay draft.
                    </p>
                  </div>
                  <Switch checked={autoAuthorise} onCheckedChange={setAutoAuthorise} />
                </div>
              </section>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={createM.isPending || loading || !name.trim() || !contactId}
            onClick={() => createM.mutate()}
          >
            {createM.isPending ? <Loader2 className="size-4 animate-spin" /> : "Save template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
