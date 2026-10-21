"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileText, Loader2, Paperclip, Upload, X } from "lucide-react";
import { toast } from "sonner";
import {
  deleteBillAttachment,
  downloadBillAttachment,
  uploadBillAttachment,
} from "@/lib/purchases/purchases.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type BillAttachmentRow = {
  id: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  billId: string;
  attachments: BillAttachmentRow[];
  canUpload?: boolean;
  /** Auto-select this attachment when opening (e.g. first PDF). */
  focusAttachmentId?: string | null;
};

function isPdf(a: BillAttachmentRow) {
  const name = a.file_name.toLowerCase();
  const type = (a.content_type ?? "").toLowerCase();
  return type.includes("pdf") || name.endsWith(".pdf");
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * LinkBooks related-files layover: list attachments and inline PDF preview.
 * Independent layout — not a copy of any competitor files panel.
 */
export function BillRelatedFilesOverlay({
  open,
  onOpenChange,
  companyId,
  billId,
  attachments,
  canUpload = false,
  focusAttachmentId = null,
}: Props) {
  const qc = useQueryClient();
  const doDownload = useServerFn(downloadBillAttachment);
  const doUpload = useServerFn(uploadBillAttachment);
  const doDelete = useServerFn(deleteBillAttachment);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>("");
  const [previewKind, setPreviewKind] = useState<"pdf" | "image" | "other">("other");
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    if (!open) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setSelectedId(null);
      return;
    }
    const preferred =
      (focusAttachmentId && attachments.find((a) => a.id === focusAttachmentId)) ||
      attachments.find(isPdf) ||
      attachments[0] ||
      null;
    if (preferred) void loadPreview(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open/attachments drive initial selection
  }, [open, focusAttachmentId]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const loadPreview = async (att: BillAttachmentRow) => {
    setSelectedId(att.id);
    setLoadingPreview(true);
    setPreviewName(att.file_name);
    try {
      const file = await doDownload({ data: { companyId, attachmentId: att.id } });
      const bin = atob(file.contentBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const type = file.contentType || att.content_type || "application/octet-stream";
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      setPreviewUrl(url);
      if (type.includes("pdf") || att.file_name.toLowerCase().endsWith(".pdf")) {
        setPreviewKind("pdf");
      } else if (type.startsWith("image/")) {
        setPreviewKind("image");
      } else {
        setPreviewKind("other");
      }
    } catch (e) {
      toast.error(friendlyAuthError(e));
      setPreviewUrl(null);
    } finally {
      setLoadingPreview(false);
    }
  };

  const uploadM = useMutation({
    mutationFn: async (file: File) => {
      const max = 8 * 1024 * 1024;
      if (file.size > max) throw new Error("File must be 8 MB or smaller");
      const contentBase64 = await fileToBase64(file);
      return doUpload({
        data: {
          companyId,
          billId,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          contentBase64,
        },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      toast.success("File attached");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const deleteM = useMutation({
    mutationFn: (attachmentId: string) =>
      doDelete({ data: { companyId, attachmentId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bill", companyId, billId] });
      toast.success("Attachment removed");
      setSelectedId(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[min(960px,94vw)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Paperclip className="size-4 text-muted-foreground" />
            Related files
          </DialogTitle>
          <DialogDescription>
            Preview PDFs and manage documents attached to this bill.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 md:grid-cols-[220px_1fr]">
          <aside className="flex max-h-[70vh] flex-col border-b border-border md:border-b-0 md:border-r">
            <ul className="flex-1 overflow-y-auto p-2">
              {attachments.length === 0 ? (
                <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No files yet
                </li>
              ) : (
                attachments.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => void loadPreview(a)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                        selectedId === a.id
                          ? "bg-primary/10 text-foreground"
                          : "hover:bg-muted/70 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <FileText
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          isPdf(a) ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">
                          {a.file_name}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {a.created_at
                            ? new Date(a.created_at).toLocaleString()
                            : "Attached"}
                          {a.size_bytes != null
                            ? ` · ${Math.max(1, Math.round(a.size_bytes / 1024))} KB`
                            : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="space-y-2 border-t border-border p-3">
              {canUpload ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,image/*,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) uploadM.mutate(f);
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={uploadM.isPending}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploadM.isPending ? (
                      <Loader2 className="mr-1 size-4 animate-spin" />
                    ) : (
                      <Upload className="mr-1 size-4" />
                    )}
                    Upload file
                  </Button>
                </>
              ) : null}
              {selectedId && canUpload ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="w-full text-destructive"
                  disabled={deleteM.isPending}
                  onClick={() => {
                    if (confirm("Remove this attachment?")) deleteM.mutate(selectedId);
                  }}
                >
                  Remove selected
                </Button>
              ) : null}
            </div>
          </aside>

          <div className="relative flex min-h-[320px] flex-col bg-muted/30">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-2">
              <p className="truncate text-sm font-medium">{previewName || "Select a file"}</p>
              <div className="flex items-center gap-1">
                {previewUrl ? (
                  <Button size="sm" variant="outline" asChild>
                    <a href={previewUrl} download={previewName} target="_blank" rel="noreferrer">
                      Download
                    </a>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label="Close"
                  onClick={() => onOpenChange(false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {loadingPreview ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                  Loading preview…
                </div>
              ) : !previewUrl ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                  <FileText className="size-10 opacity-40" />
                  <p>Choose a file to preview, or upload a PDF.</p>
                </div>
              ) : previewKind === "pdf" ? (
                <iframe
                  title={previewName}
                  src={previewUrl}
                  className="h-[min(70vh,640px)] w-full border-0 bg-white"
                />
              ) : previewKind === "image" ? (
                <div className="flex h-[min(70vh,640px)] items-center justify-center overflow-auto p-4">
                  <img src={previewUrl} alt={previewName} className="max-h-full max-w-full object-contain" />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
                  <p className="text-muted-foreground">Inline preview is not available for this file type.</p>
                  <Button size="sm" asChild>
                    <a href={previewUrl} download={previewName}>
                      Download file
                    </a>
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact header control that opens the related-files layover. */
export function BillAttachmentsButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="relative"
      onClick={onClick}
      aria-label={count ? `${count} attachments` : "Attachments"}
    >
      <Paperclip className="size-4" />
      {count > 0 ? (
        <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </Button>
  );
}
