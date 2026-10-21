// Request handler built only on Web APIs (Request, Response, WebCrypto, compression streams), shared
// by the Cloudflare Worker entry and the Node server. The ingest and session handlers are exported on
// their own too, so a host with its own sign-in and projects can serve them for any project's store.

import type { IngestBatch, ReplayEvent } from "../shared/protocol.ts";
import {
  AdminStore, LoginLimiter, MIN_PASSWORD, checkSession, clearCookie, hasPassword, hashPassword, issueSession, readCookie, sessionCookie, verifyPassword,
} from "./auth.ts";
import type { Db } from "./db.ts";
import { OAuthClient, isAllowed, newFlow, type OAuthConfig } from "./oauth.ts";
import { SearchError, parseSearch, type SessionQuery } from "./search.ts";
import type { ObjectStorage } from "./storage.ts";
import { ID_RE, SessionStore, gunzip } from "./store.ts";

const MAX_BODY = 20 * 1024 * 1024;

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Content-Encoding",
  "Access-Control-Max-Age": "86400",
  // Lets pages on public origins post to a collector on a private network (Chrome private network access).
  "Access-Control-Allow-Private-Network": "true",
};

export interface AppOptions {
  storage: ObjectStorage;
  /** Summaries, search and settings. Wrap with withSchema() so the tables exist. */
  db: Db;
  /** Serves a file from the built public directory, e.g. "/dashboard/index.html". */
  asset(path: string, req: Request): Promise<Response>;
  /** When set, creating the admin password requires this token. */
  setupToken?: string;
  /** Sign-in through an OAuth 2.0 / OpenID Connect provider, see oauth.ts. */
  oauth?: OAuthConfig | null;
  /** Used for the OAuth token and userinfo requests; tests pass a stub. */
  fetch?: typeof fetch;
}

export interface RequestContext {
  ip?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });

const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "/";
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only same-site paths, never another origin. */
const safeNext = (n: string | null | undefined) => (n && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : "/");

const FLOW_COOKIE = "ro_oauth";
const FLOW_PATH = "/api/auth/oauth/";

async function readBody(req: Request): Promise<Uint8Array> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) throw new HttpError(413, "body too large");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_BODY) throw new HttpError(413, "body too large");
  return buf;
}

/** Highest seq a part name (at most 9 digits) and the INTEGER column can hold. */
const MAX_SEQ = 999_999_999;

/** Events the store can count: a known shape for the fields it reads, malformed ones are dropped. */
function validEvent(e: ReplayEvent): boolean {
  if (!e || typeof e !== "object" || typeof e.k !== "string" || !Number.isSafeInteger(e.ts)) return false;
  if (e.k !== "meta") return true;
  return typeof e.url === "string" && typeof e.ua === "string" && typeof e.view === "string" && typeof e.title === "string" &&
    dimension(e.w) && dimension(e.h);
}

const dimension = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 2 ** 31 - 1;

function parseBatch(text: string): IngestBatch {
  let batch: IngestBatch;
  try {
    batch = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad json");
  }
  if (!batch || typeof batch !== "object") throw new HttpError(400, "bad batch");
  if (typeof batch.sid !== "string" || !ID_RE.test(batch.sid)) throw new HttpError(400, "bad sid");
  if (typeof batch.view !== "string" || !ID_RE.test(batch.view)) throw new HttpError(400, "bad view");
  if (!Number.isInteger(batch.seq) || batch.seq < 0 || batch.seq > MAX_SEQ) throw new HttpError(400, "bad seq");
  if (!Array.isArray(batch.events)) throw new HttpError(400, "bad events");
  batch.events = batch.events.filter(validEvent);
  return batch;
}

export async function readJson<T>(req: Request): Promise<T> {
  if (!/application\/json/i.test(req.headers.get("content-type") || "")) throw new HttpError(415, "expected application/json");
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "bad json");
  }
}

