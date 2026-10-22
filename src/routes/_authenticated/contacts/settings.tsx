import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  getContactSettings,
  saveContactSettings,
  listContactGroups,
  upsertContactGroup,
  listContactTags,
  upsertContactTag,
} from "@/lib/contacts/contacts.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/contacts/settings")({
  head: () => ({ meta: [{ title: "Contact settings — LinkBooks" }] }),
  component: ContactSettingsPage,
});

function ContactSettingsPage() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const qc = useQueryClient();
  const fetchSettings = useServerFn(getContactSettings);
  const saveSettings = useServerFn(saveContactSettings);
  const fetchGroups = useServerFn(listContactGroups);
  const saveGroup = useServerFn(upsertContactGroup);
  const fetchTags = useServerFn(listContactTags);
  const saveTag = useServerFn(upsertContactTag);

  const settingsQ = useQuery({
    queryKey: ["contact-settings", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchSettings({ data: { companyId: companyId! } }),
  });
  const groupsQ = useQuery({
    queryKey: ["contact-groups", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchGroups({ data: { companyId: companyId! } }),
  });
  const tagsQ = useQuery({
    queryKey: ["contact-tags", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchTags({ data: { companyId: companyId! } }),
  });

  const [defaultKind, setDefaultKind] = useState("customer");
  const [prefix, setPrefix] = useState("C");
  const [nextNum, setNextNum] = useState("1001");
  const [terms, setTerms] = useState("30");
  const [groupName, setGroupName] = useState("");
  const [tagName, setTagName] = useState("");

  useEffect(() => {
    const s = settingsQ.data as {
      default_kind?: unknown;
      account_number_prefix?: unknown;
      next_account_number?: unknown;
      default_payment_terms_days?: unknown;
    } | undefined;
    if (!s) return;
    setDefaultKind(String(s.default_kind ?? "customer"));
    setPrefix(String(s.account_number_prefix ?? "C"));
    setNextNum(String(s.next_account_number ?? 1001));
    setTerms(String(s.default_payment_terms_days ?? 30));
  }, [settingsQ.data]);

  const saveM = useMutation({
    mutationFn: () =>
      saveSettings({
        data: {
          companyId: companyId!,
          defaultKind,
          accountNumberPrefix: prefix,
          nextAccountNumber: Number(nextNum) || 1001,
          defaultPaymentTermsDays: Number(terms) || 30,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["contact-settings", companyId] });
      toast.success("Settings saved — existing account numbers are not renumbered");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  if (settingsQ.isPending) return <LoadingState />;
  if (settingsQ.isError) {
    return <ErrorState title="Could not load settings" description={friendlyAuthError(settingsQ.error)} />;
  }

  return (
    <>
      <PageHeader
        title="Contact settings"
        description="Numbering, defaults, groups and tags for this organisation."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/contacts">Back to directory</Link>
          </Button>
        }
      />

      <section className="mb-8 max-w-lg space-y-3 rounded-md border p-4">
        <h2 className="text-sm font-medium">General</h2>
        <div className="space-y-1">
          <Label>Default role for new contacts</Label>
          <Select value={defaultKind} onValueChange={setDefaultKind}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="customer">Customer</SelectItem>
              <SelectItem value="supplier">Supplier</SelectItem>
              <SelectItem value="both">Customer & supplier</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Account number prefix</Label>
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Next account number</Label>
            <Input value={nextNum} onChange={(e) => setNextNum(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Default payment terms (days)</Label>
          <Input value={terms} onChange={(e) => setTerms(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Changing the next number only affects new contacts. Posted documents keep their historical
          contact snapshots and amounts.
        </p>
        <Button disabled={saveM.isPending} onClick={() => saveM.mutate()}>
          Save settings
        </Button>
      </section>

      <section className="mb-8 max-w-lg space-y-3 rounded-md border p-4">
        <h2 className="text-sm font-medium">Groups</h2>
        <div className="flex gap-2">
          <Input
            placeholder="New group name"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!groupName.trim()}
            onClick={async () => {
              try {
                await saveGroup({ data: { companyId: companyId!, name: groupName } });
                setGroupName("");
                await qc.invalidateQueries({ queryKey: ["contact-groups", companyId] });
                toast.success("Group created");
              } catch (e) {
                toast.error(friendlyAuthError(e));
              }
            }}
          >
            Add
          </Button>
        </div>
        <ul className="text-sm">
          {((groupsQ.data ?? []) as Array<{ id: string; name: string; is_active: boolean }>).map(
            (g) => (
              <li key={g.id} className="border-b py-1">
                {g.name}
                {!g.is_active ? " (inactive)" : ""}
              </li>
            ),
          )}
        </ul>
      </section>

      <section className="max-w-lg space-y-3 rounded-md border p-4">
        <h2 className="text-sm font-medium">Tags</h2>
        <div className="flex gap-2">
          <Input
            placeholder="New tag"
            value={tagName}
            onChange={(e) => setTagName(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!tagName.trim()}
            onClick={async () => {
              try {
                await saveTag({ data: { companyId: companyId!, name: tagName } });
                setTagName("");
                await qc.invalidateQueries({ queryKey: ["contact-tags", companyId] });
                toast.success("Tag created");
              } catch (e) {
                toast.error(friendlyAuthError(e));
              }
            }}
          >
            Add
          </Button>
        </div>
        <ul className="flex flex-wrap gap-2 text-sm">
          {((tagsQ.data ?? []) as Array<{ id: string; name: string }>).map((t) => (
            <li key={t.id} className="rounded-full border px-2 py-0.5">
              {t.name}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
