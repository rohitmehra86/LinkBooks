import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getBankIntegrity } from "@/lib/banking/bank-ops.functions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Honest startup check of bank data. Shows nothing when everything adds up, and says so plainly when the
 * database function is not installed (it never pretends the data was checked).
 */
export function BankIntegrityBanner() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const check = useServerFn(getBankIntegrity);
  const query = useQuery({
    queryKey: ["bank-integrity", companyId],
    enabled: Boolean(companyId),
    queryFn: () => check({ data: { companyId: companyId! } }),
    staleTime: 60_000,
  });

  if (!companyId || query.isPending) return null;
  if (query.isError) {
    return (
      <Alert className="mb-4">
        <AlertTitle>Bank data check could not run</AlertTitle>
        <AlertDescription>Try reloading the page.</AlertDescription>
      </Alert>
    );
  }
  if (!query.data.available) {
    return (
      <Alert className="mb-4">
        <AlertTitle>Bank data check unavailable</AlertTitle>
        <AlertDescription>
          The integrity check needs a database update that has not been applied yet.
        </AlertDescription>
      </Alert>
    );
  }
  if (query.data.findings.length === 0) return null;
  return (
    <Alert variant="destructive" className="mb-4" role="alert">
      <AlertTitle>Bank data needs attention</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-5">
          {query.data.findings.map((f) => (
            <li key={f.code}>
              {f.count} — {f.message}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs">
          These lines were not produced by the posting engine or lost their link. Review them in{" "}
          <Link to="/banking/transactions" className="underline">
            Transactions
          </Link>{" "}
          and re-code or unmatch them. Nothing was changed automatically.
        </p>
      </AlertDescription>
    </Alert>
  );
}
