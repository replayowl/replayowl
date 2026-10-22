// Records two sessions (one signed in, one anonymous) and finds them through the search API and the
// dashboard search form, including the round trip to a replay and back.

import { expect, test } from "@playwright/test";
import { signIn } from "./auth.ts";
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

test("search by user, page and signals", async ({ browser }) => {
  // Session 1: signs in on the home page, then opens a product and hits the failing button.
  const ctx1 = await browser.newContext();
  const p1 = await ctx1.newPage();
  await p1.goto(base + "/demo/index.html");
  await p1.waitForTimeout(600);
  await p1.evaluate(() => (window as any).ReplayOwl.identify("ada-1"));
  await p1.mouse.move(300, 300);
  await p1.goto(base + "/demo/product.html");
  await p1.waitForTimeout(600);
  await p1.click("#buggy-btn");
  await p1.waitForTimeout(300);
  await p1.goto("about:blank");

  // Session 2: anonymous, checkout only.
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(base + "/demo/checkout.html");
  await p2.waitForTimeout(600);
  await p2.mouse.move(200, 200);
  await p2.goto("about:blank");

  const viewer = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await signIn(viewer, base);
  const users = async (qs: string) => (await (await viewer.request.get(base + "/api/sessions?" + qs)).json()).sessions.map((s: { userIds: string[] }) => s.userIds.join(","));
  await expect.poll(async () => (await users("")).length, { timeout: 20_000 }).toBe(2);
  expect(await users("user=ada-1")).toEqual(["ada-1"]);
  expect(await users("user=nobody")).toEqual([]);
  expect(await users("url=/demo/product")).toEqual(["ada-1"]);
  expect(await users("url=/demo/checkout.html&urlMode=exact")).toEqual([""]);
  expect(await users("url=checkout&urlMode=contains")).toEqual([""]);
  expect(await users("errors=1")).toEqual(["ada-1"]);
  expect(await users("minPages=2")).toEqual(["ada-1"]);
  expect(await users("device=desktop")).toHaveLength(2);
  const bad = await viewer.request.get(base + "/api/sessions?device=tv");
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toContain("device");

  // Search by user in the form; the query string carries the search.
  await viewer.goto(base + "/");
  await expect(viewer.locator("a.row")).toHaveCount(2);
  await viewer.fill("#q-user", "ada-1");
  await viewer.click("#search-form button[type=submit]");
  await expect(viewer).toHaveURL(/\?user=ada-1$/);
  await expect(viewer.locator("a.row")).toHaveCount(1);

  // Open the replay and come back: the search is still applied.
  await viewer.locator("a.row").first().click();
  await expect(viewer).toHaveURL(/\/replay\?id=/);
  await expect(viewer.locator("#p-details")).toContainText("ada-1");
  await viewer.goBack();
  await expect(viewer.locator("#q-user")).toHaveValue("ada-1");
  await expect(viewer.locator("a.row")).toHaveCount(1);

  // Clear, then click a user id in the list to search for it.
  await viewer.click("#clear-btn");
  await expect(viewer).toHaveURL(base + "/");
  await expect(viewer.locator("a.row")).toHaveCount(2);
  await viewer.locator(".user-link", { hasText: "ada-1" }).click();
  await expect(viewer).toHaveURL(/\?user=ada-1$/);
  await expect(viewer.locator("a.row")).toHaveCount(1);

  // Page search plus a filter from the extra panel.
  await viewer.click("#clear-btn");
  await viewer.fill("#q-url", "/demo/checkout");
  await viewer.click("#more-btn");
  await expect(viewer.locator("#more")).toBeVisible();
  await viewer.selectOption("#q-device", "desktop");
  await viewer.click("#search-form button[type=submit]");
  await expect(viewer.locator("a.row")).toHaveCount(1);
  await expect(viewer.locator("a.row .user-link")).toHaveCount(0);

  // The site filter lists the recorded hosts, is remembered like a project and survives Clear.
  const host = new URL(base).host;
  expect((await (await viewer.request.get(base + "/api/sessions/sites")).json()).sites).toEqual([{ host, sessions: 2 }]);
  expect(await users("site=other.test")).toEqual([]);
  expect(await users("site=" + host + "&url=/demo/product")).toEqual(["ada-1"]);
  await viewer.goto(base + "/");
  await expect(viewer.locator("#q-site")).toBeVisible();
  await expect(viewer.locator("#q-site option[value='" + host + "']")).toHaveText(host + " (2)");
  await viewer.selectOption("#q-site", host);
  await expect(viewer).toHaveURL(base + "/?site=" + encodeURIComponent(host));
  await expect(viewer.locator("a.row")).toHaveCount(2);
  await expect(viewer.locator("#clear-btn")).toBeHidden();
  await viewer.goto(base + "/");
  await expect(viewer).toHaveURL(base + "/?site=" + encodeURIComponent(host));
  await expect(viewer.locator("#q-site")).toHaveValue(host);
  await viewer.locator(".user-link", { hasText: "ada-1" }).click();
  await expect(viewer).toHaveURL(base + "/?site=" + encodeURIComponent(host) + "&user=ada-1");
  await viewer.click("#clear-btn");
  await expect(viewer).toHaveURL(base + "/?site=" + encodeURIComponent(host));
  await viewer.selectOption("#q-site", "");
  await expect(viewer).toHaveURL(base + "/");
  await viewer.goto(base + "/");
  await expect(viewer).toHaveURL(base + "/");

  // A search the server rejects shows its message.
  await viewer.goto(base + "/?minDuration=abc");
  await expect(viewer.locator(".empty-panel")).toContainText("minDuration");
  // The extra panel opens by itself when the address holds one of its filters.
  await expect(viewer.locator("#more")).toBeVisible();

  await ctx1.close();
  await ctx2.close();
});
