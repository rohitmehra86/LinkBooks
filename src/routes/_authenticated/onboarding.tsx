import { useMemo, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { companyContextKey } from "@/hooks/use-active-company";
import { createCompany, openDemoCompany, setActiveCompany } from "@/lib/company.functions";
import {
  countries,
  currencies,
  months,
  timezones,
} from "@/lib/company-constants";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/common/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "Create organisation — LinkBooks" },
      {
        name: "description",
        content: "Create your LinkBooks organisation or open the Demo Company.",
      },
    ],
  }),
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useServerFn(createCompany);
  const openDemo = useServerFn(openDemoCompany);
  const switchCompany = useServerFn(setActiveCompany);

  const defaultCountry = countries[1]!; // GB
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [countryCode, setCountryCode] = useState<string>(defaultCountry.code);
  const [currency, setCurrency] = useState<string>(defaultCountry.currency);
  const [timezone, setTimezone] = useState<string>(defaultCountry.timezone);
  const [fyMonth, setFyMonth] = useState(String(defaultCountry.fyMonth));
  const [fyDay, setFyDay] = useState(String(defaultCountry.fyDay));
  const [formError, setFormError] = useState<string | null>(null);

  const maxDay = useMemo(() => new Date(2023, Number(fyMonth), 0).getDate(), [fyMonth]);

  async function afterCompany(id: string, message: string) {
    await switchCompany({ data: { companyId: id } });
    await queryClient.cancelQueries();
    queryClient.clear();
    await queryClient.invalidateQueries({ queryKey: companyContextKey });
    await router.invalidate();
    toast.success(message);
    navigate({ to: "/", replace: true });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      create({
        data: {
          name,
          legal_name: legalName,
          country_code: countryCode,
          base_currency: currency,
          fiscal_year_end_month: Number(fyMonth),
          fiscal_year_end_day: Number(fyDay),
          timezone,
        },
      }),
    onSuccess: (result) => afterCompany(result.id, "Organisation created"),
    onError: (error) => {
      const message = friendlyAuthError(error);
      setFormError(message);
      toast.error(message);
    },
  });

  const demoMutation = useMutation({
    mutationFn: () => openDemo(),
    onSuccess: (result) => afterCompany(result.id, "Demo Company ready"),
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  const busy = createMutation.isPending || demoMutation.isPending;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Set up your organisation"
        description="Create a real company to keep your books, or explore Demo Company with the same engine and sample data."
      />

      <Alert>
        <AlertTitle>Multi-company ready</AlertTitle>
        <AlertDescription>
          Access is enforced by membership and database row-level security. You will only see
          organisations you belong to.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create organisation</CardTitle>
          <CardDescription>Owners can invite team members from Settings after creation.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="co-name">Organisation name</Label>
            <Input
              id="co-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Northgate Consulting"
              disabled={busy}
              autoComplete="organization"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="co-legal">Legal name (optional)</Label>
            <Input
              id="co-legal"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Country</Label>
              <Select
                value={countryCode}
                disabled={busy}
                onValueChange={(code) => {
                  setCountryCode(code);
                  const match = countries.find((c) => c.code === code);
                  if (match) {
                    setCurrency(match.currency);
                    setTimezone(match.timezone);
                    setFyMonth(String(match.fyMonth));
                    setFyDay(String(match.fyDay));
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {countries.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Base currency</Label>
              <Select value={currency} disabled={busy} onValueChange={setCurrency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Financial year end month</Label>
              <Select value={fyMonth} disabled={busy} onValueChange={setFyMonth}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {months.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fy-day">Financial year end day</Label>
              <Input
                id="fy-day"
                type="number"
                min={1}
                max={maxDay}
                value={fyDay}
                disabled={busy}
                onChange={(e) => setFyDay(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Time zone</Label>
              <Select value={timezone} disabled={busy} onValueChange={setTimezone}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezones.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              size="sm"
              disabled={busy || name.trim().length < 2}
              onClick={() => {
                setFormError(null);
                createMutation.mutate();
              }}
            >
              {createMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create organisation
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => demoMutation.mutate()}
            >
              {demoMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Explore Demo Company
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
