// Postgres through node-postgres. Node keeps one pool. A Worker cannot share a socket between
// requests, so it opens a client per use through Hyperdrive, which pools the real connections.

import pg from "pg";
import { POSTGRES, type Db, type Param, type Row, type Statement } from "./db.ts";

// BIGINT columns hold millisecond timestamps, well inside the safe integer range.
pg.types.setTypeParser(20, (v: string) => Number(v));

interface Conn {
  query(sql: string, params?: Param[]): Promise<{ rows: Row[] }>;
  /** `broken` tells the pool to discard the client instead of reusing it. */
  release(broken?: boolean): Promise<void> | void;
}

const numbered = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => "$" + ++i);
};

export class PgDb implements Db {
  readonly dialect = POSTGRES;
  private connect: () => Promise<Conn>;
  private shutdown: () => Promise<void>;

  constructor(connect: () => Promise<Conn>, shutdown: () => Promise<void> = async () => {}) {
    this.connect = connect;
    this.shutdown = shutdown;
  }

  static pool(connectionString: string): PgDb {
    const pool = new pg.Pool({ connectionString, max: 10 });
    // Without a listener, an idle client error (server restart, dropped connection) would crash the process.
    pool.on("error", (err) => console.error("postgres pool:", err.message));
    return new PgDb(async () => {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(sql, params), release: (broken) => client.release(broken) };
    }, () => pool.end());
  }

  /** A new client for every use, as Hyperdrive recommends for Workers. */
  static perUse(connectionString: string): PgDb {
    return new PgDb(async () => {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return { query: (sql, params) => client.query(sql, params), release: () => client.end() };
    });
  }

  // fn can call markBroken() when the connection is no longer trustworthy; the client is then discarded.
  private async use<T>(fn: (c: Conn, markBroken: () => void) => Promise<T>): Promise<T> {
    const c = await this.connect();
    let broken = false;
    try {
      return await fn(c, () => {
        broken = true;
      });
    } finally {
      await c.release(broken);
    }
  }

  all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.use(async (c) => (await c.query(numbered(sql), params)).rows as T[]);
  }

  async run(sql: string, params: Param[] = []): Promise<void> {
    await this.use((c) => c.query(numbered(sql), params));
  }

  async batch(statements: Statement[]): Promise<void> {
    await this.use(async (c, markBroken) => {
      await c.query("BEGIN");
      try {
        for (const s of statements) await c.query(numbered(s.sql), s.params || []);
        await c.query("COMMIT");
      } catch (err) {
        // If the rollback fails the transaction state is unknown, so the client must not be reused.
        await c.query("ROLLBACK").catch(markBroken);
        throw err;
      }
    });
  }

  isUniqueViolation(err: unknown): boolean {
    return !!err && typeof err === "object" && (err as { code?: unknown }).code === "23505";
  }

  close(): Promise<void> {
    return this.shutdown();
  }
}
