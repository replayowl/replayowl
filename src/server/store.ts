// Sessions. Upload batches live in object storage (S3 has no append, so every batch is its own object):
//
//   sessions/<sid>/parts/<firstTs>-<view>-<seq>.json.gz   one gzipped IngestBatch per upload
//
// Summaries, page views and user ids live in the database for listing and search. The player
// downloads the parts directly and merges them, so serving a session costs the server no parsing.
//
// A store serves one project. Its object storage holds only that project (a bucket or key prefix of
// its own); its database rows carry the project id, so many projects can share one database.

import { MAX_USERS_PER_SESSION, batchDelta, deviceOf } from "../shared/analyze.ts";
import type { ClickEvent, Device, IngestBatch, SessionSummary } from "../shared/protocol.ts";
import { DEFAULT_PROJECT, type Db, type Dialect, type Param, type Statement } from "./db.ts";
import { MAX_URL, encodeCursor, splitUrl, type SessionQuery } from "./search.ts";
import { listAll, pool, type ObjectStorage } from "./storage.ts";

export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const PART_RE = /^\d{13}-[A-Za-z0-9_-]{8,64}-\d{1,9}\.json\.gz$/;
const MAX_TS = 9_999_999_999_999;

const pad13 = (n: number) => String(Math.max(0, Math.min(MAX_TS, Math.floor(n)))).padStart(13, "0");
const enc = new TextEncoder();

export async function gzip(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: Uint8Array, maxBytes = 200 * 1024 * 1024): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) throw new Error("decompressed body too large");
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const COLUMNS = "id, started_at, ended_at, duration, first_url, last_url, pages, ua, device, w, h, events, clicks, rage_clicks, errors, inputs";

interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number;
  duration: number;
  first_url: string;
  last_url: string;
  pages: number;
  ua: string;
  device: string;
  w: number;
  h: number;
  events: number;
  clicks: number;
  rage_clicks: number;
  errors: number;
  inputs: number;
}

function toSummary(r: SessionRow, userIds: string[]): SessionSummary {
  return {
    id: r.id, startedAt: r.started_at, endedAt: r.ended_at, duration: r.duration, firstUrl: r.first_url, lastUrl: r.last_url, pages: r.pages,
    ua: r.ua, device: r.device as Device, w: r.w, h: r.h, events: r.events, clicks: r.clicks, rageClicks: r.rage_clicks, errors: r.errors,
    inputs: r.inputs, userIds,
  };
}

/** The first page view sets the entry fields; an earlier one arriving later replaces them. */
const EARLIER = "excluded.first_ts > 0 AND (sessions.first_ts = 0 OR excluded.first_ts < sessions.first_ts)";

function upsertSession(d: Dialect): string {
  const first = (col: string) => `${col} = CASE WHEN ${EARLIER} THEN excluded.${col} ELSE sessions.${col} END`;
  const add = (col: string) => `${col} = sessions.${col} + excluded.${col}`;
  return `INSERT INTO sessions (project_id, id, started_at, ended_at, duration, first_url, first_ts, last_url, last_ts, pages, ua, device, w, h, events, clicks, rage_clicks, errors, inputs)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (project_id, id) DO UPDATE SET
  started_at = ${d.least("sessions.started_at", "excluded.started_at")},
  ended_at = ${d.greatest("sessions.ended_at", "excluded.ended_at")},
  duration = ${d.greatest("sessions.ended_at", "excluded.ended_at")} - ${d.least("sessions.started_at", "excluded.started_at")},
  ${["first_url", "ua", "device", "w", "h", "first_ts"].map(first).join(",\n  ")},
  last_url = CASE WHEN excluded.last_ts > 0 AND excluded.last_ts >= sessions.last_ts THEN excluded.last_url ELSE sessions.last_url END,
  last_ts = ${d.greatest("sessions.last_ts", "excluded.last_ts")},
  ${["pages", "events", "clicks", "rage_clicks", "errors", "inputs"].map(add).join(",\n  ")}`;
}

