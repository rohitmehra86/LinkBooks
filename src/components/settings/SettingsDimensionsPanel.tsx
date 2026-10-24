import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listTrackingDimensions,
  upsertTrackingCategory,
  upsertTrackingOption,
  exportDimensionsCsv,
  reportPnLByDimension,
} from "@/lib/settings/dimensions.functions";
import { dimensionKindLabel } from "@/lib/settings/dimension-helpers";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LookupSelect } from "@/components/lookup";
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
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

type Props = { companyId: string; canEdit: boolean; currency: string };

export function SettingsDimensionsPanel({ companyId, canEdit, currency }: Props) {
  const qc = useQueryClient();
  const fetchDims = useServerFn(listTrackingDimensions);
  const saveCat = useServerFn(upsertTrackingCategory);
  const saveOpt = useServerFn(upsertTrackingOption);
  const exportFn = useServerFn(exportDimensionsCsv);
  const reportFn = useServerFn(reportPnLByDimension);

  const [catName, setCatName] = useState("");
  const [catKind, setCatKind] = useState("department");
  const [optName, setOptName] = useState("");
  const [optCategoryId, setOptCategoryId] = useState("");
  const [reportCat, setReportCat] = useState("");
  const [fromDate, setFromDate] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));

  const dimsQ = useQuery({
    queryKey: ["tracking-dimensions", companyId],
    queryFn: () => fetchDims({ data: { companyId, includeInactive: true } }),
  });

  const reportQ = useQuery({
    queryKey: ["dim-pnl", companyId, reportCat, fromDate, toDate],
    enabled: Boolean(reportCat),
    queryFn: () => reportFn({ data: { companyId, categoryId: reportCat, fromDate, toDate } }),
  });

  const cats = (dimsQ.data?.categories ?? []) as Array<{
    id: string;
    name: string;
    dimension_kind: string;
    is_active: boolean;
    is_required: boolean;
  }>;
  const opts = (dimsQ.data?.options ?? []) as Array<{
    id: string;
    category_id: string;
    name: string;
    code: string | null;
    is_active: boolean;
  }>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Classes & reporting dimensions</CardTitle>
          <CardDescription>
            Analytical attributes for segments (class, department, location, project). These are not
            Chart of Accounts codes and not tax codes. Deactivating keeps historical assignments.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>New dimension</Label>
              <Input
                value={catName}
                disabled={!canEdit}
                onChange={(e) => setCatName(e.target.value)}
                placeholder="e.g. Department"
              />
            </div>
            <div className="space-y-1">
              <Label>Kind</Label>
              <Select value={catKind} onValueChange={setCatKind} disabled={!canEdit}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(dimsQ.data?.dimensionKinds ?? []).map((k) => (
                    <SelectItem key={k} value={k}>
                      {dimensionKindLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                size="sm"
                disabled={!canEdit || !catName.trim()}
                onClick={async () => {
                  try {
                    await saveCat({
                      data: { companyId, name: catName, dimensionKind: catKind },
                    });
                    setCatName("");
                    await qc.invalidateQueries({ queryKey: ["tracking-dimensions", companyId] });
                    toast.success("Dimension created");
                  } catch (e) {
                    toast.error(friendlyAuthError(e));
                  }
                }}
              >
                Add dimension
              </Button>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cats.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{dimensionKindLabel(c.dimension_kind)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={c.is_active}
                      disabled={!canEdit}
                      onCheckedChange={async (checked) => {
                        try {
                          await saveCat({
                            data: {
                              companyId,
                              id: c.id,
                              name: c.name,
                              dimensionKind: c.dimension_kind,
                              isActive: checked,
                            },
                          });
                          await qc.invalidateQueries({
                            queryKey: ["tracking-dimensions", companyId],
                          });
                        } catch (e) {
                          toast.error(friendlyAuthError(e));
                        }
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {opts.filter((o) => o.category_id === c.id).length} options
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="grid gap-2 border-t pt-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Dimension</Label>
              <LookupSelect
                ariaLabel="Dimension"
                allowClear={false}
                disabled={!canEdit}
                value={optCategoryId}
                onChange={setOptCategoryId}
                placeholder="Select…"
                searchPlaceholder="Search dimension"
                options={cats
                  .filter((c) => c.is_active)
                  .map((c) => ({
                    id: c.id,
                    name: c.name,
                    label: c.name,
                    group: dimensionKindLabel(c.dimension_kind),
                    keywords: `${c.name} ${c.dimension_kind}`,
                  }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Option name</Label>
              <Input
                value={optName}
                disabled={!canEdit}
                onChange={(e) => setOptName(e.target.value)}
                placeholder="e.g. North region"
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                disabled={!canEdit || !optCategoryId || !optName.trim()}
                onClick={async () => {
                  try {
                    await saveOpt({
                      data: { companyId, categoryId: optCategoryId, name: optName },
                    });
                    setOptName("");
                    await qc.invalidateQueries({ queryKey: ["tracking-dimensions", companyId] });
                    toast.success("Option added");
                  } catch (e) {
                    toast.error(friendlyAuthError(e));
                  }
                }}
              >
                Add option
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    const res = await exportFn({ data: { companyId } });
                    const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "linkbooks-dimensions.csv";
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    toast.error(friendlyAuthError(e));
                  }
                }}
              >
                Export CSV
              </Button>
            </div>
          </div>

          {opts.length ? (
            <ul className="max-h-48 space-y-1 overflow-auto text-sm">
              {opts.map((o) => (
                <li key={o.id} className="flex items-center justify-between border-b py-1">
                  <span>
                    {cats.find((c) => c.id === o.category_id)?.name ?? "?"} · {o.name}
                    {o.code ? ` (${o.code})` : ""}
                  </span>
                  <Badge variant={o.is_active ? "outline" : "secondary"}>
                    {o.is_active ? "active" : "inactive"}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Income & expense by dimension</CardTitle>
          <CardDescription>
            Uses document totals for invoices/bills assigned to this dimension. Reconcile to the
            ledger P&amp;L for the same dates; unassigned documents are listed separately in notes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <LookupSelect
              ariaLabel="Report dimension"
              allowClear={false}
              value={reportCat}
              onChange={setReportCat}
              placeholder="Dimension…"
              searchPlaceholder="Search dimension"
              options={cats.map((c) => ({
                id: c.id,
                name: c.name,
                label: c.name,
                group: dimensionKindLabel(c.dimension_kind),
                status: c.is_active ? null : "Inactive",
                disabled: !c.is_active && c.id !== reportCat,
                keywords: `${c.name} ${c.dimension_kind}`,
              }))}
            />
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          {reportQ.data ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Option</TableHead>
                  <TableHead className="text-right">Income</TableHead>
                  <TableHead className="text-right">Expense</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reportQ.data.rows
                  .filter((r) => r.optionId !== "__unassigned__")
                  .map((r) => (
                    <TableRow key={r.optionId}>
                      <TableCell>{r.optionName}</TableCell>
                      <TableCell className="text-right">
                        {fromMinorUnits(r.incomeMinor, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fromMinorUnits(r.expenseMinor, currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {fromMinorUnits(r.netMinor, currency)}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          ) : null}
          {reportQ.data?.method ? (
            <p className="text-xs text-muted-foreground">{reportQ.data.method}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
