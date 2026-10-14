import { postJson } from "./api.ts";
import { OWL_SVG, svg } from "./util.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
$("mark").append(svg(OWL_SVG.replace("<svg ", '<svg width="48" height="48" ')));

const form = $<HTMLFormElement>("form");
const password = $<HTMLInputElement>("password");
const confirm = $<HTMLInputElement>("confirm");
const token = $<HTMLInputElement>("token");
const error = $("error");
const submit = $<HTMLButtonElement>("submit");
let mode: "login" | "setup" = "login";

function showError(msg: string | null) {
  error.textContent = msg || "";
  error.hidden = !msg;
}

function next(): string {
  const n = new URLSearchParams(location.search).get("next") || "/";
  // Only same-site paths, never another origin.
  return n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : "/";
}

const OAUTH_ERRORS: Record<string, string> = {
  cancelled: "The sign-in was cancelled at the provider.",
  state: "The sign-in took too long or was started in another browser. Try again.",
  provider: "The sign-in provider could not be reached or refused the request. Try again, or check the server log.",
};

/** Error handed back by the OAuth callback. Only known codes are shown, so a crafted link cannot put arbitrary text here. */
function oauthError(): string | null {
  const q = new URLSearchParams(location.search);
  const code = q.get("error");
  if (!code) return null;
  if (code === "denied") {
    const who = (q.get("who") || "").slice(0, 200);
    return "The account " + (who || "you signed in with") + " is not allowed to open this dashboard. Add it to OAUTH_ALLOW to let it in.";
  }
  return OAUTH_ERRORS[code] || null;
}

interface Status {
  configured: boolean;
  password: boolean;
  oauth: { name: string } | null;
  authenticated: boolean;
  needsToken: boolean;
}

async function init() {
  const res = await fetch("/api/auth/status", { credentials: "same-origin" });
  const status: Status = await res.json();
  if (status.authenticated) {
    location.replace(next());
    return;
  }
  showError(oauthError());
  if (status.oauth) {
    const link = $<HTMLAnchorElement>("oauth");
    link.textContent = "Continue with " + status.oauth.name;
    link.href = "/api/auth/oauth/start?next=" + encodeURIComponent(next());
    link.hidden = false;
    $("or").hidden = !status.password;
    $("lead").textContent = "Sign in with " + status.oauth.name + (status.password ? " or the admin password" : "") + " to view recorded sessions.";
    if (!status.password) {
      link.focus();
      return;
    }
  }
  if (!status.configured) {
    mode = "setup";
    document.title = "Set up - Replayowl";
    $("heading").textContent = "Set the admin password";
    $("lead").textContent = "This password protects your recorded sessions. You will use it to sign in from now on.";
    $("password-label").textContent = "New password";
    password.autocomplete = "new-password";
    password.minLength = 8;
    $("confirm-field").hidden = false;
    $("token-field").hidden = !status.needsToken;
    submit.textContent = "Set password and sign in";
  } else if (!status.oauth) {
    $("lead").textContent = "Enter the admin password to view recorded sessions.";
  }
  form.hidden = false;
  (status.needsToken && mode === "setup" ? token : status.oauth ? $("oauth") : password).focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(null);
  if (mode === "setup") {
    if (password.value.length < 8) return showError("Use at least 8 characters.");
    if (password.value !== confirm.value) return showError("The two passwords do not match.");
  } else if (!password.value) {
    return showError("Enter the password.");
  }
  submit.disabled = true;
  try {
    const r = await postJson(mode === "setup" ? "/api/auth/setup" : "/api/auth/login", { password: password.value, token: token.value });
    if (r.ok) {
      location.replace(next());
      return;
    }
    showError(r.data.error || "Sign-in failed (HTTP " + r.status + ").");
    password.select();
  } catch {
    showError("Could not reach the server. Check your connection and try again.");
  } finally {
    submit.disabled = false;
  }
});

void init();
