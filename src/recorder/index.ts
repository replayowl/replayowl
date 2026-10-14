// Replayowl recorder. Load with
//   <script src="https://host/recorder.js" data-endpoint="https://host/api/ingest" defer></script>
// or call ReplayOwl.start({ endpoint }) yourself.

import { validUserId } from "../shared/analyze.ts";
import { DOCUMENT_ID, type ReplayEvent } from "../shared/protocol.ts";
import { installCssHooks, readAdopted } from "./css.ts";
import { Mirror } from "./mirror.ts";
import { Privacy, type PrivacyOptions } from "./privacy.ts";
import { Transport } from "./transport.ts";

export interface RecorderOptions extends Partial<PrivacyOptions> {
  endpoint: string;
  /** Minutes of inactivity after which the next page load starts a new session. */
  sessionTimeoutMin?: number;
  /** Capture console errors and warnings, uncaught errors and unhandled rejections. */
  captureLogs?: boolean;
  /** The site's own id for the signed-in visitor. Same as calling identify() before start. */
  userId?: string;
}

const MOVE_SAMPLE_MS = 40;
const SCROLL_SAMPLE_MS = 60;
/** Scrolls, inputs and focus changes this long after the last user input are attributed to page script (covers momentum scrolling). */
const USER_INPUT_WINDOW_MS = 3000;
const SID_KEY = "ro_sid";
const LAST_KEY = "ro_last";
const UID_KEY = "ro_uid";

type Distribute<T> = T extends ReplayEvent ? Omit<T, "ts"> : never;
type EventBody = Distribute<ReplayEvent>;

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionId(timeoutMin: number): string {
  try {
    const now = Date.now();
    const last = Number(sessionStorage.getItem(LAST_KEY) || 0);
    let sid = sessionStorage.getItem(SID_KEY);
    if (!sid || now - last > timeoutMin * 60000) {
      sid = randomId();
      sessionStorage.setItem(SID_KEY, sid);
    }
    sessionStorage.setItem(LAST_KEY, String(now));
    return sid;
  } catch {
    return randomId();
  }
}

/** The id given to identify() earlier in this session (sessionStorage is per tab, like the session). */
function storedUserId(sid: string): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(UID_KEY) || "null");
    return v && v.sid === sid && validUserId(v.uid) ? v.uid : null;
  } catch {
    return null;
  }
}

function storeUserId(sid: string, uid: string) {
  try {
    sessionStorage.setItem(UID_KEY, JSON.stringify({ sid, uid }));
  } catch {
    /* storage blocked */
  }
}

/** Calls fn at most once per `ms`, always delivering the latest arguments (trailing call included). */
function sampler<A extends unknown[]>(ms: number, fn: (...args: A) => void) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  return (...args: A) => {
    pending = args;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      pending = null;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, wait);
    }
  };
}

export class Recorder {
  private opts: Required<Pick<RecorderOptions, "endpoint" | "sessionTimeoutMin" | "captureLogs">>;
  private privacy: Privacy;
  private mirror!: Mirror;
  private transport!: Transport;
  private cleanups: (() => void)[] = [];
  private shadowRoots = new Set<ShadowRoot>();
  private touchedAt = 0;
  private inputAt = 0;
  readonly sid: string;
  readonly view = randomId();
  private running = false;
  private uid: string | null;

  constructor(options: RecorderOptions) {
    this.opts = { sessionTimeoutMin: 30, captureLogs: true, ...options };
    this.privacy = new Privacy(options);
    this.sid = sessionId(this.opts.sessionTimeoutMin);
    this.uid = validUserId(options.userId) ? options.userId : storedUserId(this.sid);
    if (this.uid) storeUserId(this.sid, this.uid);
  }

  private emit(body: EventBody) {
    if (!this.running) return;
    const ts = Date.now();
    // Carousels, auto-scrolling feeds and form scripts would otherwise keep a resting visitor looking active.
    const auto = (body.k === "scroll" || body.k === "input" || body.k === "focus") && !this.userActive(ts);
    this.transport.push({ ...body, ...(auto ? { auto: true } : {}), ts } as ReplayEvent);
  }

