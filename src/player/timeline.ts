// Precomputed views over a session: page segments, the cursor track, scroll chains, markers and
// activity density. Everything is computed once so playback and seeking stay cheap.

import { findIdleRanges, findRageClicks, isUserActivity, type Range } from "../shared/analyze.ts";
import type { MetaEvent, ReplayEvent, SnapshotEvent } from "../shared/protocol.ts";

export interface Segment {
  index: number;
  /** Index of the meta event. */
  metaIdx: number;
  /** Index of the first snapshot after the meta event, -1 when it never arrived. */
  snapIdx: number;
  start: number;
  end: number;
  meta: MetaEvent;
}

export type MarkerKind = "page" | "click" | "rage" | "input" | "error" | "warn";

export interface Marker {
  t: number;
  idx: number;
  kind: MarkerKind;
  label: string;
  detail?: string;
}

/** Gap after which the cursor is considered resting rather than travelling between samples. */
const REST_GAP_MS = 250;
/** Time a resting cursor takes to travel to its next sample. */
const TRAVEL_MS = 140;

export class Timeline {
  readonly events: ReplayEvent[];
  readonly t0: number;
  readonly duration: number;
  /** Event times relative to t0. */
  readonly times: Float64Array;
  readonly segments: Segment[] = [];
  readonly idle: Range[];
  readonly markers: Marker[] = [];
  /** Index of the next scroll event with the same target in the same segment, or -1. */
  readonly scrollNext: Int32Array;
  readonly rageIdx = new Set<number>();

  private cursorT: number[] = [];
  private cursorX: number[] = [];
  private cursorY: number[] = [];

  constructor(events: ReplayEvent[]) {
    this.events = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
    const n = this.events.length;
    this.t0 = n ? this.events[0].ts : 0;
    this.duration = n ? this.events[n - 1].ts - this.t0 : 0;
    this.times = new Float64Array(n);
    for (let i = 0; i < n; i++) this.times[i] = this.events[i].ts - this.t0;
    this.scrollNext = new Int32Array(n).fill(-1);

    this.buildSegments();
    this.buildTracks();
    this.buildMarkers();
    this.idle = findIdleRanges(this.events, this.t0, this.duration).filter((r) => r.end - r.start > 1000);
  }

  private buildSegments() {
    let cur: Segment | null = null;
    this.events.forEach((e, i) => {
      if (e.k === "meta") {
        if (cur) cur.end = this.times[i];
        cur = { index: this.segments.length, metaIdx: i, snapIdx: -1, start: this.times[i], end: this.duration, meta: e };
        this.segments.push(cur);
      } else if (e.k === "snapshot" && cur && cur.snapIdx < 0) {
        cur.snapIdx = i;
      }
    });
  }

  private buildTracks() {
    const lastScroll = new Map<string, number>();
    let seg = -1;
    this.events.forEach((e, i) => {
      if (e.k === "meta") {
        seg++;
        lastScroll.clear();
      } else if (e.k === "move" || e.k === "click") {
        this.cursorT.push(this.times[i]);
        this.cursorX.push(e.x);
        this.cursorY.push(e.y);
      } else if (e.k === "scroll") {
        const key = seg + ":" + e.id;
        const prev = lastScroll.get(key);
        if (prev !== undefined) this.scrollNext[prev] = i;
        lastScroll.set(key, i);
      }
    });
  }

  private buildMarkers() {
    const rage = new Set(findRageClicks(this.events));
    let lastInput: { id: number; t: number; marker: Marker } | null = null;
    this.events.forEach((e, i) => {
      const t = this.times[i];
      switch (e.k) {
        case "meta":
          this.markers.push({ t, idx: i, kind: "page", label: e.title || pathOf(e.url), detail: e.url });
          break;
        case "click":
          if (rage.has(e)) {
            this.rageIdx.add(i);
            this.markers.push({ t, idx: i, kind: "rage", label: "Rage click" + (e.label ? " on " + quote(e.label) : "") });
          } else {
            this.markers.push({ t, idx: i, kind: "click", label: e.label ? "Clicked " + quote(e.label) : "Clicked" });
          }
          break;
        case "input": {
          // One marker per typing burst in a field, labelled with the value the burst ended with.
          const label =
            e.field === "radio" ? "Picked an option" :
            e.field === "checkbox" || e.c !== undefined ? (e.c ? "Ticked a checkbox" : "Unticked a checkbox") :
            e.field === "select" ? "Selected " + quote(e.v || "") :
            e.masked ? "Typed into a masked field" :
            e.v ? "Typed " + quote(e.v) : "Cleared a field";
          if (e.field === "radio" && e.c === false) break;
          if (lastInput && lastInput.id === e.id && t - lastInput.t <= 3000 && !e.field) {
            lastInput.marker.label = label;
            lastInput.t = t;
          } else {
            const marker: Marker = { t, idx: i, kind: "input", label };
            this.markers.push(marker);
            lastInput = { id: e.id, t, marker };
          }
          break;
        }
        case "log":
          if (e.level === "error" || e.level === "warn") this.markers.push({ t, idx: i, kind: e.level, label: e.msg, detail: e.stack });
          break;
      }
    });
  }

