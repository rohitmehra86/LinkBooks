import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  getLockPolicy,
  getOrganisationConfig,
  setLockPolicy,
  upsertOrganisationConfig,
} from "@/lib/settings/settings-centre.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Props = { companyId: string; canEdit: boolean; canLock: boolean };

export function SettingsAccountingLocksPanel({ companyId, canEdit, canLock }: Props) {
  const qc = useQueryClient();
  const fetchLock = useServerFn(getLockPolicy);
  const saveLock = useServerFn(setLockPolicy);
  const fetchCfg = useServerFn(getOrganisationConfig);
  const saveCfg = useServerFn(upsertOrganisationConfig);

  const lockQ = useQuery({
    queryKey: ["lock-policy", companyId],
    queryFn: () => fetchLock({ data: { companyId } }),
  });
  const cfgQ = useQuery({
    queryKey: ["organisation-config", companyId, "accounting"],
    queryFn: () => fetchCfg({ data: { companyId, category: "accounting" } }),
  });

  const [everyone, setEveryone] = useState("");
  const [advisors, setAdvisors] = useState("");
  const [conversion, setConversion] = useState("");
  const [reason, setReason] = useState("");
  const [warnDup, setWarnDup] = useState(true);
  const [warnControl, setWarnControl] = useState(true);
  const [warnBank, setWarnBank] = useState(true);
  const [backdated, setBackdated] = useState("90");
  const [autoCredits, setAutoCredits] = useState(false);
  const [basis, setBasis] = useState<"accrual" | "cash">("accrual");

  useEffect(() => {
    if (!lockQ.data) return;
    setEveryone(lockQ.data.lock_date_everyone ?? "");
    setAdvisors(lockQ.data.lock_date_except_advisors ?? "");
    setConversion(lockQ.data.conversion_date ?? "");
  }, [lockQ.data]);

  useEffect(() => {
    if (!cfgQ.data?.document) return;
    const d = cfgQ.data.document;
    setWarnDup(Boolean(d["warn_duplicate_document_numbers"] ?? true));
    setWarnControl(Boolean(d["warn_post_to_control_account"] ?? true));
    setWarnBank(Boolean(d["warn_bank_direct_posting"] ?? true));
    setBackdated(String(d["warn_backdated_days"] ?? 90));
    setAutoCredits(Boolean(d["auto_apply_credits"] ?? false));
    setBasis((d["reporting_basis"] as "accrual" | "cash") ?? "accrual");
  }, [cfgQ.data]);

  const lockMut = useMutation({
    mutationFn: () =>
      saveLock({
        data: {
          companyId,
          lockDateEveryone: everyone || null,
          lockDateExceptAdvisors: advisors || null,
          conversionDate: conversion || null,
          reason,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["lock-policy", companyId] });
      await qc.invalidateQueries({ queryKey: ["settings-overview", companyId] });
      toast.success("Lock policy saved");
      setReason("");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const cfgMut = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          companyId,
          category: "accounting",
          expectedVersion: cfgQ.data?.version ?? 0,
          document: {
            reporting_basis: basis,
            warn_duplicate_document_numbers: warnDup,
            warn_post_to_control_account: warnControl,
            warn_bank_direct_posting: warnBank,
            warn_backdated_days: Number(backdated) || 0,
            auto_apply_credits: autoCredits,
            account_code_padding: 0,
          },
          reason: "Accounting preferences updated",
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["organisation-config", companyId, "accounting"] });
      toast.success("Accounting preferences saved");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Two-tier lock dates</AlertTitle>
        <AlertDescription>
          Enforced in <code>post_journal</code> for every posting path (UI, API, import, AI). Period status
          locks on{" "}
          <Link to="/accounting" className="underline">
            Accounting → Periods
          </Link>{" "}
          still apply. Cash-basis is a reporting view only — it never rewrites posted journals.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lock dates & conversion</CardTitle>
          <CardDescription>
            Lock for everyone blocks all roles. Lock except advisers still allows owner, admin and
            accountant. Conversion / books-start blocks posting before that date.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid max-w-xl gap-3">
          {!canLock ? (
            <p className="text-sm text-muted-foreground">
              You need the periods.lock permission to change lock dates.
            </p>
          ) : null}
          <div className="space-y-1">
            <Label>Lock date for everyone</Label>
            <Input
              type="date"
              value={everyone}
              disabled={!canLock}
              onChange={(e) => setEveryone(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Lock date except advisers</Label>
            <Input
              type="date"
              value={advisors}
              disabled={!canLock}
              onChange={(e) => setAdvisors(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Conversion / books-start date</Label>
            <Input
              type="date"
              value={conversion}
              disabled={!canLock}
              onChange={(e) => setConversion(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Reason (required, audited)</Label>
            <Textarea
              value={reason}
              disabled={!canLock}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Month-end close March 2026"
            />
          </div>
          <Button
            disabled={!canLock || !reason.trim() || lockMut.isPending}
            onClick={() => lockMut.mutate()}
          >
            Save lock policy
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounting preferences</CardTitle>
          <CardDescription>Warnings and reporting defaults. Do not affect posted journals.</CardDescription>
        </CardHeader>
        <CardContent className="grid max-w-xl gap-3">
          <div className="flex items-center justify-between gap-3">
            <Label>Reporting basis (view)</Label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={basis}
              disabled={!canEdit}
              onChange={(e) => setBasis(e.target.value as "accrual" | "cash")}
            >
              <option value="accrual">Accrual</option>
              <option value="cash">Cash (reporting view)</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <Label>Warn on duplicate document numbers</Label>
            <Switch checked={warnDup} disabled={!canEdit} onCheckedChange={setWarnDup} />
          </div>
          <div className="flex items-center justify-between">
            <Label>Warn posting to control accounts</Label>
            <Switch checked={warnControl} disabled={!canEdit} onCheckedChange={setWarnControl} />
          </div>
          <div className="flex items-center justify-between">
            <Label>Warn bank-account direct posting</Label>
            <Switch checked={warnBank} disabled={!canEdit} onCheckedChange={setWarnBank} />
          </div>
          <div className="space-y-1">
            <Label>Warn back-dated entries beyond (days)</Label>
            <Input
              value={backdated}
              disabled={!canEdit}
              onChange={(e) => setBackdated(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label>Auto-apply credits / prepayments</Label>
            <Switch checked={autoCredits} disabled={!canEdit} onCheckedChange={setAutoCredits} />
          </div>
          <Button disabled={!canEdit || cfgMut.isPending} onClick={() => cfgMut.mutate()}>
            Save preferences
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
