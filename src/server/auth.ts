// Single admin account protected by a password and/or OAuth sign-in (oauth.ts). Uses only WebCrypto,
// so it runs on Workers and Node.
//
// The "admin" row of the settings table holds the PBKDF2 hash of the password (absent when only OAuth
// is used) and a random secret that signs session cookies. Changing the password rotates the secret,
// which signs every existing session out.

import type { Db } from "./db.ts";

const SETTINGS_KEY = "admin";
// Workers cap PBKDF2 at 100k iterations.
const ITERATIONS = 100_000;
const SESSION_DAYS = 14;
export const COOKIE = "ro_session";
export const MIN_PASSWORD = 8;

export interface AdminConfig {
  v: 1;
  /** Password fields, absent until a password is set. */
  salt?: string;
  hash?: string;
  iterations?: number;
  secret: string;
  updatedAt: number;
}

const enc = new TextEncoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Constant-time comparison of two strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return b64(bits);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", unb64(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function hashPassword(password: string): Promise<AdminConfig> {
  const salt = random(16);
  return { v: 1, salt: b64(salt), hash: await derive(password, salt, ITERATIONS), iterations: ITERATIONS, secret: b64(random(32)), updatedAt: Date.now() };
}

/** A config holding only the cookie signing secret, for deployments that sign in through OAuth. */
export function secretOnly(): AdminConfig {
  return { v: 1, secret: b64(random(32)), updatedAt: Date.now() };
}

export function hasPassword(cfg: AdminConfig | null): boolean {
  return !!cfg && !!cfg.hash && !!cfg.salt && !!cfg.iterations;
}

export async function verifyPassword(cfg: AdminConfig, password: string): Promise<boolean> {
  if (!hasPassword(cfg)) return false;
  return safeEqual(await derive(password, unb64(cfg.salt!), cfg.iterations!), cfg.hash!);
}

/** Cookie value: expiry.nonce.signature */
export async function issueSession(cfg: AdminConfig, now = Date.now()): Promise<string> {
  const payload = String(now + SESSION_DAYS * 86400_000) + "." + b64(random(12));
  return payload + "." + (await hmac(cfg.secret, payload));
}

export async function checkSession(cfg: AdminConfig, value: string | null, now = Date.now()): Promise<boolean> {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < now) return false;
  return safeEqual(await hmac(cfg.secret, parts[0] + "." + parts[1]), parts[2]);
}

export function sessionCookie(value: string, secure: boolean): string {
  return COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400 + (secure ? "; Secure" : "");
}

export function clearCookie(secure: boolean): string {
  return COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (secure ? "; Secure" : "");
}

export function readCookie(header: string | null, name = COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Loads and caches the admin config. Workers run many isolates, each with its own cache, so a change
 * made in one isolate is invisible to the others until their cache expires. Callers that act on the
 * config (setup, login, password change) pass `fresh`; session checks retry fresh on failure.
 */
export class AdminStore {
  private db: Db;
  private cached: { cfg: AdminConfig | null; at: number } | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  /** Age of the cached copy in ms, Infinity when nothing is cached. */
  get age(): number {
    return this.cached ? Date.now() - this.cached.at : Infinity;
  }

  async get(fresh = false): Promise<AdminConfig | null> {
    if (!fresh && this.cached && Date.now() - this.cached.at < 10_000) return this.cached.cfg;
    const rows = await this.db.all<{ value: string }>("SELECT value FROM settings WHERE key = ?", [SETTINGS_KEY]);
    let cfg: AdminConfig | null = null;
    if (rows.length) {
      try {
        cfg = JSON.parse(rows[0].value);
      } catch {
        cfg = null;
      }
    }
    this.cached = { cfg, at: Date.now() };
    return cfg;
  }

  /** Stores the first config. False when one exists already, e.g. a simultaneous setup won. */
  async create(cfg: AdminConfig): Promise<boolean> {
    try {
      await this.db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [SETTINGS_KEY, JSON.stringify(cfg)]);
    } catch (err) {
      if (this.db.isUniqueViolation(err)) return false;
      throw err;
    }
    this.cached = { cfg, at: Date.now() };
    return true;
  }

  /** The current config, creating a secret-only one when none exists yet (first OAuth sign-in). */
  async ensure(): Promise<AdminConfig> {
    const cfg = await this.get(true);
    if (cfg) return cfg;
    if (await this.create(secretOnly())) return this.cached!.cfg!;
    return (await this.get(true))!;
  }

  /** Replaces `prev` with `next` unless someone else changed the row first. */
  async replace(prev: AdminConfig, next: AdminConfig): Promise<boolean> {
    await this.db.run("UPDATE settings SET value = ? WHERE key = ? AND value = ?", [JSON.stringify(next), SETTINGS_KEY, JSON.stringify(prev)]);
    const now = await this.get(true);
    return !!now && now.secret === next.secret;
  }

  async set(cfg: AdminConfig): Promise<void> {
    await this.db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [SETTINGS_KEY, JSON.stringify(cfg)]);
    this.cached = { cfg, at: Date.now() };
  }
}

/** Per-isolate brake on password guessing. Best effort: Workers may run many isolates. */
export class LoginLimiter {
  private fails = new Map<string, { n: number; until: number; first: number }>();

  blocked(ip: string, now = Date.now()): number {
    const f = this.fails.get(ip);
    return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
  }

  fail(ip: string, now = Date.now()) {
    let f = this.fails.get(ip);
    if (!f || now - f.first > 15 * 60_000) f = { n: 0, until: 0, first: now };
    f.n++;
    if (f.n >= 5) f.until = now + Math.min(15 * 60_000, 30_000 * 2 ** (f.n - 5));
    this.fails.set(ip, f);
    if (this.fails.size > 10_000) this.fails.clear();
  }

  succeed(ip: string) {
    this.fails.delete(ip);
  }
}
