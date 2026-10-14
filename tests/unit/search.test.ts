import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchError, encodeCursor, parseSearch, parseUrlInput, splitUrl } from "../../src/server/search.ts";

test("stored urls split into lowercase host and path without query", () => {
  assert.deepEqual(splitUrl("https://Shop.Test:8443/Check%20out/?a=1#top"), { host: "shop.test:8443", path: "/Check%20out/" });
  assert.deepEqual(splitUrl("http://127.0.0.1:8790/demo/"), { host: "127.0.0.1:8790", path: "/demo/" });
  assert.equal(splitUrl("not a url"), null);
});

test("search input accepts paths, hosts, schemes, queries and fragments", () => {
  assert.deepEqual(parseUrlInput("/checkout?x=1#a", "prefix"), { host: null, path: "/checkout" });
  assert.deepEqual(parseUrlInput("checkout", "prefix"), { host: null, path: "/checkout" });
  assert.deepEqual(parseUrlInput("checkout", "contains"), { host: null, path: "checkout" });
  assert.deepEqual(parseUrlInput("/check", "contains"), { host: null, path: "/check" });
  assert.deepEqual(parseUrlInput(" Shop.Test/checkout ", "prefix"), { host: "shop.test", path: "/checkout" });
  assert.deepEqual(parseUrlInput("http://127.0.0.1:8790/demo/", "exact"), { host: "127.0.0.1:8790", path: "/demo/" });
  assert.deepEqual(parseUrlInput("shop.test", "prefix"), { host: "shop.test", path: "/" });
  assert.deepEqual(parseUrlInput("/a b", "exact"), { host: null, path: "/a%20b" });
  assert.equal(parseUrlInput("   ", "prefix"), null);
  assert.equal(parseUrlInput("?only=query", "prefix"), null);
});

test("odd search input is normalized or rejected, never thrown", () => {
  assert.throws(() => parseSearch(new URLSearchParams("url=//[")), SearchError);
  assert.deepEqual(parseUrlInput("//evil.com/x", "prefix"), { host: "evil.com", path: "/x" });
  assert.equal(parseUrlInput("/\\foo", "prefix"), null);
  assert.equal(parseUrlInput("a/../..", "contains"), null);
  assert.deepEqual(parseUrlInput("/../x", "prefix"), { host: null, path: "/x" });
});

test("search parameters are parsed and validated", () => {
  const p = (s: string) => parseSearch(new URLSearchParams(s));
  assert.deepEqual(p(""), { limit: 30 });
  assert.deepEqual(p("user=&url=&device=&minDuration="), { limit: 30 });
  assert.deepEqual(
    p("user=%20u-1%20&url=/checkout&urlMode=exact&from=10&to=20&minDuration=5&maxDuration=60&minPages=2&errors=1&rage=1&device=mobile&limit=500"),
    { limit: 100, user: "u-1", url: { host: null, path: "/checkout", mode: "exact" }, from: 10, to: 20, minDuration: 5000, maxDuration: 60000, minPages: 2, errors: true, rage: true, device: "mobile" },
  );
  assert.deepEqual(p("url=/x").url, { host: null, path: "/x", mode: "prefix" });
  assert.equal(p("errors=0").errors, undefined);
  const cursor = encodeCursor({ startedAt: 1700000000000, id: "sessionA1" });
  assert.deepEqual(p("cursor=" + encodeURIComponent(cursor)).cursor, { startedAt: 1700000000000, id: "sessionA1" });
  for (const bad of ["minDuration=abc", "minDuration=-1", "from=1e400", "device=tv", "urlMode=regex", "cursor=nope", "minPages=0", "limit=0", "user=" + "x".repeat(129), "url=" + "/a".repeat(1100), "url=%3F"]) {
    assert.throws(() => p(bad), SearchError, bad);
  }
});
