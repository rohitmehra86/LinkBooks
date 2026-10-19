import { describe, expect, it } from "vitest";
import { assertUuid } from "./company-validation";
import { roleHasPermission } from "./permissions";

/**
 * Contract tests for tenant isolation behaviour expected of server + RLS.
 * Live Supabase 2-user isolation remains a manual/staging checklist until
 * integration credentials are provided in CI.
 */
describe("tenant isolation contracts", () => {
  it("requires uuid company ids before server mutations", () => {
    expect(() => assertUuid("company-a")).toThrow();
    expect(assertUuid("11111111-1111-4111-8111-111111111111")).toHaveLength(36);
  });

  it("does not grant cross-role privilege escalation via matrix alone", () => {
    // Staff must not manage members or edit company settings.
    expect(roleHasPermission("staff", "members.manage")).toBe(false);
    expect(roleHasPermission("staff", "company.settings.edit")).toBe(false);
    expect(roleHasPermission("staff", "billing.manage")).toBe(false);
  });

  it("documents that UI permission hints are not a security boundary", () => {
    // Security boundary = requireSupabaseAuth + has_company_permission RPC + RLS.
    // This test exists so the matrix cannot silently grant owner-only keys to read_only.
    expect(roleHasPermission("read_only", "members.grant_owner")).toBe(false);
    expect(roleHasPermission("read_only", "demo.reset")).toBe(false);
  });
});
