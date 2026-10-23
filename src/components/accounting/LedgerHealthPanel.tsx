import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, CircleSlash, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { useFormat } from "@/hooks/use-format";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { runLedgerHealthCheck } from "@/lib/accounting/ledger-health.functions";
import {
  checkHref,
  headline,
  problemLabel,
  type HealthItem,
  type HealthReport,
  type HealthStatus,
} from "@/lib/accounting/ledger-health";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const ICON: Record<HealthStatus, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: TriangleAlert,
  fail: XCircle,
  na: CircleSlash,
};
const TONE: Record<HealthStatus, string> = {
  pass: "text-emerald-600",
  warn: "text-amber-600",
  fail: "text-destructive",
  na: "text-muted-foreground",
};
const WORD: Record<HealthStatus, string> = {
  pass: "Passed",
  warn: "Needs a look",
  fail: "Failed",
  na: "Not applicable",
};

const HIDDEN_KEYS = new Set(["id", "journal_id", "problem"]);

function itemText(
  item: HealthItem,
  baseCurrency: string,
  money: (minor: number, currency: string) => string,
): string {
  const currency =
    typeof item["currency"] === "string" ? (item["currency"] as string) : baseCurrency;
  const parts: string[] = [];
  if (typeof item["problem"] === "string") parts.push(problemLabel(item["problem"]));
  for (const [k, v] of Object.entries(item)) {
    if (HIDDEN_KEYS.has(k) || v === null || v === "") continue;
    const label = k.replace(/_minor$/, "").replace(/_/g, " ");
    parts.push(
      k.endsWith("_minor") && typeof v === "number"
        ? `${label}: ${money(v, currency)}`
        : `${label}: ${String(v)}`,
    );
  }
  return parts.join(" · ");
}

/** Accounting settings: runs the read-only ledger checks and shows an honest pass/fail for each. */
export function LedgerHealthPanel({ companyId }: { companyId: string }) {
  const fmt = useFormat();
  const run = useServerFn(runLedgerHealthCheck);
  const mutation = useMutation({ mutationFn: () => run({ data: { companyId } }) });
  const result = mutation.data;
  const report: HealthReport | null = result && "report" in result ? result.report : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ledger health check</CardTitle>
        <CardDescription>
          Read-only checks on the books: trial balance, journal balance, orphan lines, documents
          against journals, receivables and payables against the ledger, and period locks. It
          changes nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          type="button"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {report ? "Run again" : "Run health check"}
        </Button>

        {mutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>The check could not run</AlertTitle>
            <AlertDescription>{friendlyAuthError(mutation.error)}</AlertDescription>
          </Alert>
        ) : null}

        {result && "unavailable" in result ? (
          <Alert>
            <AlertTitle>Unavailable</AlertTitle>
            <AlertDescription>{result.unavailable}</AlertDescription>
          </Alert>
        ) : null}

        {report ? (
          <>
            <p
              role="status"
              className={cn(
                "text-sm font-medium",
                report.overall === "pass"
                  ? "text-emerald-600"
                  : report.overall === "warn"
                    ? "text-amber-600"
                    : "text-destructive",
              )}
            >
              {headline(report)}{" "}
              <span className="font-normal text-muted-foreground">
                {report.journalsChecked} posted journals and {report.linesChecked} lines checked
                {report.generatedAt ? ` at ${new Date(report.generatedAt).toLocaleString()}` : ""}.
              </span>
            </p>
            <ul className="divide-y rounded-md border">
              {report.checks.map((c) => {
                const Icon = ICON[c.status];
                const href = checkHref(c.key);
                return (
                  <li key={c.key} className="space-y-1 p-3">
                    <div className="flex items-start gap-2">
                      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE[c.status])} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{c.label}</span>
                          <span className={cn("text-xs", TONE[c.status])}>{WORD[c.status]}</span>
                        </div>
                        <p className="text-sm text-muted-foreground">{c.summary}</p>
                      </div>
                      {href && (c.status === "fail" || c.status === "warn") ? (
                        <Button asChild size="sm" variant="ghost">
                          <Link to={href as never}>Review</Link>
                        </Button>
                      ) : null}
                    </div>
                    {c.status !== "pass" && c.status !== "na" && c.items.length > 0 ? (
                      <ul className="ml-6 space-y-0.5 text-xs text-muted-foreground">
                        {c.items.map((item, i) => (
                          <li key={i}>
                            {itemText(item, report.baseCurrency, (minor, cur) =>
                              fmt.amount(minor, cur),
                            )}
                          </li>
                        ))}
                        {c.count > c.items.length ? (
                          <li>…and {c.count - c.items.length} more.</li>
                        ) : null}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