  private userActive(now = Date.now()) {
    return now - this.inputAt <= USER_INPUT_WINDOW_MS;
  }

  /** Keeps the session alive across page loads while the user is active. */
  private touch() {
    const now = Date.now();
    if (now - this.touchedAt < 5000) return;
    this.touchedAt = now;
    try {
      sessionStorage.setItem(LAST_KEY, String(now));
    } catch {
      /* storage blocked */
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.transport = new Transport(this.opts.endpoint, this.sid, this.view);
    const scrolled: Element[] = [];
    this.mirror = new Mirror(this.privacy, {
      onMutation: (m) => {
        this.emit({ k: "mutation", m });
        css.check();
      },
      onShadowRoot: (root) => this.attachShadow(root),
      onScrolled: (el) => scrolled.push(el),
    });

    const css = installCssHooks(
      {
        onRule: (owner, op, index, rule) => {
          const id = this.mirror.idOf(owner);
          // Unknown owner: the element is still pending in the mutation queue and its snapshot will include the rule.
          if (id) this.emit({ k: "css", id, op, index, ...(rule !== undefined ? { rule } : {}) });
        },
        onAdopted: (root) => {
          const id = root instanceof ShadowRoot ? this.mirror.idOf(root.host) : DOCUMENT_ID;
          if (id !== null) this.emit({ k: "adopt", id, sheets: readAdopted(root) });
        },
      },
      () => [document as Document | ShadowRoot, ...this.shadowRoots],
    );
    this.cleanups.push(css.stop);

    this.emit({ k: "meta", url: location.href, title: document.title, w: innerWidth, h: innerHeight, ua: navigator.userAgent, view: this.view, ...(this.uid ? { uid: this.uid } : {}) });
    this.emit({ k: "snapshot", snap: this.mirror.snapshot(document) });
    this.mirror.watchShadowRoots();
    for (const root of this.shadowRoots) css.prime(root);
    if (scrollX || scrollY) this.emit({ k: "scroll", id: DOCUMENT_ID, x: Math.round(scrollX), y: Math.round(scrollY) });
    for (const el of scrolled) this.emitScroll(el);
    scrolled.length = 0;
    const active = document.activeElement;
    if (active && active !== document.body) this.emit({ k: "focus", id: this.mirror.idOf(active) });

    this.listen();
    this.patchValueSetters();
    if (this.opts.captureLogs) this.captureLogs();
    const poll = setInterval(() => css.check(), 1000);
    this.cleanups.push(() => clearInterval(poll), () => this.mirror.disconnect());
    this.transport.start();
    // Send the snapshot right away so a session exists even if the visitor leaves within seconds.
    this.transport.flush();
  }

  /** Attributes the whole session to `uid`; later page loads of the session carry it in their meta event. */
  identify(uid: string) {
    if (!validUserId(uid) || uid === this.uid) return;
    this.uid = uid;
    storeUserId(this.sid, uid);
    // Before start() the meta event carries it instead (emit does nothing until then).
    this.emit({ k: "identify", uid });
  }

  stop() {
    if (!this.running) return;
    for (const fn of this.cleanups.splice(0)) fn();
    this.transport.stop();
    this.running = false;
  }

  private on(target: EventTarget, type: string, fn: (e: any) => void, opts: AddEventListenerOptions = { capture: true, passive: true }) {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  private attachShadow(root: ShadowRoot) {
    if (this.shadowRoots.has(root)) return;
    this.shadowRoots.add(root);
    // Scroll, input and media events do not cross shadow boundaries in a useful way, so listen inside too.
    this.on(root, "scroll", (e: Event) => this.onScroll(e));
    this.on(root, "input", (e: Event) => this.onInput(e));
    this.on(root, "change", (e: Event) => this.onInput(e));
  }

  private emitScroll(el: Element) {
    const id = this.mirror.idOf(el);
    if (id) this.emit({ k: "scroll", id, x: Math.round(el.scrollLeft), y: Math.round(el.scrollTop) });
  }

  private scrollSamplers = new WeakMap<EventTarget, () => void>();
  private onScroll(e: Event) {
    const target = e.target;
    if (!target) return;
    let fn = this.scrollSamplers.get(target);
    if (!fn) {
      fn = sampler(SCROLL_SAMPLE_MS, () => {
        if (target === document || target === document.documentElement || target === document.scrollingElement)
          this.emit({ k: "scroll", id: DOCUMENT_ID, x: Math.round(scrollX), y: Math.round(scrollY) });
        else if (target instanceof Element) this.emitScroll(target);
      });
      this.scrollSamplers.set(target, fn);
    }
    fn();
    if (this.userActive()) this.touch();
  }

  private inputTarget(e: Event): Element | null {
    const t = (e.composedPath ? e.composedPath()[0] : e.target) as Element | null;
    return t && t.nodeType === Node.ELEMENT_NODE ? t : null;
  }

  private recordValue(el: Element) {
    const id = this.mirror.idOf(el);
    if (!id) return;
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
    const field = el as HTMLInputElement;
    if (field.type === "checkbox" || field.type === "radio") {
      this.emit({ k: "input", id, c: field.checked, field: field.type });
      return;
    }
    if (field.type === "file") return;
    const masked = this.privacy.isValueMasked(el);
    const value = masked ? this.privacy.maskValue(el, field.value) : field.value;
    this.emit({ k: "input", id, v: value, ...(masked ? { masked } : {}), ...(tag === "SELECT" ? { field: "select" as const } : {}) });
  }

  private onInput(e: Event) {
    const el = this.inputTarget(e);
    if (el) this.recordValue(el);
    if (this.userActive()) this.touch();
  }

  /** Values set from script (form libraries, autofill helpers) fire no events; catch them at the setter. */
  private patchValueSetters() {
    const patch = (proto: object, prop: string) => {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return;
      const self = this;
      Object.defineProperty(proto, prop, {
        ...desc,
        set(this: Element, v: unknown) {
          desc.set!.call(this, v);
          if (self.running && this.isConnected) self.recordValue(this);
        },
      });
      this.cleanups.push(() => Object.defineProperty(proto, prop, desc));
    };
    patch(HTMLInputElement.prototype, "value");
    patch(HTMLInputElement.prototype, "checked");
    patch(HTMLTextAreaElement.prototype, "value");
    patch(HTMLSelectElement.prototype, "value");
    patch(HTMLSelectElement.prototype, "selectedIndex");
  }

  private listen() {
    const input = () => (this.inputAt = Date.now());
    for (const type of ["pointerdown", "mousedown", "mousemove", "touchstart", "touchmove", "wheel", "keydown"]) this.on(document, type, input);

    const move = sampler(MOVE_SAMPLE_MS, (x: number, y: number) => this.emit({ k: "move", x, y }));
    this.on(document, "mousemove", (e: MouseEvent) => {
      move(Math.round(e.clientX), Math.round(e.clientY));
      this.touch();
    });
    this.on(document, "touchmove", (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) move(Math.round(t.clientX), Math.round(t.clientY));
      this.touch();
    });
    this.on(document, "touchstart", (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) this.emit({ k: "move", x: Math.round(t.clientX), y: Math.round(t.clientY) });
    });

    this.on(document, "click", (e: MouseEvent) => {
      const target = this.inputTarget(e);
      const id = this.mirror.idOf(target);
      const clickable = target && target.closest("a,button,[role=button],input[type=submit],input[type=button],label,summary");
      let label: string | undefined;
      if (clickable && !this.privacy.isTextMasked(clickable)) {
        const text = (clickable.getAttribute("aria-label") || (clickable as HTMLElement).innerText || (clickable as HTMLInputElement).value || "").trim().replace(/\s+/g, " ");
        if (text) label = this.privacy.scrub(text.slice(0, 80));
      }
      this.emit({ k: "click", x: Math.round(e.clientX), y: Math.round(e.clientY), id, ...(label ? { label } : {}) });
      this.touch();
    });

    this.on(document, "scroll", (e: Event) => this.onScroll(e));
    this.on(document, "input", (e: Event) => this.onInput(e));
    this.on(document, "change", (e: Event) => this.onInput(e));

    this.on(document, "focusin", (e: FocusEvent) => this.emit({ k: "focus", id: this.mirror.idOf(this.inputTarget(e)) }));
    this.on(document, "focusout", (e: FocusEvent) => {
      if (!e.relatedTarget) this.emit({ k: "focus", id: null });
    });

    const resize = sampler(150, () => this.emit({ k: "resize", w: innerWidth, h: innerHeight }));
    this.on(window, "resize", resize);

    for (const type of ["play", "pause", "seeked"]) {
      this.on(document, type, (e: Event) => {
        const media = e.target as HTMLMediaElement;
        const id = this.mirror.idOf(media);
        if (id) this.emit({ k: "media", id, op: media.paused ? "pause" : "play", time: media.currentTime });
      });
    }

    this.on(document, "visibilitychange", () => {
      this.emit({ k: "visibility", visible: !document.hidden });
      if (document.hidden) this.transport.flushNow();
    });
    this.on(window, "pagehide", () => this.transport.flushNow());
  }

