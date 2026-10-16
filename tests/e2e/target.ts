// Starts the system under test. TARGET selects the runtime:
//   node    (default) Node server on a fresh Postgres database (PG_TEST_URL); S3 storage when
//           S3_TEST_ENDPOINT is set, otherwise a temp directory
//   worker  `wrangler dev` (workerd, the Workers runtime) with S3 storage; needs S3_TEST_ENDPOINT.
//           WORKER_DB=d1 (default) uses a local D1 database, WORKER_DB=pg a fresh Postgres database
//           through a local Hyperdrive binding
//   remote  a deployed instance at REMOTE_BASE with empty storage and database; SETUP_TOKEN if it requires one
// S3_TEST_ENDPOINT, S3_TEST_KEY and S3_TEST_SECRET point at an S3-compatible server (see tests/unit/storage.test.ts).

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { AwsClient } from "aws4fetch";
import { PgDb } from "../../src/server/pg.ts";
import { freshDatabase } from "../pg.ts";
import { startServer } from "../../src/server/index.ts";
import { FsStorage } from "../../src/server/fs-storage.ts";
import { S3Storage } from "../../src/server/s3.ts";
import type { ObjectStorage } from "../../src/server/storage.ts";

export interface Target {
  base: string;
  name: string;
  stop(): Promise<void>;
}

const S3 = {
  endpoint: process.env.S3_TEST_ENDPOINT || "",
  key: process.env.S3_TEST_KEY || "",
  secret: process.env.S3_TEST_SECRET || "",
};

async function freshBucket(): Promise<string> {
  const bucket = "ro-e2e-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  const client = new AwsClient({ accessKeyId: S3.key, secretAccessKey: S3.secret, service: "s3", region: "us-east-1" });
  const res = await client.fetch(S3.endpoint + "/" + bucket, { method: "PUT" });
  if (!res.ok) throw new Error("could not create bucket: " + res.status + " " + (await res.text()));
  return bucket;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error("wrangler dev exited with " + child.exitCode);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("timed out waiting for " + url);
}

/** wrangler.jsonc with test bindings; paths made absolute so the file can live in a temp directory. */
function workerConfig(dir: string, pgUrl: string | null): string {
  const root = path.resolve(".");
  // JSONC: drop comment lines and trailing commas.
  const text = fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const cfg = JSON.parse(text);
  delete cfg.$schema;
  delete cfg.vars;
  cfg.main = path.join(root, cfg.main);
  cfg.assets.directory = path.join(root, cfg.assets.directory);
  if (pgUrl) cfg.hyperdrive = [{ binding: "HYPERDRIVE", id: "local-test", localConnectionString: pgUrl }];
  else cfg.d1_databases = [{ binding: "DB", database_name: "replayowl-test", database_id: "00000000-0000-0000-0000-000000000000" }];
  const file = path.join(dir, "wrangler.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

export async function startTarget(): Promise<Target> {
  const kind = process.env.TARGET || "node";
  if (kind === "remote") {
    // An already deployed instance with empty storage, e.g. a Worker on workers.dev.
    const base = (process.env.REMOTE_BASE || "").replace(/\/+$/, "");
    if (!base) throw new Error("TARGET=remote needs REMOTE_BASE");
    return { base, name: "remote", stop: async () => {} };
  }
  if (kind === "worker") {
    if (!S3.endpoint) throw new Error("TARGET=worker needs S3_TEST_ENDPOINT");
    const bucket = await freshBucket();
    const port = await freePort();
    const pgDb = process.env.WORKER_DB === "pg" ? await freshDatabase() : null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-wrangler-"));
    const vars = {
      S3_ENDPOINT: S3.endpoint, S3_BUCKET: bucket, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: S3.key, S3_SECRET_ACCESS_KEY: S3.secret, S3_PREFIX: "", S3_PATH_STYLE: "true",
    };
    const args = ["wrangler", "dev", "--config", workerConfig(dir, pgDb && pgDb.url), "--port", String(port), "--ip", "127.0.0.1", "--log-level", "warn", "--persist-to", path.join(dir, "state")];
    for (const [k, v] of Object.entries(vars)) args.push("--var", k + ":" + v);
    const child = spawn("npx", args, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
    const base = "http://127.0.0.1:" + port;
    await waitFor(base + "/api/auth/status", child);
    return {
      base,
      name: pgDb ? "worker+pg+s3" : "worker+d1+s3",
      stop: async () => {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (pgDb) await pgDb.drop();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  let storage: ObjectStorage;
  let cleanup = () => {};
  let name: string;
  if (S3.endpoint) {
    storage = new S3Storage({ endpoint: S3.endpoint, bucket: await freshBucket(), accessKeyId: S3.key, secretAccessKey: S3.secret, region: "us-east-1" });
    name = "node+s3";
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replayowl-"));
    storage = new FsStorage(dir);
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    name = "node+fs";
  }
  const fresh = await freshDatabase();
  const db = PgDb.pool(fresh.url);
  const server = startServer({ port: 0, host: "127.0.0.1", storage, db, setupToken: "", oauth: null });
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  return {
    base: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    name: name + "+pg",
    stop: async () => {
      await new Promise((r) => { server.close(r); server.closeAllConnections(); });
      await db.close();
      await fresh.drop();
      cleanup();
    },
  };
}
