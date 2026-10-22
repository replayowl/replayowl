// Admin sign-in through a standard OAuth 2.0 / OpenID Connect provider: authorization code flow with
// PKCE (S256), identity read from the userinfo endpoint. Uses only fetch and WebCrypto, so it runs on
// Workers and Node.
//
// Endpoints come from OIDC discovery (OAUTH_ISSUER) or are given one by one, for plain OAuth 2.0
// providers such as GitHub. Only identities listed in OAUTH_ALLOW may sign in.

import { b64, random } from "./auth.ts";

export interface OAuthConfig {
  /** Shown on the sign-in button, e.g. "Google". */
  name: string;
  clientId: string;
  /** Empty for public clients that rely on PKCE alone. */
  clientSecret: string;
  issuer?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  scopes: string;
  /** Emails, "@domain" for a whole email domain, "sub:<subject>" for a provider account id, or "*" for everyone. */
  allow: string[];
  /** How the client authenticates at the token endpoint; picked from discovery when unset. */
  tokenAuth?: "basic" | "post";
  /** Overrides <origin>/api/auth/oauth/callback, e.g. behind a reverse proxy that changes the origin. */
  redirectUri?: string;
}

export interface OAuthIdentity {
  sub: string;
  /** Null when the provider did not return one or marked it unverified. */
  email: string | null;
}

interface Endpoints {
  authorize: string;
  token: string;
  userinfo: string;
  tokenAuth: "basic" | "post";
}

export class OAuthError extends Error {}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Reads OAUTH_* variables. Null when OAuth is off (no client id); throws on an incomplete setup. */
export function oauthConfigFromEnv(env: Record<string, unknown>): OAuthConfig | null {
  const clientId = str(env.OAUTH_CLIENT_ID);
  if (!clientId) return null;
  const cfg: OAuthConfig = {
    name: str(env.OAUTH_NAME) || "SSO",
    clientId,
    clientSecret: str(env.OAUTH_CLIENT_SECRET),
    issuer: str(env.OAUTH_ISSUER) || undefined,
    authorizeUrl: str(env.OAUTH_AUTHORIZE_URL) || undefined,
    tokenUrl: str(env.OAUTH_TOKEN_URL) || undefined,
    userinfoUrl: str(env.OAUTH_USERINFO_URL) || undefined,
    scopes: str(env.OAUTH_SCOPES) || "openid email profile",
    allow: str(env.OAUTH_ALLOW).split(/[\s,]+/).filter(Boolean),
    redirectUri: str(env.OAUTH_REDIRECT_URI) || undefined,
  };
  const auth = str(env.OAUTH_TOKEN_AUTH);
  if (auth) {
    if (auth !== "basic" && auth !== "post") throw new Error("OAUTH_TOKEN_AUTH must be basic or post");
    cfg.tokenAuth = auth;
  }
  if (!cfg.issuer && !(cfg.authorizeUrl && cfg.tokenUrl && cfg.userinfoUrl)) {
    throw new Error("OAuth needs OAUTH_ISSUER, or OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL and OAUTH_USERINFO_URL");
  }
  // Without an allowlist every account at the provider could open the dashboard.
  if (!cfg.allow.length) throw new Error("OAuth needs OAUTH_ALLOW: the emails, @domains or sub:<id> entries that may sign in");
  return cfg;
}