  private captureLogs() {
    const stringify = (a: unknown): string => {
      if (a instanceof Error) return a.name + ": " + a.message;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    };
    const log = (level: "error" | "warn", msg: string, stack?: string) =>
      this.emit({ k: "log", level, msg: this.privacy.scrub(msg.slice(0, 2000)), ...(stack ? { stack: stack.slice(0, 4000) } : {}) });

    for (const level of ["error", "warn"] as const) {
      const native = console[level];
      console[level] = (...args: unknown[]) => {
        native.apply(console, args);
        try {
          const err = args.find((a) => a instanceof Error) as Error | undefined;
          log(level, args.map(stringify).join(" "), err && err.stack);
        } catch {
          /* never break the page */
        }
      };
      this.cleanups.push(() => (console[level] = native));
    }
    this.on(window, "error", (e: ErrorEvent) => {
      if (e.error || e.message) log("error", "Uncaught " + (e.error ? stringify(e.error) : e.message), e.error && e.error.stack);
    });
    this.on(window, "unhandledrejection", (e: PromiseRejectionEvent) => {
      log("error", "Unhandled rejection: " + stringify(e.reason), e.reason && e.reason.stack);
    });
  }
}

let current: Recorder | null = null;
let pendingUid: string | null = null;

export function start(options: RecorderOptions): Recorder {
  if (current) return current;
  current = new Recorder({ ...options, userId: options.userId || pendingUid || undefined });
  pendingUid = null;
  const run = () => current && current.start();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
  return current;
}

