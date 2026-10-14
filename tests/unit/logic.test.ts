import assert from "node:assert/strict";
import { test } from "node:test";
import { batchDelta, deviceOf, findIdleRanges, findRageClicks, summarize, userIdsOf } from "../../src/shared/analyze.ts";
import type { ReplayEvent } from "../../src/shared/protocol.ts";
import { rewritePseudo, transformCss } from "../../src/player/css.ts";
import { Timeline } from "../../src/player/timeline.ts";
import { Transport } from "../../src/recorder/transport.ts";
import { gunzip } from "../../src/server/store.ts";

const meta = (ts: number, url = "https://shop.test/a"): ReplayEvent => ({ k: "meta", ts, url, title: "", w: 1280, h: 800, ua: "UA", view: "v" + ts });
const click = (ts: number, x: number, y: number): ReplayEvent => ({ k: "click", ts, x, y, id: 1 });
const move = (ts: number, x: number, y: number): ReplayEvent => ({ k: "move", ts, x, y });

test("interactive pseudo-classes become attribute selectors", () => {
  assert.equal(rewritePseudo("a:hover, b:focus, c:focus-visible, d:focus-within, e:active{}"), "a[ro-hover], b[ro-focus], c[ro-focus], d[ro-focus-within], e[ro-active]{}");
  assert.equal(rewritePseudo(".x:not(:hover)::before{}"), ".x:not([ro-hover])::before{}");
});

test("css urls resolve against the recorded page", () => {
  const css = transformCss('.a{background:url(img/x.png)} .b{background:url("data:image/png;base64,AA")} @import "theme.css";', "https://shop.test/app/page.html");
  assert.match(css, /url\(https:\/\/shop\.test\/app\/img\/x\.png\)/);
  assert.match(css, /url\("data:image\/png;base64,AA"\)/);
  assert.match(css, /@import "https:\/\/shop\.test\/app\/theme\.css"/);
});

test("rage clicks need three quick clicks in one spot", () => {
  const evs = [click(0, 10, 10), click(200, 12, 11), click(380, 11, 9), click(5000, 10, 10), click(5600, 10, 10), click(9000, 300, 300), click(9100, 10, 10), click(9200, 500, 10)];
  const rage = findRageClicks(evs);
  assert.equal(rage.length, 1);
  assert.equal(rage[0].ts, 0);
});

test("idle ranges cover gaps without user activity", () => {
  const evs = [meta(0), move(100, 1, 1), move(200, 2, 2), move(10_200, 3, 3)];
  const idle = findIdleRanges(evs, 0, 12_000);
  assert.deepEqual(idle, [{ start: 700, end: 9700 }]);
});

test("scrolls, inputs and focus changes made by page script do not count as activity", () => {
  const evs: ReplayEvent[] = [meta(0), move(100, 1, 1)];
  for (let ts = 1000; ts < 10_000; ts += 1000) evs.push({ k: "scroll", ts, id: 5, x: 0, y: ts / 10, auto: true });
  evs.push({ k: "input", ts: 4500, id: 6, v: "x", auto: true }, { k: "focus", ts: 5500, id: 6, auto: true }, move(10_200, 3, 3));
  assert.deepEqual(findIdleRanges(evs, 0, 12_000), [{ start: 600, end: 9700 }]);
});

test("cursor rests between distant samples and glides just before the next one", () => {
  const tl = new Timeline([meta(0), move(1000, 0, 0), move(3000, 100, 0)]);
  assert.equal(tl.cursorAt(500), null);
  assert.deepEqual(tl.cursorAt(2000), { x: 0, y: 0 });
  const p = tl.cursorAt(2930)!;
  assert.ok(p.x > 0 && p.x < 100);
  assert.deepEqual(tl.cursorAt(3500), { x: 100, y: 0 });
});

test("cursor follows a smooth curve through dense samples", () => {
  const tl = new Timeline([meta(0), move(0, 0, 0), move(40, 40, 0), move(80, 80, 40), move(120, 80, 80)]);
  const mid = tl.cursorAt(60)!;
  assert.ok(mid.x > 40 && mid.x < 80);
  assert.ok(mid.y > 0 && mid.y < 40);
});

test("segments split on page loads and know their snapshot", () => {
  const snap: ReplayEvent = { k: "snapshot", ts: 1, snap: { doctype: "", children: [] } };
  const tl = new Timeline([meta(0), snap, move(500, 1, 1), meta(2000, "https://shop.test/b"), { ...snap, ts: 2001 }]);
  assert.equal(tl.segments.length, 2);
  assert.equal(tl.segments[1].snapIdx, 4);
  assert.equal(tl.segmentAt(1999)!.index, 0);
  assert.equal(tl.segmentAt(2000)!.index, 1);
});

test("input markers collapse a typing burst into its final value", () => {
  const input = (ts: number, v: string): ReplayEvent => ({ k: "input", ts, id: 7, v });
  const tl = new Timeline([meta(0), input(100, "N"), input(150, "NI"), input(200, "NIGHT10"), input(9000, "X")]);
  const labels = tl.markers.filter((m) => m.kind === "input").map((m) => m.label);
  assert.deepEqual(labels, ["Typed “NIGHT10”", "Typed “X”"]);
});

