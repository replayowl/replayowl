import type { IngestBatch, LogEvent, ReplayEvent, SessionData, SessionSummary } from "../shared/protocol.ts";
import { createPlayer, formatTime, type Marker } from "../player/index.ts";
import { api, errorText } from "./api.ts";
import { listPage, sessionsApi } from "./config.ts";
import { OWL_SVG, describeUA, formatDuration, h, pathOf, svg } from "./util.ts";

const ICONS: Record<string, string> = {
  page: '<svg viewBox="0 0 16 16"><path d="M3 1h7l3 3v11H3zm6 1v3h3"/></svg>',
  click: '<svg viewBox="0 0 16 16"><path d="M5 2v10l2.6-2.4 1.7 3.9 1.8-.8-1.7-3.8H13z"/></svg>',
  rage: '<svg viewBox="0 0 16 16"><path d="M8 1l2 4.5 5 .5-3.8 3.3 1.1 4.9L8 11.6 3.7 14.2l1.1-4.9L1 6l5-.5z"/></svg>',
  input: '<svg viewBox="0 0 16 16"><path d="M2 4h12v8H2zm2 2v4h1V6z"/></svg>',
  error: '<svg viewBox="0 0 16 16"><path d="M8 1l7 13H1zm-1 4v5h2V5zm0 6v2h2v-2z"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 1l7 13H1zm-1 4v5h2V5zm0 6v2h2v-2z"/></svg>',
};

const $ = (id: string) => document.getElementById(id)!;
$("brand").append(svg(OWL_SVG));
($("brand") as HTMLAnchorElement).href = listPage;

// Shortcut popover.
const keysBtn = $("keys-btn");
const keysPop = $("keys-pop");
keysBtn.onclick = (e) => {
  e.stopPropagation();
  keysPop.hidden = !keysPop.hidden;
  keysBtn.setAttribute("aria-expanded", String(!keysPop.hidden));
};
document.addEventListener("click", (e) => {
  if (!keysPop.contains(e.target as Node)) {
    keysPop.hidden = true;
    keysBtn.setAttribute("aria-expanded", "false");
  }
});

// Tabs.
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
for (const tab of tabs) {
  tab.onclick = () => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      $("p-" + t.dataset.tab).hidden = !on;
    }
  };
}

