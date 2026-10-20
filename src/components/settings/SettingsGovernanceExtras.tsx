import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  getWorkflowSettings,
  upsertWorkflowSettings,
} from "@/lib/settings/workflow-settings.functions";
import {
  createCompanyInvitation,
  listCompanyInvitations,
  revokeCompanyInvitation,
} from "@/lib/settings/org-settings.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import type { CompanyRole } from "@/lib/company-constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

type Props = { companyId: string; canEdit: boolean };

export function SettingsAutomationPanel({ companyId, canEdit }: Props) {
  const qc = useQueryClient();
  const fetch = useServerFn(getWorkflowSettings);
  const save = useServerFn(upsertWorkflowSettings);
  const q = useQuery({
    queryKey: ["workflow-settings", companyId],
    queryFn: () => fetch({ data: { companyId } }),
  });

  const [salesTerms, setSalesTerms] = useState("30");
  const [purchTerms, setPurchTerms] = useState("30");
  const [requirePo, setRequirePo] = useState(false);
  const [requireMemo, setRequireMemo] = useState(false);
  const [csvFmt, setCsvFmt] = useState("YYYY-MM-DD");

  useEffect(() => {
    if (!q.data) return;
    setSalesTerms(String(q.data.sales_default_payment_terms_days));
    setPurchTerms(String(q.data.purchases_default_payment_terms_days));
    setRequirePo(q.data.purchases_require_po);
    setRequireMemo(q.data.accounting_require_journal_memo);
    setCsvFmt(q.data.banking_csv_date_format);
  }, [q.data]);

  const saveM = useMutation({
    mutationFn: () =>
      save({
        data: {
          companyId,
          salesDefaultPaymentTermsDays: Number(salesTerms) || 30,
          purchasesDefaultPaymentTermsDays: Number(purchTerms) || 30,
          purchasesRequirePo: requirePo,
          accountingRequireJournalMemo: requireMemo,
          bankingCsvDateFormat: csvFmt,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["workflow-settings", companyId] });
      toast.success("Automation defaults saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Automation & defaults</CardTitle>
        <CardDescription>
          Organisation-wide workflow defaults. Sales and Purchases module settings remain authoritative
          for document-specific preferences —{" "}
          <Link to="/sales/settings" className="underline">
            Sales settings
          </Link>
          ,{" "}
          <Link to="/purchases/settings" className="underline">
            Purchases settings
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="grid max-w-xl gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Default sales payment terms (days)</Label>
            <Input value={salesTerms} disabled={!canEdit} onChange={(e) => setSalesTerms(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Default purchase payment terms (days)</Label>
            <Input value={purchTerms} disabled={!canEdit} onChange={(e) => setPurchTerms(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Banking CSV date format</Label>
          <Select value={csvFmt} onValueChange={setCsvFmt} disabled={!canEdit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
              <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
              <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Require purchase order reference on bills</span>
          <Switch checked={requirePo} disabled={!canEdit} onCheckedChange={setRequirePo} />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Require memo on manual journals</span>
          <Switch checked={requireMemo} disabled={!canEdit} onCheckedChange={setRequireMemo} />
        </label>
        <p className="text-xs text-muted-foreground">
          Journal memo requirement is enforced server-side when posting manual journals.
        </p>
        <Button size="sm" disabled={!canEdit || saveM.isPending} onClick={() => saveM.mutate()}>
          Save automation defaults
        </Button>
      </CardContent>
    </Card>
  );
}

export function SettingsIntegrationsPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Integrations</CardTitle>
        <CardDescription>Connection status for external services used by this organisation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <IntegrationRow
          name="Outbound email (invitations & statements)"
          status="Not configured"
          detail="No email provider credentials are configured. Invitation rows can be created and shared manually; statements are not emailed."
        />
        <IntegrationRow
          name="Live FX rate feed"
          status="Not connected"
          detail="Exchange rates are recorded manually (append-only). Posted journals keep their historical fx_rate_to_base snapshot."
        />
        <IntegrationRow
          name="Bank open banking / feed aggregator"
          status="Module-local"
          detail="Bank feeds are managed under Banking. A disconnected feed never appears as connected from Settings."
        />
        <IntegrationRow
          name="Address autocomplete"
          status="Not configured"
          detail="Manual address entry remains available on contacts and documents."
        />
      </CardContent>
    </Card>
  );
}

function IntegrationRow({
  name,
  status,
  detail,
}: {
  name: string;
  status: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-medium">{name}</span>
        <Badge variant="secondary">{status}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function SettingsInvitationsPanel({ companyId, canEdit }: Props) {
  const qc = useQueryClient();
  const fetch = useServerFn(listCompanyInvitations);
  const create = useServerFn(createCompanyInvitation);
  const revoke = useServerFn(revokeCompanyInvitation);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CompanyRole>("staff");
  const [lastToken, setLastToken] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["company-invitations", companyId],
    enabled: canEdit,
    queryFn: () => fetch({ data: { companyId } }),
  });

  if (!canEdit) {
    return (
      <Alert>
        <AlertTitle>Members</AlertTitle>
        <AlertDescription>You need members.manage to invite users.</AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invitations</CardTitle>
        <CardDescription>
          Invitations are stored with expiry and role. Outbound email is not configured — tokens are
          shown once for manual sharing. Statuses are truthful (pending / expired / accepted).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>Email delivery unavailable</AlertTitle>
          <AlertDescription>
            LinkBooks will not claim an invitation was emailed until a real provider is connected.
          </AlertDescription>
        </Alert>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input
            placeholder="colleague@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Select value={role} onValueChange={(v) => setRole(v as CompanyRole)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="accountant">Accountant</SelectItem>
              <SelectItem value="bookkeeper">Bookkeeper</SelectItem>
              <SelectItem value="staff">Staff</SelectItem>
              <SelectItem value="read_only">Read only</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!email.trim()}
            onClick={async () => {
              try {
                const res = await create({ data: { companyId, email, role } });
                setLastToken(res.inviteToken);
                setEmail("");
                await qc.invalidateQueries({ queryKey: ["company-invitations", companyId] });
                toast.message(res.message);
              } catch (e) {
                toast.error(friendlyAuthError(e));
              }
            }}
          >
            Create invitation
          </Button>
        </div>
        {lastToken ? (
          <p className="break-all rounded-md border bg-muted/40 p-2 text-xs">
            One-time invite token (copy now): <code>{lastToken}</code>
          </p>
        ) : null}
        <ul className="space-y-2 text-sm">
          {((q.data ?? []) as Array<{ id: string; email: string; role: string; status: string }>).map(
            (inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-2 border-b py-1">
                <span>
                  {inv.email} · {inv.role}{" "}
                  <Badge variant="outline">{inv.status}</Badge>
                </span>
                {inv.status === "pending" || inv.status === "expired" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await revoke({ data: { companyId, invitationId: inv.id } });
                        await qc.invalidateQueries({ queryKey: ["company-invitations", companyId] });
                        toast.success("Invitation revoked");
                      } catch (e) {
                        toast.error(friendlyAuthError(e));
                      }
                    }}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ),
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
