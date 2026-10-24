import { expect, test, type Page } from "@playwright/test";

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

async function signIn(page: Page, redirect: string) {
  await page.goto(`/auth?redirect=${encodeURIComponent(redirect)}`);
  await page.getByLabel("Email").fill(email ?? "");
  await page.getByLabel("Password", { exact: true }).fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/auth/);
}

async function expectRecordFooter(page: Page) {
  const panel = page.getByTestId("document-record-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Max file size: 20 MB")).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Internal notes" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "Activity history" })).toBeVisible();
  await expect(panel.getByText("Notes are saved with this draft.")).toBeVisible();
  await panel.getByRole("tab", { name: "Activity history" }).click();
  await expect(panel.getByText("Activity appears after the first save.")).toBeVisible();
}

test.describe("document attachments, notes and activity", () => {
  test.beforeEach(() => {
    test.skip(
      !email || !password,
      "Authorised test account unavailable. Set E2E_EMAIL and E2E_PASSWORD. Sign-in is not bypassed.",
    );
  });

  test("new invoice has the bill-style record footer", async ({ page }) => {
    await signIn(page, "/sales/invoices/new");
    await expectRecordFooter(page);
    await expect(page.getByLabel("Internal note")).toHaveAttribute(
      "placeholder",
      "Internal note (not printed on customer documents)",
    );
  });

  test("new expense, purchase order and supplier credit note have the record footer", async ({
    page,
  }) => {
    await signIn(page, "/purchases/expenses/new");
    await expectRecordFooter(page);
    await page.goto("/purchases/orders/new");
    await expectRecordFooter(page);
    await page.goto("/purchases/credit-notes/new");
    await expectRecordFooter(page);
  });
});