test("summary counts pages, clicks and errors", () => {
  const s = summarize("abc", [{ ...meta(0), uid: "u-1" } as ReplayEvent, click(100, 1, 1), { k: "log", ts: 200, level: "error", msg: "boom" }, meta(1000, "https://shop.test/b")]);
  assert.equal(s.pages, 2);
  assert.equal(s.clicks, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.duration, 1000);
  assert.equal(s.lastUrl, "https://shop.test/b");
  assert.equal(s.device, "desktop");
  assert.deepEqual(s.userIds, ["u-1"]);
});

test("device type comes from the user agent", () => {
  assert.equal(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148"), "mobile");
  assert.equal(deviceOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36"), "mobile");
  assert.equal(deviceOf("Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Safari/537.36"), "tablet");
  assert.equal(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "tablet");
  assert.equal(deviceOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0"), "desktop");
  assert.equal(deviceOf(""), "desktop");
});

test("batch delta counts one batch and continues rage clicks from the previous tail", () => {
  const first = batchDelta([meta(1000), click(1100, 5, 5), click(1300, 5, 5)]);
  assert.equal(first.rageClicks, 0);
  assert.equal(first.clicks, 2);
  assert.equal(first.events, 3);
  assert.deepEqual(first.pages.map((p) => p.url), ["https://shop.test/a"]);
  assert.equal(first.tail.length, 2);
  const second = batchDelta([click(1500, 6, 5), { k: "log", ts: 1600, level: "error", msg: "x" }], first.tail);
  assert.equal(second.rageClicks, 1);
  assert.equal(second.errors, 1);
  assert.equal(second.startedAt, 1500);
  assert.equal(second.endedAt, 1600);
  assert.equal(second.tail.length, 3);
  // A fourth click continuing the same burst is not a second rage click.
  assert.equal(batchDelta([click(1700, 6, 5)], second.tail).rageClicks, 0);
});

test("user ids come from identify and meta events, valid and unique", () => {
  const ids = userIdsOf([
    { ...meta(0), uid: "u-1" } as ReplayEvent,
    { k: "identify", ts: 5, uid: "u-1" },
    { k: "identify", ts: 6, uid: "x".repeat(129) },
    { k: "identify", ts: 7, uid: 42 as unknown as string },
    { k: "identify", ts: 8, uid: "" },
    { k: "identify", ts: 9, uid: "u-2" },
  ]);
  assert.deepEqual(ids, ["u-1", "u-2"]);
});

test("transport: hiding the page resends the batch in flight once as it is, and no newer batch is dropped", async (t) => {
  const sent: { seq: number; events: number; keepalive: boolean; flush: boolean }[] = [];
  const pending: (() => void)[] = [];
  let flushing = false;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const flush = flushing;
    const raw = init.body instanceof ArrayBuffer ? new TextDecoder().decode(await gunzip(new Uint8Array(init.body))) : String(init.body);
    const b = JSON.parse(raw);
    sent.push({ seq: b.seq, events: b.events.length, keepalive: !!init.keepalive, flush });
    // Uploads from pump() stay in flight until released; those from flushNow() finish at once.
    if (!flush) await new Promise<void>((r) => pending.push(r));
    return new Response(null, { status: 204 });
  });
  const tr = new Transport("http://x/api/ingest", "sessionT1", "viewT0001");
  const big = (n: number) => {
    for (let i = 0; i < n; i++) tr.push({ k: "log", ts: i, level: "info", msg: "x".repeat(400) } as ReplayEvent);
    tr.flush();
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; !cond(); i++) {
      if (i > 200) assert.fail("timed out; sent " + JSON.stringify(sent));
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  // Seq 0, over the keepalive limit, is in flight through pump() when the page is hidden; seq 1 waits behind it.
  big(300);
  await until(() => pending.length === 1);
  big(300);
  tr.push(move(1000, 1, 1));
  flushing = true;
  tr.flushNow();
  flushing = false;
  const flushed = sent.filter((x) => x.flush);
  // The batch in flight goes out once more, whole and with its own seq (too large for keepalive).
  assert.deepEqual(flushed[0], { seq: 0, events: 300, keepalive: false, flush: true });
  // The unsent batches are split to fit keepalive, every piece with a seq of its own.
  const rest = flushed.slice(1);
  assert.ok(rest.length > 2);
  assert.ok(rest.every((x) => x.keepalive && x.seq !== 0));
  assert.equal(new Set(rest.map((x) => x.seq)).size, rest.length);
  assert.equal(rest.reduce((n, x) => n + x.events, 0), 301);
  // A newer batch queued while seq 0 is still in flight must survive seq 0 finishing.
  tr.push(move(2000, 2, 2));
  tr.flush();
  pending.shift()!();
  await until(() => pending.length === 1);
  pending.shift()!();
  const maxSeq = Math.max(...rest.map((x) => x.seq));
  assert.deepEqual(sent.filter((x) => !x.flush), [
    { seq: 0, events: 300, keepalive: false, flush: false },
    { seq: maxSeq + 1, events: 1, keepalive: false, flush: false },
  ]);
  assert.equal(sent.filter((x) => x.seq === 0).length, 2);
});
