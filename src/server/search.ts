// Dashboard search: parses query parameters and normalizes URLs, so stored page views and what people
// type into the search box compare equal (lowercase host, percent-encoded path, no query or fragment).

import { MAX_USER_ID } from "../shared/analyze.ts";
import type { Device } from "../shared/protocol.ts";

export const MAX_URL = 2048;
const DEVICES: readonly string[] = ["desktop", "mobile", "tablet"];
const MODES: readonly string[] = ["prefix", "exact", "contains"];
const BASE = "http://base.invalid";

export type UrlMode = "prefix" | "exact" | "contains";

export interface Cursor {
  startedAt: number;
  id: string;
}

export interface SessionQuery {
  user?: string;
  url?: { host: string | null; path: string; mode: UrlMode };
  from?: number;
  to?: number;
  /** Milliseconds. */
  minDuration?: number;
  maxDuration?: number;
  minPages?: number;
  errors?: boolean;
  rage?: boolean;
  device?: Device;
  cursor?: Cursor;
  limit: number;
}

export class SearchError extends Error {}

/** Host and path of an absolute URL as stored for search, or null when it does not parse. */
export function splitUrl(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return u.host ? { host: u.host, path: u.pathname || "/" } : null;
  } catch {
    return null;
  }
}

/**
 * Reads what someone typed into the page search. Input with a scheme or a dotted first segment
 * ("shop.com/checkout") names a host; anything else is a path. In contains mode a bare word stays a
 * fragment of the path instead of becoming "/word".
 */
export function parseUrlInput(input: string, mode: UrlMode): { host: string | null; path: string } | null {
  let v = input.trim().replace(/[?#].*$/, "");
  if (!v || v.includes("\\")) return null;
  // Scheme-relative input ("//host/path") names a host, not a path.
  if (v.startsWith("//")) v = "https:" + v;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
  if (hasScheme || (!v.startsWith("/") && /^[^/]*\./.test(v))) {
    const parts = splitUrl(hasScheme ? v : "https://" + v);
    return parts && { host: parts.host, path: parts.path };
  }
  let path: string;
  try {
    path = new URL(v.startsWith("/") ? v : "/" + v, BASE).pathname;
  } catch {
    return null;
  }
  if (mode === "contains" && !v.startsWith("/")) {
    path = path.slice(1);
    if (!path) return null;
  }
  return { host: null, path };
}

export function encodeCursor(c: Cursor): string {
  return c.startedAt + "." + c.id;
}

export function decodeCursor(v: string): Cursor | null {
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{8,64})$/.exec(v);
  return m ? { startedAt: Number(m[1]), id: m[2] } : null;
}

export function parseSearch(params: URLSearchParams): SessionQuery {
  const q: SessionQuery = { limit: 30 };
  const num = (name: string, min: number): number | undefined => {
    const raw = (params.get(name) || "").trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new SearchError(name + " must be a number of at least " + min + ".");
    return n;
  };

  const user = (params.get("user") || "").trim();
  if (user.length > MAX_USER_ID) throw new SearchError("user must be at most " + MAX_USER_ID + " characters.");
  if (user) q.user = user;

  const mode = params.get("urlMode") || "prefix";
  if (!MODES.includes(mode)) throw new SearchError("urlMode must be prefix, exact or contains.");
  const url = (params.get("url") || "").trim();
  if (url.length > MAX_URL) throw new SearchError("url must be at most " + MAX_URL + " characters.");
  if (url) {
    const parsed = parseUrlInput(url, mode as UrlMode);
    if (!parsed) throw new SearchError("url must be a page address or a path such as /checkout.");
    q.url = { host: parsed.host, path: parsed.path, mode: mode as UrlMode };
  }

  const from = num("from", 0);
  if (from !== undefined) q.from = from;
  const to = num("to", 0);
  if (to !== undefined) q.to = to;
  const minDuration = num("minDuration", 0);
  if (minDuration !== undefined) q.minDuration = minDuration * 1000;
  const maxDuration = num("maxDuration", 0);
  if (maxDuration !== undefined) q.maxDuration = maxDuration * 1000;
  const minPages = num("minPages", 1);
  if (minPages !== undefined) q.minPages = minPages;
  if (params.get("errors") === "1") q.errors = true;
  if (params.get("rage") === "1") q.rage = true;

  const device = params.get("device") || "";
  if (device && !DEVICES.includes(device)) throw new SearchError("device must be desktop, mobile or tablet.");
  if (device) q.device = device as Device;

  const cursor = params.get("cursor");
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) throw new SearchError("cursor is not valid.");
    q.cursor = c;
  }
  const limit = num("limit", 1);
  if (limit !== undefined) q.limit = Math.min(100, Math.floor(limit));
  return q;
}
