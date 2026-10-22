import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSettingsOverview } from "@/lib/settings/settings-centre.functions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  companyId: string;
  onNavigate: (section: string) => void;
};

export function SettingsOverviewPanel({ companyId, onNavigate }: Props) {
  const fetch = useServerFn(getSettingsOverview);
  const q = useQuery({
    queryKey: ["settings-overview", companyId],
    queryFn: () => fetch({ data: { companyId } }),
  });

  if (q.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load overview</AlertTitle>
        <AlertDescription>{(q.error as Error)?.message ?? "Unknown error"}</AlertDescription>
      </Alert>
    );
  }

  const d = q.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Setup status</CardTitle>
          <CardDescription>
            {d.company?.name ?? "Organisation"} · {d.company?.base_currency} ·{" "}
            {d.memberCount} member{d.memberCount === 1 ? "" : "s"}
            {d.company?.is_demo ? " · Demo" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Badge variant="secondary">{d.featureSummary.operational} operational</Badge>
          <Badge variant="outline">{d.featureSummary.disabled} available off</Badge>
          <Badge variant="outline">{d.featureSummary.needsConfig} need config</Badge>
          <Badge variant="outline">{d.featureSummary.unavailable} unavailable</Badge>
        </CardContent>
      </Card>

      {d.warnings.length > 0 ? (
        <div className="space-y-2">
          {d.warnings.map((w) => (
            <Alert key={w.message} variant={w.severity === "high" ? "destructive" : "default"}>
              <AlertTitle>
                {w.severity === "high" ? "Security / integrity" : w.severity === "medium" ? "Configuration" : "Info"}
              </AlertTitle>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>{w.message}</span>
                {w.href?.includes("section=") ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onNavigate(w.href!.split("section=")[1] ?? "overview")}
                  >
                    Open
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ))}
        </div>
      ) : null}

      {d.incompleteConfigurations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Incomplete configurations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {d.incompleteConfigurations.map((name) => (
              <Badge key={name} variant="outline">
                {name}
              </Badge>
            ))}
            <Button size="sm" variant="secondary" onClick={() => onNavigate("features")}>
              Feature Manager
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Integration health</CardTitle>
          <CardDescription>Honest connection state — nothing is claimed as live unless wired.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {d.integrations.map((i) => (
            <div key={i.name} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>{i.name}</span>
              <Badge variant="outline">Unavailable</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick access</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => onNavigate("accounting")}>
            Lock dates
          </Button>
          <Button size="sm" variant="outline" onClick={() => onNavigate("features")}>
            Feature Manager
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/accounting">Accounting periods</Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/tax">Tax</Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/purchases/bills/new">New bill</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
