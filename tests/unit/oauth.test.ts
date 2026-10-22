import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminStore, hasPassword, hashPassword, secretOnly } from "../../src/server/auth.ts";
import { withSchema } from "../../src/server/db.ts";
import { OAuthClient, isAllowed, oauthConfigFromEnv, pkceChallenge, type OAuthConfig } from "../../src/server/oauth.ts";
import { PgDb } from "../../src/server/pg.ts";
import { freshDatabase } from "../pg.ts";

test("OAuth config from the environment", () => {
  assert.equal(oauthConfigFromEnv({}), null);
  assert.throws(() => oauthConfigFromEnv({ OAUTH_CLIENT_ID: "id", OAUTH_ALLOW: "a@b.c" }), /OAUTH_ISSUER/);
  assert.throws(() => oauthConfigFromEnv({ OAUTH_CLIENT_ID: "id", OAUTH_ISSUER: "https://idp" }), /OAUTH_ALLOW/);
  assert.throws(() => oauthConfigFromEnv({ OAUTH_CLIENT_ID: "id", OAUTH_ISSUER: "https://idp", OAUTH_ALLOW: "x", OAUTH_TOKEN_AUTH: "jwt" }), /basic or post/);
  const cfg = oauthConfigFromEnv({ OAUTH_CLIENT_ID: "id", OAUTH_ISSUER: "https://idp", OAUTH_ALLOW: " a@b.c, @corp.example\nsub:42 " })!;
  assert.deepEqual(cfg.allow, ["a@b.c", "@corp.example", "sub:42"]);
  assert.equal(cfg.scopes, "openid email profile");
  assert.equal(cfg.name, "SSO");
  const gh = oauthConfigFromEnv({
    OAUTH_CLIENT_ID: "id", OAUTH_AUTHORIZE_URL: "https://a", OAUTH_TOKEN_URL: "https://t", OAUTH_USERINFO_URL: "https://u", OAUTH_ALLOW: "sub:1", OAUTH_NAME: "GitHub", OAUTH_SCOPES: "read:user",
  })!;
  assert.equal(gh.issuer, undefined);
  assert.equal(gh.scopes, "read:user");
});

test("allowlist matches emails, domains and subjects", () => {
  const allow = ["Admin@Example.com", "@corp.example", "sub:AbC"];
  assert.equal(isAllowed({ sub: "1", email: "admin@example.com" }, allow), true);
  assert.equal(isAllowed({ sub: "1", email: "bob@corp.example" }, allow), true);
  assert.equal(isAllowed({ sub: "1", email: "bob@evilcorp.example" }, allow), false);
  assert.equal(isAllowed({ sub: "1", email: "bob@sub.corp.example" }, allow), false);
  assert.equal(isAllowed({ sub: "AbC", email: null }, allow), true);
  assert.equal(isAllowed({ sub: "abc", email: null }, allow), false, "subjects are case sensitive");
  assert.equal(isAllowed({ sub: "1", email: null }, allow), false);
  assert.equal(isAllowed({ sub: "1", email: null }, ["*"]), true);
});

