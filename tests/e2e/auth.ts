import { expect, type Page } from "@playwright/test";

export const ADMIN_PASSWORD = "owl-admin-pass-1";

/** Opens the dashboard and signs in, setting the admin password first when none exists yet. */
export async function signIn(page: Page, base: string, password = ADMIN_PASSWORD) {
  await page.goto(base + "/");
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.locator("#form").waitFor();
  const setup = (await page.locator("#heading").textContent()) === "Set the admin password";
  await page.fill("#password", password);
  if (setup) await page.fill("#confirm", password);
  if (setup && (await page.locator("#token-field").isVisible())) await page.fill("#token", process.env.SETUP_TOKEN || "");
  await page.click("#submit");
  await expect(page).toHaveURL(base + "/");
}
