import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import {
  deleteAttachment,
  getAttachmentDownload,
  listCompanyFiles,
  registerAttachment,
} from "@/lib/documents/attachments.functions";
import {
  ATTACHMENT_ENTITIES,
  ATTACHMENT_ENTITY_TYPES,
  FILE_INPUT_ACCEPT,
  MAX_FILE_BYTES,
  formatFileSize,
  validateUpload,
} from "@/lib/documents/attachments";
import { downloadBase64, uploadCompanyDocument } from "@/lib/documents/upload-client";
import { openSignedDownload } from "@/lib/documents/ui";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/files")({
  head: () => ({ meta: [{ title: "Files — LinkBooks" }] }),
  component: FilesPage,
});

const PAGE_SIZE = 25;

function FilesPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const { can } = useCan();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const fetchFiles = useServerFn(listCompanyFiles);
  const register = useServerFn(registerAttachment);
  const fetchDownload = useServerFn(getAttachmentDownload);
  const remove = useServerFn(deleteAttachment);
  const inputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const canUpload = ATTACHMENT_ENTITIES.company.manage.some((p) => can(p));

  const filesQ = useQuery({
    queryKey: ["company-files", companyId, debounced, type, page],
    enabled: Boolean(companyId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      fetchFiles({
        data: {
          companyId: companyId!,
          search: debounced,
          entityType: type,
          page,
          pageSize: PAGE_SIZE,
        },
      }),
  });

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await uploadCompanyDocument({
          file,
          companyId: companyId!,
          entityType: "company",
          entityId: companyId!,
          register: register as never,
        });
      }
      return files.length;
    },
    onSuccess: async (n) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["company-files", companyId] });
      toast.success(n === 1 ? "File uploaded" : `${n} files uploaded`);
    },
    onError: async (e) => {
      setError(friendlyAuthError(e));
      await queryClient.invalidateQueries({ queryKey: ["company-files", companyId] });
    },
  });

  const downloadM = useMutation({
    mutationFn: (id: string) =>
      fetchDownload({ data: { companyId: companyId!, attachmentId: id } }),
    onSuccess: (r) => {
      if (r.kind === "url") openSignedDownload(r.url, r.fileName);
      else downloadBase64(r.fileName, r.contentType, r.contentBase64);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => remove({ data: { companyId: companyId!, attachmentId: id } }),
    onSuccess: async () => {
      setPendingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["company-files", companyId] });
      toast.success("File deleted");
    },
    onError: (e) => {
      setPendingDelete(null);
      toast.error(friendlyAuthError(e));
    },
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const onPick = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    for (const f of files) {
      const check = validateUpload({ fileName: f.name, sizeBytes: f.size, contentType: f.type });
      if (!check.ok) {
        setError(`${f.name}: ${check.error}`);
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
    }
    setError(null);
    uploadM.mutate(files);
    if (inputRef.current) inputRef.current.value = "";
  };

  const data = filesQ.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Files"
        description="Everything attached to invoices, bills, contacts and journals, plus files you upload here. You only see files for records you are allowed to view."
        actions={
          canUpload ? (
            <>
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                accept={FILE_INPUT_ACCEPT}
                aria-label="Choose files to upload"
                onChange={(e) => onPick(e.target.files)}
              />
              <Button
                size="sm"
                disabled={uploadM.isPending}
                onClick={() => inputRef.current?.click()}
              >
                {uploadM.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Upload className="mr-1 size-4" />
                )}
                Upload files
              </Button>
            </>
          ) : undefined
        }
      />
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          className="w-64"
          placeholder="Search file names"
          aria-label="Search file names"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          value={type}
          onValueChange={(v) => {
            setType(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-52" aria-label="Filter by record type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All records</SelectItem>
            {ATTACHMENT_ENTITY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {ATTACHMENT_ENTITIES[t].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filesQ.isPending ? (
        <LoadingState />
      ) : filesQ.isError ? (
        <ErrorState
          title="Could not load files"
          description={friendlyAuthError(filesQ.error)}
          onRetry={() => filesQ.refetch()}
        />
      ) : filesQ.data.files.length === 0 ? (
        <EmptyState
          title="No files"
          description={
            debounced || type !== "all"
              ? "No files match this search."
              : canUpload
                ? `Upload a file here or attach one to an invoice or bill. Up to ${formatFileSize(MAX_FILE_BYTES)} each.`
                : "No files have been added yet."
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Attached to</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filesQ.data.files.map((f) => {
                const manageable = (
                  f.entity_type in ATTACHMENT_ENTITIES
                    ? ATTACHMENT_ENTITIES[f.entity_type as keyof typeof ATTACHMENT_ENTITIES].manage
                    : []
                ).some((p) => can(p));
                return (
                  <TableRow key={f.id}>
                    <TableCell className="max-w-xs truncate font-medium">{f.file_name}</TableCell>
                    <TableCell>
                      {f.entityPath && f.entity_type !== "company" ? (
                        <a href={f.entityPath} className="underline">
                          {f.entityLabel}
                          {f.entityRef ? ` · ${f.entityRef}` : ""}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">{f.entityLabel}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.size_bytes != null ? formatFileSize(f.size_bytes) : "—"}
                    </TableCell>
                    <TableCell>{fmt.dateTime(f.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Download ${f.file_name}`}
                        disabled={downloadM.isPending}
                        onClick={() => downloadM.mutate(f.id)}
                      >
                        <Download className="size-4" />
                      </Button>
                      {manageable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${f.file_name}`}
                          onClick={() => setPendingDelete({ id: f.id, name: f.file_name })}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {filesQ.data.total} file{filesQ.data.total === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <span>
                Page {page + 1} of {pages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page + 1 >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” will be removed permanently. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteM.isPending}
              onClick={() => pendingDelete && deleteM.mutate(pendingDelete.id)}
            >
              Delete file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
