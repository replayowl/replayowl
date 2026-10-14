// Stylesheet capture. Replays should not depend on the live site still serving the same CSS,
// and CSS-in-JS libraries write rules straight into the CSSOM where MutationObserver cannot see them.

const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const IMPORT_RE = /@import\s+(['"])([^'"]+)\1/g;

export function absolutizeCssUrls(css: string, base: string): string {
  const fix = (u: string) => {
    if (/^(data:|blob:|#|[a-z][a-z0-9+.-]*:\/\/)/i.test(u)) return u;
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  };
  return css
    .replace(URL_RE, (_m, q: string, u: string) => "url(" + q + fix(u.trim()) + q + ")")
    .replace(IMPORT_RE, (_m, q: string, u: string) => "@import " + q + fix(u) + q);
}

export function rulesText(sheet: CSSStyleSheet): string | null {
  try {
    const rules = sheet.cssRules;
    let out = "";
    for (let i = 0; i < rules.length; i++) out += rules[i].cssText + "\n";
    return out;
  } catch {
    // Cross-origin sheet without CORS: the player falls back to loading the href.
    return null;
  }
}

/** Full CSS of a loaded <link rel=stylesheet>, or null when unavailable. */
export function inlineCss(link: HTMLLinkElement): string | null {
  if (!/stylesheet/i.test(link.rel) || !link.sheet) return null;
  const text = rulesText(link.sheet);
  return text === null ? null : absolutizeCssUrls(text, link.sheet.href || link.href);
}

/** CSS of a <style> whose CSSOM holds more rules than its text, or null when the text is accurate. */
export function readStyleElementCss(style: HTMLStyleElement): string | null {
  const sheet = style.sheet;
  if (!sheet) return null;
  let count: number;
  try {
    count = sheet.cssRules.length;
  } catch {
    return null;
  }
  if (!count) return null;
  const text = style.textContent || "";
  const braces = (text.match(/{/g) || []).length;
  if (text.trim() && count <= braces) return null;
  return rulesText(sheet);
}

export function readAdopted(root: Document | ShadowRoot): string[][] {
  const list = root.adoptedStyleSheets;
  if (!list || !list.length) return [];
  return Array.from(list).map((s) => {
    const out: string[] = [];
    try {
      for (const r of Array.from(s.cssRules)) out.push(r.cssText);
    } catch {
      /* unreadable */
    }
    return out;
  });
}

export interface CssHooks {
  onRule(owner: Element, op: "insert" | "delete", index: number, rule?: string): void;
  /** Adopted sheets of a document or shadow root changed (assignment, push, or a rule edit). */
  onAdopted(root: Document | ShadowRoot): void;
}

/**
 * Watches CSSOM edits. Returns `check`, which detects adoptedStyleSheets changes made through
 * array methods (they bypass the setter), and `stop`, which restores the patched prototypes.
 */
export function installCssHooks(hooks: CssHooks, roots: () => Iterable<Document | ShadowRoot>) {
  const proto = CSSStyleSheet.prototype;
  const nativeInsert = proto.insertRule;
  const nativeDelete = proto.deleteRule;
  const nativeReplaceSync = proto.replaceSync;
  const nativeReplace = proto.replace;
  const seen = new WeakMap<Document | ShadowRoot, readonly CSSStyleSheet[]>();

  const adopters = (sheet: CSSStyleSheet) => {
    const out: (Document | ShadowRoot)[] = [];
    for (const r of roots()) if (r.adoptedStyleSheets && r.adoptedStyleSheets.indexOf(sheet) >= 0) out.push(r);
    return out;
  };
  const sheetChanged = (sheet: CSSStyleSheet) => {
    if (sheet.ownerNode) return;
    for (const r of adopters(sheet)) hooks.onAdopted(r);
  };

  proto.insertRule = function (this: CSSStyleSheet, rule: string, index?: number) {
    const at = nativeInsert.call(this, rule, index);
    const owner = this.ownerNode;
    if (owner && owner.nodeType === Node.ELEMENT_NODE) hooks.onRule(owner as Element, "insert", at, rule);
    else sheetChanged(this);
    return at;
  };
  proto.deleteRule = function (this: CSSStyleSheet, index: number) {
    nativeDelete.call(this, index);
    const owner = this.ownerNode;
    if (owner && owner.nodeType === Node.ELEMENT_NODE) hooks.onRule(owner as Element, "delete", index);
    else sheetChanged(this);
  };
  if (nativeReplaceSync) {
    proto.replaceSync = function (this: CSSStyleSheet, text: string) {
      nativeReplaceSync.call(this, text);
      sheetChanged(this);
    };
  }
  if (nativeReplace) {
    proto.replace = function (this: CSSStyleSheet, text: string) {
      return nativeReplace.call(this, text).then((s) => {
        sheetChanged(this);
        return s;
      });
    };
  }

  const check = () => {
    for (const r of roots()) {
      const now = r.adoptedStyleSheets;
      if (!now) continue;
      const before = seen.get(r);
      const same = before && before.length === now.length && before.every((s, i) => s === now[i]);
      if (!same) {
        seen.set(r, Array.from(now));
        if (before || now.length) hooks.onAdopted(r);
      }
    }
  };
  // Prime the cache so pre-existing sheets (already in the snapshot) are not re-sent.
  for (const r of roots()) if (r.adoptedStyleSheets) seen.set(r, Array.from(r.adoptedStyleSheets));

  const stop = () => {
    proto.insertRule = nativeInsert;
    proto.deleteRule = nativeDelete;
    if (nativeReplaceSync) proto.replaceSync = nativeReplaceSync;
    if (nativeReplace) proto.replace = nativeReplace;
  };
  return { check, stop, prime: (r: Document | ShadowRoot) => r.adoptedStyleSheets && seen.set(r, Array.from(r.adoptedStyleSheets)) };
}