export function createApp(opts: AppOptions) {
  const sessions = new SessionStore(opts.storage, opts.db);
  const admin = new AdminStore(opts.db);
  const limiter = new LoginLimiter();
  const oauth = opts.oauth ? new OAuthClient(opts.oauth, opts.fetch) : null;

  async function isAuthed(req: Request): Promise<boolean> {
    const cookie = readCookie(req.headers.get("cookie"));
    if (!cookie) return false;
    const cfg = await admin.get();
    if (cfg && (await checkSession(cfg, cookie))) return true;
    // The cookie may be signed with a secret this isolate has not seen yet (set up or changed elsewhere).
    // Re-read at most once a second so bogus cookies cannot turn into a storage request each.
    if (admin.age < 1000) return false;
    const latest = await admin.get(true);
    return !!latest && (await checkSession(latest, cookie));
  }

  /** GET /api/auth/oauth/start: remembers state and PKCE verifier in a short-lived cookie, then leaves for the provider. */
  async function oauthStart(url: URL, secure: boolean): Promise<Response> {
    const { state, verifier } = newFlow();
    const next = safeNext(url.searchParams.get("next"));
    const target = await oauth!.authorizeUrl(redirectUri(url), state, verifier);
    const value = state + "." + verifier + "." + encodeURIComponent(next);
    return new Response(null, {
      status: 302,
      headers: {
        Location: target,
        "Cache-Control": "no-store",
        "Set-Cookie": FLOW_COOKIE + "=" + value + "; Path=" + FLOW_PATH + "; HttpOnly; SameSite=Lax; Max-Age=600" + (secure ? "; Secure" : ""),
      },
    });
  }

  /** GET /api/auth/oauth/callback: checks state, redeems the code, signs in allowed identities. */
  async function oauthCallback(req: Request, url: URL, secure: boolean): Promise<Response> {
    const flow = (readCookie(req.headers.get("cookie"), FLOW_COOKIE) || "").split(".");
    const next = flow.length === 3 ? safeNext(decodeURIComponentSafe(flow[2])) : "/";
    const clearFlow = FLOW_COOKIE + "=; Path=" + FLOW_PATH + "; HttpOnly; SameSite=Lax; Max-Age=0" + (secure ? "; Secure" : "");
    const back = (error: string, extra: Record<string, string> = {}) => {
      const q = new URLSearchParams({ error, ...extra });
      if (next !== "/") q.set("next", next);
      return new Response(null, { status: 302, headers: { Location: "/login?" + q, "Cache-Control": "no-store", "Set-Cookie": clearFlow } });
    };
    const p = url.searchParams;
    if (p.get("error")) return back(p.get("error") === "access_denied" ? "cancelled" : "provider");
    const state = p.get("state") || "";
    const code = p.get("code") || "";
    if (flow.length !== 3 || !state || state !== flow[0] || !code) return back("state");
    let who;
    try {
      who = await oauth!.identify(code, flow[1], redirectUri(url));
    } catch (err) {
      console.error("OAuth sign-in failed:", err);
      return back("provider");
    }
    if (!isAllowed(who, opts.oauth!.allow)) return back("denied", { who: who.email ? who.email + " (sub:" + who.sub + ")" : "sub:" + who.sub });
    const cfg = await admin.ensure();
    const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
    headers.append("Set-Cookie", sessionCookie(await issueSession(cfg), secure));
    headers.append("Set-Cookie", clearFlow);
    return new Response(null, { status: 302, headers });
  }

  function redirectUri(url: URL): string {
    return opts.oauth!.redirectUri || url.origin + "/api/auth/oauth/callback";
  }

  async function authApi(req: Request, url: URL, ctx: RequestContext): Promise<Response> {
    const secure = url.protocol === "https:";
    const ip = ctx.ip || req.headers.get("cf-connecting-ip") || "local";
    const op = url.pathname.slice("/api/auth/".length);
    if (op === "status" && req.method === "GET") {
      // Fresh so the sign-in page never offers setup after the password was set in another isolate.
      const cfg = await admin.get(true);
      const password = hasPassword(cfg);
      return json({
        configured: password || !!oauth,
        password,
        oauth: opts.oauth ? { name: opts.oauth.name } : null,
        authenticated: await isAuthed(req),
        needsToken: !password && !oauth && !!opts.setupToken,
      });
    }
    if (op === "oauth/start" || op === "oauth/callback") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      if (!oauth) throw new HttpError(404, "OAuth sign-in is not configured.");
      return op === "oauth/start" ? await oauthStart(url, secure) : await oauthCallback(req, url, secure);
    }
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    sameOrigin(req, url);

    if (op === "setup") {
      const body = await readJson<{ password?: string; token?: string }>(req);
      const current = await admin.get(true);
      if (hasPassword(current)) throw new HttpError(409, "The admin password is already set. Sign in instead.");
      // With OAuth on, only a signed-in admin may add a password (from the dashboard).
      if (oauth) throw new HttpError(409, "Sign in with " + opts.oauth!.name + ", then set a password from the dashboard if you want one.");
      if (opts.setupToken && body.token !== opts.setupToken) {
        await sleep(500);
        throw new HttpError(403, "The setup token is not correct.");
      }
      const password = String(body.password || "");
      if (password.length < MIN_PASSWORD) throw new HttpError(400, "Use at least " + MIN_PASSWORD + " characters.");
      const cfg = await hashPassword(password);
      // A secret-only row is left behind when OAuth was configured earlier and later removed.
      const stored = current ? await admin.replace(current, cfg) : await admin.create(cfg);
      if (!stored) throw new HttpError(409, "The admin password is already set. Sign in instead.");
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await issueSession(cfg), secure) });
    }

    if (op === "login") {
      const wait = limiter.blocked(ip);
      if (wait) return json({ error: "Too many attempts. Try again in " + wait + " seconds." }, 429, { "Retry-After": String(wait) });
      const body = await readJson<{ password?: string }>(req);
      const cfg = await admin.get(true);
      if (!hasPassword(cfg)) throw new HttpError(409, "No admin password is set yet.");
      if (!(await verifyPassword(cfg!, String(body.password || "")))) {
        limiter.fail(ip);
        await sleep(400);
        throw new HttpError(401, "That password is not correct.");
      }
      limiter.succeed(ip);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await issueSession(cfg!), secure) });
    }

    if (op === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie(secure) });

    if (op === "password") {
      if (!(await isAuthed(req))) throw new HttpError(401, "Sign in first.");
      const body = await readJson<{ current?: string; password?: string }>(req);
      const cfg = await admin.get(true);
      if (!cfg) throw new HttpError(409, "No admin password is set yet.");
      // Signed in through OAuth with no password yet: the first one needs no current password.
      if (hasPassword(cfg) && !(await verifyPassword(cfg, String(body.current || "")))) {
        await sleep(400);
        throw new HttpError(403, "The current password is not correct.");
      }
      const password = String(body.password || "");
      if (password.length < MIN_PASSWORD) throw new HttpError(400, "Use at least " + MIN_PASSWORD + " characters.");
      const next = await hashPassword(password);
      await admin.set(next);
      // The new secret signs out every other browser; this one gets a fresh cookie.
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await issueSession(next), secure) });
    }
    throw new HttpError(404, "not found");
  }

  async function sessionsApi(req: Request, url: URL): Promise<Response> {
    if (!(await isAuthed(req))) throw new HttpError(401, "Sign in to view sessions.");
    return sessionsRequest(req, url, url.pathname.slice("/api/sessions".length), sessions);
  }

  async function page(req: Request, file: string, needsAuth: boolean): Promise<Response> {
    if (needsAuth && !(await isAuthed(req))) {
      const url = new URL(req.url);
      return redirect("/login?next=" + encodeURIComponent(url.pathname + url.search));
    }
    const res = await opts.asset(file, req);
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  }

  return async function handle(req: Request, ctx: RequestContext = {}): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/api/ingest") return await ingestRequest(req, sessions);
      if (p.startsWith("/api/auth/")) return await authApi(req, url, ctx);
      if (p === "/api/sessions" || p.startsWith("/api/sessions/")) return await sessionsApi(req, url);
      if (p.startsWith("/api/")) throw new HttpError(404, "not found");
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");

      if (p === "/" || p === "/index.html") return await page(req, "/dashboard/index.html", true);
      if (p === "/replay" || p === "/replay.html") return await page(req, "/dashboard/replay.html", true);
      if (p === "/login" || p === "/setup") {
        if (await isAuthed(req)) return redirect("/");
        return await page(req, "/dashboard/login.html", false);
      }
      if (p === "/demo") return redirect("/demo/");
      if (p.endsWith("/")) return await opts.asset(p + "index.html", req);
      return await opts.asset(p, req);
    } catch (err) {
      return errorResponse(err, p === "/api/ingest");
    }
  };
}

