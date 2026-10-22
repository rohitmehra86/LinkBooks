export function buildOccurrenceKey(scheduleId: string, scheduledDate: string): string {
  return `${scheduleId}:${scheduledDate}`;
}

export function buildOccurrenceIdempotencyKey(
  documentType: "purchase_bill" | "sales_invoice",
  scheduleId: string,
  scheduledDate: string,
): string {
  return `recurring:${documentType}:${scheduleId}:${scheduledDate}`;
}
