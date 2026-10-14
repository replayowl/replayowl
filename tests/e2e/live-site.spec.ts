// Records real websites by injecting the recorder, then compares the replay with the live page.
// Needs network access, so it only runs when LIVE_URLS is set:
//   LIVE_URLS="https://en.wikipedia.org/wiki/Owl https://react.dev" npx playwright test live-site

import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../../src/server/index.ts";
import { PgDb } from "../../src/server/pg.ts";
import { freshDatabase } from "../pg.ts";
import { signIn } from "./auth.ts";
import { signature, textMatches, type Signature } from "./signature.ts";

const urls = (process.env.LIVE_URLS || "").split(/\s+/).filter(Boolean);
const OUT = path.resolve("test-results/live");
let server: Server;
let base = "";
let dataDir = "";
let db: PgDb;
let dropDb: () => Promise<void>;

test.skip(!urls.length, "set LIVE_URLS to run");

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "replayowl-live-"));
  const fresh = await freshDatabase();
  db = PgDb.pool(fresh.url);
  dropDb = fresh.drop;
  server = startServer({ port: 0, host: "127.0.0.1", dataDir, db });
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  fs.mkdirSync(OUT, { recursive: true });
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  await dropDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const [n, url] of urls.entries()) {
  test("live site " + url, async ({ browser }) => {
    const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1280, height: 800 } });
    // Public pages may not call loopback addresses (Local Network Access), so the recorder posts to a
    // public-looking endpoint that the test forwards to the local server.
    await ctx.route("https://collector.replayowl.test/**", async (route) => {
      const req = route.request();
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, content-encoding", "access-control-allow-methods": "POST, OPTIONS" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const res = await fetch(base + "/api/ingest", { method: "POST", headers: req.headers(), body: new Uint8Array(req.postDataBuffer() || []) });
      return route.fulfill({ status: res.status, headers: cors, body: "" });
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.addScriptTag({ path: path.resolve("dist/public/recorder.js") });
    await page.evaluate((endpoint) => (window as any).ReplayOwl.start({ endpoint }), "https://collector.replayowl.test/api/ingest");
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(200 + i * 120, 200 + (i % 3) * 120, { steps: 8 });
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(2500);
    const at = Date.now();
    const live = (await page.evaluate(`(${signature.toString()})(document, [])`)) as Signature;
    await page.screenshot({ path: path.join(OUT, n + "-live.png") });
    await page.evaluate(() => (window as any).ReplayOwl.stop());
    await page.waitForTimeout(1500);
    await ctx.close();

    const viewer = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors: string[] = [];
    viewer.on("pageerror", (e) => errors.push(e.message));
    await signIn(viewer, base);
    const list = (await (await viewer.request.get(base + "/api/sessions")).json()).sessions;
    const id = list.find((s: { firstUrl: string }) => s.firstUrl.startsWith(new URL(url).origin))?.id;
    expect(id).toBeTruthy();
    await viewer.goto(base + "/replay?id=" + id + "&autoplay=0");
    await viewer.waitForFunction(() => !!(window as any).replayer);
    const t0 = await viewer.evaluate(() => (window as any).replayer.timeline.t0);
    const started = Date.now();
    await viewer.evaluate((t) => (window as any).replayer.seek(t), at - t0);
    const seekMs = Date.now() - started;
    await viewer.waitForTimeout(2500);
    await viewer.evaluate((t) => (window as any).replayer.seek(t), at - t0);
    await viewer.waitForTimeout(300);
    await viewer.screenshot({ path: path.join(OUT, n + "-replay.png") });
    const replay = (await viewer.evaluate(`(${signature.toString()})(document.querySelector('.ro-frame.ro-front').contentDocument, [])`)) as Signature;

    const textDiffs = live.texts.map((t, i) => [t, replay.texts[i]]).filter(([a, b]) => b === undefined || !textMatches(a, b));
    const report = {
      url,
      nodesLive: live.structure.length,
      nodesReplay: replay.structure.length,
      firstStructureDiff: live.structure.findIndex((s, i) => s !== replay.structure[i]),
      texts: live.texts.length,
      textDiffs: textDiffs.length,
      scroll: [live.scroll.window, replay.scroll.window],
      seekMs,
      viewerErrors: errors,
    };
    fs.writeFileSync(path.join(OUT, n + "-report.json"), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report));
    expect(errors).toEqual([]);
    expect(replay.structure.length).toBe(live.structure.length);
    expect(replay.scroll.window).toBe(live.scroll.window);
  });
}
