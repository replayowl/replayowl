// Control bar: timeline with activity waveform, idle stretches and event markers, transport
// buttons, speed and toggles, plus keyboard shortcuts.

import type { Replayer } from "./replayer.ts";
import type { Marker } from "./timeline.ts";

const SPEEDS = [0.5, 1, 2, 4, 8];
const BUCKETS = 240;

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M12 5V1.5L7 6l5 4.5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.2" text-anchor="middle" font-size="6.5" font-weight="700">5</text></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M12 5V1.5L17 6l-5 4.5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.2" text-anchor="middle" font-size="6.5" font-weight="700">5</text></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM4 15h2v3h3v2H4zm14 0h2v5h-5v-2h3z"/></svg>',
};

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
}

export class Controls {
  readonly el: HTMLElement;
  private r: Replayer;
  private track: HTMLElement;
  private wave: HTMLCanvasElement;
  private head: HTMLElement;
  private tip: HTMLElement;
  private playBtn: HTMLButtonElement;
  private clock: HTMLElement;
  private speedBtn: HTMLButtonElement;
  private skipBtn: HTMLButtonElement;
  private trailBtn: HTMLButtonElement;
  private activity: Float32Array;
  private scrubbing = false;
  private wasPlaying = false;
  private pendingSeek: number | null = null;
  private fullscreenTarget: HTMLElement;

  constructor(container: HTMLElement, replayer: Replayer, fullscreenTarget: HTMLElement) {
    this.r = replayer;
    this.fullscreenTarget = fullscreenTarget;
    this.activity = replayer.timeline.activity(BUCKETS);
    this.el = document.createElement("div");
    this.el.className = "ro-controls";
    this.el.innerHTML = `
      <div class="ro-track" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">
        <canvas class="ro-wave"></canvas>
        <div class="ro-idle-layer"></div>
        <div class="ro-marker-layer"></div>
        <div class="ro-head"><span></span></div>
        <div class="ro-tip" hidden></div>
      </div>
      <div class="ro-bar">
        <button class="ro-btn ro-play" title="Play (Space)" aria-label="Play">${ICONS.play}</button>
        <button class="ro-btn ro-back" title="Back 5 seconds (Left arrow)" aria-label="Back 5 seconds">${ICONS.back}</button>
        <button class="ro-btn ro-fwd" title="Forward 5 seconds (Right arrow)" aria-label="Forward 5 seconds">${ICONS.fwd}</button>
        <span class="ro-clock"></span>
        <span class="ro-skipping-pill">Skipping inactivity</span>
        <span class="ro-spacer"></span>
        <button class="ro-toggle ro-skip" title="Skip inactivity (S)" aria-pressed="true">Skip inactivity</button>
        <button class="ro-toggle ro-trailbtn" title="Mouse trail (T)" aria-pressed="true">Mouse trail</button>
        <button class="ro-speed" title="Playback speed (1 to 5)"></button>
        <button class="ro-btn ro-full" title="Full screen (F)" aria-label="Full screen">${ICONS.full}</button>
      </div>`;
    container.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.track = q(".ro-track");
    this.wave = q(".ro-wave");
    this.head = q(".ro-head");
    this.tip = q(".ro-tip");
    this.playBtn = q(".ro-play");
    this.clock = q(".ro-clock");
    this.speedBtn = q(".ro-speed");
    this.skipBtn = q(".ro-skip");
    this.trailBtn = q(".ro-trailbtn");

    this.playBtn.onclick = () => replayer.toggle();
    q<HTMLButtonElement>(".ro-back").onclick = () => this.jump(-5000);
    q<HTMLButtonElement>(".ro-fwd").onclick = () => this.jump(5000);
    this.speedBtn.onclick = () => {
      const i = SPEEDS.indexOf(replayer.speed);
      replayer.setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
    };
    this.skipBtn.onclick = () => replayer.setSkipIdle(!replayer.skipIdle);
    this.trailBtn.onclick = () => replayer.setTrail(!replayer.trail);
    q<HTMLButtonElement>(".ro-full").onclick = () => this.toggleFullscreen();

    this.renderIdle();
    this.renderMarkers();
    this.bindTrack();
    new ResizeObserver(() => this.drawWave()).observe(this.track);
    replayer.on("time", () => this.update());
    replayer.on("state", () => this.update());
    this.update();
  }

  jump(delta: number) {
    this.r.seek(this.r.time + delta);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.fullscreenTarget.requestFullscreen().catch(() => {});
  }

