// DOM signature used to compare a live page with its replay. Runs inside the browser.

export interface Signature {
  structure: string[];
  texts: string[];
  values: Record<string, string | boolean>;
  scroll: Record<string, number>;
  styles: Record<string, string>;
}

/** Elements whose computed style proves that a given CSS path was replayed. */
export const STYLE_PROBES: [string, string][] = [
  ["body", "background-color"],
  ["body", "font-family"],
  [".topbar", "background-color"],
  [".badge-new", "background-color"],
  [".adopted-outline", "outline-style"],
  ["#cart-list li", "font-weight"],
  ["#cart-list li.highlight", "background-color"],
  ["#modal", "display"],
];

export function signature(doc: Document, probes: [string, string][]): Signature {
  const structure: string[] = [];
  const texts: string[] = [];
  const values: Record<string, string | boolean> = {};
  const skip = (el: Element) => el.hasAttribute("data-ro-internal");
  const tagOf = (el: Element) => {
    const t = el.tagName.toUpperCase();
    // Inlined stylesheets are replayed as <style>.
    if (t === "LINK" && /stylesheet/i.test(el.getAttribute("rel") || "")) return "SHEET";
    if (t === "STYLE") return "SHEET";
    return t;
  };
  const walk = (node: Node, depth: number) => {
    node.childNodes.forEach((c) => {
      if (c.nodeType === 1) {
        const el = c as Element;
        if (skip(el)) return;
        const cls = Array.from(el.classList).sort().join(".");
        structure.push(depth + ":" + tagOf(el) + (el.id ? "#" + el.id : "") + (cls ? "." + cls : ""));
        const tag = el.tagName;
        if (el.id && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) {
          const f = el as HTMLInputElement;
          values[el.id] = f.type === "checkbox" || f.type === "radio" ? f.checked : f.value;
        }
        if (el.shadowRoot) {
          structure.push(depth + 1 + ":#shadow");
          walk(el.shadowRoot, depth + 2);
        }
        if (tag !== "SCRIPT" && tag !== "STYLE" && tag !== "NOSCRIPT") walk(el, depth + 1);
      } else if (c.nodeType === 3) {
        const t = (c.textContent || "").trim();
        if (t) texts.push(t);
      }
    });
  };
  walk(doc, 0);
  const win = doc.defaultView!;
  const scroll: Record<string, number> = { window: Math.round(win.scrollY) };
  const reviews = doc.getElementById("reviews");
  if (reviews) scroll.reviews = Math.round(reviews.scrollTop);
  const styles: Record<string, string> = {};
  for (const [sel, prop] of probes) {
    const el = doc.querySelector(sel);
    if (el) styles[sel + " " + prop] = win.getComputedStyle(el).getPropertyValue(prop);
  }
  const rating = doc.getElementById("rating");
  const star = rating && rating.shadowRoot && rating.shadowRoot.querySelector("button.on");
  if (star) styles["rating star color"] = win.getComputedStyle(star).color;
  return { structure, texts, values, scroll, styles };
}

/** A replayed text matches when it is identical or a same-length mask of the live text. */
export function textMatches(live: string, replay: string): boolean {
  if (live === replay) return true;
  if (live.length !== replay.length) return false;
  for (let i = 0; i < live.length; i++) if (live[i] !== replay[i] && replay[i] !== "*") return false;
  return true;
}
