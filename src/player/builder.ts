// Builds the recorded DOM inside the replay iframe and keeps it in sync with mutation events.
// Nothing executable survives: scripts are inert in the sandboxed frame, event handler attributes
// are dropped, and nested frames are replaced by placeholders.

import { DOCUMENT_ID, type MutationData, type NodeId, type SerializedElement, type SerializedNode, type Snapshot } from "../shared/protocol.ts";
import { absolutize, absolutizeSrcset, transformCss } from "./css.ts";

const URL_ATTRS = new Set(["src", "href", "poster", "action", "background", "data", "xlink:href"]);
const BLOCKED_BG = "repeating-linear-gradient(135deg,#e7e5f0 0 8px,#d6d3e3 8px 16px)";

/** Base styles injected into every replay document. */
const REPLAY_CSS = `
[data-ro-blocked]{background:${BLOCKED_BG}!important;border-radius:4px}
[data-ro-frame]{background:repeating-linear-gradient(135deg,#f1f0f6 0 10px,#e8e6f0 10px 20px)!important}
html{scroll-behavior:auto!important}
*,*::before,*::after{caret-color:transparent!important}
`;

export class DomBuilder {
  readonly doc: Document;
  private base: string;
  private nodes = new Map<NodeId, Node>();

  constructor(doc: Document, base: string) {
    this.doc = doc;
    this.base = base;
  }

  get size() {
    return this.nodes.size;
  }

  node(id: NodeId): Node | undefined {
    return id === DOCUMENT_ID ? this.doc : this.nodes.get(id);
  }

  /** Replace the whole document with a snapshot. */
  load(snap: Snapshot) {
    const doc = this.doc;
    // Rendering mode (standards vs quirks) is decided at parse time, so the recorded doctype is parsed first.
    doc.open();
    doc.write((snap.doctype || "") + "<html><head></head><body></body></html>");
    doc.close();
    while (doc.firstChild) doc.removeChild(doc.firstChild);
    this.nodes.clear();
    for (const child of snap.children) {
      const node = this.create(child);
      if (node && node.nodeType !== Node.DOCUMENT_TYPE_NODE) doc.appendChild(node);
    }
    if (!doc.documentElement) doc.appendChild(doc.createElement("html"));
    const root = doc.documentElement;
    let head = doc.head;
    if (!head) {
      head = doc.createElement("head");
      root.insertBefore(head, root.firstChild);
    }
    const style = doc.createElement("style");
    style.setAttribute("data-ro-internal", "");
    style.textContent = REPLAY_CSS;
    head.appendChild(style);
    if (snap.sheets && snap.sheets.length) this.adopt(DOCUMENT_ID, snap.sheets);
  }

  /** Creates (or reuses, for moves) the live node for a serialized record, including its subtree. */
  private create(rec: SerializedNode, parentTag?: string): Node | null {
    if (rec.type === 0) return this.nodes.get(rec.id) || null;
    const existing = this.nodes.get(rec.id);
    if (existing) return existing;
    const doc = this.doc;
    let node: Node;
    switch (rec.type) {
      case 3:
        node = doc.createTextNode(parentTag === "STYLE" ? transformCss(rec.text, this.base) : rec.text);
        break;
      case 8:
        node = doc.createComment(rec.text);
        break;
      case 10:
        node = doc.implementation.createDocumentType(rec.name || "html", rec.publicId, rec.systemId);
        break;
      case 1:
        node = this.createElement(rec);
        break;
      default:
        return null;
    }
    this.nodes.set(rec.id, node);
    return node;
  }