function stubProvider(opts: { discovery?: Record<string, unknown>; user: Record<string, unknown> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json(opts.discovery);
    if (url.endsWith("/token")) return Response.json({ access_token: "at-1", token_type: "Bearer" });
    if (url.endsWith("/userinfo")) {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer at-1" ? Response.json(opts.user) : new Response("no", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const base: OAuthConfig = { name: "IdP", clientId: "client 1", clientSecret: "s3cret", scopes: "openid email", allow: [] };

test("OIDC discovery, PKCE and client_secret_basic", async () => {
  const { fetchFn, calls } = stubProvider({
    discovery: { authorization_endpoint: "https://idp/auth", token_endpoint: "https://idp/token", userinfo_endpoint: "https://idp/userinfo" },
    user: { sub: "u-1", email: "a@b.c", email_verified: true },
  });
  const client = new OAuthClient({ ...base, issuer: "https://idp/" }, fetchFn);
  const auth = new URL(await client.authorizeUrl("https://ro/cb", "st", "verifier-123"));
  assert.equal(auth.origin + auth.pathname, "https://idp/auth");
  assert.equal(auth.searchParams.get("code_challenge"), await pkceChallenge("verifier-123"));
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("state"), "st");
  assert.equal(auth.searchParams.get("client_id"), "client 1");
  assert.deepEqual(await client.identify("code-1", "verifier-123", "https://ro/cb"), { sub: "u-1", email: "a@b.c" });
  assert.equal(calls.filter((c) => c.url.includes("well-known")).length, 1, "discovery is cached");
  const tokenCall = calls.find((c) => c.url.endsWith("/token"))!;
  const headers = new Headers(tokenCall.init!.headers);
  assert.equal(headers.get("authorization"), "Basic " + btoa("client%201:s3cret"));
  const body = new URLSearchParams(String(tokenCall.init!.body));
  assert.equal(body.get("code_verifier"), "verifier-123");
  assert.equal(body.get("client_secret"), null);
});

test("plain OAuth 2.0 endpoints, client_secret_post, numeric ids and unverified emails", async () => {
  const { fetchFn, calls } = stubProvider({ user: { id: 42, login: "owl", email: "x@y.z", email_verified: false } });
  const client = new OAuthClient({ ...base, authorizeUrl: "https://gh/authorize", tokenUrl: "https://gh/token", userinfoUrl: "https://gh/userinfo" }, fetchFn);
  assert.deepEqual(await client.identify("c", "v", "https://ro/cb"), { sub: "42", email: null });
  assert.equal(calls.some((c) => c.url.includes("well-known")), false);
  const tokenCall = calls.find((c) => c.url.endsWith("/token"))!;
  assert.equal(new Headers(tokenCall.init!.headers).get("authorization"), null);
  const body = new URLSearchParams(String(tokenCall.init!.body));
  assert.equal(body.get("client_id"), "client 1");
  assert.equal(body.get("client_secret"), "s3cret");
  assert.equal(new Headers(calls.find((c) => c.url.endsWith("/userinfo"))!.init!.headers).get("user-agent"), "Replayowl");
});

test("discovery that only supports client_secret_post", async () => {
  const { fetchFn, calls } = stubProvider({
    discovery: { authorization_endpoint: "https://idp/auth", token_endpoint: "https://idp/token", userinfo_endpoint: "https://idp/userinfo", token_endpoint_auth_methods_supported: ["client_secret_post"] },
    user: { sub: "u" },
  });
  await new OAuthClient({ ...base, issuer: "https://idp" }, fetchFn).identify("c", "v", "https://ro/cb");
  assert.equal(new URLSearchParams(String(calls.find((c) => c.url.endsWith("/token"))!.init!.body)).get("client_secret"), "s3cret");
});

test("a secret-only admin row: ensure creates it once, a password replaces it", async () => {
  const fresh = await freshDatabase();
  const db = PgDb.pool(fresh.url);
  try {
    const sdb = withSchema(db);
    const store = new AdminStore(sdb);
    assert.equal(await store.get(true), null);
    const [a, b] = await Promise.all([new AdminStore(sdb).ensure(), new AdminStore(sdb).ensure()]);
    assert.equal(a.secret, b.secret, "concurrent first sign-ins share one secret");
    assert.equal(hasPassword(a), false);
    const withPw = await hashPassword("a-password");
    assert.equal(await store.replace(a, withPw), true);
    assert.equal(hasPassword(await store.get(true)), true);
    assert.equal(await store.replace(a, secretOnly()), false, "a stale replace does not apply");
    assert.equal((await store.get(true))!.secret, withPw.secret);
  } finally {
    await db.close();
    await fresh.drop();
  }
});
