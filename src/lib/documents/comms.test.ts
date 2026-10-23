import { describe, expect, it } from "vitest";
import {
  buildMailto,
  defaultTemplateFor,
  escapeHtml,
  isValidEmail,
  parseRecipients,
  renderEmail,
  safeHttpLink,
  type EmailInput,
} from "@/lib/documents/email-templates";
import {
  ATTACHMENT_ENTITIES,
  buildStoragePath,
  formatFileSize,
  isAttachmentEntityType,
  parseStoragePath,
  safeStorageName,
  validateUpload,
} from "@/lib/documents/attachments";
import {
  DEFAULT_REMINDER_SETTINGS,
  normaliseReminderSettings,
  reminderDecision,
} from "@/lib/documents/reminders";

const input: EmailInput = {
  companyName: "Acme & Sons <Ltd>",
  partyName: "Bob",
  documentLabel: "Invoice",
  documentNumber: "INV-0001",
  currency: "GBP",
  totalMinor: 123456,
  dueMinor: 100000,
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  daysOverdue: 0,
  link: "https://app.example.com/share/invoice/abc",
  customMessage: null,
  locale: "en-GB",
  dateFormat: "DD/MM/YYYY",
  bankDetails: "Sort 00-00-00\nAcc 1234",
};

describe("email templates", () => {
  it("renders an invoice email with amount, due date and link", () => {
    const e = renderEmail("invoice", input);
    expect(e.subject).toBe("Invoice INV-0001 from Acme & Sons <Ltd>");
    expect(e.text).toContain("£1,234.56");
    expect(e.text).toContain("31/10/2026");
    expect(e.text).toContain("https://app.example.com/share/invoice/abc");
    expect(e.text).toContain("Sort 00-00-00");
  });

  it("escapes HTML in names and never emits raw markup from data", () => {
    const e = renderEmail("invoice", { ...input, partyName: '<script>alert("x")</script>' });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.html).toContain('<a href="https://app.example.com/share/invoice/abc">');
  });

  it("drops non-http links", () => {
    expect(safeHttpLink("javascript:alert(1)")).toBeNull();
    expect(safeHttpLink("https://ok.test/x?a=1&b=2")).toBe("https://ok.test/x?a=1&b=2");
    const e = renderEmail("invoice", { ...input, link: "javascript:alert(1)" });
    expect(e.text).not.toContain("javascript:");
  });

  it("renders overdue and not-yet-due reminders differently", () => {
    const overdue = renderEmail("reminder", { ...input, daysOverdue: 12, dueDate: "2026-10-01" });
    expect(overdue.subject).toContain("is overdue");
    expect(overdue.text).toContain("12 days overdue");
    expect(overdue.text).toContain("£1,000.00");
    const early = renderEmail("reminder", { ...input, daysOverdue: 0 });
    expect(early.subject).not.toContain("overdue");
    expect(early.text).toContain("is due on 31/10/2026");
  });

  it("renders statement, receipt, quote and remittance templates", () => {
    const s = renderEmail("statement", {
      ...input,
      statement: {
        from: "2026-10-01",
        to: "2026-10-31",
        rows: [{ currency: "EUR", openingMinor: 100, closingMinor: 20000 }],
      },
    });
    expect(s.text).toContain("EUR: opening balance");
    expect(s.text).toContain("01/10/2026");
    expect(renderEmail("receipt", input).subject).toContain("Payment received");
    expect(renderEmail("quote", input).text).toContain("accept");
    expect(renderEmail("remittance", input).subject).toContain("Remittance advice");
  });

  it("appends a custom message before the sign-off", () => {
    const e = renderEmail("invoice", { ...input, customMessage: "Call me." });
    expect(e.text.indexOf("Call me.")).toBeLessThan(e.text.indexOf("Kind regards"));
  });

  it("maps document kinds to templates; received documents have none", () => {
    expect(defaultTemplateFor("sales_invoice")).toBe("invoice");
    expect(defaultTemplateFor("purchase_bill")).toBeNull();
  });

  it("validates and splits recipients", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(parseRecipients("a@b.co, A@B.co; bad  c@d.org")).toEqual({
      valid: ["a@b.co", "c@d.org"],
      invalid: ["bad"],
    });
  });

  it("builds a mailto link", () => {
    const m = buildMailto({ to: "a@b.co", subject: "Hi & bye", body: "Line1\nLine2" });
    expect(m.startsWith("mailto:a@b.co?subject=Hi%20%26%20bye&body=Line1%0ALine2")).toBe(true);
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("attachments", () => {
  it("validates size and type", () => {
    expect(
      validateUpload({ fileName: "a.pdf", sizeBytes: 1000, contentType: "application/pdf" }).ok,
    ).toBe(true);
    expect(validateUpload({ fileName: "a.pdf", sizeBytes: 0 }).ok).toBe(false);
    expect(validateUpload({ fileName: "a.pdf", sizeBytes: 21 * 1024 * 1024 }).ok).toBe(false);
    expect(validateUpload({ fileName: "a.exe", sizeBytes: 10 }).ok).toBe(false);
    expect(validateUpload({ fileName: "a.zip", sizeBytes: 10 }).ok).toBe(false);
    expect(validateUpload({ fileName: "macro.xlsm", sizeBytes: 10 }).ok).toBe(false);
    expect(validateUpload({ fileName: "a.pdf", sizeBytes: 10, contentType: "image/png" }).ok).toBe(
      false,
    );
    expect(
      validateUpload({ fileName: "pic.webp", sizeBytes: 10, contentType: "image/webp" }).ok,
    ).toBe(true);
    expect(
      validateUpload({ fileName: "pic.webp", sizeBytes: 10, contentType: "text/html" }).ok,
    ).toBe(false);
    expect(validateUpload({ fileName: "noext", sizeBytes: 10 }).ok).toBe(false);
  });

  it("builds and parses storage paths without path traversal", () => {
    const company = "11111111-1111-4111-8111-111111111111";
    const entity = "22222222-2222-4222-8222-222222222222";
    const uid = "33333333-3333-4333-8333-333333333333";
    const path = buildStoragePath({
      companyId: company,
      entityType: "sales_invoice",
      entityId: entity,
      uniqueId: uid,
      fileName: "../../etc/pass wd.pdf",
    });
    expect(path.startsWith(`${company}/sales_invoice/${entity}/${uid}-`)).toBe(true);
    expect(path.split("/")).toHaveLength(4);
    expect(parseStoragePath(path)).toMatchObject({
      companyId: company,
      entityType: "sales_invoice",
      entityId: entity,
    });
    expect(parseStoragePath("x/y")).toBeNull();
    expect(safeStorageName("../a b.pdf")).toBe("a-b.pdf");
    expect(safeStorageName("   ")).toBe("file");
  });

  it("knows its entity registry", () => {
    expect(isAttachmentEntityType("journal")).toBe(true);
    expect(isAttachmentEntityType("users")).toBe(false);
    expect(ATTACHMENT_ENTITIES.sales_invoice.manage).toContain("sales.draft");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("reminders", () => {
  const s = DEFAULT_REMINDER_SETTINGS; // first after 7d, every 14d, max 3
  const base = {
    status: "authorised",
    dueDate: "2026-10-01",
    outstandingMinor: 5000,
    remindersSent: 0,
    lastReminderDate: null,
  };

  it("waits for the first threshold", () => {
    expect(reminderDecision(base, "2026-10-05", s)).toEqual({ due: false, reason: "too_early" });
    expect(reminderDecision(base, "2026-10-08", s)).toEqual({ due: true, daysOverdue: 7 });
    expect(reminderDecision(base, "2026-09-30", s)).toEqual({ due: false, reason: "not_overdue" });
  });

  it("spaces repeats and stops at the maximum", () => {
    const one = { ...base, remindersSent: 1, lastReminderDate: "2026-10-08" };
    expect(reminderDecision(one, "2026-10-15", s)).toEqual({ due: false, reason: "too_soon" });
    expect(reminderDecision(one, "2026-10-22", s)).toEqual({ due: true, daysOverdue: 21 });
    expect(reminderDecision({ ...one, remindersSent: 3 }, "2026-12-01", s)).toEqual({
      due: false,
      reason: "max_reached",
    });
  });

  it("never reminds settled, draft or void invoices", () => {
    expect(reminderDecision({ ...base, status: "paid" }, "2026-12-01", s).due).toBe(false);
    expect(reminderDecision({ ...base, status: "draft" }, "2026-12-01", s).due).toBe(false);
    expect(reminderDecision({ ...base, outstandingMinor: 0 }, "2026-12-01", s).due).toBe(false);
  });

  it("clamps settings", () => {
    expect(
      normaliseReminderSettings({ firstAfterDays: -4, repeatEveryDays: 0, maxReminders: 99 }),
    ).toMatchObject({
      firstAfterDays: 0,
      repeatEveryDays: 1,
      maxReminders: 12,
    });
    expect(normaliseReminderSettings(null)).toEqual(DEFAULT_REMINDER_SETTINGS);
  });
});
