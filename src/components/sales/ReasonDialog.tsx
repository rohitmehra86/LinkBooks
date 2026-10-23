"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Label of the date field (e.g. "Void date"). Omit to hide the date input. */
  dateLabel?: string;
  /** Earliest date that may be chosen (the document's own date). */
  minDate?: string | undefined;
  defaultDate: string;
  pending?: boolean;
  destructive?: boolean;
  onConfirm: (input: { reason: string; date: string }) => void;
};

/** Confirmation dialog for accounting corrections: a reason is mandatory, the date is explicit. */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  dateLabel,
  minDate,
  defaultDate,
  pending,
  destructive = true,
  onConfirm,
}: Props) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(defaultDate);
  const trimmed = reason.trim();
  const dateOk = !dateLabel || (Boolean(date) && (!minDate || date >= minDate));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setReason("");
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reason-dialog-reason">Reason (required)</Label>
            <Textarea
              id="reason-dialog-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being corrected?"
            />
          </div>
          {dateLabel ? (
            <div className="space-y-2">
              <Label htmlFor="reason-dialog-date">{dateLabel}</Label>
              <Input
                id="reason-dialog-date"
                type="date"
                value={date}
                min={minDate}
                onChange={(e) => setDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The reversing entry is posted on this date. It must fall in an open period.
              </p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending || trimmed.length < 3 || !dateOk}
            onClick={() => onConfirm({ reason: trimmed, date })}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
