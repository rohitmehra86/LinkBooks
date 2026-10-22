import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CategoryMeta } from "@/lib/settings/registry";

export function SettingsUnavailablePanel({ meta }: { meta: CategoryMeta }) {
  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Unavailable</AlertTitle>
        <AlertDescription>
          {meta.label} is not operational in the current LinkBooks build. It is listed here so the
          Settings Centre covers the full information architecture without presenting a fake
          connected or synchronised state.
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{meta.label}</CardTitle>
          <CardDescription>{meta.description}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Tracked in <code>docs/settings/CHECKLIST.md</code>. When implemented, this panel will
          persist configuration through the typed settings registry with server-side enforcement.
        </CardContent>
      </Card>
    </div>
  );
}