/** JSON error for a thrown HttpError, or a logged 500 for anything else. `cors` for the ingest endpoint. */
export function errorResponse(err: unknown, cors = false): Response {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  const message = err instanceof HttpError ? err.message : "Internal error";
  return json({ error: message }, status, cors ? CORS : {});
}

/** State-changing calls must come from this origin (cookies are SameSite=Lax as a second layer). */
export function sameOrigin(req: Request, url: URL) {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "cross-origin request refused");
}

export interface IngestRequestOptions {
  /** Runs after the upload is parsed and before it is stored; throw an HttpError to refuse it (quotas). */
  beforeStore?(batch: IngestBatch): Promise<void>;
}

/** The collector endpoint (OPTIONS and POST) for one project. Throws HttpError for bad uploads. */
export async function ingestRequest(req: Request, store: SessionStore, opts: IngestRequestOptions = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") throw new HttpError(405, "method not allowed");
  const raw = await readBody(req);
  // Detect gzip by magic bytes: proxies may strip or keep Content-Encoding.
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  let text: string;
  try {
    text = new TextDecoder().decode(isGzip ? await gunzip(raw, MAX_BODY * 5) : raw);
  } catch {
    throw new HttpError(400, "bad gzip body");
  }
  const batch = parseBatch(text);
  if (opts.beforeStore) await opts.beforeStore(batch);
  await store.ingest(batch, isGzip ? raw : undefined);
  return new Response(null, { status: 204, headers: CORS });
}

