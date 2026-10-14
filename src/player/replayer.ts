// Playback engine and stage.
//
// - Two stacked iframes act as a double buffer: rebuilding a page for a backward seek or a page
//   change happens in the hidden frame and is swapped in only when complete, so there is no flash.
// - Seeking applies DOM changes in one synchronous pass and only the final scroll, focus and
//   viewport state, so the browser lays out once.
// - The cursor is interpolated from samples, scrolls glide between samples, and hover, focus and
//   active states are emulated in the replayed document.

import { DOCUMENT_ID, type ClickEvent, type NodeId, type ReplayEvent } from "../shared/protocol.ts";
import { ACTIVE_ATTR, FOCUS_ATTR, FOCUS_WITHIN_ATTR, HOVER_ATTR } from "./css.ts";
import { DomBuilder } from "./builder.ts";
import { Timeline, type Segment } from "./timeline.ts";

export interface ReplayerOptions {
  speed?: number;
  skipIdle?: boolean;
  trail?: boolean;
  /** Upper bound for scaling the recorded viewport up to fill the stage. */
  maxScale?: number;
}

type EventMap = {
  time: number;
  state: void;
  page: Segment;
  end: void;
};

const SCROLL_GLIDE_MAX_GAP = 400;
const TRAIL_MS = 600;
const HOVER_INTERVAL_MS = 40;

interface ScrollAnim {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number;
  t1: number;
}

export class Replayer {
  readonly timeline: Timeline;
  readonly el: HTMLElement;
  time = 0;
  playing = false;
  speed: number;
  skipIdle: boolean;
  trail: boolean;
  segment: Segment | null = null;
  w = 1280;
  h = 800;
  scale = 1;
  tabHidden = false;
  skipping = false;

  private maxScale: number;
  private viewport: HTMLElement;
  private canvas: HTMLElement;
  private frames: HTMLIFrameElement[];
  private front = 0;
  private builder: DomBuilder | null = null;
  private next = 0;
  private raf = 0;
  private lastFrame = 0;
  private idleRate = 0;
  private cursorEl: HTMLElement;
  private trailCanvas: HTMLCanvasElement;
  private notice: HTMLElement;
  private resizeObserver: ResizeObserver;
  private listeners: { [K in keyof EventMap]?: ((v: EventMap[K]) => void)[] } = {};

  private scrollAnims = new Map<NodeId, ScrollAnim>();
  private desiredScroll = new Map<NodeId, { x: number; y: number }>();
  private lastGuard = 0;
  private hovered: Element[] = [];
  private lastHoverAt = 0;
  private lastHoverPt = { x: -1, y: -1 };
  private domDirty = true;
  private focused: Element[] = [];
  private cursorPt: { x: number; y: number } | null = null;

