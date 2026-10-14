// Records a three-page visit to the demo shop, replays it and compares the replayed DOM with the
// live DOM at the end of every page: structure, text (masked text allowed), form values, scroll
// positions and computed styles that prove each CSS capture path works.

import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { ReplayEvent } from "../../src/shared/protocol.ts";
import { signIn } from "./auth.ts";
import { STYLE_PROBES, signature, textMatches, type Signature } from "./signature.ts";
import { startTarget, type Target } from "./target.ts";

let target: Target;
let base = "";
const OUT = path.resolve("test-results/roundtrip");

test.beforeAll(async () => {
  target = await startTarget();
  base = target.base;
  fs.mkdirSync(OUT, { recursive: true });
});

test.afterAll(async () => {
  await target.stop();
});

const sig = (page: Page) => page.evaluate(`(${signature.toString()})(document, ${JSON.stringify(STYLE_PROBES)})`) as Promise<Signature>;

async function settle(page: Page) {
  // Toasts disappear after 2.5 s; capture the stable state that the replay reaches before navigation.
  await page.waitForTimeout(3000);
}

async function moveAround(page: Page, points: [number, number][]) {
  for (const [x, y] of points) await page.mouse.move(x, y, { steps: 6 });
}

function compare(name: string, live: Signature, replay: Signature) {
  expect(replay.structure, name + ": structure").toEqual(live.structure);
  expect(replay.texts.length, name + ": text count").toBe(live.texts.length);
  const bad = live.texts.map((t, i) => [t, replay.texts[i]]).filter(([a, b]) => !textMatches(a, b));
  expect(bad, name + ": texts differ beyond masking").toEqual([]);
  expect(replay.scroll, name + ": scroll").toEqual(live.scroll);
  expect(replay.styles, name + ": computed styles").toEqual(live.styles);
}

