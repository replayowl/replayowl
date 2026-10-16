// OAuth sign-in against a mock OpenID Connect provider: discovery, PKCE, allowlist, errors, and adding
// a password after an OAuth-only start.

import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../../src/server/index.ts";
import { FsStorage } from "../../src/server/fs-storage.ts";
import { PgDb } from "../../src/server/pg.ts";
import { freshDatabase } from "../pg.ts";

interface MockUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

/** A minimal OIDC provider. `user` decides who "signs in" at the authorize endpoint; `deny` cancels instead. */
function mockProvider() {
  const codes = new Map<string, { challenge: string; redirect: string; user: MockUser }>();
  const tokens = new Map<string, MockUser>();
  const state = { user: { sub: "owner-1", email: "owner@example.com", email_verified: true } as MockUser, deny: false, base: "" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", state.base);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer: state.base,
        authorization_endpoint: state.base + "/authorize",
        token_endpoint: state.base + "/token",
        userinfo_endpoint: state.base + "/userinfo",
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("state", q.get("state") || "");
      if (q.get("client_id") !== "ro-client" || q.get("code_challenge_method") !== "S256") back.searchParams.set("error", "invalid_request");
      else if (state.deny) back.searchParams.set("error", "access_denied");
      else {
        const code = crypto.randomBytes(8).toString("hex");
        codes.set(code, { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, user: state.user });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const form = new URLSearchParams(body);
      if (req.headers.authorization !== "Basic " + Buffer.from("ro-client:ro-secret").toString("base64")) return send(401, { error: "invalid_client" });
      const entry = codes.get(form.get("code") || "");
      codes.delete(form.get("code") || "");
      const challenge = crypto.createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
      if (!entry || entry.challenge !== challenge || entry.redirect !== form.get("redirect_uri")) return send(400, { error: "invalid_grant" });
      const token = crypto.randomBytes(8).toString("hex");
      tokens.set(token, entry.user);
      return send(200, { access_token: token, token_type: "Bearer" });
    }
    if (url.pathname === "/userinfo") {
      const user = tokens.get((req.headers.authorization || "").replace(/^Bearer /, ""));
      return user ? send(200, user) : send(401, { error: "invalid_token" });
    }
    send(404, { error: "not found" });
  });
  return { server, state };
}

let provider: ReturnType<typeof mockProvider>;
let base = "";
let stop: () => Promise<void>;

test.beforeAll(async () => {
  provider = mockProvider();
  await new Promise<void>((r) => provider.server.listen(0, "127.0.0.1", r));
  provider.state.base = "http://127.0.0.1:" + (provider.server.address() as AddressInfo).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-oauth-"));
  const fresh = await freshDatabase();
  const db = PgDb.pool(fresh.url);
  const server = startServer({
    port: 0,
    host: "127.0.0.1",
    storage: new FsStorage(dir),
    db,
    setupToken: "",
    oauth: { name: "Mock ID", clientId: "ro-client", clientSecret: "ro-secret", issuer: provider.state.base, scopes: "openid email", allow: ["owner@example.com", "sub:robot-7"] },
  });
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  stop = async () => {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    await new Promise((r) => { provider.server.close(r); provider.server.closeAllConnections(); });
    await db.close();
    await fresh.drop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
});

test.afterAll(async () => {
  await stop();
});

test("OAuth only: sign in, add a password, then both work", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // No password and no setup form: OAuth is the way in, and nobody can claim the dashboard with a password.
  await page.goto(base + "/replay?id=abcdefgh");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.locator("#oauth")).toHaveText("Continue with Mock ID");
  await expect(page.locator("#form")).toBeHidden();
  const status = await (await fetch(base + "/api/auth/status")).json();
  expect(status).toMatchObject({ configured: true, password: false, oauth: { name: "Mock ID" }, needsToken: false });
  const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "takeover-password" }) });
  expect(setup.status).toBe(409);
  expect((await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "x" }) })).status).toBe(409);

  // The round trip through the provider lands on the requested page.
  await page.click("#oauth");
  await expect(page).toHaveURL(base + "/replay?id=abcdefgh");
  expect((await page.request.get(base + "/api/sessions")).status()).toBe(200);
  const cookies = await ctx.cookies();
  expect(cookies.find((c) => c.name === "ro_oauth")).toBeUndefined();

  // Set a password without a current one.
  await page.goto(base + "/");
  await expect(page.locator("#account-btn")).toHaveText("Set password");
  await page.click("#account-btn");
  await expect(page.locator("#pw-current-field")).toBeHidden();
  await page.fill("#pw-new", "oauth-then-pass");
  await page.fill("#pw-confirm", "oauth-then-pass");
  await page.click("#pw-submit");
  await expect(page.locator("#pw-ok")).toContainText("Password set");
  await page.click("#pw-cancel");
  await expect(page.locator("#account-btn")).toHaveText("Change password");

  // Sign out: both ways in are offered now.
  await page.click("#logout-btn");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("#oauth")).toBeVisible();
  await expect(page.locator("#or")).toBeVisible();
  await expect(page.locator("#confirm-field")).toBeHidden();
  await page.fill("#password", "oauth-then-pass");
  await page.click("#submit");
  await expect(page).toHaveURL(base + "/");
  await page.click("#logout-btn");
  await page.click("#oauth");
  await expect(page).toHaveURL(base + "/");
  await ctx.close();
});

test("allowlist by subject, refused accounts, cancelled and forged callbacks", async ({ page }) => {
  // An account with no email, allowed by its subject.
  provider.state.user = { sub: "robot-7" };
  await page.goto(base + "/login");
  await page.click("#oauth");
  await expect(page).toHaveURL(base + "/");
  await page.context().clearCookies();

  // An unverified email does not count, even when it is on the list.
  provider.state.user = { sub: "intruder", email: "owner@example.com", email_verified: false };
  await page.goto(base + "/login?next=%2Freplay%3Fid%3Dx");
  await page.click("#oauth");
  await expect(page).toHaveURL(/\/login\?error=denied/);
  await expect(page.locator("#error")).toContainText("sub:intruder is not allowed");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/replay?id=x");
  expect((await page.request.get(base + "/api/sessions")).status()).toBe(401);

  provider.state.deny = true;
  await page.click("#oauth");
  await expect(page.locator("#error")).toHaveText("The sign-in was cancelled at the provider.");
  provider.state.deny = false;

  // A callback without the matching state cookie (login CSRF) is refused.
  await page.goto(base + "/api/auth/oauth/callback?code=abc&state=forged");
  await expect(page).toHaveURL(/\/login\?error=state/);
  await expect(page.locator("#error")).toContainText("took too long");

  // Unknown codes cannot inject text; an open redirect through next is not possible.
  await page.goto(base + "/login?error=Call+555-0100+now");
  await expect(page.locator("#error")).toBeHidden();
  const start = await fetch(base + "/api/auth/oauth/start?next=//evil.example", { redirect: "manual" });
  expect(start.status).toBe(302);
  expect(start.headers.get("set-cookie")).toMatch(/ro_oauth=[^;]+\.%2F;/);
  expect(new URL(start.headers.get("location")!).searchParams.get("redirect_uri")).toBe(base + "/api/auth/oauth/callback");
});
