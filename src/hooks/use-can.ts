import { permissionsForRole, type Permission } from "@/lib/permissions";
import { useActiveCompany } from "@/hooks/use-active-company";

/**
 * UI permission hint based on the active company's role (P-26).
 * This only decides whether to show or enable a control. The server functions and
 * row-level security remain the real enforcement, so a missing permission here
 * must never be the only protection for an action.
 *
 * While the company is still loading everything is reported as not allowed so a
 * button is never briefly offered and then taken away.
 */
export function useCan() {
  const { company } = useActiveCompany();
  const granted = permissionsForRole(company?.role);
  const can = (permission: Permission): boolean => granted.includes(permission);
  return { can, role: company?.role ?? null, ready: Boolean(company) };
}

/** Convenience wrapper for a single permission. */
export function useCanDo(permission: Permission): boolean {
  return useCan().can(permission);
}
