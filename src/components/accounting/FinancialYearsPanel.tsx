import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { listPeriods, lockPeriod, unlockPeriod } from "@/lib/accounting/accounting.functions";
import { createFinancialYear } from "@/lib/accounting/period-close.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { useFormat } from "@/hooks/use-format";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** AC-01: financial years / accounting periods, with creation for any date (past or future). */
export function FinancialYearsPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const f = useFormat();
  const fetchPeriods = useServerFn(listPeriods);
  const doCreate = useServerFn(createFinancialYear);
  const doLock = useServerFn(lockPeriod);
  const doUnlock = useServerFn(unlockPeriod);
  const [date, setDate] = useState("");

  const periods = useQuery({
    queryKey: ["periods", companyId],
    queryFn: () => fetchPeriods({ data: { companyId } }),
  });

  const create = useMutation({
    mutationFn: () => doCreate({ data: { companyId, date } }),
    onSuccess: async () => {
      toast.success("Financial year ready");
      setDate("");
      await qc.invalidateQueries({ queryKey: ["periods", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const toggle = useMutation({
    mutationFn: ({ id, lock }: { id: string; lock: boolean }) =>
      lock ? doLock({ data: { periodId: id } }) : doUnlock({ data: { periodId: id } }),
    onSuccess: async (_r, v) => {
      toast.success(v.lock ? "Period locked" : "Period unlocked");
      await qc.invalidateQueries({ queryKey: ["periods", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rows = useMemo(() => periods.data ?? [], [periods.data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a financial year</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Posting to a date with no period creates its financial year automatically. Use this to
            prepare a year ahead, or to load prior-year history. Locked dates are never reopened.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="fy-date">Any date in the year</Label>
              <Input
                id="fy-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <Button disabled={!date || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create financial year
            </Button>
          </div>
        </CardContent>
      </Card>

      {periods.isPending ? (
        <LoadingState />
      ) : periods.isError ? (
        <ErrorState
          title="Could not load periods"
          description={friendlyAuthError(periods.error)}
          onRetry={() => periods.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No accounting periods"
          description="Add a financial year above, or use Ensure CoA & periods."
        />
      ) : (
        <Card>
          <CardContent className="space-y-3 pt-6">
            {rows.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {f.date(p.start_date)} → {f.date(p.end_date)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={p.status === "open" ? "secondary" : "outline"}>{p.status}</Badge>
                  {p.status === "open" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ id: p.id, lock: true })}
                    >
                      Lock
                    </Button>
                  ) : null}
                  {p.status === "locked" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ id: p.id, lock: false })}
                    >
                      Unlock
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Run the checklist on the Period close tab before locking a period.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
