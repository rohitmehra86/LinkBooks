import { describe, expect, it } from "vitest";
import { effectiveStatus, humanizeStatus, statusDisplay } from "./status-badge";

describe("statusDisplay", () => {
  it("maps the document lifecycle to consistent labels and tones", () => {
    expect(statusDisplay("draft")).toMatchObject({ label: "Draft", tone: "neutral" });
    expect(statusDisplay("awaiting_approval")).toMatchObject({
      label: "Awaiting approval",
      tone: "warning",
    });
    expect(statusDisplay("authorised")).toMatchObject({ label: "Awaiting payment", tone: "info" });
    expect(statusDisplay("paid")).toMatchObject({ label: "Paid", tone: "success" });
    expect(statusDisplay("overdue")).toMatchObject({ label: "Overdue", tone: "danger" });
    expect(statusDisplay("void")).toMatchObject({ label: "Void", muted: true });
  });
  it("is case, space and underscore insensitive", () => {
    expect(statusDisplay("Awaiting payment").label).toBe("Awaiting payment");
    expect(statusDisplay("PARTLY_PAID").tone).toBe("info");
  });
  it("falls back to a neutral humanised label for unknown statuses", () => {
    expect(statusDisplay("on_hold")).toEqual({ label: "On hold", tone: "neutral" });
    expect(statusDisplay(null).label).toBe("—");
  });
});

describe("effectiveStatus", () => {
  it("promotes open past-due documents to overdue", () => {
    expect(effectiveStatus("authorised", "2026-10-01", "2026-10-23")).toBe("overdue");
    expect(effectiveStatus("partly_paid", "2026-10-22", "2026-10-23")).toBe("overdue");
  });
  it("leaves current, paid, draft and void documents alone", () => {
    expect(effectiveStatus("authorised", "2026-10-23", "2026-10-23")).toBe("authorised");
    expect(effectiveStatus("paid", "2026-01-01", "2026-10-23")).toBe("paid");
    expect(effectiveStatus("draft", "2026-01-01", "2026-10-23")).toBe("draft");
    expect(effectiveStatus("void", "2026-01-01", "2026-10-23")).toBe("void");
    expect(effectiveStatus("authorised", null, "2026-10-23")).toBe("authorised");
  });
});

describe("humanizeStatus", () => {
  it("capitalises and spaces", () => {
    expect(humanizeStatus("partly_paid")).toBe("Partly paid");
    expect(humanizeStatus("")).toBe("—");
  });
});
