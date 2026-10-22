import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  getOrganisationConfig,
  upsertOrganisationConfig,
  type SettingsDocument,
} from "@/lib/settings/settings-centre.functions";
import { categoryMeta, type SettingsCategory } from "@/lib/settings/registry";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type Props = {
  companyId: string;
  category: SettingsCategory;
  canEdit: boolean;
};

export function SettingsCategoryConfigPanel({ companyId, category, canEdit }: Props) {
  const meta = categoryMeta.find((c) => c.id === category);
  const qc = useQueryClient();
  const fetch = useServerFn(getOrganisationConfig);
  const save = useServerFn(upsertOrganisationConfig);
  const q = useQuery({
    queryKey: ["organisation-config", companyId, category],
    queryFn: () => fetch({ data: { companyId, category } }),
  });

  const [doc, setDoc] = useState<SettingsDocument>({});

  useEffect(() => {
    if (q.data?.document) setDoc({ ...q.data.document });
  }, [q.data]);

  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId,
          category,
          document: doc,
          expectedVersion: q.data?.version ?? 0,
          reason: `${meta?.label ?? category} updated`,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["organisation-config", companyId, category] });
      await qc.invalidateQueries({ queryKey: ["organisation-features", companyId] });
      toast.success("Saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!meta) return null;

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>{meta.label}</AlertTitle>
        <AlertDescription>{meta.description}</AlertDescription>
      </Alert>

      {meta.moduleLinks?.length ? (
        <div className="flex flex-wrap gap-2">
          {meta.moduleLinks.map((l) => (
            <Button key={l.to} size="sm" variant="outline" asChild>
              <Link to={l.to}>{l.label}</Link>
            </Button>
          ))}
        </div>
      ) : null}

      {meta.availability === "unavailable" ? (
        <Alert>
          <AlertTitle>Unavailable</AlertTitle>
          <AlertDescription>
            This category is not operational yet. Configuration below is stored for readiness but
            related product behaviour remains disabled until marked Verified.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
          <CardDescription>Persisted via organisation_config with optimistic concurrency.</CardDescription>
        </CardHeader>
        <CardContent className="grid max-w-xl gap-3">
          {Object.keys(doc).length === 0 ? (
            <p className="text-sm text-muted-foreground">No typed fields for this category yet.</p>
          ) : (
            Object.entries(doc).map(([key, value]) => {
              if (typeof value === "boolean") {
                return (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <Label className="capitalize">{key.replace(/_/g, " ")}</Label>
                    <Switch
                      checked={Boolean(doc[key])}
                      disabled={!canEdit}
                      onCheckedChange={(on) => setDoc((d) => ({ ...d, [key]: on }))}
                    />
                  </div>
                );
              }
              if (typeof value === "number" || typeof value === "string") {
                return (
                  <div key={key} className="space-y-1">
                    <Label className="capitalize">{key.replace(/_/g, " ")}</Label>
                    <Input
                      value={String(doc[key] ?? "")}
                      disabled={!canEdit}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setDoc((d) => ({
                          ...d,
                          [key]: typeof value === "number" ? Number(raw) : raw,
                        }));
                      }}
                    />
                  </div>
                );
              }
              if (Array.isArray(value)) {
                return (
                  <div key={key} className="space-y-1">
                    <Label className="capitalize">{key.replace(/_/g, " ")}</Label>
                    <Input
                      value={(doc[key] as unknown[]).join(", ")}
                      disabled={!canEdit}
                      onChange={(e) => {
                        const parts = e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((s) => (Number.isFinite(Number(s)) ? Number(s) : s));
                        setDoc((d) => ({ ...d, [key]: parts }));
                      }}
                    />
                    <p className="text-xs text-muted-foreground">Comma-separated</p>
                  </div>
                );
              }
              return null;
            })
          )}
          <Button disabled={!canEdit || mut.isPending} onClick={() => mut.mutate()}>
            Save
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
