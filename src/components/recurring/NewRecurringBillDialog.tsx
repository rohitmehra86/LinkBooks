"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[94vh] w-[min(96vw,1200px)] max-w-none flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Recurring bill template</DialogTitle>
          <p className="text-sm text-muted-foreground">
            The full New bill form. Saving a template does not create a bill or an Accounts Payable balance.
          </p>
        </DialogHeader>
        {open ? <NewBill mode="template" /> : null}
      </DialogContent>
    </Dialog>
  );
}
