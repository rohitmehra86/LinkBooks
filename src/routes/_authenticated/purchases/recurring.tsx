import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useActiveCompany } from "@/hooks/use-active-company";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RecurringBillOverlay } from "@/components/recurring/RecurringBillOverlay";
import { NewRecurringBillDialog } from "@/components/recurring/NewRecurringBillDialog";
import {
  archiveRecurringBill,
  duplicateRecurringBill,
  getRecurringForecast,
  listRecurringExceptions,
  listRecurringWorkspace,
} from "@/lib/recurring/recurring-api.functions";
import { generateRecurringBill } from "@/lib/purchases/purchases.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";

const searchSchema = z.object({
  id: z.string().uuid().optional(),
  tab: z.string().optional(),
  view: z.enum(["schedules", "exceptions", "forecast"]).optional(),
  q: z.string().optional(),
  page: z.coerce.number().optional(),
  status: z.enum(["active", "paused", "error"]).optional(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  supplier: z.string().optional(),
  nextFrom: z.string().optional(),
  nextTo: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/purchases/recurring")({
  validateSearch: (s) => searchSchema.parse(s),
  component: RecurringTransactionsPage,
});

function RecurringTransactionsPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();

  const [qDraft, setQDraft] = useState(search.q ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const view = search.view ?? "schedules";
  const page = search.page ?? 0;

  const fetchWorkspace = useServerFn(listRecurringWorkspace);
  const fetchExceptions = useServerFn(listRecurringExceptions);
  const fetchForecast = useServerFn(getRecurringForecast);
  const dup = useServerFn(duplicateRecurringBill);
  const archive = useServerFn(archiveRecurringBill);
  const generate = useServerFn(generateRecurringBill);

  const workspaceQ = useQuery({
    queryKey: [
      "recurring-workspace",
      companyId,
      qDraft,
      page,
      search.status,
      search.frequency,
      search.supplier,
      search.nextFrom,
      search.nextTo,
    ],
    enabled: Boolean(companyId) && view === "schedules",
    queryFn: () =>
      fetchWorkspace({
        data: {
          companyId: companyId!,
          documentType: "purchase_bill",
          q: qDraft,
          page,
          pageSize: 25,
          ...(search.status ? { status: search.status } : {}),
          ...(search.frequency ? { frequency: search.frequency } : {}),
          ...(search.supplier ? { supplier: search.supplier } : {}),
          ...(search.nextFrom ? { nextFrom: search.nextFrom } : {}),
          ...(search.nextTo ? { nextTo: search.nextTo } : {}),
        },
      }),
  });

  const exceptionsQ = useQuery({
    queryKey: ["recurring-exceptions", companyId],
    enabled: Boolean(companyId) && view === "exceptions",
    queryFn: () => fetchExceptions({ data: { companyId: companyId! } }),
  });

  const forecastQ = useQuery({
    queryKey: ["recurring-forecast", companyId],
    enabled: Boolean(companyId) && view === "forecast",
    queryFn: () => fetchForecast({ data: { companyId: companyId!, days: 90 } }),
  });

  const dupM = useMutation({
    mutationFn: (recurringBillId: string) =>
      dup({ data: { companyId: companyId!, recurringBillId } }),
    onSuccess: async (r) => {
      toast.success("Duplicated");
      await qc.invalidateQueries({ queryKey: ["recurring-workspace", companyId] });
      navigate({ search: (prev) => ({ ...prev, id: r.id, tab: "details" }) });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const archiveM = useMutation({
    mutationFn: (recurringBillId: string) =>
      archive({ data: { companyId: companyId!, recurringBillId } }),
    onSuccess: async () => {
      toast.success("Archived. Generated bills are unchanged.");
      await qc.invalidateQueries({ queryKey: ["recurring-workspace", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const retryM = useMutation({
    mutationFn: (recurringBillId: string) =>
      generate({ data: { companyId: companyId!, recurringId: recurringBillId } }),
    onSuccess: async () => {
      toast.success("Retry submitted");
      await qc.invalidateQueries({ queryKey: ["recurring-exceptions", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  useEffect(() => {
    const t = setTimeout(() => {
      if (qDraft !== (search.q ?? "")) {
        navigate({ search: (prev) => ({ ...prev, q: qDraft || undefined, page: 0 }) });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [qDraft, navigate, search.q]);

  const openId = search.id;
  const overlayOpen = Boolean(openId);

  const closeOverlay = () => {
    navigate({ search: (prev) => ({ ...prev, id: undefined, tab: undefined }) });
  };

  if (!companyId) {
    return <EmptyState title="No organisation" description="Select a company." />;
  }

  return (
    <>
      <PageHeader
        title="Recurring transactions"
        description="Supplier bill schedules — premium overlay, idempotent generation, exceptions and forecast."
      />

      <Tabs
        value={view}
        onValueChange={(v) =>
          navigate({ search: (prev) => ({ ...prev, view: v as typeof view, page: 0 }) })
        }
        className="mb-4"
      >
        <TabsList>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="exceptions">Exception centre</TabsTrigger>
          <TabsTrigger value="forecast">Forecast (90d)</TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "schedules" && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <Input
              className="max-w-sm"
              placeholder="Search schedules…"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
            />
            <Input
              className="max-w-[10rem]"
              placeholder="Supplier"
              defaultValue={search.supplier ?? ""}
              onBlur={(e) =>
                navigate({
                  search: (prev) => ({ ...prev, supplier: e.target.value || undefined, page: 0 }),
                })
              }
            />
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={search.status ?? ""}
              onChange={(e) =>
                navigate({
                  search: (prev) => ({
                    ...prev,
                    status: (e.target.value || undefined) as typeof search.status,
                    page: 0,
                  }),
                })
              }
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="error">Schedule error</option>
            </select>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={search.frequency ?? ""}
              onChange={(e) =>
                navigate({
                  search: (prev) => ({
                    ...prev,
                    frequency: (e.target.value || undefined) as typeof search.frequency,
                    page: 0,
                  }),
                })
              }
            >
              <option value="">Any frequency</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
            <Input
              className="max-w-[10rem]"
              type="date"
              value={search.nextFrom ?? ""}
              onChange={(e) =>
                navigate({
                  search: (prev) => ({ ...prev, nextFrom: e.target.value || undefined, page: 0 }),
                })
              }
            />
            <Input
              className="max-w-[10rem]"
              type="date"
              value={search.nextTo ?? ""}
              onChange={(e) =>
                navigate({
                  search: (prev) => ({ ...prev, nextTo: e.target.value || undefined, page: 0 }),
                })
              }
            />
            <Button variant="default" size="sm" onClick={() => setCreateOpen(true)}>
              New recurring bill
            </Button>
          </div>

          {workspaceQ.isPending ? (
            <LoadingState />
          ) : workspaceQ.isError ? (
            <ErrorState
              title="Could not load"
              description={friendlyAuthError(workspaceQ.error)}
            />
          ) : (workspaceQ.data?.rows ?? []).length === 0 ? (
            <EmptyState
              title="No recurring bill templates"
              description="Use New recurring bill above to add a supplier template with schedule and automation."
              actionLabel="New recurring bill"
              onActionClick={() => setCreateOpen(true)}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Next</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(workspaceQ.data?.rows ?? []).map(
                    (row: {
                      id: string;
                      name: string;
                      is_active: boolean;
                      legacy_recurring_bill_id: string | null;
                      contacts: { name: string } | null;
                      recurring_schedules:
                        | {
                            next_occurrence_date: string;
                            last_error: string | null;
                            is_paused: boolean;
                          }
                        | Array<{
                            next_occurrence_date: string;
                            last_error: string | null;
                            is_paused: boolean;
                          }>
                        | null;
                    }) => {
                      const sched = Array.isArray(row.recurring_schedules)
                        ? row.recurring_schedules[0]
                        : row.recurring_schedules;
                      const legacyId = row.legacy_recurring_bill_id;
                      if (!legacyId) return null;
                      return (
                        <TableRow
                          key={row.id}
                          className="cursor-pointer"
                          onClick={() =>
                            navigate({
                              search: (prev) => ({ ...prev, id: legacyId, tab: "details" }),
                            })
                          }
                        >
                          <TableCell>{row.name}</TableCell>
                          <TableCell>{row.contacts?.name ?? "—"}</TableCell>
                          <TableCell>{sched?.next_occurrence_date ?? "—"}</TableCell>
                          <TableCell className="max-w-[180px] truncate text-destructive">
                            {sched?.last_error ??
                              (sched?.is_paused || !row.is_active ? "Paused" : "Active")}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                dupM.mutate(legacyId);
                              }}
                            >
                              Duplicate
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!window.confirm("Archive this template? Generated bills stay in Purchases.")) return;
                                archiveM.mutate(legacyId);
                              }}
                            >
                              Archive
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    },
                  )}
                </TableBody>
              </Table>
              <div className="mt-4 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 0}
                  onClick={() =>
                    navigate({ search: (prev) => ({ ...prev, page: Math.max(0, page - 1) }) })
                  }
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(workspaceQ.data?.rows?.length ?? 0) < 25}
                  onClick={() => navigate({ search: (prev) => ({ ...prev, page: page + 1 }) })}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {view === "exceptions" && (
        <>
          {exceptionsQ.isPending ? (
            <LoadingState />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(exceptionsQ.data?.rows ?? []).map(
                  (r: {
                    id: string;
                    scheduled_date: string;
                    status: string;
                    error_message: string | null;
                    recurring_schedules?:
                      | { recurring_templates?: { name?: string; legacy_recurring_bill_id?: string | null } }
                      | Array<{ recurring_templates?: { name?: string; legacy_recurring_bill_id?: string | null } }>;
                  }) => {
                    const sched = Array.isArray(r.recurring_schedules)
                      ? r.recurring_schedules[0]
                      : r.recurring_schedules;
                    const legacyId = sched?.recurring_templates?.legacy_recurring_bill_id;
                    return (
                    <TableRow key={r.id}>
                      <TableCell>{r.scheduled_date}</TableCell>
                      <TableCell>{sched?.recurring_templates?.name ?? "—"}</TableCell>
                      <TableCell>{r.status}</TableCell>
                      <TableCell>{r.error_message ?? "—"}</TableCell>
                      <TableCell>
                        {r.status === "failed" && legacyId ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryM.isPending}
                            onClick={() => retryM.mutate(legacyId)}
                          >
                            Retry
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    );
                  },
                )}
              </TableBody>
            </Table>
          )}
        </>
      )}

      {view === "forecast" && (
        <>
          {forecastQ.isPending ? (
            <LoadingState />
          ) : (
            <>
              <p className="mb-2 text-sm text-muted-foreground">
                Estimates only — not posted actuals. Variable amounts and FX may differ.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(forecastQ.data?.items ?? []).map(
                    (i: { date: string; name: string; documentType: string; scheduleId: string }) => (
                      <TableRow key={`${i.scheduleId}-${i.date}`}>
                        <TableCell>{i.date}</TableCell>
                        <TableCell>{i.name}</TableCell>
                        <TableCell>{i.documentType}</TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </>
          )}
        </>
      )}

      {openId ? (
        <RecurringBillOverlay
          companyId={companyId}
          recurringBillId={openId}
          open={overlayOpen}
          onOpenChange={(o) => !o && closeOverlay()}
          initialTab={search.tab ?? "details"}
        />
      ) : null}

      <NewRecurringBillDialog
        companyId={companyId}
        currencyCode={company?.base_currency ?? "GBP"}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          navigate({ search: (prev) => ({ ...prev, id, tab: "details" }) });
        }}
      />
    </>
  );
}
