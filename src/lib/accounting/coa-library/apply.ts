import { accountsForIndustries, INDUSTRIES_BY_CODE, LIBRARY_BY_KEY } from "./catalog";
import type {
  ApplyPreview,
  ApplyPreviewItem,
  DetailLevel,
  ExistingAccount,
  LibraryAccount,
} from "./types";

const CONTROL_CODE_HINTS: Record<NonNullable<LibraryAccount["controlRole"]>, string[]> = {
  ar: ["1100"],
  ap: ["2000"],
  tax_payable: ["2100"],
  bank: ["1000"],
  retained_earnings: ["3200"],
};

function matchExisting(existing: ExistingAccount[], lib: LibraryAccount): ExistingAccount | undefined {
  const byKey = existing.find((e) => e.catalog_key && e.catalog_key === lib.key);
  if (byKey) return byKey;
  const byCode = existing.find((e) => e.code === lib.code);
  if (byCode) return byCode;
  if (lib.controlRole) {
    const codes = CONTROL_CODE_HINTS[lib.controlRole] ?? [];
    return existing.find((e) => codes.includes(e.code) || e.is_control);
  }
  return undefined;
}

function typesCompatible(existingType: string, libType: string): boolean {
  return existingType === libType;
}

/**
 * Pure preview: additive, never deletes/renames. Detects code conflicts and
 * skips creating duplicate control accounts.
 */
export function previewIndustryApply(opts: {
  existing: ExistingAccount[];
  industryCodes: string[];
  level: DetailLevel;
}): ApplyPreview {
  const industries = opts.industryCodes.filter((c) => INDUSTRIES_BY_CODE[c]);
  const proposed = accountsForIndustries(industries, opts.level);

  const toCreate: ApplyPreviewItem[] = [];
  const alreadyPresent: ApplyPreviewItem[] = [];
  const conflicts: ApplyPreviewItem[] = [];
  const skippedControls: ApplyPreviewItem[] = [];

  for (const lib of proposed) {
    const match = matchExisting(opts.existing, lib);
    const base = {
      key: lib.key,
      code: lib.code,
      name: lib.name,
      accountType: lib.accountType,
      recommendation: lib.recommendation,
    };

    if (!match) {
      toCreate.push({
        ...base,
        action: "create",
        reason: lib.whyRecommended ?? `Recommended for selected industries at ${opts.level} level.`,
      });
      continue;
    }

    if (lib.controlRole && (match.is_control || CONTROL_CODE_HINTS[lib.controlRole]?.includes(match.code))) {
      skippedControls.push({
        ...base,
        action: "skip_control",
        reason: `Control/system account already present as ${match.code} ${match.name}.`,
      });
      continue;
    }

    if (!typesCompatible(match.account_type, lib.accountType) && match.code === lib.code) {
      conflicts.push({
        ...base,
        action: "conflict",
        reason: `Code ${lib.code} exists as ${match.account_type} “${match.name}”; library wants ${lib.accountType} “${lib.name}”.`,
      });
      continue;
    }

    alreadyPresent.push({
      ...base,
      action: "already_present",
      reason: `Matched existing ${match.code} ${match.name}.`,
    });
  }

  return {
    level: opts.level,
    industries,
    toCreate,
    alreadyPresent,
    conflicts,
    skippedControls,
  };
}

export function resolveLibraryAccount(key: string): LibraryAccount | undefined {
  return LIBRARY_BY_KEY[key];
}

export function trackingDefaultsFor(industryCodes: string[]) {
  const out: Array<{ industry: string; name: string; options: string[] }> = [];
  for (const code of industryCodes) {
    const ind = INDUSTRIES_BY_CODE[code];
    if (!ind?.trackingDefaults) continue;
    for (const t of ind.trackingDefaults) {
      out.push({ industry: code, name: t.name, options: t.options });
    }
  }
  return out;
}