async function main() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    $("player").innerHTML = "";
    $("player").append(h("div", { class: "loading" }, "No session selected. ", h("a", { href: listPage }, "Back to sessions")));
    return;
  }
  let data: SessionData;
  try {
    data = await loadSession(id);
  } catch (e) {
    $("title").textContent = "Session unavailable";
    $("player").innerHTML = "";
    $("player").append(h("div", { class: "loading" }, (e as Error).message));
    return;
  }
  const s = data.summary;
  $("title").textContent = pathOf(s.firstUrl) || "Session";
  $("subtitle").textContent = new Date(s.startedAt).toLocaleString() + ", " + formatDuration(s.duration) + ", " + describeUA(s.ua);
  document.title = (pathOf(s.firstUrl) || "Session") + " - Replayowl";

  $("player").innerHTML = "";
  const player = createPlayer($("player"), data.events, { speed: 1, skipIdle: true });
  const r = player.replayer;
  const tl = r.timeline;
  (window as unknown as { replayer: typeof r }).replayer = r;

  // URL bar follows the page being replayed.
  const showPage = () => {
    const seg = r.segment;
    if (!seg) return;
    $("url").textContent = seg.meta.url;
    $("page-count").textContent = tl.segments.length > 1 ? "Page " + (seg.index + 1) + " of " + tl.segments.length : "";
  };
  const showDims = () => ($("dims").textContent = r.w + " × " + r.h);
  r.on("page", showPage);
  r.on("state", showDims);
  showPage();
  showDims();
  let lastDims = "";
  r.on("time", () => {
    const d = r.w + "x" + r.h;
    if (d !== lastDims) {
      lastDims = d;
      showDims();
    }
  });

  // Activity list.
  const events = $("events");
  const markers = tl.markers;
  $("c-activity").textContent = String(markers.length);
  const rows: HTMLElement[] = [];
  if (!markers.length) events.append(h("div", { class: "empty-panel" }, "No clicks, typing or page views in this session."));
  for (const m of markers) {
    const row = h("button", { class: "ev k-" + m.kind, type: "button" },
      h("span", { class: "ic" }, svg(ICONS[m.kind] || ICONS.click)),
      h("span", { class: "txt" }, describe(m), m.kind === "page" ? h("small", {}, m.detail || "") : null),
      h("time", {}, formatTime(m.t)),
    );
    row.onclick = () => r.seek(Math.max(0, m.t - (m.kind === "page" ? 0 : 400)));
    rows.push(row);
    events.append(row);
  }
  const follow = $("follow") as HTMLInputElement;
  let current = -2;
  const syncList = () => {
    // Index of the last marker at or before the playhead.
    let idx = -1;
    let lo = 0;
    let hi = markers.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (markers[mid].t <= r.time + 1) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx === current) return;
    current = idx;
    rows.forEach((row, i) => {
      row.classList.toggle("past", i < idx);
      row.classList.toggle("current", i === idx);
      row.classList.toggle("future", i > idx);
    });
    if (follow.checked && idx >= 0 && !$("p-activity").hidden) {
      // Scroll the panel only; scrollIntoView would also scroll the page on narrow layouts.
      const panel = $("p-activity");
      const row = rows[idx];
      const top = row.offsetTop - panel.offsetTop;
      if (top < panel.scrollTop + 40 || top + row.offsetHeight > panel.scrollTop + panel.clientHeight) {
        panel.scrollTo({ top: top - panel.clientHeight / 3, behavior: "smooth" });
      }
    }
  };
  r.on("time", syncList);
  syncList();

  // Console.
  const logs = data.events.filter((e): e is LogEvent => e.k === "log");
  const errors = logs.filter((l) => l.level === "error").length;
  const consoleCount = $("c-console");
  consoleCount.textContent = String(logs.length);
  if (errors) consoleCount.classList.add("red");
  const consolePanel = $("p-console");
  if (!logs.length) consolePanel.append(h("div", { class: "empty-panel" }, "No console errors or warnings were captured."));
  for (const l of logs) {
    const t = l.ts - tl.t0;
    const row = h("div", { class: "log " + l.level, title: "Jump to " + formatTime(t) },
      h("div", { class: "meta" }, h("span", {}, l.level), h("span", {}, formatTime(t))),
      l.msg,
      l.stack ? h("pre", {}, l.stack) : null,
    );
    row.onclick = () => r.seek(Math.max(0, t - 1000));
    consolePanel.append(row);
  }

  // Details.
  const details = $("p-details");
  const dl = h("dl");
  const add = (k: string, v: string) => dl.append(h("dt", {}, k), h("dd", {}, v));
  add("User", s.userIds.length ? s.userIds.join(", ") : "Anonymous");
  add("Started", new Date(s.startedAt).toLocaleString());
  add("Duration", formatDuration(s.duration));
  add("Device", describeUA(s.ua) + " (" + s.device + ")");
  add("Viewport", s.w + " × " + s.h);
  add("Clicks", String(s.clicks) + (s.rageClicks ? " (" + s.rageClicks + " rage)" : ""));
  add("Errors", String(s.errors));
  add("User agent", s.ua);
  add("Session id", s.id);
  const pages = h("ol");
  for (const seg of tl.segments) {
    const b = h("button", { type: "button" }, seg.meta.url);
    b.onclick = () => r.seek(seg.start);
    pages.append(h("li", {}, b, " ", h("small", { class: "muted" }, formatTime(seg.start))));
  }
  details.append(dl, h("h3", {}, "Pages visited"), pages);

  if (new URLSearchParams(location.search).get("autoplay") !== "0") r.play();
}

/** Downloads every stored upload batch of a session and merges them into one ordered event list. */
async function loadSession(id: string): Promise<SessionData> {
  const base = sessionsApi + "/" + encodeURIComponent(id);
  const res = await api(base);
  if (!res.ok) throw new Error(await errorText(res));
  const index: { summary: SessionSummary; parts: string[] } = await res.json();
  const loading = $("player").querySelector(".loading");
  let done = 0;
  // Kept per part and flattened in name order (names start with the first timestamp), so events that
  // share a timestamp keep their recorded order no matter which download finishes first.
  const byPart: ReplayEvent[][] = new Array(index.parts.length);
  let next = 0;
  const worker = async () => {
    while (next < index.parts.length) {
      const i = next++;
      const name = index.parts[i];
      const r = await api(base + "/parts/" + encodeURIComponent(name));
      if (!r.ok) throw new Error("Could not load part of this session. " + (await errorText(r)));
      const batch: IngestBatch = await r.json();
      byPart[i] = (batch.events || []).filter((e) => e && typeof e.k === "string" && typeof e.ts === "number");
      done++;
      if (loading) loading.textContent = "Loading session, " + Math.round((done / index.parts.length) * 100) + "%";
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, index.parts.length) }, worker));
  const events = byPart.flat();
  if (!events.length) throw new Error("This session has no recorded events yet.");
  return { summary: index.summary, events };
}

function describe(m: Marker): string {
  if (m.kind === "page") return "Opened " + (m.label || "a page");
  return m.label;
}

void main();
