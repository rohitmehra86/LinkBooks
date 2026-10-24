import { defineConfig, devices } from "@playwright/test";

const hasAccount = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);

/**
 * Authenticated LookupSelect checks. They sign in through /auth.
 * Without E2E_EMAIL and E2E_PASSWORD the suite skips and does not start a browser.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: hasAccount
    ? {
        command: "npm run dev -- --port 8080 --strictPort --host 127.0.0.1",
        url: "http://127.0.0.1:8080",
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : undefined,
});
