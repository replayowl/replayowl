// Fresh Postgres databases for tests. PG_TEST_URL points at a server whose user may create databases:
//   docker run -d --name replayowl-pg -p 15432:5432 -e POSTGRES_USER=replayowl -e POSTGRES_PASSWORD=replayowl postgres:17
//   PG_TEST_URL=postgres://replayowl:replayowl@127.0.0.1:15432/replayowl

import pg from "pg";

export const PG_TEST_URL = process.env.PG_TEST_URL || "";

async function admin(sql: string) {
  const client = new pg.Client({ connectionString: PG_TEST_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function freshDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  if (!PG_TEST_URL) throw new Error("set PG_TEST_URL, e.g. postgres://replayowl:replayowl@127.0.0.1:15432/replayowl");
  const name = "ro_test_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
  await admin("CREATE DATABASE " + name);
  const url = new URL(PG_TEST_URL);
  url.pathname = "/" + name;
  return { url: url.href, drop: () => admin("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)") };
}
