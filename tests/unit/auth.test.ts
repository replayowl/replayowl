import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminStore, LoginLimiter, checkSession, hashPassword, issueSession, readCookie, verifyPassword } from "../../src/server/auth.ts";
import { withSchema } from "../../src/server/db.ts";
import { PgDb } from "../../src/server/pg.ts";
import { freshDatabase } from "../pg.ts";

test("passwords verify only with the right input", async () => {
  const cfg = await hashPassword("correct horse");
  assert.equal(await verifyPassword(cfg, "correct horse"), true);
  assert.equal(await verifyPassword(cfg, "correct horsE"), false);
  assert.equal(await verifyPassword(cfg, ""), false);
  assert.notEqual(cfg.hash, (await hashPassword("correct horse")).hash, "salted");
});

test("session cookies reject tampering, expiry and a rotated secret", async () => {
  const cfg = await hashPassword("pw-12345678");
  const now = Date.now();
  const v = await issueSession(cfg, now);
  assert.equal(await checkSession(cfg, v, now), true);
  const [exp, nonce, sig] = v.split(".");
  assert.equal(await checkSession(cfg, String(Number(exp) + 1) + "." + nonce + "." + sig, now), false);
  assert.equal(await checkSession(cfg, exp + "." + nonce + "." + sig.slice(0, -2) + "AA", now), false);
  assert.equal(await checkSession(cfg, v, Number(exp) + 1), false);
  assert.equal(await checkSession(await hashPassword("pw-12345678"), v, now), false);
  assert.equal(await checkSession(cfg, null, now), false);
  assert.equal(await checkSession(cfg, "garbage", now), false);
});

test("cookie header parsing", () => {
  assert.equal(readCookie("a=1; ro_session=x.y.z; b=2"), "x.y.z");
  assert.equal(readCookie("a=1"), null);
  assert.equal(readCookie(null), null);
});

test("login limiter blocks after repeated failures", () => {
  const l = new LoginLimiter();
  const t = 1_000_000;
  for (let i = 0; i < 4; i++) l.fail("1.2.3.4", t);
  assert.equal(l.blocked("1.2.3.4", t), 0);
  l.fail("1.2.3.4", t);
  assert.ok(l.blocked("1.2.3.4", t) > 0);
  assert.equal(l.blocked("5.6.7.8", t), 0);
  l.succeed("1.2.3.4");
  assert.equal(l.blocked("1.2.3.4", t), 0);
});

test("admin config lives in the settings table and setup cannot run twice", async () => {
  const fresh = await freshDatabase();
  const db = PgDb.pool(fresh.url);
  try {
    const sdb = withSchema(db);
    const store = new AdminStore(sdb);
    assert.equal(await store.get(true), null);
    const a = await hashPassword("first-password");
    const b = await hashPassword("second-password");
    // Two isolates setting the password at the same moment: exactly one wins.
    const results = await Promise.all([store.create(a), new AdminStore(sdb).create(b)]);
    assert.deepEqual(results.sort(), [false, true]);
    const winner = (await new AdminStore(sdb).get(true))!;
    await store.set({ ...winner, updatedAt: 1 });
    assert.equal((await new AdminStore(sdb).get(true))!.updatedAt, 1);
  } finally {
    await db.close();
    await fresh.drop();
  }
});