  private createElement(rec: SerializedElement): Element {
    const doc = this.doc;
    let tag = rec.tag;
    // Stylesheets captured as text are rendered from that text so the replay never depends on the live site.
    if (rec.css !== undefined && tag.toLowerCase() === "link") tag = "style";
    let el: Element;
    try {
      el = rec.ns ? doc.createElementNS(rec.ns, tag) : doc.createElement(tag);
    } catch {
      el = doc.createElement("ro-invalid");
    }
    const upper = el.tagName.toUpperCase();
    if (rec.blocked) {
      el.setAttribute("data-ro-blocked", "");
      this.setAttrs(el, rec.attrs);
      const s = (el as HTMLElement).style;
      if (s) {
        s.setProperty("width", rec.blocked.w + "px", "important");
        s.setProperty("height", rec.blocked.h + "px", "important");
        if (getComputedStyleSafe(el) === "inline") s.setProperty("display", "inline-block", "important");
      }
      return el;
    }
    this.setAttrs(el, rec.attrs);
    if (upper === "IFRAME" || upper === "FRAME" || upper === "OBJECT" || upper === "EMBED") el.setAttribute("data-ro-frame", "");
    if (rec.css !== undefined) {
      el.textContent = transformCss(rec.css, this.base);
    } else {
      for (const c of rec.children) {
        const child = this.create(c, upper);
        if (child) el.appendChild(child);
      }
    }
    if (rec.shadow && (el as HTMLElement).attachShadow) {
      const root = this.shadowOf(el);
      if (root) {
        for (const c of rec.shadow) {
          const child = this.create(c);
          if (child) root.appendChild(child);
        }
        if (rec.shadowSheets) this.adoptInto(root, rec.shadowSheets);
      }
    }
    if (rec.value !== undefined) (el as HTMLInputElement).value = rec.value;
    if (rec.checked !== undefined) (el as HTMLInputElement).checked = rec.checked;
    if (upper === "VIDEO" || upper === "AUDIO") {
      (el as HTMLMediaElement).muted = true;
      (el as HTMLMediaElement).autoplay = false;
    }
    return el;
  }