export function stop() {
  if (current) current.stop();
  current = null;
}

/** Names the signed-in visitor. Safe to call before or after start, and again when the account changes. */
export function identify(userId: string) {
  const uid = typeof userId === "string" ? userId.trim() : "";
  if (!validUserId(uid)) return;
  if (current) current.identify(uid);
  else pendingUid = uid;
}

// Auto start from the script tag: data-endpoint plus optional data-user-id, data-mask-all-text, data-mask-all-inputs="false", data-mask-digits.
const script = document.currentScript as HTMLScriptElement | null;
if (script && script.dataset.endpoint) {
  const d = script.dataset;
  const flag = (v: string | undefined) => (v === undefined ? undefined : v !== "false");
  const opts: RecorderOptions = { endpoint: new URL(d.endpoint!, script.src || location.href).href };
  const pick: [keyof PrivacyOptions, string | undefined][] = [
    ["maskAllText", d.maskAllText],
    ["maskAllInputs", d.maskAllInputs],
    ["maskDigits", d.maskDigits],
    ["maskEmails", d.maskEmails],
    ["maskCardNumbers", d.maskCardNumbers],
  ];
  for (const [key, v] of pick) if (flag(v) !== undefined) opts[key] = flag(v)!;
  if (d.userId) opts.userId = d.userId.trim();
  start(opts);
}