  constructor(container: HTMLElement, events: ReplayEvent[], opts: ReplayerOptions = {}) {
    this.timeline = new Timeline(events);
    this.speed = opts.speed ?? 1;
    this.skipIdle = opts.skipIdle ?? true;
    this.trail = opts.trail ?? true;
    this.maxScale = opts.maxScale ?? 1.5;

    this.el = document.createElement("div");
    this.el.className = "ro-stage";
    this.viewport = div("ro-viewport");
    this.canvas = div("ro-canvas");
    this.frames = [0, 1].map(() => {
      const f = document.createElement("iframe");
      // Same origin so the player can write into it; no allow-scripts, so recorded scripts never run.
      f.setAttribute("sandbox", "allow-same-origin");
      f.setAttribute("tabindex", "-1");
      f.setAttribute("aria-hidden", "true");
      f.className = "ro-frame";
      this.canvas.appendChild(f);
      return f;
    });
    this.trailCanvas = document.createElement("canvas");
    this.trailCanvas.className = "ro-trail";
    this.cursorEl = div("ro-cursor");
    this.cursorEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4.5 2.8v16.9l4.4-4.1 2.9 6.6 3-1.3-2.9-6.5h6z" fill="#1f2240" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    this.notice = div("ro-notice");
    this.viewport.append(this.canvas, this.trailCanvas, this.cursorEl, this.notice);
    this.el.appendChild(this.viewport);
    container.appendChild(this.el);

    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.el);
    this.seek(0);
  }

  get duration() {
    return this.timeline.duration;
  }

  on<K extends keyof EventMap>(type: K, fn: (v: EventMap[K]) => void) {
    (this.listeners[type] ||= [] as never[]).push(fn as never);
    return () => {
      const list = this.listeners[type] as ((v: EventMap[K]) => void)[];
      list.splice(list.indexOf(fn), 1);
    };
  }

  private emit<K extends keyof EventMap>(type: K, v: EventMap[K]) {
    for (const fn of (this.listeners[type] || []) as ((v: EventMap[K]) => void)[]) fn(v);
  }

  // ------------------------------------------------------------------ transport controls

  play() {
    if (this.playing || !this.duration) return;
    if (this.time >= this.duration) this.seek(0);
    this.playing = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
    this.emit("state", undefined);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.setSkipping(false);
    this.emit("state", undefined);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.emit("state", undefined);
  }

  setSkipIdle(on: boolean) {
    this.skipIdle = on;
    if (!on) this.setSkipping(false);
    this.emit("state", undefined);
  }

  setTrail(on: boolean) {
    this.trail = on;
    this.renderOverlay(true);
    this.emit("state", undefined);
  }

  /** Jump to t (ms from session start). */
  seek(t: number) {
    t = Math.max(0, Math.min(t, this.duration));
    const seg = this.timeline.segmentAt(t);
    if (!seg) return;
    if (seg !== this.segment || t < this.time || !this.builder) this.rebuild(seg, t);
    else this.applyUntil(t, true);
    this.scrollAnims.clear();
    this.time = t;
    this.lastFrame = performance.now();
    this.idleRate = 0;
    this.restoreScroll(true);
    this.renderOverlay(true);
    this.emit("time", t);
  }

  destroy() {
    this.pause();
    this.resizeObserver.disconnect();
    this.el.remove();
  }

  // ------------------------------------------------------------------ playback loop

  private frame(now: number) {
    if (!this.playing) return;
    const dt = Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;
    let rate = this.speed;
    const idle = this.skipIdle ? this.timeline.idleAt(this.time) : null;
    if (idle) {
      // Cross any idle stretch in about a second, whatever its length.
      if (!this.idleRate) this.idleRate = Math.max(this.speed, (idle.end - idle.start) / 1000);
      rate = this.idleRate;
    } else {
      this.idleRate = 0;
    }
    this.setSkipping(!!idle);
    const t = Math.min(this.time + dt * rate, this.duration);
    this.advance(t);
    if (t >= this.duration) {
      this.pause();
      this.emit("end", undefined);
      return;
    }
    this.raf = requestAnimationFrame((n) => this.frame(n));
  }

  private advance(t: number) {
    this.applyUntil(t, false);
    this.time = t;
    this.stepScrollAnims();
    if (performance.now() - this.lastGuard > 200) this.restoreScroll(false);
    this.renderOverlay(false);
    this.emit("time", t);
  }

  /** Applies every event up to and including time t. `fast` coalesces visual-only events (seeking). */
  private applyUntil(t: number, fast: boolean) {
    const { events, times } = this.timeline;
    while (this.next < events.length && times[this.next] <= t) {
      const i = this.next++;
      const ev = events[i];
      if (ev.k === "meta") {
        const seg = this.timeline.segments.find((s) => s.metaIdx === i);
        if (seg && seg !== this.segment) {
          this.rebuild(seg, times[i]);
          continue;
        }
      }
      this.apply(ev, i, fast);
    }
  }

  // ------------------------------------------------------------------ page building

  /** Builds `seg` in the back buffer, fast-forwards it to t and swaps it in. */
  private rebuild(seg: Segment, t: number) {
    const back = this.frames[1 - this.front];
    this.setViewport(seg.meta.w, seg.meta.h);
    const doc = back.contentDocument;
    if (!doc) return;
    const builder = new DomBuilder(doc, seg.meta.url);
    const snap = this.timeline.snapshotOf(seg);
    builder.load(snap ? snap.snap : { doctype: "<!DOCTYPE html>", children: [] });
    const prevBuilder = this.builder;
    this.builder = builder;
    this.segment = seg;
    this.next = (snap ? seg.snapIdx : seg.metaIdx) + 1;
    this.scrollAnims.clear();
    this.desiredScroll.clear();
    this.hovered = [];
    this.focused = [];
    this.tabHidden = false;
    this.domDirty = true;
    this.applyUntil(t, true);
    this.restoreScroll(true);
    back.classList.add("ro-front");
    this.frames[this.front].classList.remove("ro-front");
    this.front = 1 - this.front;
    if (prevBuilder !== builder) this.emit("page", seg);
    this.setNotice(snap ? null : "This page was not captured");
  }

  private setViewport(w: number, h: number) {
    if (w === this.w && h === this.h && this.canvas.style.width) return;
    this.w = w;
    this.h = h;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    for (const f of this.frames) {
      f.style.width = w + "px";
      f.style.height = h + "px";
    }
    this.fit();
  }

  fit() {
    const box = this.el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const pad = 24;
    this.scale = Math.min((box.width - pad * 2) / this.w, (box.height - pad * 2) / this.h, this.maxScale);
    this.viewport.style.width = Math.round(this.w * this.scale) + "px";
    this.viewport.style.height = Math.round(this.h * this.scale) + "px";
    this.canvas.style.transform = "scale(" + this.scale + ")";
    const dpr = window.devicePixelRatio || 1;
    this.trailCanvas.width = Math.round(this.w * this.scale * dpr);
    this.trailCanvas.height = Math.round(this.h * this.scale * dpr);
    this.renderOverlay(true);
  }

  // ------------------------------------------------------------------ event application

  private apply(ev: ReplayEvent, i: number, fast: boolean) {
    const b = this.builder;
    if (!b) return;
    switch (ev.k) {
      case "mutation":
        b.applyMutation(ev.m);
        this.domDirty = true;
        break;
      case "css":
        if (ev.op === "insert" && ev.rule !== undefined) b.insertRule(ev.id, ev.rule, ev.index);
        else if (ev.op === "delete") b.deleteRule(ev.id, ev.index);
        this.domDirty = true;
        break;
      case "adopt":
        b.adopt(ev.id, ev.sheets);
        this.domDirty = true;
        break;
      case "input":
        b.setInput(ev.id, ev.v, ev.c);
        break;
      case "resize":
        this.setViewport(ev.w, ev.h);
        break;
      case "scroll":
        this.desiredScroll.set(ev.id, { x: ev.x, y: ev.y });
        if (fast) break;
        this.glideScroll(ev.id, i, ev.x, ev.y);
        this.setScroll(ev.id, ev.x, ev.y);
        break;
      case "click":
        if (!fast) this.showClick(ev, this.timeline.rageIdx.has(i));
        break;
      case "focus":
        this.setFocus(ev.id);
        break;
      case "media": {
        const m = b.node(ev.id) as HTMLMediaElement | undefined;
        if (m && "currentTime" in m) {
          try {
            m.currentTime = ev.time;
            if (ev.op === "play" && !fast) void m.play().catch(() => {});
            else m.pause();
          } catch {
            /* media not ready */
          }
        }
        break;
      }
      case "visibility":
        this.tabHidden = !ev.visible;
        this.setNotice(this.tabHidden ? "The visitor switched to another tab" : null);
        break;
      default:
        break;
    }
  }

  private glideScroll(id: NodeId, i: number, x: number, y: number) {
    const nextIdx = this.timeline.scrollNext[i];
    const { times, events } = this.timeline;
    if (nextIdx >= 0 && times[nextIdx] - times[i] <= SCROLL_GLIDE_MAX_GAP) {
      const n = events[nextIdx] as { x: number; y: number };
      this.scrollAnims.set(id, { fx: x, fy: y, tx: n.x, ty: n.y, t0: times[i], t1: times[nextIdx] });
    } else {
      this.scrollAnims.delete(id);
    }
  }

  private stepScrollAnims() {
    for (const [id, a] of this.scrollAnims) {
      const u = Math.min(1, (this.time - a.t0) / (a.t1 - a.t0 || 1));
      this.setScroll(id, a.fx + (a.tx - a.fx) * u, a.fy + (a.ty - a.fy) * u);
      if (u >= 1) this.scrollAnims.delete(id);
    }
  }

  private setScroll(id: NodeId, x: number, y: number) {
    const b = this.builder;
    if (!b) return;
    if (id === DOCUMENT_ID) {
      const win = b.doc.defaultView;
      if (win) win.scrollTo(x, y);
    } else {
      const el = b.node(id) as Element | undefined;
      if (el && el.nodeType === Node.ELEMENT_NODE) {
        el.scrollLeft = x;
        el.scrollTop = y;
      }
    }
    this.domDirty = true;
  }

  private getScroll(id: NodeId): { x: number; y: number } | null {
    const b = this.builder;
    if (!b) return null;
    if (id === DOCUMENT_ID) {
      const win = b.doc.defaultView;
      return win ? { x: win.scrollX, y: win.scrollY } : null;
    }
    const el = b.node(id) as Element | undefined;
    return el && el.nodeType === Node.ELEMENT_NODE ? { x: el.scrollLeft, y: el.scrollTop } : null;
  }

  /**
   * Images and fonts in the replay load after the DOM is built, so an early scrollTo can be clamped
   * by a page that is not tall enough yet. Re-apply the recorded positions until they stick.
   */
  private restoreScroll(force: boolean) {
    this.lastGuard = performance.now();
    for (const [id, want] of this.desiredScroll) {
      if (this.scrollAnims.has(id)) continue;
      const cur = this.getScroll(id);
      if (force || (cur && (Math.abs(cur.x - want.x) > 1 || Math.abs(cur.y - want.y) > 1))) this.setScroll(id, want.x, want.y);
    }
  }

  // ------------------------------------------------------------------ overlay: cursor, trail, clicks, states

  private renderOverlay(force: boolean) {
    const p = this.timeline.cursorAt(this.time);
    this.cursorPt = p;
    if (!p) {
      this.cursorEl.style.opacity = "0";
    } else {
      this.cursorEl.style.opacity = "1";
      this.cursorEl.style.transform = "translate(" + p.x * this.scale + "px," + p.y * this.scale + "px)";
    }
    this.drawTrail();
    const now = performance.now();
    if (p && (force || now - this.lastHoverAt > HOVER_INTERVAL_MS)) {
      const moved = Math.abs(p.x - this.lastHoverPt.x) + Math.abs(p.y - this.lastHoverPt.y) > 1;
      if (force || moved || this.domDirty) {
        this.lastHoverAt = now;
        this.lastHoverPt = { ...p };
        this.domDirty = false;
        this.updateHover(p.x, p.y);
      }
    }
  }

  private drawTrail() {
    const c = this.trailCanvas;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this.trail) return;
    const pts = this.timeline.cursorPath(this.time - TRAIL_MS, this.time);
    if (pts.length < 2) return;
    const k = this.scale * (window.devicePixelRatio || 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const age = (this.time - pts[i].t) / TRAIL_MS;
      ctx.strokeStyle = "rgba(242,169,59," + (0.55 * (1 - age)).toFixed(3) + ")";
      ctx.lineWidth = (1 + 3 * (1 - age)) * (window.devicePixelRatio || 1);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x * k, pts[i - 1].y * k);
      ctx.lineTo(pts[i].x * k, pts[i].y * k);
      ctx.stroke();
    }
  }

  private showClick(ev: ClickEvent, rage: boolean) {
    const r = div(rage ? "ro-ripple ro-rage" : "ro-ripple");
    r.style.left = ev.x * this.scale + "px";
    r.style.top = ev.y * this.scale + "px";
    this.viewport.appendChild(r);
    setTimeout(() => r.remove(), rage ? 1200 : 700);
    this.cursorEl.classList.remove("ro-pressed");
    void this.cursorEl.offsetWidth;
    this.cursorEl.classList.add("ro-pressed");
    const target = this.builder && (ev.id !== null ? this.builder.node(ev.id) : null);
    const chain = target && target.nodeType === Node.ELEMENT_NODE ? composedChain(target as Element) : [];
    for (const el of chain) el.setAttribute(ACTIVE_ATTR, "");
    setTimeout(() => chain.forEach((el) => el.removeAttribute(ACTIVE_ATTR)), 160 / Math.max(1, this.speed / 2));
  }

  private updateHover(x: number, y: number) {
    const b = this.builder;
    if (!b) return;
    let hit: Element | null = null;
    try {
      hit = deepElementFromPoint(b.doc, x, y);
    } catch {
      hit = null;
    }
    const chain = hit ? composedChain(hit) : [];
    if (chain.length === this.hovered.length && chain.every((el, i) => el === this.hovered[i])) return;
    const next = new Set(chain);
    for (const el of this.hovered) if (!next.has(el)) el.removeAttribute(HOVER_ATTR);
    for (const el of chain) if (!el.hasAttribute(HOVER_ATTR)) el.setAttribute(HOVER_ATTR, "");
    this.hovered = chain;
  }

  private setFocus(id: NodeId | null) {
    for (const el of this.focused) {
      el.removeAttribute(FOCUS_ATTR);
      el.removeAttribute(FOCUS_WITHIN_ATTR);
    }
    this.focused = [];
    const node = id !== null && this.builder ? this.builder.node(id) : null;
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const chain = composedChain(node as Element);
    (node as Element).setAttribute(FOCUS_ATTR, "");
    for (const el of chain) el.setAttribute(FOCUS_WITHIN_ATTR, "");
    this.focused = chain;
  }

  private setSkipping(on: boolean) {
    if (on === this.skipping) return;
    this.skipping = on;
    this.el.classList.toggle("ro-is-skipping", on);
    this.emit("state", undefined);
  }

  private setNotice(text: string | null) {
    this.notice.textContent = text || "";
    this.notice.classList.toggle("ro-show", !!text);
  }

  get cursor() {
    return this.cursorPt;
  }
}

function div(cls: string) {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

/** The element and all its ancestors, crossing shadow boundaries. */
function composedChain(el: Element): Element[] {
  const out: Element[] = [];
  let n: Node | null = el;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) out.push(n as Element);
    const parent: Node | null = n.parentNode;
    n = parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (parent as ShadowRoot).host ? (parent as ShadowRoot).host : parent;
    if (n && n.nodeType === Node.DOCUMENT_NODE) break;
  }
  return out;
}

function deepElementFromPoint(doc: Document, x: number, y: number): Element | null {
  let el = doc.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}
