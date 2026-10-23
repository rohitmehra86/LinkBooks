import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, FileText, Loader2, Paperclip, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import { useCan } from "@/hooks/use-can";
import { useFormat } from "@/hooks/use-format";
import {
  deleteAttachment,
  getAttachmentDownload,
  listAttachments,
  registerAttachment,
} from "@/lib/documents/attachments.functions";
import {
  ATTACHMENT_ENTITIES,
  FILE_INPUT_ACCEPT,
  MAX_FILE_BYTES,
  formatFileSize,
  validateUpload,
  type AttachmentEntityType,
} from "@/lib/documents/attachments";
import { downloadBase64, uploadCompanyDocument } from "@/lib/documents/upload-client";
import { openSignedDownload } from "@/lib/documents/ui";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export function AttachmentsPanel({
  entityType,
  entityId,
  title = "Attachments",
}: {
  entityType: AttachmentEntityType;
  entityId: string;
  title?: string;
}) {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const { can } = useCan();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const fetchList = useServerFn(listAttachments);
  const register = useServerFn(registerAttachment);
  const fetchDownload = useServerFn(getAttachmentDownload);
  const remove = useServerFn(deleteAttachment);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const info = ATTACHMENT_ENTITIES[entityType];
  const canManage = info.manage.some((p) => can(p));
  const canView = info.view ? can(info.view) : true;
  const key = ["attachments", companyId, entityType, entityId];

  const listQ = useQuery({
    queryKey: key,
    enabled: Boolean(companyId) && canView,
    queryFn: () => fetchList({ data: { companyId: companyId!, entityType, entityId } }),
  });

  const uploadM = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await uploadCompanyDocument({
          file,
          companyId: companyId!,
          entityType,
          entityId,
          register: register as never,
        });
      }
      return files.length;
    },
    onSuccess: async (n) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ["company-files", companyId] });
      toast.success(n === 1 ? "File uploaded" : `${n} files uploaded`);
    },
    onError: async (e) => {
      setError(friendlyAuthError(e));
      await queryClient.invalidateQueries({ queryKey: key });
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
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ["company-files", companyId] });
      toast.success("File deleted");
    },
    onError: (e) => {
      setPendingDelete(null);
      toast.error(friendlyAuthError(e));
    },
  });

  if (!companyId || !canView) return null;

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

  const rows = listQ.data ?? [];
  return (
    <Card className="mt-6 max-w-4xl print:hidden" data-testid="attachments-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Paperclip className="size-4" /> {title}
          {rows.length > 0 ? (
            <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
          ) : null}
        </CardTitle>
        {canManage ? (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              accept={FILE_INPUT_ACCEPT}
              onChange={(e) => onPick(e.target.files)}
              aria-label="Choose files to attach"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={uploadM.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {uploadM.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Upload file
            </Button>
          </>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {listQ.isPending ? (
          <p className="text-muted-foreground">Loading files…</p>
        ) : listQ.isError ? (
          <p className="text-destructive">{friendlyAuthError(listQ.error)}</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">
            No files attached.{" "}
            {canManage
              ? `PDF, images, CSV, text and Office files up to ${formatFileSize(MAX_FILE_BYTES)}.`
              : "You can view files here but not add them."}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded border border-border">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{r.file_name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {r.size_bytes != null ? formatFileSize(r.size_bytes) : ""} ·{" "}
                    {fmt.dateTime(r.created_at)}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Download ${r.file_name}`}
                    disabled={downloadM.isPending}
                    onClick={() => downloadM.mutate(r.id)}
                  >
                    <Download className="size-4" />
                  </Button>
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${r.file_name}`}
                      onClick={() => setPendingDelete({ id: r.id, name: r.file_name })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

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
              onClick={() => pendingDelete && deleteM.mutate(pendingDelete.id)}
              disabled={deleteM.isPending}
            >
              Delete file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
