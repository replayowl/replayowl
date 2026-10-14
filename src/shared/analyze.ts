import type { ClickEvent, Device, ReplayEvent, SessionSummary } from "./protocol.ts";

/** Three or more clicks within this window and radius count as a rage click. */
const RAGE_WINDOW_MS = 1000;
const RAGE_RADIUS_PX = 32;
export const RAGE_MIN_CLICKS = 3;

/** Gaps without user activity longer than this are skippable during playback. */
export const IDLE_THRESHOLD_MS = 3000;

export const MAX_USER_ID = 128;
export const MAX_USERS_PER_SESSION = 5;

export function deviceOf(ua: string): Device {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return "mobile";
  return "desktop";
}

export function validUserId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_USER_ID;
}

/** User ids named by identify and meta events, in order of first appearance. */
export function userIdsOf(events: ReplayEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const uid = e.k === "identify" || e.k === "meta" ? e.uid : undefined;
    if (validUserId(uid) && !out.includes(uid)) out.push(uid);
  }
  return out;
}

const ACTIVITY_KINDS = new Set(["move", "click", "scroll", "input", "resize", "meta", "focus"]);

export function isUserActivity(ev: ReplayEvent): boolean {
  return ACTIVITY_KINDS.has(ev.k) && !("auto" in ev && ev.auto);
}

/** Returns the timestamps of clicks that complete a rage-click burst (one per burst). */
export function findRageClicks(events: ReplayEvent[]): ClickEvent[] {
  const clicks = events.filter((e): e is ClickEvent => e.k === "click");
  const out: ClickEvent[] = [];
  let i = 0;
  while (i < clicks.length) {
    let j = i + 1;
    while (
      j < clicks.length &&
      clicks[j].ts - clicks[j - 1].ts <= RAGE_WINDOW_MS / 2 &&
      clicks[j].ts - clicks[i].ts <= RAGE_WINDOW_MS * 2 &&
      Math.hypot(clicks[j].x - clicks[i].x, clicks[j].y - clicks[i].y) <= RAGE_RADIUS_PX
    ) {
      j++;
    }
    if (j - i >= RAGE_MIN_CLICKS) {
      out.push(clicks[i]);
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

export interface Range {
  start: number;
  end: number;
}

/** Idle ranges in ms relative to `t0`; a short lead-in and tail are kept so motion does not start abruptly. */
export function findIdleRanges(events: ReplayEvent[], t0: number, end: number): Range[] {
  const ranges: Range[] = [];
  let last = t0;
  const consider = (ts: number) => {
    if (ts - last > IDLE_THRESHOLD_MS) ranges.push({ start: last - t0 + 500, end: ts - t0 - 500 });
    last = ts;
  };
  for (const ev of events) if (isUserActivity(ev)) consider(ev.ts);
  consider(t0 + end);
  return ranges;
}

export function summarize(id: string, events: ReplayEvent[]): SessionSummary {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const metas = sorted.filter((e) => e.k === "meta");
  const first = metas[0];
  const last = metas[metas.length - 1];
  const startedAt = sorted.length ? sorted[0].ts : 0;
  const endedAt = sorted.length ? sorted[sorted.length - 1].ts : 0;
  let clicks = 0;
  let errors = 0;
  let inputs = 0;
  for (const e of sorted) {
    if (e.k === "click") clicks++;
    else if (e.k === "log" && e.level === "error") errors++;
    else if (e.k === "input") inputs++;
  }
  return {
    id,
    startedAt,
    endedAt,
    duration: endedAt - startedAt,
    firstUrl: first ? first.url : "",
    lastUrl: last ? last.url : "",
    pages: metas.length,
    ua: first ? first.ua : "",
    device: deviceOf(first ? first.ua : ""),
    w: first ? first.w : 0,
    h: first ? first.h : 0,
    events: sorted.length,
    clicks,
    rageClicks: findRageClicks(sorted).length,
    errors,
    inputs,
    userIds: userIdsOf(sorted).slice(0, MAX_USERS_PER_SESSION),
  };
}

export interface PageView {
  view: string;
  ts: number;
  url: string;
  ua: string;
  w: number;
  h: number;
}

/** What one uploaded batch adds to its session. */
export interface BatchDelta {
  startedAt: number;
  endedAt: number;
  events: number;
  clicks: number;
  inputs: number;
  errors: number;
  rageClicks: number;
  pages: PageView[];
  userIds: string[];
  /** Last clicks of the previous tail and this batch, stored for the next batch of the page view. */
  tail: ClickEvent[];
}

/** Counts one batch. `prevTail` is the tail stored with the previous batch of the same page view. */
export function batchDelta(events: ReplayEvent[], prevTail: ClickEvent[] = []): BatchDelta {
  const d: BatchDelta = {
    startedAt: 0, endedAt: 0, events: events.length, clicks: 0, inputs: 0, errors: 0, rageClicks: 0, pages: [], userIds: userIdsOf(events), tail: [],
  };
  for (const e of events) {
    if (!d.startedAt || e.ts < d.startedAt) d.startedAt = e.ts;
    if (e.ts > d.endedAt) d.endedAt = e.ts;
    if (e.k === "meta") d.pages.push({ view: e.view, ts: e.ts, url: e.url, ua: e.ua, w: e.w, h: e.h });
    else if (e.k === "click") d.clicks++;
    else if (e.k === "input") d.inputs++;
    else if (e.k === "log" && e.level === "error") d.errors++;
  }
  const clicks = [...prevTail, ...events.filter((e): e is ClickEvent => e.k === "click")].sort((a, b) => a.ts - b.ts);
  // A burst that started in the previous batch and continues here is still one burst.
  d.rageClicks = findRageClicks(clicks).length - findRageClicks(prevTail).length;
  d.tail = clicks.slice(-RAGE_MIN_CLICKS).map((c) => ({ k: "click", ts: c.ts, x: c.x, y: c.y, id: null }));
  return d;
}
