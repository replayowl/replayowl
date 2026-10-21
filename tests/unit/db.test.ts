import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT, SQLITE, schema, schemaObjects, withSchema, type Db, type Param } from "../../src/server/db.ts";
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
    await raw.run("DROP INDEX session_users_project_user");
    const third = spy(raw);
    await withSchema(third.db).all("SELECT 1");
    assert.equal(third.creates(), schema(raw.dialect).length);
  } finally {
    await raw.close();
    await fresh.drop();
  }
});

function sqlite(lite: DatabaseSync): Db {
  return {
    dialect: SQLITE,
    all: async <T>(q: string, p: Param[] = []) => lite.prepare(q).all(...p).map((r) => ({ ...r })) as T[],
    run: async (q, p = []) => void lite.prepare(q).run(...p),
    batch: async (statements) => {
      lite.exec("BEGIN");
      try {
        for (const s of statements) lite.prepare(s.sql).run(...(s.params || []));
        lite.exec("COMMIT");
      } catch (err) {
        lite.exec("ROLLBACK");
        throw err;
      }
    },
    isUniqueViolation: () => false,
  };
}

test("sqlite: the schema probe sees the created tables and indexes", async () => {
  const lite = new DatabaseSync(":memory:");
  const raw = sqlite(lite);
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

// Tables as created by versions without projects, with one row each.
const V1 = [
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at BIGINT NOT NULL, ended_at BIGINT NOT NULL, duration BIGINT NOT NULL,
    first_url TEXT NOT NULL, first_ts BIGINT NOT NULL, last_url TEXT NOT NULL, last_ts BIGINT NOT NULL, pages INTEGER NOT NULL,
    ua TEXT NOT NULL, device TEXT NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, events INTEGER NOT NULL, clicks INTEGER NOT NULL,
    rage_clicks INTEGER NOT NULL, errors INTEGER NOT NULL, inputs INTEGER NOT NULL)`,
  "CREATE INDEX sessions_started ON sessions (started_at DESC, id DESC)",
  "CREATE TABLE session_pages (session_id TEXT NOT NULL, view TEXT NOT NULL, ts BIGINT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (session_id, view))",
  "CREATE INDEX session_pages_path ON session_pages (path, session_id)",
  "CREATE TABLE session_users (session_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (session_id, user_id))",
  "CREATE TABLE batches (session_id TEXT NOT NULL, view TEXT NOT NULL, seq INTEGER NOT NULL, tail TEXT NOT NULL, PRIMARY KEY (session_id, view, seq))",
  "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "INSERT INTO sessions VALUES ('sessionA1', 1000, 2000, 1000, 'https://a.test/', 1000, 'https://a.test/b', 1500, 2, 'UA', 'desktop', 800, 600, 9, 3, 1, 0, 2)",
  "INSERT INTO session_pages VALUES ('sessionA1', 'viewA0001', 1000, 'a.test', '/', 'https://a.test/')",
  "INSERT INTO session_users VALUES ('sessionA1', 'u-1')",
  "INSERT INTO batches VALUES ('sessionA1', 'viewA0001', 0, '[]')",
  "INSERT INTO settings VALUES ('admin', '{}')",
];

async function checkMigrated(db: Db) {
  assert.deepEqual(await db.all("SELECT project_id, id, pages, clicks FROM sessions"), [{ project_id: DEFAULT_PROJECT, id: "sessionA1", pages: 2, clicks: 3 }]);
  assert.deepEqual(await db.all("SELECT project_id, view, path FROM session_pages"), [{ project_id: DEFAULT_PROJECT, view: "viewA0001", path: "/" }]);
  assert.deepEqual(await db.all("SELECT project_id, user_id FROM session_users"), [{ project_id: DEFAULT_PROJECT, user_id: "u-1" }]);
  assert.deepEqual(await db.all("SELECT project_id, seq FROM batches"), [{ project_id: DEFAULT_PROJECT, seq: 0 }]);
  assert.deepEqual(await db.all("SELECT key FROM settings"), [{ key: "admin" }]);
  // The same session id may now exist in another project.
  await db.run("INSERT INTO sessions SELECT 'other', id, started_at, ended_at, duration, first_url, first_ts, last_url, last_ts, pages, ua, device, w, h, events, clicks, rage_clicks, errors, inputs FROM sessions");
}

test("postgres: tables from a version without projects move into the default project", async () => {
  const fresh = await freshDatabase();
  const raw = PgDb.pool(fresh.url);
  try {
    for (const sql of V1) await raw.run(sql);
    // Two processes upgrading at once: one migrates, the other waits and then finds the new tables.
    await Promise.all([withSchema(raw).all("SELECT 1"), withSchema(raw).all("SELECT 1")]);
    await checkMigrated(withSchema(raw));
    const names = (await raw.all<{ relname: string }>("SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'i') ORDER BY relname")).map((r) => r.relname);
    for (const n of schemaObjects(raw.dialect)) assert.ok(names.includes(n), n);
    assert.equal(names.some((n) => /_v[12]|^sessions_started$|^session_pages_path$/.test(n)), false, names.join(" "));
  } finally {
    await raw.close();
    await fresh.drop();
  }
});

test("sqlite: tables from a version without projects move into the default project", async () => {
  const lite = new DatabaseSync(":memory:");
  try {
    const raw = sqlite(lite);
    for (const sql of V1) await raw.run(sql);
    await withSchema(raw).all("SELECT 1");
    await checkMigrated(withSchema(raw));
    const names = (await raw.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
    assert.deepEqual(names, [...schemaObjects(SQLITE)].sort());
  } finally {
    lite.close();
  }
});
