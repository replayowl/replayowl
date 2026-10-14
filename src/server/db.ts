// Database for session summaries, search and settings: Cloudflare D1 or Postgres. Statements use "?"
// placeholders and portable SQL; the few differences between SQLite and Postgres live in the dialect.

export type Param = string | number | null;
export type Row = Record<string, unknown>;

export interface Statement {
  sql: string;
  params?: Param[];
}

export interface Dialect {
  name: "sqlite" | "pg";
  least(a: string, b: string): string;
  greatest(a: string, b: string): string;
  /** SQL that is true when `needle` occurs in `haystack`. */
  contains(haystack: string, needle: string): string;
  /** Column type for text compared byte by byte (hosts, paths), so a range query matches a prefix. */
  bytesText: string;
}

export const SQLITE: Dialect = {
  name: "sqlite",
  least: (a, b) => `MIN(${a}, ${b})`,
  greatest: (a, b) => `MAX(${a}, ${b})`,
  contains: (h, n) => `instr(${h}, ${n}) > 0`,
  bytesText: "TEXT",
};

export const POSTGRES: Dialect = {
  name: "pg",
  least: (a, b) => `LEAST(${a}, ${b})`,
  greatest: (a, b) => `GREATEST(${a}, ${b})`,
  contains: (h, n) => `strpos(${h}, ${n}) > 0`,
  bytesText: 'TEXT COLLATE "C"',
};

export interface Db {
  readonly dialect: Dialect;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  run(sql: string, params?: Param[]): Promise<void>;
  /** Runs the statements atomically: all of them apply or none does. */
  batch(statements: Statement[]): Promise<void>;
  /** True when `err` is a primary key or unique constraint violation. */
  isUniqueViolation(err: unknown): boolean;
}

export function schema(d: Dialect): string[] {
  const t = d.bytesText;
  return [
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at BIGINT NOT NULL,
      ended_at BIGINT NOT NULL,
      duration BIGINT NOT NULL,
      first_url TEXT NOT NULL,
      first_ts BIGINT NOT NULL,
      last_url TEXT NOT NULL,
      last_ts BIGINT NOT NULL,
      pages INTEGER NOT NULL,
      ua TEXT NOT NULL,
      device TEXT NOT NULL,
      w INTEGER NOT NULL,
      h INTEGER NOT NULL,
      events INTEGER NOT NULL,
      clicks INTEGER NOT NULL,
      rage_clicks INTEGER NOT NULL,
      errors INTEGER NOT NULL,
      inputs INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at DESC, id DESC)",
    `CREATE TABLE IF NOT EXISTS session_pages (
      session_id TEXT NOT NULL,
      view TEXT NOT NULL,
      ts BIGINT NOT NULL,
      host ${t} NOT NULL,
      path ${t} NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (session_id, view)
    )`,
    "CREATE INDEX IF NOT EXISTS session_pages_path ON session_pages (path, session_id)",
    "CREATE INDEX IF NOT EXISTS session_pages_host_path ON session_pages (host, path, session_id)",
    `CREATE TABLE IF NOT EXISTS session_users (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (session_id, user_id)
    )`,
    "CREATE INDEX IF NOT EXISTS session_users_user ON session_users (user_id, session_id)",
    `CREATE TABLE IF NOT EXISTS batches (
      session_id TEXT NOT NULL,
      view TEXT NOT NULL,
      seq INTEGER NOT NULL,
      tail TEXT NOT NULL,
      PRIMARY KEY (session_id, view, seq)
    )`,
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ];
}

/** Names of the tables and indexes schema() creates, taken from its statements so the two cannot drift. */
export function schemaObjects(d: Dialect): string[] {
  return schema(d).map((sql) => /IF NOT EXISTS (\w+)/.exec(sql)![1]);
}

/** True when every table and index of the schema exists already. */
async function schemaPresent(db: Db): Promise<boolean> {
  const names = schemaObjects(db.dialect);
  const list = names.map(() => "?").join(", ");
  const sql = db.dialect.name === "pg"
    ? `SELECT COUNT(*) AS n FROM pg_class WHERE relname IN (${list}) AND relnamespace = current_schema()::regnamespace`
    : `SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (${list})`;
  const rows = await db.all<{ n: number | string }>(sql, names);
  return Number(rows[0] && rows[0].n) === names.length;
}

/**
 * Wraps a database so the tables exist before its first statement (checked once per process or isolate).
 * Existing tables are detected first: CREATE INDEX IF NOT EXISTS still takes a lock on Postgres that blocks writers.
 */
export function withSchema(db: Db): Db {
  // Only success is cached. A shared pending promise could stay pending forever when the request that
  // started it is cancelled, so concurrent first requests each run the idempotent check themselves.
  let done = false;
  const create = async () => {
    if (await schemaPresent(db)) return;
    for (const sql of schema(db.dialect)) await db.run(sql);
  };
  // Two processes creating the tables at once can make Postgres report a duplicate catalog entry;
  // the second attempt then finds the tables and succeeds.
  const ensure = async () => {
    if (done) return;
    await create().catch(create);
    done = true;
  };
  return {
    dialect: db.dialect,
    async all<T = Row>(sql: string, params?: Param[]) {
      await ensure();
      return db.all<T>(sql, params);
    },
    async run(sql: string, params?: Param[]) {
      await ensure();
      await db.run(sql, params);
    },
    async batch(statements: Statement[]) {
      await ensure();
      await db.batch(statements);
    },
    isUniqueViolation: (err) => db.isUniqueViolation(err),
  };
}

interface D1PreparedStatement {
  bind(...values: Param[]): D1PreparedStatement;
  all<T = Row>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

/** The parts of the Workers D1 binding used here. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export class D1Db implements Db {
  readonly dialect = SQLITE;
  private d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    return (await this.d1.prepare(sql).bind(...params).all<T>()).results;
  }

  async run(sql: string, params: Param[] = []): Promise<void> {
    await this.d1.prepare(sql).bind(...params).run();
  }

  async batch(statements: Statement[]): Promise<void> {
    // D1 runs a batch as one transaction and rolls it back when any statement fails.
    await this.d1.batch(statements.map((s) => this.d1.prepare(s.sql).bind(...(s.params || []))));
  }

  isUniqueViolation(err: unknown): boolean {
    const text = (e: unknown): string => (e instanceof Error ? e.message + " " + text(e.cause) : "");
    return /UNIQUE constraint failed|SQLITE_CONSTRAINT_(PRIMARYKEY|UNIQUE)/.test(text(err));
  }
}