function parseTail(raw: string | undefined): ClickEvent[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export class SessionStore {
  readonly storage: ObjectStorage;
  readonly project: string;
  private db: Db;

  constructor(storage: ObjectStorage, db: Db, project: string = DEFAULT_PROJECT) {
    this.storage = storage;
    this.db = db;
    this.project = project;
  }

  /**
   * Stores one batch. `gz` is the batch as uploaded when the client already compressed it, so it is
   * stored as-is. The database step is atomic and starts with the batch's unique key, so a retried
   * or concurrent duplicate either rolls back or is skipped and never counts twice.
   */
  async ingest(batch: IngestBatch, gz?: Uint8Array): Promise<void> {
    if (!batch.events.length) return;
    let firstTs = batch.events[0].ts;
    for (const e of batch.events) if (e.ts < firstTs) firstTs = e.ts;
    const part = "sessions/" + batch.sid + "/parts/" + pad13(firstTs) + "-" + batch.view + "-" + batch.seq + ".json.gz";
    await this.storage.put(part, gz || (await gzip(JSON.stringify(batch))), "application/gzip");

    // Batches of one page view are uploaded one at a time, so the previous one is already stored.
    const prev = batch.seq > 0
      ? await this.db.all<{ tail: string }>("SELECT tail FROM batches WHERE project_id = ? AND session_id = ? AND view = ? AND seq = ?", [this.project, batch.sid, batch.view, batch.seq - 1])
      : [];
    const d = batchDelta(batch.events, parseTail(prev[0] && prev[0].tail));
    const pages = [...d.pages].sort((a, b) => a.ts - b.ts);
    const first = pages[0];
    const last = pages[pages.length - 1];
    const ua = first ? first.ua.slice(0, 1024) : "";
    const pid = this.project;
    const statements: Statement[] = [
      { sql: "INSERT INTO batches (project_id, session_id, view, seq, tail) VALUES (?, ?, ?, ?, ?)", params: [pid, batch.sid, batch.view, batch.seq, JSON.stringify(d.tail)] },
      {
        sql: upsertSession(this.db.dialect),
        params: [
          pid, batch.sid, d.startedAt, d.endedAt, d.endedAt - d.startedAt,
          first ? first.url.slice(0, MAX_URL) : "", first ? first.ts : 0, last ? last.url.slice(0, MAX_URL) : "", last ? last.ts : 0,
          pages.length, ua, deviceOf(ua), first ? first.w : 0, first ? first.h : 0,
          d.events, d.clicks, d.rageClicks, d.errors, d.inputs,
        ],
      },
    ];
    for (const p of pages) {
      const parts = splitUrl(p.url);
      statements.push({
        sql: "INSERT INTO session_pages (project_id, session_id, view, ts, host, path, url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        params: [pid, batch.sid, p.view, p.ts, parts ? parts.host : "", parts ? parts.path.slice(0, MAX_URL) : "", p.url.slice(0, MAX_URL)],
      });
    }
    // The cap below holds under concurrency because the sessions upsert above already holds the session's row lock.
    for (const uid of d.userIds.slice(0, MAX_USERS_PER_SESSION)) {
      statements.push({
        sql: "INSERT INTO session_users (project_id, session_id, user_id) SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT) WHERE (SELECT COUNT(*) FROM session_users WHERE project_id = ? AND session_id = ?) < ? ON CONFLICT DO NOTHING",
        params: [pid, batch.sid, uid, pid, batch.sid, MAX_USERS_PER_SESSION],
      });
    }
    try {
      await this.db.batch(statements);
    } catch (err) {
      // Another request already counted this batch.
      if (this.db.isUniqueViolation(err)) return;
      throw err;
    }
  }

  async summary(sid: string): Promise<SessionSummary | null> {
    if (!ID_RE.test(sid)) return null;
    const rows = await this.db.all<SessionRow>(`SELECT ${COLUMNS} FROM sessions WHERE project_id = ? AND id = ?`, [this.project, sid]);
    if (!rows.length) return null;
    return toSummary(rows[0], (await this.userIds([sid])).get(sid) || []);
  }

  /** Newest sessions first, filtered, paginated by a keyset cursor. */
  async search(q: SessionQuery): Promise<{ sessions: SessionSummary[]; next: string | null }> {
    const where: string[] = ["project_id = ?"];
    const params: Param[] = [this.project];
    const add = (sql: string, ...values: Param[]) => {
      where.push(sql);
      params.push(...values);
    };
    if (q.user !== undefined) add("id IN (SELECT session_id FROM session_users WHERE project_id = ? AND user_id = ?)", this.project, q.user);
    // A site and a page without a host of its own must match on the same page view.
    const host = q.url && q.url.host !== null ? q.url.host : q.site;
    if (q.site !== undefined && (!q.url || host !== q.site)) add("id IN (SELECT session_id FROM session_pages WHERE project_id = ? AND host = ?)", this.project, q.site);
    if (q.url) {
      const cond: string[] = ["project_id = ?"];
      const values: Param[] = [this.project];
      if (host !== undefined) {
        cond.push("host = ?");
        values.push(host);
      }
      if (q.url.mode === "exact") {
        cond.push("path = ?");
        values.push(q.url.path);
      } else if (q.url.mode === "prefix") {
        // Stored paths are percent-encoded ASCII, so every path starting with the prefix sorts below prefix + DEL.
        cond.push("path >= ? AND path < ?");
        values.push(q.url.path, q.url.path + "\u007f");
      } else {
        cond.push(this.db.dialect.contains("path", "?"));
        values.push(q.url.path);
      }
      add(`id IN (SELECT session_id FROM session_pages WHERE ${cond.join(" AND ")})`, ...values);
    }
    if (q.from !== undefined) add("started_at >= ?", q.from);
    if (q.to !== undefined) add("started_at <= ?", q.to);
    if (q.minDuration !== undefined) add("duration >= ?", q.minDuration);
    if (q.maxDuration !== undefined) add("duration <= ?", q.maxDuration);
    if (q.minPages !== undefined) add("pages >= ?", q.minPages);
    if (q.errors) add("errors > 0");
    if (q.rage) add("rage_clicks > 0");
    if (q.device) add("device = ?", q.device);
    if (q.cursor) add("(started_at < ? OR (started_at = ? AND id < ?))", q.cursor.startedAt, q.cursor.startedAt, q.cursor.id);
    params.push(q.limit + 1);
    const rows = await this.db.all<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC, id DESC LIMIT ?`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const users = await this.userIds(page.map((r) => r.id));
    const last = page[page.length - 1];
    return {
      sessions: page.map((r) => toSummary(r, users.get(r.id) || [])),
      next: rows.length > q.limit && last ? encodeCursor({ startedAt: last.started_at, id: last.id }) : null,
    };
  }

  /** Hosts that recorded page views, with how many sessions visited each, most visited first. */
  async sites(limit = 200): Promise<{ host: string; sessions: number }[]> {
    const rows = await this.db.all<{ host: string; n: number | string }>(
      "SELECT host, COUNT(DISTINCT session_id) AS n FROM session_pages WHERE project_id = ? AND host <> '' GROUP BY host ORDER BY n DESC, host LIMIT ?",
      [this.project, limit],
    );
    return rows.map((r) => ({ host: r.host, sessions: Number(r.n) }));
  }

  private async userIds(sids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!sids.length) return out;
    // Chunks of 50 ids plus the project stay within D1's limit of 100 bound parameters.
    const rows: { session_id: string; user_id: string }[] = [];
    for (let i = 0; i < sids.length; i += 50) {
      const chunk = sids.slice(i, i + 50);
      rows.push(...await this.db.all<{ session_id: string; user_id: string }>(
        `SELECT session_id, user_id FROM session_users WHERE project_id = ? AND session_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY user_id`,
        [this.project, ...chunk],
      ));
    }
    for (const r of rows) {
      const list = out.get(r.session_id) || [];
      list.push(r.user_id);
      out.set(r.session_id, list);
    }
    return out;
  }

  async parts(sid: string): Promise<string[]> {
    const prefix = "sessions/" + sid + "/parts/";
    return (await listAll(this.storage, prefix)).map((k) => k.slice(prefix.length)).filter((n) => PART_RE.test(n));
  }

  async part(sid: string, name: string): Promise<Uint8Array | null> {
    if (!ID_RE.test(sid) || !PART_RE.test(name)) return null;
    return this.storage.get("sessions/" + sid + "/parts/" + name);
  }

  /**
   * Database rows first, so the session disappears from the dashboard even if object deletion fails.
   * The sessions row goes first because ingest locks it first too; the other order can deadlock.
   */
  async remove(sid: string): Promise<void> {
    if (!ID_RE.test(sid)) return;
    await this.db.batch([
      { sql: "DELETE FROM sessions WHERE project_id = ? AND id = ?", params: [this.project, sid] },
      ...["session_users", "session_pages", "batches"].map((t) => ({ sql: `DELETE FROM ${t} WHERE project_id = ? AND session_id = ?`, params: [this.project, sid] })),
    ]);
    const keys = await listAll(this.storage, "sessions/" + sid + "/");
    await pool(keys, 8, (k) => this.storage.delete(k));
  }
}
