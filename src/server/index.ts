// Node server: wraps the Web handler from app.ts in node:http and serves dist/public from disk.
// Storage is S3 when S3_BUCKET is set, otherwise files under DATA_DIR. The database is Postgres at DATABASE_URL.
// OAUTH_* variables add OAuth sign-in (see oauth.ts).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { withSchema, type Db } from "./db.ts";
import { FsStorage } from "./fs-storage.ts";
import { oauthConfigFromEnv, type OAuthConfig } from "./oauth.ts";
import { PgDb } from "./pg.ts";
import { S3Storage, s3ConfigFromEnv } from "./s3.ts";
import type { ObjectStorage } from "./storage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = path.join(ROOT, "dist/public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  storage?: ObjectStorage;
  db?: Db;
  setupToken?: string;
  /** Defaults to the OAUTH_* environment variables; null turns OAuth off. */
  oauth?: OAuthConfig | null;
}

async function serveFile(rel: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const file = path.resolve(PUBLIC, "." + path.posix.normalize("/" + decoded));
  if (!file.startsWith(PUBLIC + path.sep) || decoded.includes("\0")) return new Response("not found", { status: 404 });
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error("not a file");
    const body = await fs.promises.readFile(file);
    return new Response(body, { headers: { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" } });
  } catch {
    return new Response("not found", { status: 404, headers: { "Content-Type": TYPES[".txt"] } });
  }
}

function defaultStorage(dataDir?: string): ObjectStorage {
  const s3 = s3ConfigFromEnv(process.env);
  if (s3 && !dataDir) return new S3Storage(s3);
  return new FsStorage(dataDir || process.env.DATA_DIR || path.join(ROOT, "data"));
}

function defaultDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to a Postgres connection string, e.g. postgres://replayowl:replayowl@127.0.0.1:15432/replayowl");
  return PgDb.pool(url);
}

export function startServer(opts: ServerOptions = {}): http.Server {
  const port = opts.port ?? Number(process.env.PORT || 8790);
  const host = opts.host ?? (process.env.HOST || "127.0.0.1");
  const storage = opts.storage || defaultStorage(opts.dataDir);
  const db = withSchema(opts.db || defaultDb());
  const handle = createApp({
    storage,
    db,
    asset: (p) => serveFile(p),
    setupToken: opts.setupToken ?? (process.env.SETUP_TOKEN || undefined),
    oauth: opts.oauth !== undefined ? opts.oauth : oauthConfigFromEnv(process.env),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = "http://" + (req.headers.host || host + ":" + port) + (req.url || "/");
      const method = req.method || "GET";
      const chunks: Buffer[] = [];
      if (method !== "GET" && method !== "HEAD") for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const request = new Request(url, { method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const response = await handle(request, { ip: req.socket.remoteAddress });
      const out: Record<string, string | string[]> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(response.status, out);
      if (!response.body || method === "HEAD") res.end();
      else Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, host, () => {
    const addr = server.address();
    const actual = addr && typeof addr === "object" ? addr.port : port;
    console.log(`Replayowl listening on http://${host}:${actual} (storage: ${storage.constructor.name})`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = startServer();
  // As PID 1 in a container Node has no default SIGTERM handler, so stop explicitly.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