/** True when the identity matches an OAUTH_ALLOW entry. */
export function isAllowed(id: OAuthIdentity, allow: string[]): boolean {
  const email = id.email ? id.email.toLowerCase() : null;
  for (const raw of allow) {
    const entry = raw.toLowerCase();
    // "*" trusts the provider's own access control, e.g. a self-hosted server with a per-app allowlist.
    if (entry === "*") return true;
    if (entry.startsWith("sub:")) {
      if (raw.slice(4) === id.sub) return true;
    } else if (entry.startsWith("@")) {
      if (email && email.endsWith(entry)) return true;
    } else if (email && email === entry) {
      return true;
    }
  }
  return false;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

/** A fresh state value and PKCE verifier for one sign-in attempt. */
export function newFlow(): { state: string; verifier: string } {
  return { state: b64(random(16)), verifier: b64(random(32)) };
}

export class OAuthClient {
  readonly cfg: OAuthConfig;
  private fetch: typeof fetch;
  private endpoints: Endpoints | null = null;

  constructor(cfg: OAuthConfig, fetchFn: typeof fetch = (input, init) => fetch(input, init)) {
    this.cfg = cfg;
    this.fetch = fetchFn;
  }

  private async resolve(): Promise<Endpoints> {
    if (this.endpoints) return this.endpoints;
    const c = this.cfg;
    let doc: Record<string, unknown> | null = null;
    if (c.issuer && !(c.authorizeUrl && c.tokenUrl && c.userinfoUrl && c.tokenAuth)) {
      const url = c.issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
      const res = await this.fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new OAuthError("discovery at " + url + " answered HTTP " + res.status);
      doc = (await res.json()) as Record<string, unknown>;
    }
    const authorize = c.authorizeUrl || str(doc?.authorization_endpoint);
    const token = c.tokenUrl || str(doc?.token_endpoint);
    const userinfo = c.userinfoUrl || str(doc?.userinfo_endpoint);
    if (!authorize || !token || !userinfo) throw new OAuthError("the provider did not publish authorization, token and userinfo endpoints");
    // OIDC providers default to client_secret_basic; plain OAuth 2.0 providers (no discovery) mostly expect the secret in the body.
    const methods = Array.isArray(doc?.token_endpoint_auth_methods_supported) ? (doc!.token_endpoint_auth_methods_supported as unknown[]) : [];
    const postOnly = methods.includes("client_secret_post") && !methods.includes("client_secret_basic");
    const tokenAuth = c.tokenAuth || (!doc || postOnly ? "post" : "basic");
    this.endpoints = { authorize, token, userinfo, tokenAuth };
    return this.endpoints;
  }

  async authorizeUrl(redirectUri: string, state: string, verifier: string): Promise<string> {
    const ep = await this.resolve();
    const url = new URL(ep.authorize);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.cfg.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", this.cfg.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.href;
  }

  /** Exchanges the authorization code and reads who signed in. */
  async identify(code: string, verifier: string, redirectUri: string): Promise<OAuthIdentity> {
    const ep = await this.resolve();
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    const { clientId, clientSecret } = this.cfg;
    if (clientSecret && ep.tokenAuth === "basic") {
      headers.Authorization = "Basic " + btoa(encodeURIComponent(clientId) + ":" + encodeURIComponent(clientSecret));
    } else {
      form.set("client_id", clientId);
      if (clientSecret) form.set("client_secret", clientSecret);
    }
    const res = await this.fetch(ep.token, { method: "POST", headers, body: form.toString() });
    const text = await res.text();
    let tok: Record<string, unknown> = {};
    try {
      tok = JSON.parse(text);
    } catch {
      /* reported below */
    }
    const accessToken = str(tok.access_token);
    if (!res.ok || !accessToken) {
      throw new OAuthError("token endpoint answered HTTP " + res.status + (tok.error ? " (" + str(tok.error) + ")" : "") + " without an access token");
    }

    // GitHub's API refuses requests without a User-Agent.
    const info = await this.fetch(ep.userinfo, { headers: { Authorization: "Bearer " + accessToken, Accept: "application/json", "User-Agent": "Replayowl" } });
    if (!info.ok) throw new OAuthError("userinfo endpoint answered HTTP " + info.status);
    const user = (await info.json()) as Record<string, unknown>;
    // OIDC uses "sub"; plain OAuth 2.0 APIs such as GitHub's use a numeric "id".
    const sub = user.sub != null ? String(user.sub) : user.id != null ? String(user.id) : "";
    if (!sub) throw new OAuthError("userinfo has neither sub nor id");
    const email = str(user.email) && user.email_verified !== false && user.email_verified !== "false" ? str(user.email) : null;
    return { sub, email };
  }
}
