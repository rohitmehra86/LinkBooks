import { describe, expect, it } from "vitest";
import { assertNoServiceRoleInViteEnv, findUnsafeViteEnvKeys } from "./env-safety";

describe("env safety", () => {
  it("allows publishable vite keys", () => {
    expect(
      findUnsafeViteEnvKeys({
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      }),
    ).toEqual([]);
  });

  it("flags service role name under VITE_", () => {
    expect(
      findUnsafeViteEnvKeys({
        VITE_SUPABASE_SERVICE_ROLE_KEY: "redacted",
      }),
    ).toContain("VITE_SUPABASE_SERVICE_ROLE_KEY");
  });

  it("flags secret key material in vite values without logging them", () => {
    expect(
      findUnsafeViteEnvKeys({
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_should_not_be_here",
      }),
    ).toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
  });

  it("throws on assert", () => {
    expect(() =>
      assertNoServiceRoleInViteEnv({ VITE_SUPABASE_SERVICE_ROLE_KEY: "x" }),
    ).toThrow(/privileged key/);
  });
});
