// Admin sign-in: first-time setup, sign-out, wrong passwords, password change and request guards.

import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../../src/server/index.ts";
import { FsStorage } from "../../src/server/fs-storage.ts";
import { PgDb } from "../../src/server/pg.ts";
import { freshDatabase } from "../pg.ts";
import { startTarget, type Target } from "./target.ts";

let target: Target;
let base = "";

test.beforeAll(async () => {
  target = await startTarget();
  base = target.base;
});

test.afterAll(async () => {
  await target.stop();
});

test("set up, sign out, sign in, change password", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Locked before setup.
  expect((await fetch(base + "/api/sessions")).status).toBe(401);
  await page.goto(base + "/replay?id=abcdefgh");
  await expect(page).toHaveURL(/\/login\?next=%2Freplay%3Fid%3Dabcdefgh/);
  await expect(page.locator("#heading")).toHaveText("Set the admin password");
  if (process.env.SETUP_TOKEN) await page.fill("#token", process.env.SETUP_TOKEN);
  else await expect(page.locator("#token-field")).toBeHidden();

  // Validation.
  await page.fill("#password", "short");
  await page.fill("#confirm", "short");
  await page.click("#submit");
  await expect(page.locator("#error")).toHaveText("Use at least 8 characters.");
  await page.fill("#password", "first-password");
  await page.fill("#confirm", "first-passwordX");
  await page.click("#submit");
  await expect(page.locator("#error")).toHaveText("The two passwords do not match.");

  // Setup signs in and returns to the requested page.
  await page.fill("#confirm", "first-password");
  await page.click("#submit");
  await expect(page).toHaveURL(base + "/replay?id=abcdefgh");
  await expect(page.locator(".loading")).toContainText("does not exist");

  // A second setup is refused.
  const again = await page.request.post(base + "/api/auth/setup", { data: { password: "takeover-password" } });
  expect(again.status()).toBe(409);

  // A second browser signs in with the first password.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(base + "/login");
  await expect(otherPage.locator("#heading")).toHaveText("Sign in to Replayowl");
  await expect(otherPage.locator("#confirm-field")).toBeHidden();
  await otherPage.fill("#password", "wrong-password");
  await otherPage.click("#submit");
  await expect(otherPage.locator("#error")).toHaveText("That password is not correct.");
  await otherPage.fill("#password", "first-password");
  await otherPage.click("#submit");
  await expect(otherPage).toHaveURL(base + "/");
  expect((await otherPage.request.get(base + "/api/sessions")).status()).toBe(200);

  // Change the password from the dashboard.
  await page.goto(base + "/");
  await page.click("#account-btn");
  await page.fill("#pw-current", "not-the-password");
  await page.fill("#pw-new", "second-password");
  await page.fill("#pw-confirm", "second-password");
  await page.click("#pw-submit");
  await expect(page.locator("#pw-error")).toHaveText("The current password is not correct.");
  await page.fill("#pw-current", "first-password");
  await page.fill("#pw-new", "second-password");
  await page.fill("#pw-confirm", "second-password");
  await page.click("#pw-submit");
  await expect(page.locator("#pw-ok")).toBeVisible();
  await page.click("#pw-cancel");

  // This browser stays signed in; the other one is signed out by the rotated secret.
  expect((await page.request.get(base + "/api/sessions")).status()).toBe(200);
  // The admin config is cached for a few seconds per process; wait it out for other isolates.
  await expect.poll(async () => (await otherPage.request.get(base + "/api/sessions")).status(), { timeout: 20_000 }).toBe(401);

  // Sign out, then only the new password works.
  await page.click("#logout-btn");
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get(base + "/api/sessions")).status()).toBe(401);
  await page.fill("#password", "first-password");
  await page.click("#submit");
  await expect(page.locator("#error")).toHaveText("That password is not correct.");
  await page.fill("#password", "second-password");
  await page.click("#submit");
  await expect(page).toHaveURL(base + "/");

  await ctx.close();
  await other.close();
});

test("request guards", async () => {
  // Cross-origin password attempts are refused before any check.
  const cross = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ password: "x" }),
  });
  expect(cross.status).toBe(403);
  // Form posts (no JSON) cannot reach the auth endpoints.
  const form = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=x" });
  expect(form.status).toBe(415);
  // The collector stays open to any site.
  const pre = await fetch(base + "/api/ingest", { method: "OPTIONS", headers: { Origin: "https://shop.example", "Access-Control-Request-Method": "POST" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  // Static files for the recorder and the sign-in page need no session.
  expect((await fetch(base + "/recorder.js")).status).toBe(200);
  expect((await fetch(base + "/dashboard/login.js")).status).toBe(200);
});

test("setup token", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-token-"));
  const fresh = await freshDatabase();
  const db = PgDb.pool(fresh.url);
  const server = startServer({ port: 0, host: "127.0.0.1", storage: new FsStorage(dir), db, setupToken: "let-me-in", oauth: null });
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    await page.goto(url + "/login");
    await expect(page.locator("#token-field")).toBeVisible();
    await page.fill("#token", "guess");
    await page.fill("#password", "token-password");
    await page.fill("#confirm", "token-password");
    await page.click("#submit");
    await expect(page.locator("#error")).toHaveText("The setup token is not correct.");
    await page.fill("#token", "let-me-in");
    await page.click("#submit");
    await expect(page).toHaveURL(url + "/");
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    await db.close();
    await fresh.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
