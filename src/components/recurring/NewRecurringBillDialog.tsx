"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { NewBill } from "@/routes/_authenticated/purchases/bills.new";

type Props = {
  companyId: string;
  currencyCode: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (recurringBillId: string) => void;
};

/** Recurring template is the existing New bill screen, not a second form. */
export function NewRecurringBillDialog({ open, onOpenChange }: Props) {
  const [dirty, setDirty] = useState(false);

  const requestClose = (next: boolean) => {
    if (!next && dirty) {
      if (!window.confirm("You have unsaved changes. Close anyway?")) return;
    }
    if (!next) setDirty(false);
    onOpenChange(next);
  };

  return (
    <Sheet open={open} onOpenChange={requestClose}>
      <SheetContent
        side="right"
        className="flex h-full w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[82vw] sm:min-w-[40rem] sm:max-w-[1200px]"
      >
        <SheetHeader className="shrink-0 space-y-1 border-b border-border px-6 py-4 pr-12 text-left">
          <SheetTitle>Recurring bill template</SheetTitle>
          <p className="text-sm text-muted-foreground">
            The full New bill form. Saving a template does not create a bill or an Accounts Payable balance.
          </p>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {open ? <NewBill mode="template" onDirty={() => setDirty(true)} /> : null}
        </div>
        <div className="flex shrink-0 justify-end border-t border-border px-6 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={() => requestClose(false)}>
            Cancel
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