  /** Keyboard shortcuts; returns true when the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    const r = this.r;
    switch (e.key) {
      case " ":
      case "k":
        r.toggle();
        return true;
      case "ArrowLeft":
        this.jump(e.shiftKey ? -15000 : -5000);
        return true;
      case "ArrowRight":
        this.jump(e.shiftKey ? 15000 : 5000);
        return true;
      case "Home":
        r.seek(0);
        return true;
      case "End":
        r.seek(r.duration);
        return true;
      case ",":
      case ".": {
        const m = this.neighbourMarker(e.key === "." ? 1 : -1);
        if (m) r.seek(Math.max(0, m.t - 400));
        return true;
      }
      case "s":
        r.setSkipIdle(!r.skipIdle);
        return true;
      case "t":
        r.setTrail(!r.trail);
        return true;
      case "f":
        this.toggleFullscreen();
        return true;
      default:
        if (/^[1-5]$/.test(e.key)) {
          r.setSpeed(SPEEDS[Number(e.key) - 1]);
          return true;
        }
        return false;
    }
  }

  private neighbourMarker(dir: 1 | -1): Marker | null {
    const ms = this.r.timeline.markers.filter((m) => m.kind !== "input");
    const now = this.r.time;
    if (dir > 0) return ms.find((m) => m.t - 400 > now + 50) || null;
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i].t - 400 < now - 600) return ms[i];
    return null;
  }

  private pct(t: number) {
    const d = this.r.duration || 1;
    return (t / d) * 100;
  }

  private renderIdle() {
    const layer = this.el.querySelector(".ro-idle-layer") as HTMLElement;
    for (const r of this.r.timeline.idle) {
      const d = document.createElement("div");
      d.className = "ro-idle";
      d.style.left = this.pct(r.start) + "%";
      d.style.width = this.pct(r.end - r.start) + "%";
      d.title = "Inactive for " + formatTime(r.end - r.start);
      layer.appendChild(d);
    }
  }

  private renderMarkers() {
    const layer = this.el.querySelector(".ro-marker-layer") as HTMLElement;
    for (const m of this.r.timeline.markers) {
      if (m.kind === "page" && m.t === 0) continue;
      const d = document.createElement("div");
      d.className = "ro-mark ro-mark-" + m.kind;
      d.style.left = this.pct(m.t) + "%";
      d.dataset.t = String(m.t);
      layer.appendChild(d);
    }
  }

  private drawWave() {
    const c = this.wave;
    const dpr = window.devicePixelRatio || 1;
    const w = this.track.clientWidth;
    const h = this.track.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const played = (this.r.time / (this.r.duration || 1)) * w;
    const bw = w / BUCKETS;
    const base = h - 6;
    for (let i = 0; i < BUCKETS; i++) {
      const v = this.activity[i];
      const bh = Math.max(2, v * (h - 14));
      const x = i * bw;
      ctx.fillStyle = x + bw / 2 <= played ? "#f2a93b" : "rgba(214,218,240,0.28)";
      ctx.fillRect(x + 0.5, base - bh, Math.max(1, bw - 1), bh);
    }
    ctx.fillStyle = "rgba(214,218,240,0.18)";
    ctx.fillRect(0, base, w, 2);
    ctx.fillStyle = "#f2a93b";
    ctx.fillRect(0, base, played, 2);
  }

  private update() {
    const r = this.r;
    const atEnd = r.time >= r.duration && r.duration > 0;
    this.playBtn.innerHTML = r.playing ? ICONS.pause : ICONS.play;
    this.playBtn.setAttribute("aria-label", r.playing ? "Pause" : atEnd ? "Replay" : "Play");
    this.clock.textContent = formatTime(r.time) + " / " + formatTime(r.duration);
    this.head.style.left = this.pct(r.time) + "%";
    this.track.setAttribute("aria-valuemax", String(Math.round(r.duration)));
    this.track.setAttribute("aria-valuenow", String(Math.round(r.time)));
    this.track.setAttribute("aria-valuetext", formatTime(r.time));
    this.speedBtn.textContent = r.speed + "×";
    this.skipBtn.setAttribute("aria-pressed", String(r.skipIdle));
    this.trailBtn.setAttribute("aria-pressed", String(r.trail));
    this.el.classList.toggle("ro-skipping", r.skipping && r.playing);
    this.drawWave();
  }

  private timeAt(clientX: number): number {
    const box = this.track.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return u * this.r.duration;
  }

  private bindTrack() {
    const track = this.track;
    const flushSeek = () => {
      if (this.pendingSeek === null) return;
      const t = this.pendingSeek;
      this.pendingSeek = null;
      this.r.seek(t);
    };
    const queueSeek = (t: number) => {
      // Several pointer moves per frame collapse into one seek.
      if (this.pendingSeek === null) requestAnimationFrame(flushSeek);
      this.pendingSeek = t;
      this.head.style.left = this.pct(t) + "%";
    };
    track.addEventListener("pointerdown", (e) => {
      const mark = (e.target as HTMLElement).closest(".ro-mark") as HTMLElement | null;
      this.scrubbing = true;
      this.wasPlaying = this.r.playing;
      this.r.pause();
      track.setPointerCapture(e.pointerId);
      track.classList.add("ro-scrubbing");
      queueSeek(mark ? Math.max(0, Number(mark.dataset.t) - 400) : this.timeAt(e.clientX));
    });
    track.addEventListener("pointermove", (e) => {
      this.showTip(e.clientX, e.target as HTMLElement);
      if (this.scrubbing) queueSeek(this.timeAt(e.clientX));
    });
    const end = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      track.classList.remove("ro-scrubbing");
      flushSeek();
      if (this.wasPlaying) this.r.play();
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    track.addEventListener("pointerleave", () => {
      if (!this.scrubbing) this.tip.hidden = true;
    });
    track.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        this.jump(e.key === "ArrowLeft" ? -5000 : 5000);
      }
    });
  }

  private showTip(clientX: number, target: HTMLElement) {
    const box = this.track.getBoundingClientRect();
    let t = this.timeAt(clientX);
    let label = "";
    const markEl = target.closest(".ro-mark") as HTMLElement | null;
    if (markEl) {
      t = Number(markEl.dataset.t);
      const m = this.r.timeline.markers.find((x) => x.t === t);
      if (m) label = m.label;
    } else {
      const seg = this.r.timeline.segmentAt(t);
      if (seg && this.r.timeline.segments.length > 1) label = seg.meta.title || seg.meta.url;
      if (this.r.timeline.idleAt(t)) label = "Inactive";
    }
    this.tip.hidden = false;
    this.tip.innerHTML = "";
    const time = document.createElement("b");
    time.textContent = formatTime(t);
    this.tip.appendChild(time);
    if (label) {
      const s = document.createElement("span");
      s.textContent = label.length > 70 ? label.slice(0, 69) + "…" : label;
      this.tip.appendChild(s);
    }
    const x = Math.min(Math.max(clientX - box.left, 60), box.width - 60);
    this.tip.style.left = x + "px";
  }
}
