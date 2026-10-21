import type { SessionSummary } from "../shared/protocol.ts";
import { api, errorText, postJson } from "./api.ts";
import { config, listPage, replayPage, sessionsApi } from "./config.ts";
import { OWL_SVG, describeUA, formatDuration, h, hostOf, pathOf, relativeTime, svg } from "./util.ts";

const PLAY = '<svg viewBox="0 0 16 16"><path d="M3 1.5v13L14 8z"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>';

const brand = document.getElementById("brand") as HTMLAnchorElement;
brand.prepend(svg(OWL_SVG));
brand.href = listPage;
if (!config.demo) document.getElementById("demo-btn")?.remove();

const list = document.getElementById("sessions")!;
const form = document.getElementById("search-form") as HTMLFormElement;
const more = document.getElementById("more")!;
const moreBtn = document.getElementById("more-btn")!;
const clearBtn = document.getElementById("clear-btn")!;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const select = (id: string) => document.getElementById(id) as HTMLSelectElement;

// Query parameter, form control. Text and number fields map one to one.
const FIELDS: [string, string][] = [["user", "q-user"], ["url", "q-url"], ["minDuration", "q-min-dur"], ["maxDuration", "q-max-dur"], ["minPages", "q-min-pages"], ["device", "q-device"]];
const TIMES: [string, string][] = [["from", "q-from"], ["to", "q-to"]];
const PANEL = ["from", "to", "minDuration", "maxDuration", "minPages", "device", "errors", "rage"];

let query = new URLSearchParams(location.search);
query.delete("cursor");
let sessions: SessionSummary[] = [];
let nextCursor: string | null = null;
let pagesLoaded = 1;
// Bumped by every request; a response is applied only if no newer request started since.
let generation = 0;

