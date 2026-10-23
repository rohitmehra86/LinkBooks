/**
 * `rrule` resolves differently under Vite dev SSR (CJS interop) vs production ESM.
 * Always import RRule through this module.
 */
import * as rruleNS from "rrule";

export type { Options } from "rrule";

type RRuleCtor = typeof import("rrule").RRule;

function resolveRRule(): RRuleCtor {
  const ns = rruleNS as unknown as Record<string, unknown>;
  const named = ns["RRule"];
  if (named) return named as RRuleCtor;
  const wrapped = ns["default"];
  if (wrapped && typeof wrapped === "object") {
    const inner = (wrapped as Record<string, unknown>)["RRule"];
    if (inner) return inner as RRuleCtor;
  }
  throw new Error("rrule: RRule export not found");
}

export const RRule = resolveRRule();
