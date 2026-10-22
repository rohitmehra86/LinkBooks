import { describe, expect, it } from "vitest";
import { FEATURE_CATALOG, computeFeatureState } from "./feature-catalog";

describe("feature state engine", () => {
  const classes = FEATURE_CATALOG.find((f) => f.key === "classes")!;

  it("marks unavailable features honestly", () => {
    const portals = FEATURE_CATALOG.find((f) => f.key === "portals")!;
    const s = computeFeatureState(portals, { enabled: true, canEdit: true });
    expect(s.state).toBe("unavailable");
    expect(s.enabled).toBe(false);
  });

  it("returns available_disabled when off", () => {
    const s = computeFeatureState(classes, { enabled: false, canEdit: true });
    expect(s.state).toBe("available_disabled");
  });

  it("returns enabled_operational when on and config ok", () => {
    const s = computeFeatureState(classes, { enabled: true, canEdit: true, configComplete: true });
    expect(s.state).toBe("enabled_operational");
  });

  it("returns enabled_needs_config when config incomplete", () => {
    const late = FEATURE_CATALOG.find((f) => f.key === "late_fees")!;
    const s = computeFeatureState(late, {
      enabled: true,
      canEdit: true,
      configComplete: false,
    });
    expect(s.state).toBe("enabled_needs_config");
  });

  it("returns restricted when entitlement blocked", () => {
    const s = computeFeatureState(classes, {
      enabled: false,
      canEdit: true,
      entitlementBlocked: true,
    });
    expect(s.state).toBe("restricted");
  });
});
