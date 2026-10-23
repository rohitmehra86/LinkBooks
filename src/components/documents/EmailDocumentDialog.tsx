import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Mail, Send } from "lucide-react";
import { toast } from "sonner";
import { sendDocumentEmail } from "@/lib/documents/documents.functions";
import { parseRecipients, type EmailTemplate } from "@/lib/documents/email-templates";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildMailto } from "@/lib/documents/email-templates";
import { EMAIL_NOT_CONFIGURED_TEXT, TEMPLATE_LABEL } from "@/lib/documents/ui";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  kind: string;
  id: string;
  title: string;
  templates: EmailTemplate[];
  defaultTemplate: EmailTemplate;
  defaultTo: string;
  emailConfigured: boolean;
  blockedReason: null | "demo";
  canSend: boolean;
  /** Subject and plain-text body for the "open in my email program" fallback. */
  preview: (template: EmailTemplate, message: string) => { subject: string; body: string };
  /** Extra fields passed through to the server (statement date range). */
  extra?: { from?: string; toDate?: string };
  onSent?: () => void;
};

export function EmailDocumentDialog(props: Props) {
  const send = useServerFn(sendDocumentEmail);
  const [template, setTemplate] = useState<EmailTemplate>(props.defaultTemplate);
  const [to, setTo] = useState(props.defaultTo);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.open) {
      setTemplate(props.defaultTemplate);
      setTo(props.defaultTo);
      setMessage("");
      setError(null);
    }
  }, [props.open, props.defaultTemplate, props.defaultTo]);

  const recipients = parseRecipients(to);
  const toError =
    to.trim() === ""
      ? null
      : recipients.invalid.length
        ? `Invalid email address: ${recipients.invalid.join(", ")}`
        : recipients.valid.length > 5
          ? "Send to at most 5 recipients at a time."
          : null;
  const readyToSend = recipients.valid.length > 0 && !toError;

  const mutation = useMutation({
    mutationFn: () =>
      send({
        data: {
          companyId: props.companyId,
          kind: props.kind,
          id: props.id,
          template,
          to,
          ...(message.trim() ? { message } : {}),
          ...(props.extra?.from ? { from: props.extra.from } : {}),
          ...(props.extra?.toDate ? { toDate: props.extra.toDate } : {}),
        },
      }),
    onSuccess: (r) => {
      if (r.sent) {
        toast.success("Email sent");
        if (r.recordWarning) toast.warning(r.recordWarning);
        props.onOpenChange(false);
        props.onSent?.();
      } else {
        setError(r.message);
      }
    },
    onError: (e) => setError(friendlyAuthError(e)),
  });

  const mailto = readyToSend
    ? (() => {
        const p = props.preview(template, message);
        return buildMailto({ to: recipients.valid.join(","), subject: p.subject, body: p.body });
      })()
    : null;

  const sendingDisabledReason = !props.emailConfigured
    ? EMAIL_NOT_CONFIGURED_TEXT
    : props.blockedReason === "demo"
      ? "Email sending is switched off in the Demo Company so sample customers are never emailed."
      : !props.canSend
        ? "You do not have permission to send this document."
        : null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            The email contains a summary
            {props.templates.includes("invoice") ? " and an online link to the invoice" : ""}. It
            does not attach a PDF.
          </DialogDescription>
        </DialogHeader>

        {sendingDisabledReason ? (
          <Alert>
            <AlertTitle>Sending from LinkBooks is unavailable</AlertTitle>
            <AlertDescription>{sendingDisabledReason}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-3">
          {props.templates.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="email-template">Template</Label>
              <Select value={template} onValueChange={(v) => setTemplate(v as EmailTemplate)}>
                <SelectTrigger id="email-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.templates.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TEMPLATE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="email-to">To</Label>
            <Input
              id="email-to"
              value={to}
              placeholder="name@example.com, second@example.com"
              onChange={(e) => setTo(e.target.value)}
            />
            {toError ? <p className="text-xs text-destructive">{toError}</p> : null}
            {!to.trim() ? (
              <p className="text-xs text-muted-foreground">
                Enter at least one email address (up to 5, separated by commas).
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="email-message">Personal note (optional)</Label>
            <Textarea
              id="email-message"
              rows={3}
              maxLength={1500}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {mailto ? (
            <Button variant="outline" asChild>
              <a href={mailto}>
                <Mail className="mr-1 size-4" /> Open in my email program
              </a>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              <Mail className="mr-1 size-4" /> Open in my email program
            </Button>
          )}
          <Button
            disabled={Boolean(sendingDisabledReason) || !readyToSend || mutation.isPending}
            onClick={() => {
              setError(null);
              mutation.mutate();
            }}
          >
            {mutation.isPending ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Send className="mr-1 size-4" />
            )}
            Send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
