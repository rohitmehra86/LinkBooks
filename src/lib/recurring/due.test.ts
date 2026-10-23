import { describe, expect, it } from "vitest";
import { describeRunDue, selectDueSchedules } from "./due";

describe("selectDueSchedules", () => {
  it("keeps active schedules due on or before today, oldest first", () => {
    const rows = [
      { id: "c", next_due_date: "2026-10-23", is_active: true },
      { id: "a", next_due_date: "2026-09-01", is_active: true },
      { id: "b", next_due_date: "2026-10-24", is_active: true },
      { id: "d", next_due_date: "2026-08-01", is_active: false },
    ];
    expect(selectDueSchedules(rows, "2026-10-23").map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("caps the batch", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      next_due_date: "2026-01-01",
      is_active: true,
    }));
    expect(selectDueSchedules(rows, "2026-10-23", 2)).toHaveLength(2);
  });
});

describe("describeRunDue", () => {
  it("is honest about nothing due and about failures", () => {
    expect(describeRunDue("invoices", { generated: 0, failed: [] })).toBe("No invoices are due");
    expect(describeRunDue("bills", { generated: 2, failed: [{ id: "x", message: "m" }] })).toBe(
      "2 bills generated, 1 failed",
    );
  });
});