  private shadowOf(el: Element): ShadowRoot | null {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return el.attachShadow({ mode: "open" });
    } catch {
      return null;
    }
  }

  private setAttrs(el: Element, attrs: Record<string, string | null>) {
    const tag = el.tagName.toUpperCase();
    for (const name in attrs) {
      const value = attrs[name];
      const lower = name.toLowerCase();
      if (lower.startsWith("on") || lower === "srcdoc" || lower === "autofocus") continue;
      if (value === null) {
        el.removeAttribute(name);
        continue;
      }
      let v = value;
      if ((tag === "SCRIPT" || tag === "IFRAME" || tag === "FRAME" || tag === "EMBED" || tag === "OBJECT") && (lower === "src" || lower === "data")) continue;
      if (tag === "A" && lower === "href" && /^\s*javascript:/i.test(v)) v = "#";
      if (tag === "META" && lower === "http-equiv") continue;
      if (tag === "BASE" && lower === "href") continue;
      if (tag === "LINK" && lower === "rel" && /preload|prefetch|modulepreload|preconnect|dns-prefetch/i.test(v)) v = "ro-" + v;
      if (URL_ATTRS.has(lower)) v = absolutize(v, this.base);
      else if (lower === "srcset") v = absolutizeSrcset(v, this.base);
      else if (lower === "style") v = transformCss(v, this.base);
      try {
        if (name.indexOf(":") > 0 && name.startsWith("xlink:")) el.setAttributeNS("http://www.w3.org/1999/xlink", name, v);
        else el.setAttribute(name, v);
      } catch {
        /* invalid attribute name recorded from the live DOM */
      }
    }
  }

  applyMutation(m: MutationData) {
    if (m.rm) {
      for (const id of m.rm) {
        const n = this.nodes.get(id);
        if (n && n.parentNode) n.parentNode.removeChild(n);
        // The id stays mapped: the recorder may move this node back in later.
      }
    }
    if (m.add) {
      for (const a of m.add) {
        const parent = this.node(a.p);
        if (!parent) continue;
        const container: Node | null = a.sr ? this.shadowOf(parent as Element) : parent;
        if (!container) continue;
        const parentTag = parent.nodeType === Node.ELEMENT_NODE ? (parent as Element).tagName.toUpperCase() : undefined;
        const node = this.create(a.node, parentTag);
        if (!node || node.nodeType === Node.DOCUMENT_TYPE_NODE) continue;
        const prev = a.prev === null ? null : this.nodes.get(a.prev);
        const ref = prev && prev.parentNode === container ? prev.nextSibling : a.prev === null ? container.firstChild : null;
        try {
          container.insertBefore(node, ref);
        } catch {
          /* hierarchy error from an inconsistent batch; skip this node */
        }
      }
    }
    if (m.attr) {
      for (const c of m.attr) {
        const el = this.nodes.get(c.id);
        if (el && el.nodeType === Node.ELEMENT_NODE) this.setAttrs(el as Element, c.a);
      }
    }
    if (m.text) {
      for (const t of m.text) {
        const n = this.nodes.get(t.id);
        if (!n) continue;
        const parent = n.parentNode as Element | null;
        n.textContent = parent && parent.nodeName === "STYLE" ? transformCss(t.v, this.base) : t.v;
      }
    }
    if (m.css) {
      for (const c of m.css) this.setCss(c.id, c.v);
    }
  }

  /** Inlined CSS arrived for a <link> (or a CSSOM-built <style>): render it from text from now on. */
  private setCss(id: NodeId, css: string) {
    const el = this.nodes.get(id) as Element | undefined;
    if (!el) return;
    const text = transformCss(css, this.base);
    if (el.tagName.toUpperCase() === "STYLE") {
      el.textContent = text;
      return;
    }
    const style = this.doc.createElement("style");
    for (const a of Array.from(el.attributes)) if (a.name !== "href" && a.name !== "rel") style.setAttribute(a.name, a.value);
    style.textContent = text;
    if (el.parentNode) el.parentNode.replaceChild(style, el);
    this.nodes.set(id, style);
  }

  insertRule(id: NodeId, rule: string, index: number) {
    const sheet = this.sheetOf(id);
    if (!sheet) return false;
    const text = transformCss(rule, this.base);
    try {
      sheet.insertRule(text, Math.min(index, sheet.cssRules.length));
      return true;
    } catch {
      try {
        sheet.insertRule(text, sheet.cssRules.length);
        return true;
      } catch {
        // Rules the replay browser cannot parse (vendor prefixes) are skipped, as the original browser would have rejected them too if they differed.
        return false;
      }
    }
  }

  deleteRule(id: NodeId, index: number) {
    const sheet = this.sheetOf(id);
    if (sheet && index < sheet.cssRules.length) sheet.deleteRule(index);
  }

  private sheetOf(id: NodeId): CSSStyleSheet | null {
    const el = this.nodes.get(id) as HTMLStyleElement | undefined;
    return (el && (el as HTMLStyleElement).sheet) || null;
  }

  adopt(id: NodeId, sheets: string[][]) {
    if (id === DOCUMENT_ID) {
      this.adoptInto(this.doc, sheets);
      return;
    }
    const host = this.nodes.get(id) as Element | undefined;
    const root = host && host.nodeType === Node.ELEMENT_NODE ? this.shadowOf(host) : null;
    if (root) this.adoptInto(root, sheets);
  }

  private adoptInto(target: Document | ShadowRoot, sheets: string[][]) {
    const view = this.doc.defaultView as (Window & typeof globalThis) | null;
    if (!view) return;
    const list: CSSStyleSheet[] = [];
    for (const rules of sheets) {
      try {
        const sheet = new view.CSSStyleSheet();
        sheet.replaceSync(transformCss(rules.join("\n"), this.base));
        list.push(sheet);
      } catch {
        /* unsupported */
      }
    }
    try {
      target.adoptedStyleSheets = list;
    } catch {
      /* unsupported */
    }
  }

  setInput(id: NodeId, v: string | undefined, c: boolean | undefined) {
    const el = this.nodes.get(id) as HTMLInputElement | undefined;
    if (!el) return false;
    if (c !== undefined) el.checked = c;
    else if (v !== undefined && el.type !== "checkbox" && el.type !== "radio") el.value = v;
    return true;
  }
}

function getComputedStyleSafe(el: Element): string {
  try {
    const view = el.ownerDocument.defaultView;
    return view ? view.getComputedStyle(el).display : "";
  } catch {
    return "";
  }
}
