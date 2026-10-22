import { describe, expect, it } from "vitest";
import {
  buildOccurrenceIdempotencyKey,
  buildOccurrenceKey,
} from "@/lib/recurring/occurrence-key";

describe("occurrence keys", () => {
  it("builds deterministic schedule occurrence key", () => {
    expect(buildOccurrenceKey("550e8400-e29b-41d4-a716-446655440000", "2026-03-01")).toBe(
      "550e8400-e29b-41d4-a716-446655440000:2026-03-01",
    );
  });

  it("builds posting idempotency key scoped by company schedule and date", () => {
    const key = buildOccurrenceIdempotencyKey(
      "purchase_bill",
      "550e8400-e29b-41d4-a716-446655440000",
      "2026-03-01",
    );
    expect(key).toBe(
      "recurring:purchase_bill:550e8400-e29b-41d4-a716-446655440000:2026-03-01",
    );
  });
});
