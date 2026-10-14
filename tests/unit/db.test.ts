import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SQLITE, schema, schemaObjects, withSchema, type Db, type Param } from "../../src/server/db.ts";
import { PgDb } from "../../src/server/pg.ts";
import { freshDatabase } from "../pg.ts";

test("postgres: placeholders, atomic batches, unique violations, bigint numbers", async () => {
  const fresh = await freshDatabase();
  const raw = PgDb.pool(fresh.url);
  const db = withSchema(raw);
  try {
    await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ["a", "1"]);
    assert.deepEqual(await db.all("SELECT key, value FROM settings WHERE key = ?", ["a"]), [{ key: "a", value: "1" }]);

    // A failing statement rolls the whole batch back, and the error is recognised as a unique violation.
    await assert.rejects(
      db.batch([
        { sql: "INSERT INTO settings (key, value) VALUES (?, ?)", params: ["b", "2"] },
        { sql: "INSERT INTO settings (key, value) VALUES (?, ?)", params: ["a", "3"] },
      ]),
      (err) => db.isUniqueViolation(err),
    );
    assert.deepEqual(await db.all("SELECT key FROM settings ORDER BY key"), [{ key: "a" }]);
    assert.equal(db.isUniqueViolation(new Error("other")), false);

    // Creating the schema again is harmless.
    for (const sql of schema(raw.dialect)) await raw.run(sql);

    // Millisecond timestamps come back as numbers, not strings.
    assert.deepEqual(await db.all("SELECT CAST(? AS BIGINT) AS n", [1700000000123]), [{ n: 1700000000123 }]);
  } finally {
    await raw.close();
    await fresh.drop();
  }
});

/** Records every statement sent to `db`; `failRuns` makes that many run() calls fail first. */
function spy(db: Db, failRuns = 0) {
  const sql: string[] = [];
  let fails = failRuns;
  const wrapped: Db = {
    dialect: db.dialect,
    all: (q, p) => (sql.push(q), db.all(q, p)),
    run: async (q, p) => {
      sql.push(q);
      if (fails > 0 && fails--) throw new Error("connection reset");
      await db.run(q, p);
    },
    batch: (s) => db.batch(s),
    isUniqueViolation: (e) => db.isUniqueViolation(e),
  };
  return { db: wrapped, sql, creates: () => sql.filter((q) => q.startsWith("CREATE")).length };
}

test("postgres: schema DDL is skipped when every table and index exists, and a failure is not cached", async () => {
  const fresh = await freshDatabase();
  const raw = PgDb.pool(fresh.url);
  try {
    assert.equal(schemaObjects(raw.dialect).length, schema(raw.dialect).length);
    // Both attempts of the first call fail; the next call tries again instead of reusing the failure.
    const failing = spy(raw, 2);
    const db = withSchema(failing.db);
    await assert.rejects(db.all("SELECT 1"), /connection reset/);
    await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ["a", "1"]);
    // Checked once: later statements neither probe nor create.
    const before = failing.sql.length;
    await db.all("SELECT key FROM settings");
    assert.deepEqual(failing.sql.slice(before), ["SELECT key FROM settings"]);

    // A new process finds the schema and runs no DDL, also when several first requests arrive at once.
    const next = spy(raw);
    const db2 = withSchema(next.db);
    await Promise.all([db2.all("SELECT 1"), db2.all("SELECT 1"), db2.all("SELECT 1")]);
    assert.equal(next.creates(), 0);

    // A missing index is noticed and the DDL runs again.
    await raw.run("DROP INDEX session_users_user");
    const third = spy(raw);
    await withSchema(third.db).all("SELECT 1");
    assert.equal(third.creates(), schema(raw.dialect).length);
  } finally {
    await raw.close();
    await fresh.drop();
  }
});

test("sqlite: the schema probe sees the created tables and indexes", async () => {
  const lite = new DatabaseSync(":memory:");
  const raw: Db = {
    dialect: SQLITE,
    all: async <T>(q: string, p: Param[] = []) => lite.prepare(q).all(...p) as T[],
    run: async (q, p = []) => void lite.prepare(q).run(...p),
    batch: async () => assert.fail("unused"),
    isUniqueViolation: () => false,
  };
  try {
    const first = spy(raw);
    await withSchema(first.db).all("SELECT 1");
    assert.equal(first.creates(), schema(SQLITE).length);
    const second = spy(raw);
    await withSchema(second.db).all("SELECT 1");
    assert.equal(second.creates(), 0);
  } finally {
    lite.close();
  }
});
