import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp, errorResponse, ingestRequest, sessionsRequest } from "../../src/server/app.ts";
import { withSchema } from "../../src/server/db.ts";
import { FsStorage } from "../../src/server/fs-storage.ts";
import { PgDb } from "../../src/server/pg.ts";
import type { SessionQuery } from "../../src/server/search.ts";
import { SessionStore, gzip } from "../../src/server/store.ts";
import type { IngestBatch, ReplayEvent } from "../../src/shared/protocol.ts";
import { freshDatabase } from "../pg.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
const ev = (ts: number, body: Record<string, unknown>) => ({ ts, ...body }) as unknown as ReplayEvent;
const meta = (ts: number, url: string, view: string, extra: Record<string, unknown> = {}) => ev(ts, { k: "meta", url, title: "", w: 800, h: 600, ua: "UA", view, ...extra });
const click = (ts: number, x: number) => ev(ts, { k: "click", x, y: 5, id: 1 });
const batch = (sid: string, view: string, seq: number, events: ReplayEvent[]): IngestBatch => ({ v: 1, sid, view, seq, events });

test("session store on postgres", async (t) => {
  const fresh = await freshDatabase();
  const db = PgDb.pool(fresh.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-store-"));
  const storage = new FsStorage(dir);
  const store = new SessionStore(storage, withSchema(db));
  const ids = async (q: Partial<SessionQuery> = {}) => (await store.search({ limit: 30, ...q })).sessions.map((s) => s.id);
  try {
    await t.test("ingest counts each batch once and continues rage clicks", async () => {
      await store.ingest(batch("sessionA1", "viewA0001", 0, [meta(1000, "https://shop.test/", "viewA0001"), click(1100, 5), click(1300, 5)]));
      // The same batch twice at once (a retry while the first attempt is in flight) and once more later.
      const second = batch("sessionA1", "viewA0001", 1, [click(1500, 6), ev(1600, { k: "log", level: "error", msg: "x" })]);
      await Promise.all([store.ingest(second, await gzip(JSON.stringify(second))), store.ingest(second)]);
      await store.ingest(second);
      const s = (await store.summary("sessionA1"))!;
      assert.equal(s.clicks, 3);
      assert.equal(s.rageClicks, 1);
      assert.equal(s.errors, 1);
      assert.equal(s.events, 5);
      assert.equal(s.pages, 1);
      assert.equal(s.duration, 600);
      assert.equal(s.firstUrl, "https://shop.test/");
      assert.deepEqual(s.userIds, []);
      assert.equal((await store.parts("sessionA1")).length, 2);
    });

    await t.test("out of order batches, two page views and identify", async () => {
      await store.ingest(batch("sessionB2", "viewB0001", 1, [click(5100, 9)]));
      await store.ingest(batch("sessionB2", "viewB0001", 0, [meta(5000, "https://Shop.Test/checkout/pay?x=1", "viewB0001", { ua: IPHONE }), ev(5050, { k: "identify", uid: "u-42" })]));
      await store.ingest(batch("sessionB2", "viewB0002", 0, [meta(9000, "https://shop.test/products/lantern", "viewB0002", { ua: IPHONE, uid: "u-42" })]));
      const s = (await store.summary("sessionB2"))!;
      assert.equal(s.startedAt, 5000);
      assert.equal(s.duration, 4000);
      assert.equal(s.firstUrl, "https://Shop.Test/checkout/pay?x=1");
      assert.equal(s.lastUrl, "https://shop.test/products/lantern");
      assert.equal(s.pages, 2);
      assert.equal(s.device, "mobile");
      assert.equal(s.ua, IPHONE);
      assert.deepEqual(s.userIds, ["u-42"]);
    });

    await t.test("user ids are capped at five per session and bad ones dropped", async () => {
      const many = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"].map((uid, i) => ev(20001 + i, { k: "identify", uid }));
      await store.ingest(batch("sessionC3", "viewC0001", 0, [meta(20000, "https://other.test/", "viewC0001"), ...many, ev(20010, { k: "identify", uid: "x".repeat(129) })]));
      await store.ingest(batch("sessionC3", "viewC0001", 1, [ev(20020, { k: "identify", uid: "late-user" })]));
      const s = (await store.summary("sessionC3"))!;
      assert.equal(s.userIds.length, 5);
      assert.equal(s.userIds.includes("late-user"), false);
    });

    await t.test("concurrent different batches of one session count exactly", async () => {
      const views = ["viewE0001", "viewE0002"];
      const all = views.flatMap((view, v) =>
        [0, 1, 2, 3, 4].map((seq) => {
          const base = 40000 + v * 10000 + seq * 1000;
          const events = [click(base + 100, seq * 100), ev(base + 200, { k: "log", level: "error", msg: "e" })];
          return batch("sessionE5", view, seq, seq === 0 ? [meta(base, "https://shop.test/" + view, view), ...events] : events);
        }),
      );
      await Promise.all(all.map((b) => store.ingest(b)));
      const s = (await store.summary("sessionE5"))!;
      assert.equal(s.events, 22);
      assert.equal(s.clicks, 10);
      assert.equal(s.errors, 10);
      assert.equal(s.pages, 2);
      assert.equal(s.firstUrl, "https://shop.test/viewE0001");
      assert.equal(s.duration, 54200 - 40000);
      await store.remove("sessionE5");
    });

    await t.test("ingest rejects or drops malformed input instead of failing", async () => {
      const app = createApp({ storage, db: withSchema(db), asset: async () => new Response(null, { status: 404 }) });
      const post = (body: unknown) => app(new Request("http://x/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      for (const seq of [1_000_000_000, 2 ** 31, -1, 1.5]) assert.equal((await post(batch("sessionF6", "viewF0001", seq, [click(1, 1)]))).status, 400, "seq " + seq);
      const bad = [
        ev(1e300, { k: "click", x: 1, y: 1, id: 1 }), ev(1.5, { k: "click", x: 1, y: 1, id: 1 }), { k: "click", ts: "1", x: 1, y: 1 },
        meta(60000, "https://shop.test/bad", "viewF0001", { w: "800" }), meta(60000, "https://shop.test/bad", "viewF0001", { w: 1e12 }),
        meta(60000, "https://shop.test/bad", "viewF0001", { ua: 5 }), meta(60000, "https://shop.test/bad", "viewF0001", { url: null }),
        meta(60000, "https://shop.test/bad", "viewF0001", { title: undefined }), meta(60000, "https://shop.test/bad", "viewF0001", { view: 7 }),
      ];
      const res = await post(batch("sessionF6", "viewF0001", 999_999_999, [...bad, meta(60000, "https://shop.test/ok", "viewF0001"), click(60100, 1)] as ReplayEvent[]));
      assert.equal(res.status, 204);
      const s = (await store.summary("sessionF6"))!;
      assert.equal(s.events, 2);
      assert.equal(s.pages, 1);
      assert.equal(s.firstUrl, "https://shop.test/ok");
      assert.equal(s.w, 800);
      await store.remove("sessionF6");
    });

    await t.test("search filters", async () => {
      assert.deepEqual(await ids(), ["sessionC3", "sessionB2", "sessionA1"]);
      assert.deepEqual(await ids({ user: "u-42" }), ["sessionB2"]);
      assert.deepEqual(await ids({ user: "nobody" }), []);
      assert.deepEqual(await ids({ url: { host: null, path: "/checkout", mode: "prefix" } }), ["sessionB2"]);
      assert.deepEqual(await ids({ url: { host: null, path: "/checkout", mode: "exact" } }), []);
      assert.deepEqual(await ids({ url: { host: null, path: "/checkout/pay", mode: "exact" } }), ["sessionB2"]);
      assert.deepEqual(await ids({ url: { host: null, path: "lant", mode: "contains" } }), ["sessionB2"]);
      assert.deepEqual(await ids({ url: { host: "other.test", path: "/", mode: "prefix" } }), ["sessionC3"]);
      assert.deepEqual(await ids({ url: { host: "shop.test", path: "/", mode: "prefix" } }), ["sessionB2", "sessionA1"]);
      assert.deepEqual(await ids({ site: "shop.test" }), ["sessionB2", "sessionA1"]);
      assert.deepEqual(await ids({ site: "other.test" }), ["sessionC3"]);
      assert.deepEqual(await ids({ site: "shop.test", url: { host: null, path: "/checkout", mode: "prefix" } }), ["sessionB2"]);
      assert.deepEqual(await ids({ site: "other.test", url: { host: null, path: "/checkout", mode: "prefix" } }), [], "site and page match one page view");
      assert.deepEqual(await store.sites(), [{ host: "shop.test", sessions: 2 }, { host: "other.test", sessions: 1 }]);
      assert.deepEqual(await ids({ errors: true }), ["sessionA1"]);
      assert.deepEqual(await ids({ rage: true }), ["sessionA1"]);
      assert.deepEqual(await ids({ device: "mobile" }), ["sessionB2"]);
      assert.deepEqual(await ids({ minPages: 2 }), ["sessionB2"]);
      assert.deepEqual(await ids({ minDuration: 1000 }), ["sessionB2"]);
      assert.deepEqual(await ids({ maxDuration: 700 }), ["sessionC3", "sessionA1"]);
      assert.deepEqual(await ids({ from: 5000 }), ["sessionC3", "sessionB2"]);
      assert.deepEqual(await ids({ to: 5000 }), ["sessionB2", "sessionA1"]);
      assert.deepEqual(await ids({ user: "u-42", device: "desktop" }), []);
      const page = await store.search({ limit: 3 });
      assert.deepEqual(page.sessions.find((s) => s.id === "sessionB2")!.userIds, ["u-42"]);
    });

    await t.test("keyset pagination", async () => {
      const p1 = await store.search({ limit: 1 });
      assert.deepEqual(p1.sessions.map((s) => s.id), ["sessionC3"]);
      const p2 = await store.search({ limit: 1, cursor: decode(p1.next!) });
      assert.deepEqual(p2.sessions.map((s) => s.id), ["sessionB2"]);
      const p3 = await store.search({ limit: 1, cursor: decode(p2.next!) });
      assert.deepEqual(p3.sessions.map((s) => s.id), ["sessionA1"]);
      assert.equal(p3.next, null);
    });

    await t.test("summary of unknown or malformed ids, and delete", async () => {
      assert.equal(await store.summary("missing00"), null);
      assert.equal(await store.summary("bad"), null);
      await store.remove("sessionA1");
      assert.equal(await store.summary("sessionA1"), null);
      assert.deepEqual(await store.parts("sessionA1"), []);
      assert.deepEqual(await ids(), ["sessionC3", "sessionB2"]);
      // A new upload after delete starts the session over.
      await store.ingest(batch("sessionA1", "viewA0002", 0, [meta(30000, "https://shop.test/again", "viewA0002")]));
      assert.equal((await store.summary("sessionA1"))!.pages, 1);
    });

    await t.test("exported handlers serve one project's store and can refuse deletion", async () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-store-"));
      try {
        const other = new SessionStore(new FsStorage(otherDir), withSchema(db), "project-three");
        const call = async (fn: () => Promise<Response>) => fn().catch((err) => errorResponse(err));
        const up = batch("sessionG7", "viewG0001", 0, [meta(80000, "https://three.test/", "viewG0001")]);
        const posted = await call(() => ingestRequest(new Request("http://x/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(up) }), other));
        assert.equal(posted.status, 204);
        assert.equal(posted.headers.get("access-control-allow-origin"), "*");
        const url = new URL("http://x/p/three/api/sessions/sessionG7");
        const get = await call(() => sessionsRequest(new Request(url), url, "/sessionG7", other));
        assert.equal((await get.json()).summary.firstUrl, "https://three.test/");
        const list = await call(() => sessionsRequest(new Request(url), url, "", other));
        assert.deepEqual((await list.json()).sessions.map((s: { id: string }) => s.id), ["sessionG7"]);
        const refused = await call(() => sessionsRequest(new Request(url, { method: "DELETE" }), url, "/sessionG7", other, { canDelete: false }));
        assert.equal(refused.status, 403);
        assert.ok(await other.summary("sessionG7"));
        const deleted = await call(() => sessionsRequest(new Request(url, { method: "DELETE" }), url, "/sessionG7", other));
        assert.equal(deleted.status, 204);
        assert.equal(await other.summary("sessionG7"), null);
        assert.equal(await store.summary("sessionG7"), null);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    await t.test("projects sharing the database see only their own sessions", async () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-store-"));
      try {
        const other = new SessionStore(new FsStorage(otherDir), withSchema(db), "project-two");
        // The same session id as one in the default project, with different content.
        await other.ingest(batch("sessionC3", "viewX0001", 0, [meta(70000, "https://two.test/", "viewX0001"), ev(70001, { k: "identify", uid: "u-42" }), click(70100, 1)]));
        assert.deepEqual((await other.search({ limit: 30 })).sessions.map((s) => s.id), ["sessionC3"]);
        assert.deepEqual((await other.search({ limit: 30, user: "u-42" })).sessions.map((s) => s.id), ["sessionC3"]);
        assert.deepEqual((await other.search({ limit: 30, url: { host: "shop.test", path: "/", mode: "prefix" } })).sessions, []);
        assert.equal((await other.summary("sessionC3"))!.firstUrl, "https://two.test/");
        assert.equal((await other.summary("sessionB2")), null);
        assert.equal((await store.summary("sessionC3"))!.firstUrl, "https://other.test/");
        assert.equal((await store.summary("sessionC3"))!.userIds.length, 5);
        assert.deepEqual(await ids({ user: "u-42" }), ["sessionB2"]);
        await other.remove("sessionC3");
        assert.equal(await other.summary("sessionC3"), null);
        assert.equal((await store.summary("sessionC3"))!.pages, 1);
        assert.equal((await store.parts("sessionC3")).length, 2);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });
  } finally {
    await db.close();
    await fresh.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function decode(cursor: string) {
  const [startedAt, id] = cursor.split(".");
  return { startedAt: Number(startedAt), id };
}
