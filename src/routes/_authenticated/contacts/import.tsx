import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  getContactImportTemplate,
  importContactsCsv,
} from "@/lib/contacts/contacts.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/contacts/import")({
  head: () => ({ meta: [{ title: "Import contacts — LinkBooks" }] }),
  component: ContactImportPage,
});

function ContactImportPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const templateFn = useServerFn(getContactImportTemplate);
  const importFn = useServerFn(importContactsCsv);
  const [csvText, setCsvText] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
    failed: number;
    errors: Array<{ row: number; message: string }>;
  } | null>(null);

  const importM = useMutation({
    mutationFn: () =>
      importFn({ data: { companyId: companyId!, csvText, skipDuplicates } }),
    onSuccess: (res) => {
      setResult(res);
      toast.success(`Import finished: ${res.created} created`);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Import contacts"
        description="Upload a CSV. Existing contacts with the same name are skipped by default."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/contacts">Directory</Link>
          </Button>
        }
      />

      <ol className="mb-6 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Download the LinkBooks template</li>
        <li>Fill name (required), kind, email, phone, tax_number, payment_terms_days</li>
        <li>Upload and review results — retries skip already-created names when enabled</li>
      </ol>

      <div className="mb-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              const res = await templateFn();
              const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "linkbooks-contacts-template.csv";
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              toast.error(friendlyAuthError(e));
            }
          }}
        >
          Download template
        </Button>
        <Label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
          Choose CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 1_500_000) {
                toast.error("File too large (max ~1.5 MB)");
                return;
              }
              const text = await file.text();
              setCsvText(text);
              setResult(null);
              toast.message(`Loaded ${file.name}`);
            }}
          />
        </Label>
      </div>

      <label className="mb-4 flex items-center gap-2 text-sm">
        <Checkbox checked={skipDuplicates} onCheckedChange={(v) => setSkipDuplicates(Boolean(v))} />
        Skip contacts that already exist (same name)
      </label>

      {csvText ? (
        <pre className="mb-4 max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
          {csvText.slice(0, 4000)}
          {csvText.length > 4000 ? "\n…" : ""}
        </pre>
      ) : null}

      <Button
        disabled={!csvText || importM.isPending}
        onClick={() => importM.mutate()}
      >
        {importM.isPending ? "Importing…" : "Confirm import"}
      </Button>

      {result ? (
        <div className="mt-6 space-y-2 text-sm">
          <p>
            Created {result.created} · Skipped {result.skipped} · Failed {result.failed}
          </p>
          {result.errors.length ? (
            <ul className="rounded-md border border-destructive/40 p-3 text-destructive">
              {result.errors.map((err) => (
                <li key={`${err.row}-${err.message}`}>
                  Row {err.row}: {err.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