export interface SessionsRequestOptions {
  /** False refuses DELETE with 403, for people who may only watch. */
  canDelete?: boolean;
}

/**
 * The session list, summaries, parts and deletion for one project. `rest` is the path after the
 * sessions root ("", "/<id>" or "/<id>/parts/<name>"). The caller has already checked sign-in.
 */
export async function sessionsRequest(req: Request, url: URL, rest: string, store: SessionStore, opts: SessionsRequestOptions = {}): Promise<Response> {
  if (rest === "" || rest === "/") {
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    let query: SessionQuery;
    try {
      query = parseSearch(url.searchParams);
    } catch (err) {
      if (err instanceof SearchError) throw new HttpError(400, err.message);
      throw err;
    }
    return json(await store.search(query));
  }
  const m = /^\/([^/]+)(?:\/parts\/([^/]+))?$/.exec(rest);
  if (!m) throw new HttpError(404, "not found");
  const sid = m[1];
  if (m[2]) {
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    const bytes = await store.part(sid, m[2]);
    if (!bytes) throw new HttpError(404, "part not found");
    // Parts never change once written. encodeBody "manual" tells Workers the body is already gzipped.
    return new Response(bytes as BodyInit, {
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "private, max-age=31536000, immutable" },
      encodeBody: "manual",
    } as ResponseInit);
  }
  if (req.method === "DELETE") {
    sameOrigin(req, url);
    if (opts.canDelete === false) throw new HttpError(403, "You may not delete sessions in this project.");
    await store.remove(sid);
    return new Response(null, { status: 204 });
  }
  if (req.method !== "GET") throw new HttpError(405, "method not allowed");
  const summary = await store.summary(sid);
  if (!summary) throw new HttpError(404, "This session does not exist or was deleted.");
  return json({ summary, parts: await store.parts(sid) });
}
