import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  addOptionalLibraryAccounts,
  applyCoaIndustryTemplate,
  createManualAccount,
  getCompanyCoaSettings,
  listCoaIndustries,
  listOptionalLibraryAccounts,
  listTrackingCategories,
  previewCoaIndustryApply,
} from "@/lib/accounting/coa.functions";
import type { DetailLevel } from "@/lib/accounting/coa-library/types";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type Props = { companyId: string };

export function IndustryCoaPanel({ companyId }: Props) {
  const queryClient = useQueryClient();
  const fetchIndustries = useServerFn(listCoaIndustries);
  const fetchSettings = useServerFn(getCompanyCoaSettings);
  const fetchPreview = useServerFn(previewCoaIndustryApply);
  const doApply = useServerFn(applyCoaIndustryTemplate);
  const fetchLibrary = useServerFn(listOptionalLibraryAccounts);
  const doAddOptional = useServerFn(addOptionalLibraryAccounts);
  const doCreateManual = useServerFn(createManualAccount);
  const fetchTracking = useServerFn(listTrackingCategories);

  const [selected, setSelected] = useState<string[]>([]);
  const [level, setLevel] = useState<DetailLevel>("standard");
  const [industryQ, setIndustryQ] = useState("");
  const [libraryQ, setLibraryQ] = useState("");
  const [optionalKeys, setOptionalKeys] = useState<string[]>([]);
  const [manual, setManual] = useState({
    code: "",
    name: "",
    accountType: "expense" as "asset" | "liability" | "equity" | "income" | "expense",
  });

  const industriesQ = useQuery({
    queryKey: ["coa-industries"],
    queryFn: () => fetchIndustries(),
  });
  const settingsQ = useQuery({
    queryKey: ["coa-settings", companyId],
    queryFn: () => fetchSettings({ data: { companyId } }),
  });
  const trackingQ = useQuery({
    queryKey: ["tracking-categories", companyId],
    queryFn: () => fetchTracking({ data: { companyId } }),
  });
  const libraryQry = useQuery({
    queryKey: ["coa-library", libraryQ],
    queryFn: () => fetchLibrary({ data: { q: libraryQ } }),
  });

  useEffect(() => {
    if (settingsQ.data && selected.length === 0 && settingsQ.data.industryCodes.length > 0) {
      setSelected(settingsQ.data.industryCodes);
      setLevel(settingsQ.data.detailLevel);
    }
  }, [settingsQ.data, selected.length]);

  const filteredIndustries = useMemo(() => {
    const q = industryQ.trim().toLowerCase();
    const rows = industriesQ.data ?? [];
    if (!q) return rows;
    return rows.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.code.includes(q) ||
        i.family.includes(q) ||
        i.description.toLowerCase().includes(q),
    );
  }, [industriesQ.data, industryQ]);

  const previewMut = useMutation({
    mutationFn: () =>
      fetchPreview({ data: { companyId, industryCodes: selected, level } }),
  });

  const applyMut = useMutation({
    mutationFn: () =>
      doApply({
        data: {
          companyId,
          industryCodes: selected,
          level,
          confirmConflicts: (previewMut.data?.conflicts.length ?? 0) > 0,
        },
      }),
    onSuccess: async (res) => {
      toast.success(`Added ${res.created} account(s). Existing balances preserved.`);
      await queryClient.invalidateQueries({ queryKey: ["accounts", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["coa-settings", companyId] });
      await queryClient.invalidateQueries({ queryKey: ["tracking-categories", companyId] });
      previewMut.reset();
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const optionalMut = useMutation({
    mutationFn: () => doAddOptional({ data: { companyId, keys: optionalKeys } }),
    onSuccess: async (res) => {
      toast.success(`Added ${res.created} optional account(s).`);
      setOptionalKeys([]);
      await queryClient.invalidateQueries({ queryKey: ["accounts", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const manualMut = useMutation({
    mutationFn: () =>
      doCreateManual({
        data: {
          companyId,
          code: manual.code,
          name: manual.name,
          accountType: manual.accountType,
        },
      }),
    onSuccess: async () => {
      toast.success("Account created");
      setManual({ code: "", name: "", accountType: "expense" });
      await queryClient.invalidateQueries({ queryKey: ["accounts", companyId] });
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  function toggleIndustry(code: string) {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  return (
    <div className="space-y-6">
      <Alert>
        <AlertTitle>Maximum capability, lean defaults</AlertTitle>
        <AlertDescription>
          Every organisation keeps the core system CoA (Level A). Choose industries and a detail
          level to add recommended accounts only. Applying never deletes, renames, or rewrites
          posted history. Church and charity packs also create Fund / Mission tracking dimensions
          instead of one GL account per missionary.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Industry recommendations</CardTitle>
          <CardDescription>
            Select one or more industries (e.g. Amazon FBA + Shopify). Preview before apply.
            {settingsQ.data?.industryCodes?.length
              ? ` Current: ${settingsQ.data.industryCodes.join(", ")} (${settingsQ.data.detailLevel}).`
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="industry-search">Search industries</Label>
              <Input
                id="industry-search"
                value={industryQ}
                onChange={(e) => setIndustryQ(e.target.value)}
                placeholder="Type: church, amazon, saas…"
              />
            </div>
            <div className="w-full space-y-2 sm:w-48">
              <Label>Detail level</Label>
              <Select value={level} onValueChange={(v) => setLevel(v as DetailLevel)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="simple">Simple</SelectItem>
                  <SelectItem value="standard">Standard (recommended)</SelectItem>
                  <SelectItem value="detailed">Detailed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {industriesQ.isPending ? (
            <p className="text-sm text-muted-foreground">Loading industries…</p>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-md border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {filteredIndustries.map((ind) => (
                  <label
                    key={ind.code}
                    className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={selected.includes(ind.code)}
                      onCheckedChange={() => toggleIndustry(ind.code)}
                    />
                    <span className="text-sm">
                      <span className="font-medium">{ind.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {ind.family.replaceAll("_", " ")}
                        {ind.hasTracking ? " · tracking dimensions" : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={selected.length === 0 || previewMut.isPending}
              onClick={() => previewMut.mutate()}
            >
              {previewMut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Preview changes
            </Button>
            <Button
              type="button"
              disabled={!previewMut.data || applyMut.isPending}
              onClick={() => applyMut.mutate()}
            >
              {applyMut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Apply recommended accounts
            </Button>
          </div>

          {previewMut.data ? (
            <div className="space-y-3 rounded-md border p-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Create {previewMut.data.toCreate.length}</Badge>
                <Badge variant="outline">Already present {previewMut.data.alreadyPresent.length}</Badge>
                <Badge variant="outline">Skip controls {previewMut.data.skippedControls.length}</Badge>
                {previewMut.data.conflicts.length > 0 ? (
                  <Badge variant="destructive">Conflicts {previewMut.data.conflicts.length}</Badge>
                ) : null}
              </div>
              {previewMut.data.toCreate.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Why</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewMut.data.toCreate.slice(0, 40).map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="font-mono text-xs">{r.code}</TableCell>
                        <TableCell>{r.name}</TableCell>
                        <TableCell className="text-muted-foreground">{r.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground">Nothing new to add at this level.</p>
              )}
              {previewMut.data.conflicts.map((c) => (
                <p key={c.key} className="text-destructive">
                  {c.reason}
                </p>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Optional account library</CardTitle>
          <CardDescription>
            Search the full catalogue and add only what you need (Level C).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={libraryQ}
            onChange={(e) => setLibraryQ(e.target.value)}
            placeholder="Search by name, code or description…"
          />
          <div className="max-h-56 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Level</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(libraryQry.data ?? []).slice(0, 50).map((a) => (
                  <TableRow key={a.key}>
                    <TableCell>
                      <Checkbox
                        checked={optionalKeys.includes(a.key)}
                        onCheckedChange={(on) =>
                          setOptionalKeys((prev) =>
                            on ? [...prev, a.key] : prev.filter((k) => k !== a.key),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{a.code}</TableCell>
                    <TableCell>
                      <div>{a.name}</div>
                      <div className="text-xs text-muted-foreground">{a.description}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{a.recommendation}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button
            type="button"
            disabled={optionalKeys.length === 0 || optionalMut.isPending}
            onClick={() => optionalMut.mutate()}
          >
            {optionalMut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Add selected ({optionalKeys.length})
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add new account</CardTitle>
          <CardDescription>Create a custom account without using the industry library.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-2">
            <Label>Code</Label>
            <Input
              value={manual.code}
              onChange={(e) => setManual((m) => ({ ...m, code: e.target.value }))}
              placeholder="6420"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Name</Label>
            <Input
              value={manual.name}
              onChange={(e) => setManual((m) => ({ ...m, name: e.target.value }))}
              placeholder="Office supplies"
            />
          </div>
          <div className="space-y-2">
            <Label>Type</Label>
            <Select
              value={manual.accountType}
              onValueChange={(v) =>
                setManual((m) => ({
                  ...m,
                  accountType: v as typeof manual.accountType,
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asset">Asset</SelectItem>
                <SelectItem value="liability">Liability</SelectItem>
                <SelectItem value="equity">Equity</SelectItem>
                <SelectItem value="income">Income</SelectItem>
                <SelectItem value="expense">Expense</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-4">
            <Button
              type="button"
              disabled={!manual.code.trim() || !manual.name.trim() || manualMut.isPending}
              onClick={() => manualMut.mutate()}
            >
              {manualMut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create account
            </Button>
          </div>
        </CardContent>
      </Card>

      {(trackingQ.data ?? []).length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Tracking dimensions</CardTitle>
            <CardDescription>
              Use these for Fund / Mission / Ministry detail — not separate GL accounts per item.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(trackingQ.data ?? []).map((cat) => (
              <div key={cat.id}>
                <p className="font-medium">{cat.name}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {cat.options.map((o) => (
                    <Badge key={o.id} variant="secondary">
                      {o.name}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
