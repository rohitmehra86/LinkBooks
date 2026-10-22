/**
 * `rrule` resolves differently under Vite dev SSR (CJS interop) vs production ESM.
 * Always import RRule through this module.
 */
import * as rruleNS from "rrule";

export type { Options } from "rrule";

type RRuleCtor = typeof import("rrule").RRule;

function resolveRRule(): RRuleCtor {
  const ns = rruleNS as Record<string, unknown>;
  if (ns.RRule) return ns.RRule as RRuleCtor;
  const d = ns.default as Record<string, unknown> | undefined;
  if (d?.RRule) return d.RRule as RRuleCtor;
  throw new Error("rrule: RRule export not found");
}

export const RRule = resolveRRule();
