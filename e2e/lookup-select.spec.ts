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

async function chooseFirstMatch(page: Page, comboboxName: string, query: string) {
  const combobox = page.getByRole("combobox", { name: comboboxName });
  await combobox.click();
  const search = page.getByRole("textbox", { name: /Search/i });
  await search.fill(query);
  const option = page.getByRole("option").first();
  await expect(option).toBeVisible();
  const label = (await option.innerText()).trim();
  await option.click();
  await expect(combobox).toContainText(label.split("\n")[0] ?? label);
}

test.describe("authenticated LookupSelect", () => {
  test.beforeEach(() => {
    test.skip(
      !email || !password,
      "Authorised test account unavailable. Set E2E_EMAIL and E2E_PASSWORD. Sign-in is not bypassed.",
    );
  });

  test("bank transfer search selects an account and leaves the amount untouched", async ({
    page,
  }) => {
    await signIn(page, "/banking/transfers");
    await page.getByLabel("Transfer amount").fill("1.00");
    await chooseFirstMatch(page, "From account", "a");
    await expect(page.getByLabel("Transfer amount")).toHaveValue("1.00");
  });

  test("purchase order lookup does not clear an unsaved line", async ({ page }) => {
    await signIn(page, "/purchases/orders/new");
    const description = page
      .locator("div")
      .filter({ has: page.getByText("Line description", { exact: true }) })
      .locator("input");
    await description.fill("Unsaved lookup check");
    await chooseFirstMatch(page, "Supplier", "a");
    await expect(description).toHaveValue("Unsaved lookup check");
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Supplier" })).toBeVisible();
    await expect(description).toHaveValue("");
  });

  test("reconcile, journal, tax and products lookups open as record search", async ({ page }) => {
    await signIn(page, "/banking/reconcile");
    await page.getByRole("combobox", { name: "Bank account" }).click();
    await expect(page.getByRole("textbox", { name: /Search bank account/i })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/accounting");
    await page.getByRole("tab", { name: "Post manual journal" }).click();
    const lineAccount = page.getByRole("combobox", { name: "Line 1 account" });
    await expect(lineAccount).toBeVisible();
    await lineAccount.click();
    await expect(page.getByRole("textbox", { name: /Search/i })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/tax");
    await page.getByRole("tab", { name: "GL mappings" }).click();
    await expect(page.getByRole("combobox", { name: "Output tax liability" })).toBeVisible();

    await page.goto("/products-services");
    await page.getByRole("button", { name: "New item" }).click();
    await expect(page.getByRole("combobox", { name: "Income account" })).toBeVisible();
  });
});
