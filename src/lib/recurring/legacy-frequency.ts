import { RRule, type Options } from "@/lib/recurring/rrule-shim";

export type LegacyRecurrenceFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

export function legacyFrequencyToRrule(freq: LegacyRecurrenceFrequency): string {
  switch (freq) {
    case "weekly":
      return "FREQ=WEEKLY";
    case "monthly":
      return "FREQ=MONTHLY";
    case "quarterly":
      return "FREQ=MONTHLY;INTERVAL=3";
    case "yearly":
      return "FREQ=YEARLY";
    default:
      throw new Error(`Unsupported frequency: ${freq satisfies never}`);
  }
}

export function rruleOptionsFromLegacy(
  freq: LegacyRecurrenceFrequency,
  dtstart: Date,
): Partial<Options> {
  switch (freq) {
    case "weekly":
      return { freq: RRule.WEEKLY, dtstart };
    case "monthly":
      return { freq: RRule.MONTHLY, dtstart };
    case "quarterly":
      return { freq: RRule.MONTHLY, interval: 3, dtstart };
    case "yearly":
      return { freq: RRule.YEARLY, dtstart };
    default:
      throw new Error(`Unsupported frequency: ${freq satisfies never}`);
  }
}
