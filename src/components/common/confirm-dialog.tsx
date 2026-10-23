import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * Confirmation before an irreversible or significant action (void, delete, post, reset).
 * Controlled: the caller owns `open` and closes it when `onConfirm` finishes, so async work
 * keeps the dialog open with a spinner and a failed call can show its error without losing context.
 * Use `tone="destructive"` for voids/deletes. Say what will happen and whether it can be undone.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  pending,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
  /** Extra body content (e.g. a reason field). */
  children?: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(v) => (pending ? undefined : onOpenChange(v))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            type="button"
            variant={tone === "destructive" ? "destructive" : "default"}
            disabled={pending}
            onClick={() => void onConfirm()}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
