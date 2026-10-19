import { describe, expect, it } from "vitest";
import { permissionsForRole, roleHasPermission } from "./permissions";

describe("role permissions matrix", () => {
  it("gives owners settings and billing", () => {
    expect(roleHasPermission("owner", "company.settings.edit")).toBe(true);
    expect(roleHasPermission("owner", "billing.manage")).toBe(true);
    expect(roleHasPermission("owner", "members.grant_owner")).toBe(true);
  });

  it("prevents read_only from posting or managing members", () => {
    expect(roleHasPermission("read_only", "accounting.post")).toBe(false);
    expect(roleHasPermission("read_only", "members.manage")).toBe(false);
    expect(roleHasPermission("read_only", "company.settings.edit")).toBe(false);
    expect(roleHasPermission("read_only", "reports.view")).toBe(true);
  });

  it("allows bookkeepers to post but not unlock periods", () => {
    expect(roleHasPermission("bookkeeper", "accounting.post")).toBe(true);
    expect(roleHasPermission("bookkeeper", "periods.unlock")).toBe(false);
  });

  it("fails closed for unknown roles", () => {
    expect(permissionsForRole("hacker")).toEqual([]);
    expect(permissionsForRole(undefined)).toEqual([]);
  });

  it("keeps tenant boundary permission company.view on all roles", () => {
    for (const role of ["owner", "admin", "accountant", "bookkeeper", "staff", "read_only"] as const) {
      expect(roleHasPermission(role, "company.view")).toBe(true);
    }
  });
});