test("record, replay and compare the demo shop", async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const live: Signature[] = [];
  const liveAt: number[] = [];

  // Page 1: home.
  await page.goto(base + "/demo/index.html");
  await page.waitForTimeout(600);
  // The visitor signs in partway through page 1; the whole session, later pages included, is theirs.
  await page.evaluate(() => (window as any).ReplayOwl.identify("owl-fan-7"));
  await moveAround(page, [[200, 300], [420, 260], [640, 420]]);
  await page.hover("#nav-shop");
  await page.waitForTimeout(400);
  const hoverAt = Date.now();
  await page.waitForTimeout(300);
  await page.click("#add-lantern");
  await page.click("#add-mug");
  await page.click("#open-modal");
  await page.waitForTimeout(300);
  await page.click("#modal-close");
  await page.click("#faq-1 summary");
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(400);
  await settle(page);
  live.push(await sig(page));
  liveAt.push(Date.now());
  await page.screenshot({ path: path.join(OUT, "live-1.png") });
  await page.hover("#nav-shop");
  await page.click("#nav-lantern");

  // Page 2: product.
  await page.waitForLoadState("load");
  await page.waitForTimeout(600);
  await page.click("#tab-specs");
  await page.locator("#rating button").nth(4).click();
  await page.hover("#reviews");
  await page.mouse.wheel(0, 260);
  await page.waitForTimeout(400);
  await page.click("#buggy-btn");
  await page.click("#add-product");
  await page.mouse.move(640, 300);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(400);
  await settle(page);
  live.push(await sig(page));
  liveAt.push(Date.now());
  await page.screenshot({ path: path.join(OUT, "live-2.png") });
  await page.click("#nav-checkout");

  // Page 3: checkout.
  await page.waitForLoadState("load");
  await page.waitForTimeout(600);
  await page.locator("#name").pressSequentially("Ada Lovelace", { delay: 25 });
  await page.locator("#email").pressSequentially("barn.owl@example.com", { delay: 15 });
  await page.locator("#password").pressSequentially("hunter2pass", { delay: 15 });
  await page.locator("#card").pressSequentially("4111 1111 1111 1111", { delay: 15 });
  await page.locator("#coupon").pressSequentially("NIGHT10", { delay: 20 });
  await page.locator("#gift").pressSequentially("Happy hooting, call me at 555 0100", { delay: 10 });
  await page.selectOption("#shipping", "express");
  await page.check("#wrap-box");
  await page.check("#terms");
  await page.click("#cart-add");
  await page.click("#cart-reorder");
  await page.click("#cart-highlight");
  await page.click("#cart-style");
  await page.evaluate(() => ((document.getElementById("coupon") as HTMLInputElement).value = "AUTO5"));
  const box = (await page.locator("#account-box").boundingBox())!;
  for (let i = 0; i < 4; i++) await page.mouse.click(box.x + 40, box.y + 10, { delay: 20 });
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(400);
  await settle(page);
  live.push(await sig(page));
  liveAt.push(Date.now());
  await page.screenshot({ path: path.join(OUT, "live-3.png") });
  // Leaving the page flushes the last batch.
  await page.goto("about:blank");
  await page.waitForTimeout(1500);

  expect(pageErrors.filter((m) => !/Demo crash/.test(m))).toEqual([]);

  // The admin API is closed without a sign-in.
  expect((await fetch(base + "/api/sessions")).status).toBe(401);

  // Sign in (first visit sets the admin password) and fetch the stored session.
  const viewer = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const viewerErrors: string[] = [];
  viewer.on("pageerror", (e) => viewerErrors.push(e.message));
  await signIn(viewer, base);
  const list = (await (await viewer.request.get(base + "/api/sessions")).json()).sessions;
  expect(list).toHaveLength(1);
  const summary = list[0];
  expect(summary.pages).toBe(3);
  expect(summary.errors).toBeGreaterThan(0);
  expect(summary.rageClicks).toBe(1);
  expect(summary.userIds).toEqual(["owl-fan-7"]);
  expect(summary.device).toBe("desktop");

  // Replay.
  await viewer.goto(base + "/replay?id=" + summary.id + "&autoplay=0");
  await viewer.waitForFunction(() => !!(window as any).replayer, null, { timeout: 30_000 });
  const events: ReplayEvent[] = await viewer.evaluate(() => (window as any).replayer.timeline.events);
  fs.writeFileSync(path.join(OUT, "session.json"), JSON.stringify({ summary, events }));
  // Later page loads of the session carry the id in their meta event.
  expect(events.filter((e) => e.k === "meta").map((e) => (e as { uid?: string }).uid)).toEqual([undefined, "owl-fan-7", "owl-fan-7"]);
  expect(events.filter((e) => e.k === "identify")).toHaveLength(1);

  // Privacy: nothing typed into masked fields reaches the server.
  const raw = JSON.stringify(events);
  for (const secret of ["Ada Lovelace", "barn.owl@example.com", "hunter2pass", "4111 1111", "4417-2291", "1,234.56"]) expect(raw).not.toContain(secret);
  expect(raw).toContain("NIGHT10");
  const segEnds: number[] = await viewer.evaluate(() => {
    const r = (window as any).replayer;
    const segs = r.timeline.segments;
    return segs.map((s: any, i: number) => (i + 1 < segs.length ? segs[i + 1].start - 1 : r.duration));
  });
  expect(segEnds).toHaveLength(3);

  const replaySig = async (t: number) => {
    await viewer.evaluate((t) => (window as any).replayer.seek(t), t);
    await viewer.waitForTimeout(700);
    // Scroll guards re-apply positions once late images have loaded; let one more seek settle them.
    await viewer.evaluate((t) => (window as any).replayer.seek(t), t);
    await viewer.waitForTimeout(150);
    return viewer.evaluate(
      `(${signature.toString()})(document.querySelector('.ro-frame.ro-front').contentDocument, ${JSON.stringify(STYLE_PROBES)})`,
    ) as Promise<Signature>;
  };

  const t0 = events[0].ts;
  for (let i = 0; i < 3; i++) {
    const rs = await replaySig(liveAt[i] - t0);
    await viewer.screenshot({ path: path.join(OUT, "replay-" + (i + 1) + ".png") });
    compare("page " + (i + 1), live[i], rs);
    if (i === 2) {
      expect(rs.values.coupon).toBe("AUTO5");
      expect(rs.values.terms).toBe(true);
      expect(rs.values["wrap-box"]).toBe(true);
      expect(rs.values.shipping).toBe("express");
      expect(String(rs.values.password)).toMatch(/^\*+$/);
      expect(String(rs.values.name)).toBe("*** ********");
      expect(rs.values.gift).toBe(live[i].values.gift);
    }
  }

  // Hover emulation: the CSS-only dropdown is open while the replayed cursor rests on the menu.
  await viewer.evaluate((t) => (window as any).replayer.seek(t), hoverAt - t0);
  await viewer.waitForTimeout(600);
  const dropdown = await viewer.evaluate(() => {
    const doc = (document.querySelector(".ro-frame.ro-front") as HTMLIFrameElement).contentDocument!;
    return doc.defaultView!.getComputedStyle(doc.getElementById("nav-dropdown")!).visibility;
  });
  expect(dropdown).toBe("visible");

  // Backward seek into an earlier page, then forward again, must land on the same state.
  await replaySig(segEnds[0] / 2);
  compare("page 3 after backward seek", live[2], await replaySig(segEnds[2]));

  // Real-time playback path (not the seek path) of the last page at high speed.
  await viewer.evaluate((t) => {
    const r = (window as any).replayer;
    r.seek(t);
    r.setSpeed(8);
    r.play();
  }, segEnds[1] + 1);
  await viewer.waitForFunction(() => !(window as any).replayer.playing, null, { timeout: 60_000 });
  await viewer.waitForTimeout(500);
  const played = (await viewer.evaluate(
    `(${signature.toString()})(document.querySelector('.ro-frame.ro-front').contentDocument, ${JSON.stringify(STYLE_PROBES)})`,
  )) as Signature;
  compare("page 3 after playback", live[2], played);
  expect(viewerErrors).toEqual([]);
});
