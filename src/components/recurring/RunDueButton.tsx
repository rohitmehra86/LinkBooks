import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { describeRunDue, type RunDueSummary } from "@/lib/recurring/due";
import { Button } from "@/components/ui/button";

/** "Run due now": generates every schedule that is due today. Safe to press twice (idempotent). */
export function RunDueButton({
  label,
  run,
  invalidateKeys,
}: {
  label: string;
  run: () => Promise<RunDueSummary>;
  invalidateKeys: unknown[][];
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: async (summary) => {
      for (const key of invalidateKeys) await qc.invalidateQueries({ queryKey: key });
      const text = describeRunDue(label, summary);
      if (summary.failed.length) toast.error(`${text}: ${summary.failed[0]!.message}`);
      else toast.success(text);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
      Run due now
    </Button>
  );
}
