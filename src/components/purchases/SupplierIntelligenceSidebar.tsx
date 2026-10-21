"use client";

import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  GripVertical,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { getSupplierIntelligence } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { BillSidebarState } from "@/lib/settings/ui-preferences.functions";

export type AttachmentPreview = {
  id: string;
  fileName: string;
  contentType: string | null;
  previewUrl?: string | null;
};

type Props = {
  companyId: string;
  contactId: string | null;
  currency: string;
  state: BillSidebarState;
  widthPx: number;
  tab: string;
  onStateChange: (s: BillSidebarState) => void;
  onWidthChange: (w: number) => void;
  onTabChange: (t: string) => void;
  attachments?: AttachmentPreview[] | undefined;
  onDownloadAttachment?: ((id: string) => void) | undefined;
  className?: string | undefined;
};

export function SupplierIntelligenceSidebar({
  companyId,
  contactId,
  currency,
  state,
  widthPx,
  tab,
  onStateChange,
  onWidthChange,
  onTabChange,
  attachments = [],
  onDownloadAttachment,
  className,
}: Props) {
  const fetchIntel = useServerFn(getSupplierIntelligence);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const intelQ = useQuery({
    queryKey: ["supplier-intel", companyId, contactId],
    enabled: Boolean(companyId && contactId && state !== "closed"),
    queryFn: () => fetchIntel({ data: { companyId, contactId: contactId! } }),
  });

  useEffect(() => {
    setPreviewIdx(0);
    setZoom(1);
    setRotate(0);
  }, [contactId, attachments.length]);

  if (state === "closed") return null;

  if (state === "collapsed") {
    return (
      <aside
        className={cn(
          "flex w-11 shrink-0 flex-col items-center gap-2 border-l border-border bg-muted/30 py-3",
          className,
        )}
        aria-label="Supplier summary collapsed"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Expand supplier summary"
          onClick={() => onStateChange("open")}
        >
          <PanelRightOpen className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Close supplier summary"
          onClick={() => onStateChange("closed")}
        >
          <X className="size-4" />
        </Button>
        <span
          className="mt-4 origin-center rotate-90 whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          Supplier
        </span>
      </aside>
    );
  }

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: widthPx };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      onWidthChange(dragRef.current.startW + delta);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const money = (n: number) => fromMinorUnits(n, currency);
  const contact = intelQ.data?.contact as
    | {
        id: string;
        name: string;
        email: string | null;
        phone: string | null;
        account_number: string | null;
        default_currency: string | null;
        tax_number: string | null;
      }
    | undefined;

  const preview = attachments[previewIdx];

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col border-l border-border bg-card",
        className,
      )}
      style={{ width: widthPx }}
      aria-label="Supplier intelligence"
    >
      <button
        type="button"
        aria-label="Resize supplier panel"
        className="absolute inset-y-0 left-0 z-10 flex w-1.5 cursor-col-resize items-center justify-center hover:bg-primary/20"
        onMouseDown={onResizeStart}
      >
        <GripVertical className="size-3 text-muted-foreground opacity-40" />
      </button>

      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <h2 className="flex-1 truncate px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Supplier summary
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Collapse"
          onClick={() => onStateChange("collapsed")}
        >
          <ChevronRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close"
          onClick={() => onStateChange("closed")}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {!contactId ? (
        <p className="p-4 text-sm text-muted-foreground">Select a supplier to see balances and history.</p>
      ) : intelQ.isPending ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : intelQ.isError ? (
        <p className="p-4 text-sm text-destructive">{friendlyAuthError(intelQ.error)}</p>
      ) : (
        <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-2 mt-2 h-auto flex-wrap justify-start gap-0.5 bg-transparent p-0">
            {(
              [
                ["summary", "Summary"],
                ["bills", "Bills"],
                ["credits", "Credits"],
                ["preview", "Preview"],
                ["activity", "Activity"],
              ] as const
            ).map(([v, label]) => (
              <TabsTrigger
                key={v}
                value={v}
                className="h-7 rounded-md px-2 text-[11px] data-[state=active]:bg-muted"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
            <TabsContent value="summary" className="mt-0 space-y-3">
              <div>
                <p className="text-base font-semibold leading-tight">{contact?.name}</p>
                {contact?.account_number ? (
                  <p className="text-xs text-muted-foreground">Code {contact.account_number}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {[contact?.email, contact?.phone].filter(Boolean).join(" · ") || "No contact details"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Currency {contact?.default_currency ?? currency}
                  {contact?.tax_number ? ` · Tax ${contact.tax_number}` : ""}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-muted/50 p-2">
                  <dt className="text-muted-foreground">Outstanding AP</dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {money(intelQ.data!.outstandingMinor)}
                  </dd>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <dt className="text-muted-foreground">Overdue</dt>
                  <dd className="text-sm font-semibold tabular-nums text-destructive">
                    {money(intelQ.data!.overdueMinor)}
                  </dd>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <dt className="text-muted-foreground">Open bills</dt>
                  <dd className="text-sm font-semibold tabular-nums">{intelQ.data!.openBillCount}</dd>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <dt className="text-muted-foreground">Available credits</dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {money(intelQ.data!.availableCreditsMinor)}
                  </dd>
                </div>
                <div className="col-span-2 rounded-md bg-muted/50 p-2">
                  <dt className="text-muted-foreground">Unapplied prepayments</dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {money(intelQ.data!.unappliedPrepaymentsMinor)}
                  </dd>
                </div>
              </dl>
              <Button variant="outline" size="sm" className="w-full" asChild>
                <Link to="/contacts/$contactId" params={{ contactId: contactId }}>
                  View supplier profile
                  <ExternalLink className="ml-1 size-3" />
                </Link>
              </Button>
            </TabsContent>

            <TabsContent value="bills" className="mt-0 space-y-2">
              {(intelQ.data!.recentBills as Array<{
                id: string;
                bill_number: string | null;
                bill_date: string;
                status: string;
                total_minor: number;
                amount_paid_minor: number;
                amount_credited_minor: number;
              }>).length === 0 ? (
                <p className="text-muted-foreground">No bills yet.</p>
              ) : (
                (intelQ.data!.recentBills as Array<{
                  id: string;
                  bill_number: string | null;
                  bill_date: string;
                  status: string;
                  total_minor: number;
                  amount_paid_minor: number;
                  amount_credited_minor: number;
                }>).map((b) => {
                  const out =
                    b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
                  return (
                    <Link
                      key={b.id}
                      to="/purchases/bills/$billId"
                      params={{ billId: b.id }}
                      className="block rounded-md border border-border p-2 hover:bg-muted/40"
                    >
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">{b.bill_number ?? b.id.slice(0, 8)}</span>
                        <span className="tabular-nums">{money(b.total_minor)}</span>
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {b.bill_date} · {b.status}
                        </span>
                        {out > 0 ? <span>Due {money(out)}</span> : <span>Settled</span>}
                      </div>
                    </Link>
                  );
                })
              )}
            </TabsContent>

            <TabsContent value="credits" className="mt-0 space-y-3">
              <div>
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Credits</p>
                {(intelQ.data!.credits as Array<{
                  id: string;
                  credit_number: string | null;
                  credit_date: string;
                  available_minor: number;
                }>).length === 0 ? (
                  <p className="text-muted-foreground">No available credits.</p>
                ) : (
                  (intelQ.data!.credits as Array<{
                    id: string;
                    credit_number: string | null;
                    credit_date: string;
                    available_minor: number;
                  }>).map((c) => (
                    <Link
                      key={c.id}
                      to="/purchases/credit-notes/$creditNoteId"
                      params={{ creditNoteId: c.id }}
                      className="mb-1 flex justify-between rounded border border-border p-2 text-xs hover:bg-muted/40"
                    >
                      <span>
                        {c.credit_number ?? c.id.slice(0, 8)} · {c.credit_date}
                      </span>
                      <span className="tabular-nums font-medium">{money(c.available_minor)}</span>
                    </Link>
                  ))
                )}
              </div>
              <div>
                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Payments</p>
                {(intelQ.data!.payments as Array<{
                  id: string;
                  payment_date: string;
                  amount_minor: number;
                  unallocated_minor: number;
                  reference: string | null;
                }>).slice(0, 8).map((p) => (
                  <div
                    key={p.id}
                    className="mb-1 flex justify-between rounded border border-border p-2 text-xs"
                  >
                    <span>
                      {p.payment_date}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </span>
                    <span className="tabular-nums">{money(p.amount_minor)}</span>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="preview" className="mt-0 space-y-2">
              {attachments.length === 0 ? (
                <p className="text-muted-foreground">
                  Attach a supplier invoice to preview it here. PDF and images are supported.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={previewIdx <= 0}
                      onClick={() => setPreviewIdx((i) => i - 1)}
                      aria-label="Previous attachment"
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>
                    <span className="flex-1 truncate text-xs">
                      {preview?.fileName} ({previewIdx + 1}/{attachments.length})
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={previewIdx >= attachments.length - 1}
                      onClick={() => setPreviewIdx((i) => i + 1)}
                      aria-label="Next attachment"
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => setZoom((z) => Math.min(2.5, z + 0.25))}
                      aria-label="Zoom in"
                    >
                      <ZoomIn className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                      aria-label="Zoom out"
                    >
                      <ZoomOut className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => setRotate((r) => (r + 90) % 360)}
                      aria-label="Rotate"
                    >
                      <RotateCw className="size-3.5" />
                    </Button>
                    {preview && onDownloadAttachment ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => onDownloadAttachment(preview.id)}
                        aria-label="Download"
                      >
                        <Download className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex max-h-80 items-center justify-center overflow-auto rounded border border-border bg-muted/20 p-2">
                    {preview?.previewUrl && preview.contentType?.startsWith("image/") ? (
                      <img
                        src={preview.previewUrl}
                        alt={preview.fileName}
                        style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }}
                        className="max-w-full transition-transform"
                      />
                    ) : preview?.previewUrl && preview.contentType === "application/pdf" ? (
                      <iframe
                        title={preview.fileName}
                        src={preview.previewUrl}
                        className="h-72 w-full rounded"
                        style={{ transform: `scale(${zoom})` }}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Preview unavailable — use Download.
                      </p>
                    )}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="activity" className="mt-0 space-y-2">
              <p className="text-xs text-muted-foreground">Recent purchases & open orders</p>
              {(intelQ.data!.openOrders as Array<{
                id: string;
                order_number?: string | null;
                order_date: string;
                status: string;
                total_minor: number;
              }>).length > 0 ? (
                (intelQ.data!.openOrders as Array<{
                  id: string;
                  order_number?: string | null;
                  order_date: string;
                  status: string;
                  total_minor: number;
                }>).map((o) => (
                  <div key={o.id} className="rounded border border-border p-2 text-xs">
                    PO {o.order_number ?? o.id.slice(0, 8)} · {o.order_date} · {o.status} ·{" "}
                    {money(o.total_minor)}
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground">No open purchase orders.</p>
              )}
              <p className="pt-2 text-xs text-muted-foreground">
                Price history and payment trends use posted bill and payment data above — not
                fabricated metrics.
              </p>
            </TabsContent>
          </div>
        </Tabs>
      )}
    </aside>
  );
}

export function ShowSupplierSummaryButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("gap-1.5", className)}
      onClick={onClick}
    >
      <PanelRightClose className="size-3.5" />
      Show supplier summary
    </Button>
  );
}