  /** First event index whose time is greater than t. */
  indexAfter(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  segmentAt(t: number): Segment | null {
    let found: Segment | null = null;
    for (const s of this.segments) {
      if (s.start <= t) found = s;
      else break;
    }
    return found || this.segments[0] || null;
  }

  snapshotOf(seg: Segment): SnapshotEvent | null {
    return seg.snapIdx >= 0 ? (this.events[seg.snapIdx] as SnapshotEvent) : null;
  }

  idleAt(t: number): Range | null {
    for (const r of this.idle) if (t >= r.start && t < r.end) return r;
    return null;
  }

  /** Smoothed cursor position at time t, or null before the first sample. */
  cursorAt(t: number): { x: number; y: number } | null {
    const T = this.cursorT;
    if (!T.length || t < T[0]) return null;
    let lo = 0;
    let hi = T.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (T[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const X = this.cursorX;
    const Y = this.cursorY;
    if (i >= T.length - 1) return { x: X[i], y: Y[i] };
    const dt = T[i + 1] - T[i];
    if (dt > REST_GAP_MS) {
      // Resting: hold still, then glide to the next sample just before it was recorded.
      const leave = T[i + 1] - TRAVEL_MS;
      if (t < leave) return { x: X[i], y: Y[i] };
      const u = easeInOut((t - leave) / TRAVEL_MS);
      return { x: X[i] + (X[i + 1] - X[i]) * u, y: Y[i] + (Y[i + 1] - Y[i]) * u };
    }
    const u = dt > 0 ? (t - T[i]) / dt : 1;
    // Catmull-Rom through neighbouring samples gives curved, natural motion instead of polyline jitter.
    const p0 = i > 0 && T[i] - T[i - 1] <= REST_GAP_MS ? i - 1 : i;
    const p3 = i + 2 < T.length && T[i + 2] - T[i + 1] <= REST_GAP_MS ? i + 2 : i + 1;
    return { x: catmull(X[p0], X[i], X[i + 1], X[p3], u), y: catmull(Y[p0], Y[i], Y[i + 1], Y[p3], u) };
  }

  /** Cursor samples between two times, for drawing the trail. */
  cursorPath(from: number, to: number, step = 16): { x: number; y: number; t: number }[] {
    const out: { x: number; y: number; t: number }[] = [];
    for (let t = Math.max(from, 0); t <= to; t += step) {
      const p = this.cursorAt(t);
      if (p) out.push({ ...p, t });
    }
    // Always end exactly at `to` so the trail meets the cursor tip.
    const last = this.cursorAt(to);
    if (last && (!out.length || out[out.length - 1].t !== to)) out.push({ ...last, t: to });
    return out;
  }

  /** Normalized user activity per bucket, for the timeline waveform. */
  activity(buckets: number): Float32Array {
    const out = new Float32Array(buckets);
    if (!this.duration) return out;
    this.events.forEach((e, i) => {
      if (!isUserActivity(e) && e.k !== "mutation") return;
      const b = Math.min(buckets - 1, Math.floor((this.times[i] / this.duration) * buckets));
      out[b] += e.k === "click" || e.k === "input" ? 4 : e.k === "mutation" ? 0.5 : 1;
    });
    let max = 0;
    for (const v of out) max = Math.max(max, v);
    if (max) for (let i = 0; i < buckets; i++) out[i] = Math.sqrt(out[i] / max);
    return out;
  }
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

const quote = (s: string) => "“" + (s.length > 40 ? s.slice(0, 39) + "…" : s) + "”";
