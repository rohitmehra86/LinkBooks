import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  applyAiSuggestion,
  getAiAssistantStatus,
  listAiSuggestions,
  rejectAiSuggestion,
  runAiAssistant,
} from "@/lib/ai/ai.functions";
import { roleHasPermission } from "@/lib/permissions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/ai-assistant")({
  head: () => ({
    meta: [
      { title: "AI Assistant — LinkBooks" },
      {
        name: "description",
        content: "Accounting guidance and review suggestions, always subject to user approval.",
      },
      { property: "og:title", content: "AI Assistant — LinkBooks" },
      {
        property: "og:description",
        content: "Accounting guidance and review suggestions, always subject to user approval.",
      },
    ],
  }),
  component: AiAssistant,
});

type Intent =
  | "ask"
  | "explain"
  | "categorise"
  | "draft"
  | "duplicates"
  | "reconcile"
  | "unusual"
  | "navigate";

function AiAssistant() {
  const { company, isPending } = useActiveCompany();
  const companyId = company?.id ?? null;
  const canUse = roleHasPermission(company?.role ?? "read_only", "ai.use");
  const canApply = roleHasPermission(company?.role ?? "read_only", "ai.apply_suggestion");

  const fetchStatus = useServerFn(getAiAssistantStatus);
  const runAssist = useServerFn(runAiAssistant);
  const fetchSuggestions = useServerFn(listAiSuggestions);
  const doApply = useServerFn(applyAiSuggestion);
  const doReject = useServerFn(rejectAiSuggestion);
  const qc = useQueryClient();

  const [intent, setIntent] = useState<Intent>("ask");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [facts, setFacts] = useState<Array<{ kind: string; title: string; body: string }>>([]);
  const [lastSuggestionId, setLastSuggestionId] = useState<string | null>(null);

  const statusQ = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => fetchStatus(),
  });

  const suggestionsQ = useQuery({
    queryKey: ["ai-suggestions", companyId],
    enabled: Boolean(companyId) && canUse,
    queryFn: () => fetchSuggestions({ data: { companyId: companyId! } }),
  });

  const askM = useMutation({
    mutationFn: () => {
      if (!companyId) throw new Error("Select an organisation");
      return runAssist({ data: { companyId, intent, message } });
    },
    onSuccess: async (r) => {
      setReply(r.replyMarkdown);
      setMode(r.mode);
      setFacts(r.facts ?? []);
      setLastSuggestionId(r.suggestionId);
      await qc.invalidateQueries({ queryKey: ["ai-suggestions", companyId] });
      if (r.mode === "not_configured") {
        toast.message("AI provider not configured");
      }
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const applyM = useMutation({
    mutationFn: (suggestionId: string) => {
      if (!companyId) throw new Error("Select an organisation");
      return doApply({ data: { companyId, suggestionId, confirm: true } });
    },
    onSuccess: async (r) => {
      toast.success(`Journal posted: ${r.journalId.slice(0, 8)}…`);
      await qc.invalidateQueries({ queryKey: ["ai-suggestions", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (isPending) return <LoadingState />;
  if (!companyId) {
    return (
      <>
        <PageHeader title="AI Assistant" description="Select an organisation first." />
        <Alert>
          <AlertTitle>No organisation</AlertTitle>
          <AlertDescription>Choose a company in the switcher to use the assistant.</AlertDescription>
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="AI Assistant"
        description={`Organisation context: ${company?.name}. Suggestions never post without your confirmation.`}
      />

      <Alert className="mb-6">
        <ShieldCheck className="size-4" />
        <AlertTitle>Accounting safety</AlertTitle>
        <AlertDescription>
          AI cannot bypass journal balancing, tax validation, approvals or permissions. Calculated
          FACT blocks come from LinkBooks; model text is labelled separately. See{" "}
          <span className="font-medium">docs/ai/AI_DATA_HANDLING.md</span>.
        </AlertDescription>
      </Alert>

      {statusQ.data && !statusQ.data.configured ? (
        <Alert className="mb-6" variant="destructive">
          <AlertTitle>AI provider not configured</AlertTitle>
          <AlertDescription>{statusQ.data.message}</AlertDescription>
        </Alert>
      ) : statusQ.data?.configured ? (
        <Alert className="mb-6">
          <AlertTitle>Provider ready</AlertTitle>
          <AlertDescription>
            Model <code className="text-xs">{statusQ.data.model}</code> · max{" "}
            {statusQ.data.maxRequestsPerHour} requests/hour · keys stay on the server
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Ask the assistant</CardTitle>
            <CardDescription>
              Local checks (duplicates, reconcile, unusual, navigate) work without a provider.
              Explain / ask / categorise / draft need a configured server key.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!canUse ? (
              <p className="text-sm text-muted-foreground">Your role cannot use the AI assistant.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Select value={intent} onValueChange={(v) => setIntent(v as Intent)}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ask">Ask (org data)</SelectItem>
                      <SelectItem value="explain">Explain</SelectItem>
                      <SelectItem value="categorise">Suggest category</SelectItem>
                      <SelectItem value="draft">Draft invoice/bill/journal</SelectItem>
                      <SelectItem value="duplicates">Find duplicates (calculated)</SelectItem>
                      <SelectItem value="reconcile">Reconcile exceptions (calculated)</SelectItem>
                      <SelectItem value="unusual">Unusual movements (calculated)</SelectItem>
                      <SelectItem value="navigate">Navigate workflows</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea
                  placeholder="e.g. Explain why bank balance moved last month / draft a rent accrual journal"
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={askM.isPending || !message.trim()}
                    onClick={() => askM.mutate()}
                  >
                    {askM.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                    Send
                  </Button>
                </div>
              </>
            )}

            {reply ? (
              <div className="space-y-3 rounded-md border p-4">
                {mode ? (
                  <Badge variant="secondary">
                    {mode === "model"
                      ? "Model explanation"
                      : mode === "calculated"
                        ? "Calculated fact"
                        : "Not configured"}
                  </Badge>
                ) : null}
                <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-sm">
                  {reply}
                </div>
                {lastSuggestionId && canApply ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={applyM.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Post this AI journal suggestion to the ledger? It must balance and pass validation.",
                          )
                        ) {
                          applyM.mutate(lastSuggestionId);
                        }
                      }}
                    >
                      Confirm & post journal draft
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        doReject({ data: { companyId, suggestionId: lastSuggestionId } }).then(
                          async () => {
                            toast.message("Suggestion rejected");
                            await qc.invalidateQueries({ queryKey: ["ai-suggestions", companyId] });
                          },
                        )
                      }
                    >
                      Reject
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                <Sparkles className="mx-auto mb-2 size-5" />
                Responses appear here. No fake answers when AI is offline.
              </div>
            )}

            {facts.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  Calculated facts (not model)
                </p>
                {facts.map((f) => (
                  <details key={f.kind} className="rounded border p-2 text-sm">
                    <summary className="cursor-pointer font-medium">{f.title}</summary>
                    <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{f.body}</pre>
                  </details>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success" />
              <CardTitle className="text-base">Safety rules</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Suggestions only until you confirm apply.</p>
            <p>Unbalanced or foreign-account drafts are rejected.</p>
            <p>Cross-organisation context is blocked server-side.</p>
            <p>Prompt-injection attempts are flagged and cannot override permissions.</p>
            <p>Provider secrets never ship to the browser.</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Recent suggestions</CardTitle>
          <CardDescription>Stored proposals for this organisation only.</CardDescription>
        </CardHeader>
        <CardContent>
          {suggestionsQ.isPending ? (
            <LoadingState rows={3} />
          ) : suggestionsQ.isError ? (
            <ErrorState
              title="Could not load suggestions"
              description={friendlyAuthError(suggestionsQ.error)}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Intent</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(suggestionsQ.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.title || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{s.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{s.intent}</TableCell>
                    <TableCell>
                      {canApply && s.status === "validated" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={applyM.isPending}
                          onClick={() => {
                            if (window.confirm("Post this validated journal suggestion?")) {
                              applyM.mutate(s.id);
                            }
                          }}
                        >
                          Apply
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