/** datetime-local value for a timestamp, in local time. */
const localInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function formQuery(): URLSearchParams {
  const p = new URLSearchParams();
  for (const [name, id] of FIELDS) {
    const v = (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value.trim();
    if (v) p.set(name, v);
  }
  if (p.has("url") && select("q-mode").value !== "prefix") p.set("urlMode", select("q-mode").value);
  for (const [name, id] of TIMES) {
    const t = input(id).value ? new Date(input(id).value).getTime() : NaN;
    if (Number.isFinite(t)) p.set(name, String(t));
  }
  if (input("q-errors").checked) p.set("errors", "1");
  if (input("q-rage").checked) p.set("rage", "1");
  return p;
}

function fillForm(p: URLSearchParams) {
  for (const [name, id] of FIELDS) (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value = p.get(name) || "";
  select("q-mode").value = p.get("urlMode") || "prefix";
  for (const [name, id] of TIMES) {
    const t = Number(p.get(name));
    input(id).value = p.get(name) && Number.isFinite(t) ? localInput(t) : "";
  }
  input("q-errors").checked = p.get("errors") === "1";
  input("q-rage").checked = p.get("rage") === "1";
  setPanel(PANEL.some((k) => p.has(k)));
  clearBtn.hidden = !p.toString();
}

function setPanel(open: boolean) {
  more.hidden = !open;
  moreBtn.setAttribute("aria-expanded", String(open));
}

function search(p: URLSearchParams) {
  query = p;
  history.pushState(null, "", p.toString() ? "?" + p : location.pathname);
  clearBtn.hidden = !p.toString();
  void load();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  search(formQuery());
});
moreBtn.onclick = () => setPanel(more.hidden);
clearBtn.onclick = () => {
  fillForm(new URLSearchParams());
  search(new URLSearchParams());
};
// Back and forward between searches, and back from a replay when the page is restored from cache.
addEventListener("popstate", () => {
  query = new URLSearchParams(location.search);
  fillForm(query);
  void load();
});
fillForm(query);

function render() {
  const shown = sessions;
  document.getElementById("subtitle")!.textContent = query.toString() ? "Matching visits, newest first." : "Recorded visits, newest first.";
  list.innerHTML = "";
  if (!sessions.length && !query.toString()) {
    const snippet = config.snippet || '<script src="' + location.origin + '/recorder.js" data-endpoint="' + location.origin + '/api/ingest" defer></script>';
    list.append(
      h("div", { class: "empty" },
        svg(OWL_SVG.replace("<svg ", '<svg width="56" height="56" ')),
        h("h2", {}, "No sessions yet"),
        h("p", {}, (config.demo ? "Open the demo shop and click around, then come back here. " : "") + "To record your own site, add the recorder script to its pages:"),
        h("p", {}, h("code", {}, snippet)),
        config.demo ? h("a", { class: "btn primary", href: "/demo/", target: "_blank", rel: "noopener" }, "Open demo shop") : null,
      ),
    );
    return;
  }
  list.append(
    h("div", { class: "row head" }, h("span"), h("span", {}, "Entry page"), h("span", { class: "hide-sm" }, "User"), h("span", { class: "hide-sm" }, "Started"), h("span", {}, "Duration"), h("span", { class: "hide-sm" }, "Device"), h("span", { class: "hide-sm" }, "Signals"), h("span")),
  );
  if (!shown.length) {
    list.append(h("div", { class: "empty-panel" }, "No sessions match this search."));
    return;
  }
  for (const s of shown) {
    const signals = h("span", { class: "signals hide-sm" });
    if (s.errors) signals.append(h("span", { class: "tag red" }, s.errors + (s.errors === 1 ? " error" : " errors")));
    if (s.rageClicks) signals.append(h("span", { class: "tag red" }, s.rageClicks + " rage " + (s.rageClicks === 1 ? "click" : "clicks")));
    if (s.pages > 1) signals.append(h("span", { class: "tag plum" }, s.pages + " pages"));
    signals.append(h("span", { class: "tag" }, s.clicks + (s.clicks === 1 ? " click" : " clicks")));
    const del = h("button", { class: "del", title: "Delete session", "aria-label": "Delete session" }, svg(TRASH));
    del.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm("Delete this session? This cannot be undone.")) return;
      const res = await api(sessionsApi + "/" + encodeURIComponent(s.id), { method: "DELETE" });
      if (!res.ok) {
        alert("Could not delete the session. " + (await errorText(res)));
        return;
      }
      sessions = sessions.filter((x) => x.id !== s.id);
      render();
    };
    const user = h("span", { class: "user hide-sm" });
    for (const uid of s.userIds.slice(0, 2)) {
      const b = h("button", { type: "button", class: "user-link", title: "Show sessions of " + uid }, uid);
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = new URLSearchParams();
        p.set("user", uid);
        fillForm(p);
        search(p);
      };
      user.append(b);
    }
    if (s.userIds.length > 2) user.append(h("small", { class: "muted", title: s.userIds.slice(2).join(", ") }, "+" + (s.userIds.length - 2)));
    if (!s.userIds.length) user.append(h("span", { class: "muted" }, "Anonymous"));
    list.append(
      h("a", { class: "row", href: replayPage(s.id) },
        h("span", { class: "play-dot" }, svg(PLAY)),
        h("span", { class: "entry" }, h("b", {}, pathOf(s.firstUrl) || "/"), h("small", {}, hostOf(s.firstUrl) + (s.lastUrl !== s.firstUrl ? "  to " + pathOf(s.lastUrl) : ""))),
        user,
        h("span", { class: "muted hide-sm", title: new Date(s.startedAt).toLocaleString() }, relativeTime(s.startedAt)),
        h("span", { class: "num" }, formatDuration(s.duration)),
        h("span", { class: "muted hide-sm" }, describeUA(s.ua), h("br"), h("small", { class: "num" }, s.w + " × " + s.h)),
        signals,
        config.canDelete ? del : h("span"),
      ),
    );
  }
  if (nextCursor) {
    const more = h("button", { class: "btn", type: "button" }, "Load older sessions");
    more.onclick = () => loadMore(more);
    list.append(h("div", { class: "load-more" }, more));
  }
}

