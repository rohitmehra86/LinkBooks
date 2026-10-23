import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCanDo } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { addMonthsIso, monthEnd, monthStart, todayIso } from "@/lib/accounting/fiscal-year";
import { DEPRECIATION_METHODS } from "@/lib/fixed-assets/depreciation";
import {
  deleteFixedAsset,
  getAssetRegisterPage,
  getFixedAssetRegister,
  listCapitalisableBillLines,
  previewDepreciation,
  runDepreciation,
  type AssetTypeRow,
  type CapitaliseLine,
  type FixedAssetRow,
} from "@/lib/fixed-assets/fixed-assets.functions";
import {
  AssetDialog,
  AssetTypeDialog,
  DisposeDialog,
} from "@/components/fixed-assets/AssetDialogs";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/fixed-assets")({
  head: () => ({ meta: [{ title: "Fixed assets — LinkBooks" }] }),
  component: FixedAssetsPage,
});

const METHOD_LABEL = new Map(DEPRECIATION_METHODS.map((m) => [m.value, m.label]));

type Dialogs =
  | { kind: "asset"; editing: FixedAssetRow | null; fromBillLine: CapitaliseLine | null }
  | { kind: "type"; editing: AssetTypeRow | null }
  | { kind: "dispose"; asset: FixedAssetRow }
  | { kind: "bill-lines" }
  | null;

function FixedAssetsPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const fmt = useFormat();
  const canManage = useCanDo("accounts.manage");
  const canPostEntries = useCanDo("accounting.post");
  const canPostManual = useCanDo("journals.manual");
  const canPost = canPostEntries || canPostManual;
  const pageFn = useServerFn(getAssetRegisterPage);
  const registerFn = useServerFn(getFixedAssetRegister);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const today = useMemo(() => todayIso(), []);

  const page = useQuery({
    queryKey: ["fixed-assets", companyId, "page"],
    enabled: Boolean(companyId),
    queryFn: () => pageFn({ data: { companyId: companyId! } }),
  });
  const register = useQuery({
    queryKey: ["fixed-assets", companyId, "register", today],
    enabled: Boolean(companyId) && page.data?.available === true,
    queryFn: () => registerFn({ data: { companyId: companyId!, asOf: today } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (page.isPending) return <LoadingState />;
  if (page.isError) {
    return (
      <ErrorState
        title="Could not load fixed assets"
        description={friendlyAuthError(page.error)}
        onRetry={() => void page.refetch()}
      />
    );
  }
  const d = page.data;
  if (!d.available) {
    return (
      <>
        <PageHeader
          title="Fixed assets"
          description="Register, depreciate and dispose of assets."
        />
        <Alert>
          <AlertDescription>
            Fixed assets are not available yet: the database updates that add them have not been
            applied.
          </AlertDescription>
        </Alert>
      </>
    );
  }
  const currency = d.currency;
  const accumulatedOf = (a: FixedAssetRow) =>
    register.data?.rows.find((r) => r.asset_id === a.id)?.accumulated_minor ??
    a.opening_accumulated_minor;

  return (
    <>
      <PageHeader
        title="Fixed assets"
        description="Keep a register of what you own, post monthly depreciation and record disposals. Every posting goes through the same journal engine as the rest of your books."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/reports/$reportId" params={{ reportId: "fixed-asset-register" }}>
                Register report
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/reports/$reportId" params={{ reportId: "depreciation-schedule" }}>
                Depreciation schedule
              </Link>
            </Button>
          </>
        }
      />
      <Tabs defaultValue="register">
        <TabsList>
          <TabsTrigger value="register">Register</TabsTrigger>
          <TabsTrigger value="depreciation">Run depreciation</TabsTrigger>
          <TabsTrigger value="types">Asset types</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canManage}
              onClick={() => setDialog({ kind: "asset", editing: null, fromBillLine: null })}
            >
              Add asset
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage}
              onClick={() => setDialog({ kind: "bill-lines" })}
            >
              Capitalise from a bill
            </Button>
          </div>
          {d.assets.length === 0 ? (
            <EmptyState
              title="No fixed assets"
              description="Add an asset, or capitalise a line from a posted bill."
            />
          ) : (
            <RegisterTable
              assets={d.assets}
              currency={currency}
              accumulatedOf={accumulatedOf}
              canManage={canManage}
              canPost={canPost}
              companyId={companyId}
              onEdit={(a) => setDialog({ kind: "asset", editing: a, fromBillLine: null })}
              onDispose={(a) => setDialog({ kind: "dispose", asset: a })}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Registering an asset does not post anything: the purchase is already in your books.
            Depreciation is charged for whole months from the month depreciation starts.
          </p>
        </TabsContent>

        <TabsContent value="depreciation">
          <DepreciationPanel
            companyId={companyId}
            currency={currency}
            assets={d.assets}
            lastRunThrough={d.lastRunThrough}
            canPost={canPost}
          />
        </TabsContent>

        <TabsContent value="types" className="space-y-4">
          <Button
            size="sm"
            disabled={!canManage}
            onClick={() => setDialog({ kind: "type", editing: null })}
          >
            New asset type
          </Button>
          {d.types.length === 0 ? (
            <EmptyState
              title="No asset types"
              description="Types such as Computers or Vehicles set default methods and accounts."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Life / rate</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.types.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{METHOD_LABEL.get(t.depreciation_method)}</TableCell>
                    <TableCell className="text-right">
                      {t.depreciation_method === "straight_line"
                        ? `${t.useful_life_months} months`
                        : t.depreciation_method === "reducing_balance"
                          ? `${fmt.percentBps(t.annual_rate_bps ?? 0)} a year`
                          : "–"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canManage}
                        onClick={() => setDialog({ kind: "type", editing: t })}
                      >
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>

      {dialog?.kind === "asset" ? (
        <AssetDialog
          key={dialog.editing?.id ?? dialog.fromBillLine?.lineId ?? "new"}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          companyId={companyId}
          currency={currency}
          accounts={d.accounts}
          types={d.types}
          editing={dialog.editing}
          fromBillLine={dialog.fromBillLine}
          frozen={
            dialog.editing
              ? dialog.editing.depreciated_through !== null || dialog.editing.status === "disposed"
              : false
          }
        />
      ) : null}
      {dialog?.kind === "type" ? (
        <AssetTypeDialog
          key={dialog.editing?.id ?? "new"}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          companyId={companyId}
          accounts={d.accounts}
          editing={dialog.editing}
        />
      ) : null}
      {dialog?.kind === "dispose" ? (
        <DisposeDialog
          key={dialog.asset.id}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          companyId={companyId}
          currency={currency}
          accounts={d.accounts}
          asset={dialog.asset}
          accumulatedMinor={accumulatedOf(dialog.asset)}
        />
      ) : null}
      {dialog?.kind === "bill-lines" ? (
        <BillLinesDialog
          companyId={companyId}
          currency={currency}
          onClose={() => setDialog(null)}
          onPick={(line) => setDialog({ kind: "asset", editing: null, fromBillLine: line })}
        />
      ) : null}
    </>
  );
}

function RegisterTable({
  assets,
  currency,
  accumulatedOf,
  canManage,
  canPost,
  companyId,
  onEdit,
  onDispose,
}: {
  assets: FixedAssetRow[];
  currency: string;
  accumulatedOf: (a: FixedAssetRow) => number;
  canManage: boolean;
  canPost: boolean;
  companyId: string;
  onEdit: (a: FixedAssetRow) => void;
  onDispose: (a: FixedAssetRow) => void;
}) {
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const deleteFn = useServerFn(deleteFixedAsset);
  const remove = useMutation({
    mutationFn: (assetId: string) => deleteFn({ data: { companyId, assetId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["fixed-assets", companyId] });
      toast.success("Asset deleted");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Asset</TableHead>
          <TableHead>Purchased</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="text-right">Accumulated</TableHead>
          <TableHead className="text-right">Net book value</TableHead>
          <TableHead>Depreciated to</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {assets.map((a) => {
          const acc = accumulatedOf(a);
          const disposed = a.status === "disposed";
          const hasPosted = a.depreciated_through !== null;
          return (
            <TableRow key={a.id}>
              <TableCell>
                <span className="mr-2 font-mono text-xs text-muted-foreground">
                  {a.asset_number}
                </span>
                {a.name}
                {disposed ? (
                  <Badge variant="secondary" className="ml-2">
                    Disposed {a.disposal_date ? fmt.date(a.disposal_date) : ""}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>{fmt.date(a.purchase_date)}</TableCell>
              <TableCell>{METHOD_LABEL.get(a.depreciation_method)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {fmt.amount(a.cost_minor, currency)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{fmt.amount(acc, currency)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {disposed ? "–" : fmt.amount(a.cost_minor - acc, currency)}
              </TableCell>
              <TableCell>
                {a.depreciated_through ? fmt.date(a.depreciated_through) : "Not yet"}
              </TableCell>
              <TableCell className="whitespace-nowrap text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canManage || disposed}
                  onClick={() => onEdit(a)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canPost || disposed}
                  onClick={() => onDispose(a)}
                >
                  Dispose
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canManage || disposed || hasPosted || remove.isPending}
                  title={
                    hasPosted || disposed
                      ? "An asset with posted depreciation or a disposal cannot be deleted"
                      : undefined
                  }
                  onClick={() => {
                    if (window.confirm(`Delete ${a.asset_number} ${a.name}?`)) remove.mutate(a.id);
                  }}
                >
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** First month that still needs depreciation across active assets (month start), or null. */
function earliestOutstanding(assets: FixedAssetRow[]): string | null {
  let best: string | null = null;
  for (const a of assets) {
    if (a.status !== "active" || a.depreciation_method === "none") continue;
    const next = a.depreciated_through
      ? monthStart(addMonthsIso(monthStart(a.depreciated_through), 1))
      : monthStart(a.depreciation_start_date);
    if (best === null || next < best) best = next;
  }
  return best;
}

function DepreciationPanel({
  companyId,
  currency,
  assets,
  lastRunThrough,
  canPost,
}: {
  companyId: string;
  currency: string;
  assets: FixedAssetRow[];
  lastRunThrough: string | null;
  canPost: boolean;
}) {
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const previewFn = useServerFn(previewDepreciation);
  const runFn = useServerFn(runDepreciation);
  const thisMonth = monthStart(todayIso());
  const outstanding = earliestOutstanding(assets);
  // Default to the oldest month that still needs running, never later than this month.
  const [month, setMonth] = useState(
    (outstanding && outstanding <= thisMonth ? outstanding : thisMonth).slice(0, 7),
  );
  const periodEnd = monthEnd(`${month}-01`);

  const preview = useQuery({
    queryKey: ["fixed-assets", companyId, "preview", periodEnd],
    queryFn: () => previewFn({ data: { companyId, periodEnd } }),
  });

  const monthsThrough = (): string[] => {
    if (!outstanding) return [periodEnd];
    const out: string[] = [];
    for (let m = outstanding; m <= periodEnd; m = addMonthsIso(m, 1)) out.push(monthEnd(m));
    return out;
  };

  const post = useMutation({
    mutationFn: (periodEnds: string[]) => runFn({ data: { companyId, periodEnds } }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["fixed-assets", companyId] });
      if (res.posted.length > 0) {
        const total = res.posted.reduce((n, p) => n + p.totalMinor, 0);
        toast.success(
          `Posted ${res.posted.length} month${res.posted.length === 1 ? "" : "s"} (${fmt.money(total, currency)})`,
        );
      }
      if (res.failure) {
        toast.error(`${res.failure.periodEnd}: ${res.failure.message}`);
      }
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const rows = preview.data?.rows ?? [];
  const due = rows.filter((r) => r.status === "due");
  const behind = rows.filter((r) => r.status === "behind");
  const catchUp = monthsThrough();

  const STATUS: Record<string, string> = {
    due: "Will be posted",
    posted: "Posted",
    not_started: "Not started yet",
    behind: "Earlier months not run",
    done: "Already depreciated",
    nothing_left: "Fully depreciated",
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="dep-month">Month</Label>
          <Input
            id="dep-month"
            type="month"
            value={month}
            max={thisMonth.slice(0, 7)}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
          />
        </div>
        <p className="pb-2 text-sm text-muted-foreground">
          {lastRunThrough
            ? `Last posted run: ${fmt.date(lastRunThrough)}.`
            : "No depreciation has been posted yet."}{" "}
          Preview first: nothing is posted until you confirm.
        </p>
      </div>

      {preview.isPending ? (
        <LoadingState />
      ) : preview.isError ? (
        <ErrorState
          title="Could not preview depreciation"
          description={friendlyAuthError(preview.error)}
          onRetry={() => void preview.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No assets to depreciate"
          description="Add an asset that depreciates to see a preview."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Depreciation</TableHead>
                <TableHead className="text-right">Accumulated after</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.asset_id}>
                  <TableCell>
                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                      {r.asset_number}
                    </span>
                    {r.asset_name}
                  </TableCell>
                  <TableCell>{STATUS[r.status] ?? r.status}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.status === "due" ? fmt.amount(r.amount_minor, currency) : "–"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.status === "due" ? fmt.amount(r.accumulated_after_minor, currency) : "–"}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 font-semibold">
                <TableCell colSpan={2}>Total for {fmt.date(periodEnd)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmt.amount(preview.data?.totalMinor ?? 0, currency)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!canPost || post.isPending || due.length === 0}
              title={canPost ? undefined : "You do not have permission to post journals"}
              onClick={() => {
                if (
                  window.confirm(
                    `Post depreciation of ${fmt.money(preview.data?.totalMinor ?? 0, currency)} for ${fmt.date(periodEnd)}?`,
                  )
                ) {
                  post.mutate([periodEnd]);
                }
              }}
            >
              {post.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Post {fmt.date(periodEnd)}
            </Button>
            {behind.length > 0 && catchUp.length > 1 ? (
              <Button
                variant="outline"
                disabled={!canPost || post.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Post ${catchUp.length} months of depreciation, one journal per month, up to ${fmt.date(periodEnd)}? It stops at the first month that cannot be posted (for example a locked period).`,
                    )
                  ) {
                    post.mutate(catchUp);
                  }
                }}
              >
                Post all {catchUp.length} outstanding months
              </Button>
            ) : null}
          </div>
          {behind.length > 0 ? (
            <Alert>
              <AlertDescription>
                {behind.length} asset{behind.length === 1 ? " has" : "s have"} earlier months that
                are not depreciated yet. Months are posted in order, so run the earlier months first
                or use “Post all outstanding months”.
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      )}
    </div>
  );
}

function BillLinesDialog({
  companyId,
  currency,
  onClose,
  onPick,
}: {
  companyId: string;
  currency: string;
  onClose: () => void;
  onPick: (line: CapitaliseLine) => void;
}) {
  const fmt = useFormat();
  const listFn = useServerFn(listCapitalisableBillLines);
  const q = useQuery({
    queryKey: ["fixed-assets", companyId, "bill-lines"],
    queryFn: () => listFn({ data: { companyId } }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Capitalise from a bill</DialogTitle>
          <DialogDescription>
            Posted bill lines coded to an asset account. Pick one to pre-fill a new asset; the bill
            is not changed.
          </DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState
            title="Could not load bill lines"
            description={friendlyAuthError(q.error)}
            onRetry={() => void q.refetch()}
          />
        ) : q.data.lines.length === 0 ? (
          <EmptyState
            title="No bill lines to capitalise"
            description="Code a bill line to a fixed asset account (for example 1500) and it appears here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bill</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead className="text-right">Already registered</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.lines.map((l) => (
                <TableRow key={l.lineId}>
                  <TableCell>
                    {l.billNumber ?? "Bill"}
                    <span className="block text-xs text-muted-foreground">
                      {l.supplier ?? ""} · {fmt.date(l.billDate)}
                    </span>
                  </TableCell>
                  <TableCell>{l.description}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(l.netMinor, l.currency)}
                    {l.currency !== currency ? (
                      <span className="block text-xs text-muted-foreground">{l.currency}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt.amount(l.registeredMinor, currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" onClick={() => onPick(l)}>
                      Use
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
