// Cloudflare Worker entry. Static files (dashboard, recorder, demo) come from the ASSETS binding;
// upload batches live in an S3-compatible bucket; summaries, search and the admin password live in
// D1 (binding DB) or Postgres through Hyperdrive (binding HYPERDRIVE). OAUTH_* variables add OAuth sign-in.

import { createApp } from "../server/app.ts";
import { D1Db, withSchema, type D1Database, type Db } from "../server/db.ts";
import { oauthConfigFromEnv } from "../server/oauth.ts";
import { PgDb } from "../server/pg.ts";
import { S3Storage, s3ConfigFromEnv } from "../server/s3.ts";

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  DB?: D1Database;
  HYPERDRIVE?: { connectionString: string };
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION?: string;
  S3_PREFIX?: string;
  S3_PATH_STYLE?: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  SETUP_TOKEN?: string;
  /** Optional OAuth sign-in, see src/server/oauth.ts for the full list of OAUTH_* variables. */
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_ISSUER?: string;
  OAUTH_ALLOW?: string;
}

let app: ReturnType<typeof createApp> | null = null;
let appEnv: Env | null = null;

function database(env: Env): Db {
  if (env.DB) return new D1Db(env.DB);
  if (env.HYPERDRIVE) return PgDb.perUse(env.HYPERDRIVE.connectionString);
  throw new Error("No database is configured: add a D1 binding named DB or a Hyperdrive binding named HYPERDRIVE.");
}

function getApp(env: Env) {
  // The env object is stable per isolate; rebuild only if it changes.
  if (!app || appEnv !== env) {
    const cfg = s3ConfigFromEnv(env as unknown as Record<string, unknown>);
    if (!cfg) throw new Error("S3_BUCKET is not configured");
    app = createApp({
      storage: new S3Storage(cfg),
      db: withSchema(database(env)),
      asset: (path, req) => env.ASSETS.fetch(new Request(new URL(path, req.url), { method: "GET", headers: req.headers })),
      setupToken: env.SETUP_TOKEN || undefined,
      oauth: oauthConfigFromEnv(env as unknown as Record<string, unknown>),
    });
    appEnv = env;
  }
  return app;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let handle: ReturnType<typeof createApp>;
    try {
      handle = getApp(env);
    } catch (err) {
      // Missing configuration: say what is missing instead of the generic Workers error page.
      return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    return handle(req, { ip: req.headers.get("cf-connecting-ip") || undefined });
  },
};
