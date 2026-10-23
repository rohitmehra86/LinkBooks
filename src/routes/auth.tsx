import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  friendlyAuthError,
  safeRedirect,
  validateEmail,
  validatePassword,
  type FieldErrors,
} from "@/lib/auth-helpers";

export const Route = createFileRoute("/auth")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string | undefined; mode?: "signin" | "signup" | undefined } => ({
    redirect: typeof search["redirect"] === "string" ? (search["redirect"] as string) : undefined,
    mode: search["mode"] === "signup" ? "signup" : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — LinkBooks" },
      {
        name: "description",
        content: "Sign in to LinkBooks or create an account to manage your books securely.",
      },
      { property: "og:title", content: "Sign in — LinkBooks" },
      {
        property: "og:description",
        content: "Sign in to LinkBooks or create an account to manage your books securely.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const destination = safeRedirect(search.redirect);

  const [tab, setTab] = useState<"signin" | "signup">(search.mode ?? "signin");
  const [checking, setChecking] = useState(true);

  // Already signed in? Don't show the form.
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) {
        navigate({ to: destination, replace: true });
      } else {
        setChecking(false);
      }
    });
    return () => {
      active = false;
    };
  }, [destination, navigate]);

  if (checking) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Checking your session</span>
      </div>
    );
  }

  const afterAuth = async () => {
    await router.invalidate();
    navigate({ to: destination, replace: true });
  };

  return (
    <AuthLayout
      title={tab === "signin" ? "Sign in to LinkBooks" : "Create your LinkBooks account"}
      subtitle={
        tab === "signin"
          ? "Enter your details to access your books."
          : "It takes less than a minute to get started."
      }
      footer={
        <p className="text-xs leading-relaxed text-muted-foreground">
          LinkBooks is in active development. Your account is stored securely and your organisation
          data is kept separate from everyone else&apos;s.
        </p>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as "signin" | "signup")}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="signin">Sign in</TabsTrigger>
          <TabsTrigger value="signup">Create account</TabsTrigger>
        </TabsList>

        <TabsContent value="signin" className="mt-6">
          <SignInForm onSuccess={afterAuth} redirect={search.redirect} />
        </TabsContent>
        <TabsContent value="signup" className="mt-6">
          <SignUpForm onSuccess={afterAuth} />
        </TabsContent>
      </Tabs>
    </AuthLayout>
  );
}

function SignInForm({
  onSuccess,
  redirect,
}: {
  onSuccess: () => void | Promise<void>;
  redirect?: string | undefined;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const next: FieldErrors = {};
    const emailError = validateEmail(email);
    if (emailError) next["email"] = emailError;
    if (!password) next["password"] = "Password is required.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);

    if (error) {
      setFormError(friendlyAuthError(error));
      return;
    }
    await onSuccess();
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(errors["email"])}
          placeholder="you@company.com"
        />
        {errors["email"] ? (
          <p role="alert" className="text-xs text-destructive">
            {errors["email"]}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="signin-password">Password</Label>
          <Link to="/forgot-password" className="text-xs font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </div>
        <Input
          id="signin-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(errors["password"])}
        />
        {errors["password"] ? (
          <p role="alert" className="text-xs text-destructive">
            {errors["password"]}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {busy ? "Signing in…" : "Sign in"}
      </Button>

      {redirect ? (
        <p className="text-center text-xs text-muted-foreground">
          You&apos;ll be returned to the page you requested.
        </p>
      ) : null}
    </form>
  );
}

function SignUpForm({ onSuccess }: { onSuccess: () => void | Promise<void> }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setNotice(null);

    const next: FieldErrors = {};
    if (fullName.trim().length < 2) next["fullName"] = "Please enter your full name.";
    const emailError = validateEmail(email);
    if (emailError) next["email"] = emailError;
    const passwordError = validatePassword(password);
    if (passwordError) next["password"] = passwordError;
    if (confirm !== password) next["confirm"] = "Passwords do not match.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        data: { full_name: fullName.trim() },
      },
    });
    setBusy(false);

    if (error) {
      setFormError(friendlyAuthError(error));
      return;
    }

    if (!data.session) {
      setNotice("Account created. Check your email to confirm it, then sign in.");
      return;
    }
    await onSuccess();
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="signup-name">Full name</Label>
        <Input
          id="signup-name"
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          aria-invalid={Boolean(errors["fullName"])}
          placeholder="Alex Morgan"
        />
        {errors["fullName"] ? (
          <p role="alert" className="text-xs text-destructive">
            {errors["fullName"]}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-email">Work email</Label>
        <Input
          id="signup-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(errors["email"])}
          placeholder="you@company.com"
        />
        {errors["email"] ? (
          <p role="alert" className="text-xs text-destructive">
            {errors["email"]}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-password">Password</Label>
        <Input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(errors["password"])}
        />
        <p className="text-xs text-muted-foreground">
          At least 8 characters, including a letter and a number.
        </p>
        {errors["password"] ? (
          <p role="alert" className="text-xs text-destructive">
            {errors["password"]}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signup-confirm">Confirm password</Label>
        <Input
          id="signup-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={Boolean(errors["confirm"])}
        />
        {errors["confirm"] ? (
          <p role="alert" className="text-xs text-destructive">
            {errors["confirm"]}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {busy ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
