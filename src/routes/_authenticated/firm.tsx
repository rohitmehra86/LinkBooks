import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useActiveCompany } from "@/hooks/use-active-company";
import {
  createFirm,
  linkFirmClient,
  listFirmClientActivity,
  listFirmClients,
  listMyFirms,
  revokeFirmClient,
} from "@/lib/firm/firm.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/firm")({
  head: () => ({ meta: [{ title: "Firm — LinkBooks" }] }),
  component: FirmPage,
});

function FirmPage() {
  const { company } = useActiveCompany();
  const qc = useQueryClient();
  const fetchFirms = useServerFn(listMyFirms);
  const doCreate = useServerFn(createFirm);
  const fetchClients = useServerFn(listFirmClients);
  const doLink = useServerFn(linkFirmClient);
  const doRevoke = useServerFn(revokeFirmClient);

  const [firmName, setFirmName] = useState("");
  const [selectedFirmId, setSelectedFirmId] = useState("");
  const [accessLevel, setAccessLevel] = useState("view");
  const [activityCompanyId, setActivityCompanyId] = useState("");
  const fetchActivity = useServerFn(listFirmClientActivity);

  const firmsQ = useQuery({
    queryKey: ["my-firms"],
    queryFn: () => fetchFirms(),
  });

  const firmId = selectedFirmId || firmsQ.data?.[0]?.firmId || "";

  const clientsQ = useQuery({
    queryKey: ["firm-clients", firmId],
    enabled: Boolean(firmId),
    queryFn: () => fetchClients({ data: { firmId } }),
  });

  const activityCompany =
    activityCompanyId || clientsQ.data?.[0]?.company_id || "";

  const activityQ = useQuery({
    queryKey: ["firm-client-activity", firmId, activityCompany],
    enabled: Boolean(firmId && activityCompany),
    queryFn: () =>
      fetchActivity({ data: { firmId, companyId: activityCompany } }),
  });

  const createM = useMutation({
    mutationFn: () => doCreate({ data: { name: firmName } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["my-firms"] });
      setSelectedFirmId(r.id);
      setFirmName("");
      toast.success("Firm created");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const linkM = useMutation({
    mutationFn: () => {
      if (!company?.id) throw new Error("Select a company to link as client");
      if (!firmId) throw new Error("Select a firm");
      return doLink({ data: { firmId, companyId: company.id, accessLevel } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-clients", firmId] });
      toast.success("Client linked — firm members receive company membership");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  const revokeM = useMutation({
    mutationFn: (companyId: string) => doRevoke({ data: { firmId, companyId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["firm-clients", firmId] });
      toast.success("Client access revoked");
    },
    onError: (e) => toast.error(friendlyAuthError(e)),
  });

  return (
    <>
      <PageHeader
        title="Firm & clients"
        description="Practice management: link organisations you administer so firm members can switch into client books."
      />
      <Alert className="mb-6">
        <AlertDescription>
          Linking requires you to be owner/admin of the active organisation. Revoking removes firm-granted memberships
          (read_only / bookkeeper / accountant). Owner memberships are not deleted by revoke.
        </AlertDescription>
      </Alert>

      <div className="mb-8 grid max-w-lg gap-3 rounded-md border p-4">
        <Label>Create firm</Label>
        <Input placeholder="Firm name" value={firmName} onChange={(e) => setFirmName(e.target.value)} />
        <Button size="sm" disabled={createM.isPending || firmName.trim().length < 2} onClick={() => createM.mutate()}>
          Create
        </Button>
      </div>

      {firmsQ.isPending ? <LoadingState /> : firmsQ.isError ? (
        <ErrorState title="Could not load firms" description={friendlyAuthError(firmsQ.error)} />
      ) : (firmsQ.data ?? []).length === 0 ? (
        <EmptyState title="No firms yet" description="Create a firm to manage client organisations." />
      ) : (
        <>
          <div className="mb-4 max-w-sm space-y-1">
            <Label>Active firm</Label>
            <Select value={firmId} onValueChange={setSelectedFirmId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {firmsQ.data!.map((f) => (
                  <SelectItem key={f.firmId} value={f.firmId}>{f.name} ({f.role})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mb-6 grid max-w-lg gap-3 rounded-md border p-4">
            <Label>Link active organisation as client</Label>
            <p className="text-sm text-muted-foreground">
              Active org: <strong>{company?.name ?? "none selected"}</strong>
            </p>
            <Select value={accessLevel} onValueChange={setAccessLevel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="view">View (read_only)</SelectItem>
                <SelectItem value="bookkeep">Bookkeep</SelectItem>
                <SelectItem value="full">Full (accountant)</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" disabled={linkM.isPending || !company?.id} onClick={() => linkM.mutate()}>
              Link client
            </Button>
          </div>

          {clientsQ.isPending ? <LoadingState /> : clientsQ.isError ? (
            <ErrorState title="Could not load clients" description={friendlyAuthError(clientsQ.error)} />
          ) : (clientsQ.data ?? []).length === 0 ? (
            <EmptyState title="No linked clients" description="Link an organisation you administer." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clientsQ.data!.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.companies?.name ?? c.company_id.slice(0, 8)}</TableCell>
                    <TableCell><Badge variant="secondary">{c.access_level}</Badge></TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" disabled={revokeM.isPending}
                        onClick={() => revokeM.mutate(c.company_id)}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            Switch into a client via the company switcher once membership is granted. Multi-org users
            always see the active organisation name in the header.{" "}
            <Link className="underline" to="/accountant">
              Accountant checklist
            </Link>
          </p>

          {(clientsQ.data ?? []).length > 0 ? (
            <div className="mt-8 space-y-3">
              <Label>Client activity history</Label>
              <Select value={activityCompany} onValueChange={setActivityCompanyId}>
                <SelectTrigger className="max-w-sm">
                  <SelectValue placeholder="Select client" />
                </SelectTrigger>
                <SelectContent>
                  {clientsQ.data!.map((c) => (
                    <SelectItem key={c.company_id} value={c.company_id}>
                      {c.companies?.name ?? c.company_id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activityQ.isPending ? (
                <LoadingState rows={3} />
              ) : activityQ.isError ? (
                <ErrorState
                  title="Could not load activity"
                  description={friendlyAuthError(activityQ.error)}
                />
              ) : (activityQ.data ?? []).length === 0 ? (
                <EmptyState title="No audit events yet" description="Actions on this client will appear here." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Entity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activityQ.data!.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="text-xs whitespace-nowrap">
                          {new Date(a.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell>{a.action}</TableCell>
                        <TableCell className="text-xs">{a.entity_type}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
