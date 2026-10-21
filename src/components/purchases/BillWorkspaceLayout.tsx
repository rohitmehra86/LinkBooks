"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  SupplierIntelligenceSidebar,
  ShowSupplierSummaryButton,
  type AttachmentPreview,
} from "@/components/purchases/SupplierIntelligenceSidebar";
import type { BillSidebarState } from "@/lib/settings/ui-preferences.functions";

type Props = {
  companyId: string;
  contactId: string | null;
  currency: string;
  sidebarState: BillSidebarState;
  sidebarWidthPx: number;
  sidebarTab: string;
  onSidebarStateChange: (s: BillSidebarState) => void;
  onSidebarWidthChange: (w: number) => void;
  onSidebarTabChange: (t: string) => void;
  attachments?: AttachmentPreview[] | undefined;
  onDownloadAttachment?: ((id: string) => void) | undefined;
  header: ReactNode;
  children: ReactNode;
  className?: string | undefined;
};

/**
 * Premium three-pane New Bill shell: header + expanding main workspace + right supplier sidebar.
 * Closing/collapsing the sidebar expands the main form without remounting children.
 */
export function BillWorkspaceLayout({
  companyId,
  contactId,
  currency,
  sidebarState,
  sidebarWidthPx,
  sidebarTab,
  onSidebarStateChange,
  onSidebarWidthChange,
  onSidebarTabChange,
  attachments,
  onDownloadAttachment,
  header,
  children,
  className,
}: Props) {
  return (
    <div className={cn("flex min-h-[calc(100vh-4rem)] flex-col", className)}>
      <div className="shrink-0 border-b border-border bg-background px-1 pb-3">
        {header}
        {sidebarState === "closed" ? (
          <div className="mt-2 flex items-center gap-3">
            <ShowSupplierSummaryButton onClick={() => onSidebarStateChange("open")} />
            {contactId ? (
              <span className="text-xs text-muted-foreground">
                Compact AP indicator available when a supplier is selected — open the sidebar for full detail.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-x-auto overflow-y-auto px-1 py-3">{children}</main>
        <SupplierIntelligenceSidebar
          companyId={companyId}
          contactId={contactId}
          currency={currency}
          state={sidebarState}
          widthPx={sidebarWidthPx}
          tab={sidebarTab}
          onStateChange={onSidebarStateChange}
          onWidthChange={onSidebarWidthChange}
          onTabChange={onSidebarTabChange}
          attachments={attachments}
          onDownloadAttachment={onDownloadAttachment}
          className="hidden md:flex"
        />
      </div>
      {/* Mobile drawer trigger reuse */}
      <div className="sticky bottom-0 border-t border-border bg-background p-2 md:hidden">
        {sidebarState === "closed" ? (
          <ShowSupplierSummaryButton
            className="w-full"
            onClick={() => onSidebarStateChange("open")}
          />
        ) : (
          <SupplierIntelligenceSidebar
            companyId={companyId}
            contactId={contactId}
            currency={currency}
            state={sidebarState === "collapsed" ? "open" : sidebarState}
            widthPx={Math.min(sidebarWidthPx, 360)}
            tab={sidebarTab}
            onStateChange={onSidebarStateChange}
            onWidthChange={onSidebarWidthChange}
            onTabChange={onSidebarTabChange}
            attachments={attachments}
            onDownloadAttachment={onDownloadAttachment}
            className="max-h-[50vh] w-full border-l-0"
          />
        )}
      </div>
    </div>
  );
}
