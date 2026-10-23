import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { friendlyAuthError, validateEmail } from "@/lib/auth-helpers";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Reset your password — LinkBooks" },
      {
        name: "description",
        content: "Request a secure link to reset the password on your LinkBooks account.",
      },
      { property: "og:title", content: "Reset your password — LinkBooks" },
      {
        property: "og:description",
        content: "Request a secure link to reset the password on your LinkBooks account.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const error = validateEmail(email);
    setFieldError(error);
    if (error) return;

    setBusy(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);

    if (resetError) {
      setFormError(friendlyAuthError(resetError));
      return;
    }
    setSent(true);
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a secure link to choose a new password."
      footer={
        <Link to="/auth" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <Alert role="status">
          <AlertDescription>
            If an account exists for {email.trim()}, a reset link is on its way. The link expires
            after a short time for your security.
          </AlertDescription>
        </Alert>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {formError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="reset-email">Email</Label>
            <Input
              id="reset-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(fieldError)}
              placeholder="you@company.com"
            />
            {fieldError ? (
              <p role="alert" className="text-xs text-destructive">
                {fieldError}
              </p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
