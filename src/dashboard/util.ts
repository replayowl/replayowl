export const OWL_SVG =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 6l5 3.2A11 11 0 0 1 16 8a11 11 0 0 1 5 1.2L26 6l-1 6.5A11 11 0 0 1 27 19c0 6-5 10-11 10S5 25 5 19a11 11 0 0 1 2-6.5z" fill="#3a3f6e"/><circle cx="11.5" cy="17" r="4.2" fill="#fff"/><circle cx="20.5" cy="17" r="4.2" fill="#fff"/><circle cx="11.5" cy="17" r="2.2" fill="#f2a93b"/><circle cx="20.5" cy="17" r="2.2" fill="#f2a93b"/><path d="M16 20.5l-1.6 2.3h3.2z" fill="#f2a93b"/></svg>';

export function describeUA(ua: string): string {
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\/|CriOS\//.test(ua) ? (/HeadlessChrome/.test(ua) ? "Headless Chrome" : "Chrome") :
    /Safari\//.test(ua) ? "Safari" : "Browser";
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /Windows/.test(ua) ? "Windows" :
    /Linux/.test(ua) ? "Linux" : "";
  return os ? browser + " on " + os : browser;
}

export function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + " h ago";
  const d = Math.round(h / 24);
  if (d < 7) return d + " d ago";
  return new Date(ts).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const k in attrs) {
    if (k === "class") el.className = attrs[k];
    else el.setAttribute(k, attrs[k]);
  }
  for (const c of children) if (c !== null) el.append(c);
  return el;
}

export function svg(markup: string): Element {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as Element;
}
