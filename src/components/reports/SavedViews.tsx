import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Star, X } from "lucide-react";
import { toast } from "sonner";
import { friendlyAuthError } from "@/lib/auth-helpers";
import {
  deleteSavedReportView,
  listSavedReportViews,
  saveReportView,
} from "@/lib/reports/report-views.functions";
import { parseReportSearch } from "@/lib/reports/search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReportCtx } from "./ReportShell";

type Saved = { id: string; name: string; config: Record<string, unknown> };

const DATE_KEYS = ["from", "to"] as const;

/**
 * Per-user saved views for one report ("favourites"): the filters, columns and, if chosen, the dates.
 * Dates are left out by default so a favourite opened next month shows the current period.
 */
export function SavedViews({ ctx }: { ctx: ReportCtx }) {
  const reportId = ctx.reportId;
  const queryClient = useQueryClient();
  const listFn = useServerFn(listSavedReportViews);
  const saveFn = useServerFn(saveReportView);
  const deleteFn = useServerFn(deleteSavedReportView);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [keepDates, setKeepDates] = useState(false);

  const key = ["report-saved-views", ctx.companyId, reportId];
  const q = useQuery({
    queryKey: key,
    enabled: Boolean(reportId),
    retry: false,
    queryFn: () => listFn({ data: { companyId: ctx.companyId, reportId: reportId! } }),
  });

  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { ...ctx.search };
      if (!keepDates) for (const k of DATE_KEYS) delete config[k];
      else {
        config["from"] = ctx.from;
        config["to"] = ctx.to;
      }
      return saveFn({
        data: {
          companyId: ctx.companyId,
          reportId: reportId!,
          name: name.trim(),
          config,
          isFavourite: true,
        },
      });
    },
    onSuccess: async () => {
      setName("");
      setNaming(false);
      await queryClient.invalidateQueries({ queryKey: key });
      toast.success("View saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const remove = useMutation({
    mutationFn: (viewId: string) => deleteFn({ data: { companyId: ctx.companyId, viewId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  // The saved-views table may not exist yet; the rest of the report still works.
  if (!reportId || q.isError) return null;
  const views = (q.data ?? []) as unknown as Saved[];

  const apply = (v: Saved) => {
    const cfg = parseReportSearch(v.config ?? {});
    const patch: Record<string, unknown> = {};
    // Clear everything first so the saved view replaces, not merges with, the current filters.
    for (const k of Object.keys(ctx.search)) patch[k] = undefined;
    Object.assign(patch, cfg);
    ctx.setSearch(patch);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm print:hidden">
      <Star className="size-4 text-muted-foreground" aria-hidden />
      <span className="text-muted-foreground">Saved views</span>
      {views.map((v) => (
        <span key={v.id} className="inline-flex items-center rounded-full border pl-3">
          <button type="button" className="py-1 hover:underline" onClick={() => apply(v)}>
            {v.name}
          </button>
          <button
            type="button"
            aria-label={`Delete saved view ${v.name}`}
            className="px-2 py-1 text-muted-foreground hover:text-foreground"
            onClick={() => remove.mutate(v.id)}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {naming ? (
        <>
          <Input
            aria-label="Saved view name"
            className="h-8 w-48"
            placeholder="Name this view"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={keepDates}
              onChange={(e) => setKeepDates(e.target.checked)}
            />
            Keep these dates
          </label>
          <Button size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setNaming(true)}>
          Save this view
        </Button>
      )}
    </div>
  );
}