async function fetchPage(cursor: string | null): Promise<{ sessions: SessionSummary[]; next: string | null }> {
  const p = new URLSearchParams(query);
  if (cursor) p.set("cursor", cursor);
  const res = await api(sessionsApi + (p.toString() ? "?" + p : ""));
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

async function load() {
  const gen = ++generation;
  try {
    const page = await fetchPage(null);
    if (gen !== generation) return;
    sessions = page.sessions;
    nextCursor = page.next;
    pagesLoaded = 1;
    render();
  } catch (e) {
    if (gen !== generation) return;
    list.innerHTML = "";
    list.append(h("div", { class: "empty-panel" }, "Could not load sessions. " + (e as Error).message));
  }
}

async function loadMore(btn: HTMLButtonElement) {
  if (!nextCursor) return;
  btn.disabled = true;
  const gen = ++generation;
  try {
    const page = await fetchPage(nextCursor);
    if (gen !== generation) return;
    sessions = sessions.concat(page.sessions);
    nextCursor = page.next;
    pagesLoaded++;
    render();
  } catch (e) {
    if (gen !== generation) return;
    btn.disabled = false;
    btn.textContent = "Could not load more. Try again";
  }
}

void load();
// Sessions grow while visitors are active; refresh the first page quietly unless the user is searching or paging.
setInterval(() => {
  if (document.visibilityState === "visible" && !query.toString() && pagesLoaded === 1) void load();
}, 5000);

// Account: sign out and password change. Admins who signed in through OAuth may not have a password yet.
if (config.account) setupAccount();
else for (const id of ["account-btn", "logout-btn"]) document.getElementById(id)?.remove();

function setupAccount() {
  let hasPassword = true;
  function setPasswordMode(has: boolean) {
    hasPassword = has;
    const label = has ? "Change password" : "Set password";
    document.getElementById("account-btn")!.textContent = label;
    document.getElementById("pw-title")!.textContent = label;
    document.getElementById("pw-submit")!.textContent = label;
    document.getElementById("pw-current-field")!.hidden = !has;
  }
  void fetch("/api/auth/status", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((s: { password?: boolean }) => setPasswordMode(s.password !== false))
    .catch(() => {});
  document.getElementById("logout-btn")!.onclick = async () => {
    await postJson("/api/auth/logout", {});
    location.href = "/login";
  };
  const dialog = document.getElementById("account") as HTMLDialogElement;
  const pw = (id: string) => document.getElementById(id) as HTMLInputElement;
  const pwError = document.getElementById("pw-error")!;
  const pwOk = document.getElementById("pw-ok")!;
  document.getElementById("account-btn")!.onclick = () => {
    (document.getElementById("pw-form") as HTMLFormElement).reset();
    pwError.hidden = true;
    pwOk.hidden = true;
    dialog.showModal();
    pw(hasPassword ? "pw-current" : "pw-new").focus();
  };
  document.getElementById("pw-cancel")!.onclick = () => dialog.close();
  document.getElementById("pw-form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    pwOk.hidden = true;
    const fail = (msg: string) => {
      pwError.textContent = msg;
      pwError.hidden = false;
    };
    if (pw("pw-new").value.length < 8) return fail("Use at least 8 characters for the new password.");
    if (pw("pw-new").value !== pw("pw-confirm").value) return fail("The two new passwords do not match.");
    const btn = document.getElementById("pw-submit") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await postJson("/api/auth/password", { current: pw("pw-current").value, password: pw("pw-new").value });
      if (!r.ok) return fail(r.data.error || "Could not change the password (HTTP " + r.status + ").");
      pwError.hidden = true;
      pwOk.textContent = hasPassword ? "Password changed." : "Password set. You can now also sign in with it.";
      pwOk.hidden = false;
      setPasswordMode(true);
      (document.getElementById("pw-form") as HTMLFormElement).reset();
    } finally {
      btn.disabled = false;
    }
  });
}
