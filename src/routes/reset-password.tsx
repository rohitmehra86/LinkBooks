import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { friendlyAuthError, validatePassword } from "@/lib/auth-helpers";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Choose a new password — LinkBooks" },
      {
        name: "description",
        content: "Set a new password for your LinkBooks account using your secure reset link.",
      },
      { property: "og:title", content: "Choose a new password — LinkBooks" },
      {
        property: "og:description",
        content: "Set a new password for your LinkBooks account using your secure reset link.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Supabase puts a recovery session in the URL hash; the client picks it up.
  useEffect(() => {
    let active = true;
    const hash = window.location.hash ?? "";
    const isRecovery = hash.includes("type=recovery");
    const hashError = hash.includes("error=");

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setStatus("ready");
    });

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (hashError) setStatus("invalid");
      else if (data.session || isRecovery) setStatus("ready");
      else setStatus("invalid");
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const next: Record<string, string> = {};
    const passwordError = validatePassword(password);
    if (passwordError) next["password"] = passwordError;
    if (confirm !== password) next["confirm"] = "Passwords do not match.";
    setFieldErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (error) {
      setFormError(friendlyAuthError(error));
      return;
    }
    setDone(true);
    setTimeout(() => navigate({ to: "/", replace: true }), 1200);
  }

  if (status === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Checking your reset link</span>
      </div>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle={
        status === "invalid"
          ? undefined
          : "Pick something you haven't used elsewhere. You'll stay signed in afterwards."
      }
      footer={
        <Link to="/auth" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      {status === "invalid" ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            This reset link is invalid or has expired. Request a new one from the{" "}
            <Link to="/forgot-password" className="font-medium underline">
              forgot password
            </Link>{" "}
            page.
          </AlertDescription>
        </Alert>
      ) : done ? (
        <Alert role="status">
          <AlertDescription>Password updated. Taking you to LinkBooks…</AlertDescription>
        </Alert>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {formError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(fieldErrors["password"])}
            />
            <p className="text-xs text-muted-foreground">
              At least 8 characters, including a letter and a number.
            </p>
            {fieldErrors["password"] ? (
              <p role="alert" className="text-xs text-destructive">
                {fieldErrors["password"]}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={Boolean(fieldErrors["confirm"])}
            />
            {fieldErrors["confirm"] ? (
              <p role="alert" className="text-xs text-destructive">
                {fieldErrors["confirm"]}
              </p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {busy ? "Updating…" : "Update password"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
