import type { ReplayEvent } from "../shared/protocol.ts";
import { Controls } from "./controls.ts";
import { Replayer, type ReplayerOptions } from "./replayer.ts";
import { injectStyles } from "./styles.ts";

export { Replayer, Controls };
export { formatTime } from "./controls.ts";
export type { Marker, Segment } from "./timeline.ts";

export interface Player {
  el: HTMLElement;
  replayer: Replayer;
  controls: Controls;
  destroy(): void;
}

/** Full player: stage plus control bar, with keyboard shortcuts bound to the document. */
export function createPlayer(container: HTMLElement, events: ReplayEvent[], opts: ReplayerOptions & { keyboard?: boolean } = {}): Player {
  injectStyles();
  const el = document.createElement("div");
  el.className = "ro-player";
  container.appendChild(el);
  const replayer = new Replayer(el, events, opts);
  const controls = new Controls(el, replayer, el);
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (t && t.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    if (controls.handleKey(e)) e.preventDefault();
  };
  if (opts.keyboard !== false) document.addEventListener("keydown", onKey);
  return {
    el,
    replayer,
    controls,
    destroy() {
      document.removeEventListener("keydown", onKey);
      replayer.destroy();
      el.remove();
    },
  };
}
