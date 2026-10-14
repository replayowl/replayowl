// CSS rewriting for the replay document.
//
// The replay iframe ignores the real mouse (pointer-events: none), so interactive pseudo-classes
// would never match. They are rewritten into attribute selectors that the player toggles on the
// elements under the replayed cursor or focus. Specificity is unchanged (pseudo-class and
// attribute selectors weigh the same).

export const HOVER_ATTR = "ro-hover";
export const ACTIVE_ATTR = "ro-active";
export const FOCUS_ATTR = "ro-focus";
export const FOCUS_WITHIN_ATTR = "ro-focus-within";

const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const IMPORT_RE = /@import\s+(['"])([^'"]+)\1/g;

export function absolutize(url: string, base: string): string {
  const u = url.trim();
  if (!u || /^(data:|blob:|about:|javascript:|#|[a-z][a-z0-9+.-]*:\/\/)/i.test(u)) return u;
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

export function absolutizeSrcset(value: string, base: string): string {
  return value
    .split(",")
    .map((part) => part.trim().replace(/^(\S+)/, (u) => absolutize(u, base)))
    .join(", ");
}

export function rewritePseudo(css: string): string {
  if (css.indexOf(":") < 0) return css;
  return css
    .replace(/:hover\b/g, "[" + HOVER_ATTR + "]")
    .replace(/:active\b/g, "[" + ACTIVE_ATTR + "]")
    .replace(/:focus-visible\b/g, "[" + FOCUS_ATTR + "]")
    .replace(/:focus-within\b/g, "[" + FOCUS_WITHIN_ATTR + "]")
    .replace(/:focus\b(?!-)/g, "[" + FOCUS_ATTR + "]");
}

export function transformCss(css: string, base: string): string {
  if (!css) return css;
  const out = css
    .replace(URL_RE, (_m, q: string, u: string) => "url(" + q + absolutize(u, base) + q + ")")
    .replace(IMPORT_RE, (_m, q: string, u: string) => "@import " + q + absolutize(u, base) + q);
  return rewritePseudo(out);
}
