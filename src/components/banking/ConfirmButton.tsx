import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";

/**
 * A button that asks for confirmation before running a (potentially ledger-changing) action.
 * Thin wrapper over the shared `ConfirmDialog` so every confirmation looks and behaves the same.
 */
export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  disabled,
  variant = "outline",
  size = "sm",
}: {
  children: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        tone={variant === "destructive" ? "destructive" : "default"}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
      />
    </>
  );
}
