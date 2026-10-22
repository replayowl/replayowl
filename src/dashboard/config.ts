// Where the dashboard finds its pages and session API. A self-hosted deployment uses the defaults. A host
// that serves the dashboard per project (the hosted service) puts a JSON object into the page:
//   <script type="application/json" id="replayowl-config">{"base": "/p/abc", "canDelete": false}</script>

export interface DashboardConfig {
  /** Prefix of the dashboard pages ("<base>/", "<base>/replay") and of the session API ("<base>/api/sessions"). */
  base: string;
  /** False hides the delete buttons, for people who may only watch. */
  canDelete: boolean;
  /** Recorder snippet shown while there are no sessions; null shows the one for this server. */
  snippet: string | null;
  /** Account menu (password, sign out) of the self-hosted admin. */
  account: boolean;
}

function read(): DashboardConfig {
  const config: DashboardConfig = { base: "", canDelete: true, snippet: null, account: true };
  const el = document.getElementById("replayowl-config");
  if (!el) return config;
  try {
    const v = JSON.parse(el.textContent || "{}");
    if (typeof v.base === "string" && /^(\/[A-Za-z0-9._~-]+)*$/.test(v.base)) config.base = v.base;
    if (typeof v.canDelete === "boolean") config.canDelete = v.canDelete;
    if (typeof v.snippet === "string") config.snippet = v.snippet;
    if (typeof v.account === "boolean") config.account = v.account;
  } catch {
    /* keep the defaults */
  }
  return config;
}

export const config = read();
export const sessionsApi = config.base + "/api/sessions";
export const listPage = config.base + "/";
export const replayPage = (id: string) => config.base + "/replay?id=" + encodeURIComponent(id);
