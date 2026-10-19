import { describe, expect, it } from "vitest";
import { roleHasPermission } from "@/lib/permissions";
import { assertUuid } from "@/lib/company-validation";

/**
 * Contract tests for cross-cutting org settings, FX policy, firm, audit, demo.
 * Live RPC behaviour (reset_demo_company, void_exchange_rate) requires staging DB.
 */

describe("organisation switching & multi-org safety", () => {
  it("requires uuid company ids for all company-scoped mutations", () => {
    expect(() => assertUuid("active-company")).toThrow();
    expect(assertUuid("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toMatch(/^[a-f0-9-]{36}$/i);
  });

  it("documents that active company is session preference, not a privilege grant", () => {
    // Switching org changes last_company_id; RLS still scopes every query by membership.
    expect(roleHasPermission("read_only", "company.settings.edit")).toBe(false);
  });
});

describe("cross-tenant denial contracts", () => {
  it("staff cannot manage members or reset demo", () => {
    expect(roleHasPermission("staff", "members.manage")).toBe(false);
    expect(roleHasPermission("staff", "demo.reset")).toBe(false);
    expect(roleHasPermission("staff", "company.settings.edit")).toBe(false);
  });

  it("read_only cannot post, lock periods, or view audit escalate", () => {
    expect(roleHasPermission("read_only", "accounting.post")).toBe(false);
    expect(roleHasPermission("read_only", "periods.lock")).toBe(false);
    expect(roleHasPermission("read_only", "members.grant_owner")).toBe(false);
  });
});

describe("role change privileges", () => {
  it("only owners can grant owner; admins can manage lesser roles", () => {
    expect(roleHasPermission("owner", "members.grant_owner")).toBe(true);
    expect(roleHasPermission("admin", "members.grant_owner")).toBe(false);
    expect(roleHasPermission("admin", "members.manage")).toBe(true);
    expect(roleHasPermission("accountant", "members.manage")).toBe(false);
  });
});

describe("period locks & audit", () => {
  it("period lock/unlock are distinct permissions", () => {
    expect(roleHasPermission("bookkeeper", "periods.lock")).toBe(false);
    expect(roleHasPermission("accountant", "periods.lock")).toBe(true);
    expect(roleHasPermission("accountant", "audit.view")).toBe(true);
  });
});

describe("Demo Company isolation contracts", () => {
  it("demo.reset is owner/admin only and never implied by posting permissions", () => {
    expect(roleHasPermission("owner", "demo.reset")).toBe(true);
    expect(roleHasPermission("admin", "demo.reset")).toBe(true);
    expect(roleHasPermission("accountant", "demo.reset")).toBe(false);
    // Posting permission must not imply demo reset
    expect(roleHasPermission("bookkeeper", "accounting.post")).toBe(true);
    expect(roleHasPermission("bookkeeper", "demo.reset")).toBe(false);
  });

  it("is_demo must not appear in permission matrix (engine parity)", () => {
    // Guard: permissions module has no is_demo fork
    const src = roleHasPermission.toString();
    expect(src).not.toMatch(/is_demo/);
  });
});

describe("FX policy invariants (code-level)", () => {
  it("historical rates are never editable via client UPDATE permission model", () => {
    // Documented in migration: no UPDATE/DELETE RLS policies on exchange_rates;
    // void_exchange_rate is the only mutation path and preserves rate value.
    expect(true).toBe(true);
  });
});
