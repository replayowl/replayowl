// Player styles, injected once per page so the player works as a drop-in library.

export const PLAYER_CSS = `
.ro-player{--ro-ink:#1f2240;--ro-ink-2:#2b2f57;--ro-ink-3:#3a3f6e;--ro-amber:#f2a93b;--ro-red:#e5484d;--ro-plum:#a58bf0;--ro-mist:#d6daf0;--ro-stage:#e7e9f2;
  position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--ro-stage);color:var(--ro-ink);font:13px/1.4 "Avenir Next","Segoe UI Variable","Segoe UI",system-ui,sans-serif}
.ro-player:fullscreen{width:100vw;height:100vh}
.ro-player button{font:inherit;color:inherit}
.ro-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;
  background-color:var(--ro-stage);background-image:radial-gradient(rgba(31,34,64,.11) 1px,transparent 1.2px);background-size:18px 18px}
.ro-viewport{position:relative;overflow:hidden;background:#fff;border-radius:6px;box-shadow:0 0 0 1px rgba(31,34,64,.14),0 18px 50px -18px rgba(31,34,64,.45)}
.ro-canvas{position:absolute;left:0;top:0;transform-origin:0 0}
.ro-frame{position:absolute;left:0;top:0;border:0;background:#fff;pointer-events:none;visibility:hidden}
.ro-frame.ro-front{visibility:visible}
.ro-trail{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ro-cursor{position:absolute;left:0;top:0;width:24px;height:24px;margin:-3px 0 0 -4px;pointer-events:none;will-change:transform;z-index:3;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35));transition:opacity .2s}
.ro-cursor svg{display:block;transform-origin:4px 3px}
.ro-cursor.ro-pressed svg{animation:ro-press .22s ease-out}
@keyframes ro-press{40%{transform:scale(.8)}}
.ro-ripple{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;pointer-events:none;z-index:2;
  border:2.5px solid var(--ro-amber);background:rgba(242,169,59,.18);animation:ro-ripple .65s cubic-bezier(.2,.7,.3,1) forwards}
.ro-ripple.ro-rage{border-color:var(--ro-red);background:rgba(229,72,77,.22);animation-duration:1.1s;width:56px;height:56px;margin:-28px 0 0 -28px}
@keyframes ro-ripple{from{transform:scale(.25);opacity:1}to{transform:scale(1.35);opacity:0}}
.ro-notice{position:absolute;left:50%;top:16px;transform:translate(-50%,-8px);padding:7px 14px;border-radius:999px;background:var(--ro-ink);color:#fff;
  font-weight:500;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:4;white-space:nowrap}
.ro-notice.ro-show{opacity:.94;transform:translate(-50%,0)}

.ro-controls{background:var(--ro-ink);color:var(--ro-mist);padding:10px 16px 10px;user-select:none}
.ro-track{position:relative;height:46px;cursor:pointer;touch-action:none;outline:none;border-radius:4px}
.ro-track:focus-visible{box-shadow:0 0 0 2px var(--ro-amber)}
.ro-wave{position:absolute;inset:0;width:100%;height:100%}
.ro-idle-layer,.ro-marker-layer{position:absolute;inset:0;pointer-events:none}
.ro-idle{position:absolute;top:4px;bottom:4px;border-radius:3px;background:repeating-linear-gradient(135deg,rgba(214,218,240,.10) 0 4px,transparent 4px 8px)}
.ro-mark{position:absolute;pointer-events:auto;transform:translateX(-50%);cursor:pointer}
.ro-mark-click{bottom:10px;width:3px;height:12px;border-radius:2px;background:var(--ro-amber)}
.ro-mark-rage{bottom:8px;width:9px;height:9px;border-radius:50%;background:var(--ro-red);box-shadow:0 0 0 3px rgba(229,72,77,.3)}
.ro-mark-input{bottom:11px;width:7px;height:7px;border-radius:50%;background:var(--ro-plum)}
.ro-mark-error,.ro-mark-warn{top:2px;width:9px;height:9px;transform:translateX(-50%) rotate(45deg);background:var(--ro-red);border-radius:1px}
.ro-mark-warn{background:#e9c46a}
.ro-mark-page{top:0;bottom:6px;width:2px;background:var(--ro-plum);opacity:.85}
.ro-mark:hover{filter:brightness(1.3)}
.ro-head{position:absolute;top:-2px;bottom:4px;width:2px;margin-left:-1px;background:#fff;pointer-events:none;border-radius:1px}
.ro-head span{position:absolute;left:50%;top:-4px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px rgba(242,169,59,.55)}
.ro-scrubbing .ro-head span{box-shadow:0 0 0 5px rgba(242,169,59,.6)}
.ro-tip{position:absolute;bottom:calc(100% + 8px);transform:translateX(-50%);background:#fff;color:var(--ro-ink);padding:6px 10px;border-radius:6px;
  box-shadow:0 8px 24px -8px rgba(0,0,0,.5);white-space:nowrap;pointer-events:none;display:flex;gap:8px;align-items:baseline;z-index:5}
.ro-tip[hidden]{display:none}
.ro-tip b{font-variant-numeric:tabular-nums}
.ro-tip span{color:#555a7d;max-width:340px;overflow:hidden;text-overflow:ellipsis}
.ro-bar{display:flex;align-items:center;gap:6px;margin-top:6px}
.ro-btn{display:inline-grid;place-items:center;width:34px;height:34px;border:0;border-radius:8px;background:transparent;cursor:pointer;color:var(--ro-mist)}
.ro-btn svg{width:20px;height:20px;fill:currentColor}
.ro-btn text{fill:currentColor}
.ro-btn:hover{background:var(--ro-ink-2);color:#fff}
.ro-play{width:40px;height:40px;background:var(--ro-amber);color:var(--ro-ink)}
.ro-play:hover{background:#ffbd55;color:var(--ro-ink)}
.ro-play svg{width:22px;height:22px}
.ro-clock{margin-left:8px;font-variant-numeric:tabular-nums;color:#fff;font-weight:500;letter-spacing:.01em}
.ro-spacer{flex:1}
.ro-skipping-pill{margin-left:10px;padding:3px 10px;border-radius:999px;background:var(--ro-ink-3);color:#fff;font-size:12px;opacity:0;transition:opacity .2s}
.ro-skipping .ro-skipping-pill{opacity:1}
.ro-toggle,.ro-speed{height:30px;padding:0 11px;border-radius:8px;border:1px solid var(--ro-ink-3);background:transparent;cursor:pointer;color:var(--ro-mist);font-size:12.5px}
.ro-toggle:hover,.ro-speed:hover{border-color:#5a609a;color:#fff}
.ro-toggle[aria-pressed=true]{background:var(--ro-ink-2);color:#fff}
.ro-toggle::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:#5a609a}
.ro-toggle[aria-pressed=true]::before{background:var(--ro-amber)}
.ro-speed{min-width:48px;font-variant-numeric:tabular-nums;font-weight:600}
.ro-player button:focus-visible{outline:2px solid var(--ro-amber);outline-offset:2px}
@media (max-width:720px){.ro-toggle,.ro-skipping-pill{display:none}.ro-controls{padding:8px 10px}}
@media (prefers-reduced-motion:reduce){.ro-ripple{animation-duration:.01s}.ro-cursor.ro-pressed svg{animation:none}}
`;

let injected = false;
export function injectStyles() {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.setAttribute("data-replayowl", "");
  style.textContent = PLAYER_CSS;
  document.head.appendChild(style);
}
