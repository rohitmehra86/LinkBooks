import { toast } from "sonner";
import { friendlyAuthError } from "@/lib/auth-helpers";

/**
 * Toast conventions (use these instead of calling `toast` ad hoc):
 *  - success: short past-tense sentence, auto-dismiss ("Invoice INV-0042 saved").
 *  - error: plain-language reason, stays longer, never raw stack traces ("Could not save: …").
 *  - info/warning: for non-blocking notices only; anything that needs a decision is a dialog.
 * Undo-able actions pass `action`; destructive confirmations use <ConfirmDialog>, not a toast.
 */
export const notify = {
  success(message: string, description?: string) {
    return toast.success(message, { duration: 4000, ...(description ? { description } : {}) });
  },
  error(error: unknown, prefix?: string) {
    const reason = friendlyAuthError(error);
    return toast.error(prefix ? `${prefix}: ${reason}` : reason, { duration: 8000 });
  },
  info(message: string, description?: string) {
    return toast.info(message, { duration: 5000, ...(description ? { description } : {}) });
  },
  warning(message: string, description?: string) {
    return toast.warning(message, { duration: 7000, ...(description ? { description } : {}) });
  },
};
