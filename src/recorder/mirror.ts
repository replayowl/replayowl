// DOM serialization and incremental change tracking.
//
// Each recorded node gets a numeric id that never changes while the page lives. The snapshot
// serializes the whole tree; afterwards MutationObserver batches are reduced to the final state
// of the batch: removed ids, added or moved subtrees (in document order), attribute and text edits.

import type { AddedNode, MutationData, NodeId, SerializedElement, SerializedNode, Snapshot } from "../shared/protocol.ts";
import type { Privacy } from "./privacy.ts";
import { inlineCss, readAdopted, readStyleElementCss } from "./css.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Elements whose children are never recorded. */
const OPAQUE_TAGS = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE"]);

export interface MirrorHooks {
  onMutation(m: MutationData): void;
  /** A shadow root was found; the recorder attaches listeners to it. */
  onShadowRoot(root: ShadowRoot): void;
  /** An element whose scroll offset is not zero, found while serializing. */
  onScrolled(el: Element): void;
}

export class Mirror {
  private ids = new WeakMap<Node, NodeId>();
  private nextId = 1;
  private observers: MutationObserver[] = [];
  private privacy: Privacy;
  private hooks: MirrorHooks;
  private pendingLinks = new WeakSet<HTMLLinkElement>();
  /** <style> elements recorded from their CSSOM; their text children are not tracked. */
  private cssomStyles = new WeakSet<HTMLStyleElement>();

  constructor(privacy: Privacy, hooks: MirrorHooks) {
    this.privacy = privacy;
    this.hooks = hooks;
  }

  idOf(node: Node | null | undefined): NodeId | null {
    return (node && this.ids.get(node)) || null;
  }

  has(node: Node): boolean {
    return this.ids.has(node);
  }

  private assign(node: Node): NodeId {
    let id = this.ids.get(node);
    if (!id) {
      id = this.nextId++;
      this.ids.set(node, id);
    }
    return id;
  }

  snapshot(doc: Document): Snapshot {
    const dt = doc.doctype;
    const doctype = dt
      ? "<!DOCTYPE " + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : "") + (dt.systemId ? ' "' + dt.systemId + '"' : "") + ">"
      : "";
    const children: SerializedNode[] = [];
    doc.childNodes.forEach((c) => {
      const s = this.serialize(c);
      if (s) children.push(s);
    });
    this.observe(doc);
    const snap: Snapshot = { doctype, children };
    const sheets = readAdopted(doc);
    if (sheets.length) snap.sheets = sheets;
    return snap;
  }

  /** Serializes a node and its subtree. Nodes that already have an id become references (moves). */
  serialize(node: Node): SerializedNode | null {
    const known = this.ids.get(node);
    if (known) return { id: known, type: 0 };
    switch (node.nodeType) {
      case Node.DOCUMENT_TYPE_NODE: {
        const dt = node as DocumentType;
        return { id: this.assign(node), type: 10, name: dt.name, publicId: dt.publicId, systemId: dt.systemId };
      }
      case Node.TEXT_NODE:
        return { id: this.assign(node), type: 3, text: this.privacy.text(node.textContent || "", node.parentElement) };
      case Node.COMMENT_NODE:
        // Comments matter as positional anchors for frameworks; their content does not.
        return { id: this.assign(node), type: 8, text: "" };
      case Node.ELEMENT_NODE:
        return this.serializeElement(node as Element);
      default:
        return null;
    }
  }

  private serializeElement(el: Element): SerializedElement {
    const id = this.assign(el);
    const tag = el.tagName;
    const rec: SerializedElement = { id, type: 1, tag: el.namespaceURI === XHTML_NS ? tag.toLowerCase() : tag, attrs: {}, children: [] };
    if (el.namespaceURI && el.namespaceURI !== XHTML_NS) rec.ns = el.namespaceURI;

    if (this.privacy.isBlocked(el)) {
      const r = el.getBoundingClientRect();
      rec.blocked = { w: Math.round(r.width), h: Math.round(r.height) };
      for (const name of ["class", "style", "id"]) {
        const v = el.getAttribute(name);
        if (v !== null) rec.attrs[name] = v;
      }
      return rec;
    }

    for (const attr of Array.from(el.attributes)) {
      const v = this.privacy.attribute(el, attr.name, attr.value);
      if (v !== null) rec.attrs[attr.name] = v;
    }

    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const field = el as HTMLInputElement;
      if (field.type === "checkbox" || field.type === "radio") rec.checked = field.checked;
      else if (field.type !== "file" && field.value) rec.value = this.privacy.isValueMasked(el) ? this.privacy.maskValue(el, field.value) : field.value;
    } else if (tag === "LINK") {
      const css = inlineCss(el as HTMLLinkElement);
      if (css !== null) rec.css = css;
      else this.watchLink(el as HTMLLinkElement);
    } else if (tag === "STYLE") {
      const css = readStyleElementCss(el as HTMLStyleElement);
      if (css !== null) {
        // The CSSOM differs from the text (CSS-in-JS); the rules are the source of truth.
        rec.css = css;
        this.cssomStyles.add(el as HTMLStyleElement);
        return rec;
      }
    } else if (tag === "IMG" && (el as HTMLImageElement).currentSrc && !el.hasAttribute("srcset")) {
      rec.attrs.src = (el as HTMLImageElement).currentSrc;
    }

    if (el.scrollTop || el.scrollLeft) this.hooks.onScrolled(el);

    const shadow = el.shadowRoot;
    if (shadow) {
      rec.shadow = [];
      shadow.childNodes.forEach((c) => {
        const s = this.serialize(c);
        if (s) rec.shadow!.push(s);
      });
      const sheets = readAdopted(shadow);
      if (sheets.length) rec.shadowSheets = sheets;
      this.observe(shadow);
      this.hooks.onShadowRoot(shadow);
    }

    if (!OPAQUE_TAGS.has(tag.toUpperCase())) {
      el.childNodes.forEach((c) => {
        const s = this.serialize(c);
        if (s) rec.children.push(s);
      });
    }
    if (el.namespaceURI === SVG_NS && tag.toLowerCase() === "svg" && !rec.attrs.xmlns) rec.attrs.xmlns = SVG_NS;
    return rec;
  }

  /** Stylesheets that are still loading are inlined once they arrive. */
  private watchLink(link: HTMLLinkElement) {
    if (this.pendingLinks.has(link) || !/stylesheet/i.test(link.rel)) return;
    this.pendingLinks.add(link);
    link.addEventListener("load", () => {
      const id = this.idOf(link);
      const css = inlineCss(link);
      if (id && css !== null) this.hooks.onMutation({ css: [{ id, v: css }] });
    }, { once: true });
  }

  private observed = new WeakSet<Document | ShadowRoot>();

  private observe(root: Document | ShadowRoot) {
    if (this.observed.has(root)) return;
    this.observed.add(root);
    const mo = new MutationObserver((records) => this.process(records));
    mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    this.observers.push(mo);
  }

  disconnect() {
    for (const mo of this.observers) mo.disconnect();
    this.observers = [];
    this.unpatch();
  }

  private unpatch = () => {};

  /** Shadow roots attached to already recorded elements (late custom element upgrades) are observed from the start. */
  watchShadowRoots() {
    const native = Element.prototype.attachShadow;
    const self = this;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = native.call(this, init);
      if (init.mode === "open" && self.has(this)) {
        self.observe(root);
        self.hooks.onShadowRoot(root);
      }
      return root;
    };
    this.unpatch = () => {
      Element.prototype.attachShadow = native;
    };
  }

  /** Parent id and shadow flag for a node's current position, or null when it is not recordable. */
  private placement(node: Node): { p: NodeId; sr: boolean } | null {
    const parent = node.parentNode;
    if (!parent) return null;
    if (parent instanceof ShadowRoot) {
      const id = this.idOf(parent.host);
      return id ? { p: id, sr: true } : null;
    }
    const id = this.idOf(parent);
    if (!id) return null;
    if (parent.nodeType === Node.ELEMENT_NODE) {
      const el = parent as Element;
      if (OPAQUE_TAGS.has(el.tagName.toUpperCase())) return null;
      if (this.privacy.isBlocked(el)) return null;
      if (el.tagName === "STYLE" && this.cssomStyles.has(el as HTMLStyleElement)) return null;
    }
    return { p: id, sr: false };
  }


  private process(records: MutationRecord[]) {
    const removed = new Set<Node>();
    const added = new Set<Node>();
    const attrs = new Map<Element, Set<string>>();
    const texts = new Set<Node>();
    for (const r of records) {
      if (r.type === "childList") {
        r.removedNodes.forEach((n) => removed.add(n));
        r.addedNodes.forEach((n) => added.add(n));
      } else if (r.type === "attributes") {
        const el = r.target as Element;
        let set = attrs.get(el);
        if (!set) attrs.set(el, (set = new Set()));
        set.add(r.attributeName!);
      } else if (r.type === "characterData") {
        texts.add(r.target);
      }
    }

    const m: MutationData = {};
    const rm: NodeId[] = [];
    for (const n of removed) {
      const id = this.idOf(n);
      if (id && !n.isConnected) rm.push(id);
    }

    // Nodes new to the recorder in this batch, used to skip descendants covered by an ancestor.
    const fresh = new Set<Node>();
    const candidates: Node[] = [];
    for (const n of added) {
      if (!n.isConnected || !this.placement(n)) continue;
      candidates.push(n);
      if (!this.has(n)) fresh.add(n);
    }
    const covered = (n: Node) => {
      for (let p = composedParent(n); p; p = composedParent(p)) if (fresh.has(p)) return true;
      return false;
    };
    const roots = candidates.filter((n) => !covered(n));
    roots.sort(documentOrder);

    const add: AddedNode[] = [];
    const created = new Set<Node>();
    for (const n of roots) {
      const place = this.placement(n);
      if (!place) continue;
      const wasNew = !this.has(n);
      const node = this.serialize(n);
      if (!node) continue;
      if (wasNew) markSubtree(n, created);
      add.push({ p: place.p, prev: this.prevId(n), ...(place.sr ? { sr: true } : {}), node });
    }

    const attr: NonNullable<MutationData["attr"]> = [];
    for (const [el, names] of attrs) {
      const id = this.idOf(el);
      if (!id || created.has(el) || !el.isConnected) continue;
      const a: Record<string, string | null> = {};
      const blocked = this.privacy.isBlocked(el);
      for (const name of names) {
        if (blocked && name !== "class" && name !== "style" && name !== "id") continue;
        const v = el.getAttribute(name);
        a[name] = v === null ? null : this.privacy.attribute(el, name, v);
      }
      attr.push({ id, a });
    }

    const text: NonNullable<MutationData["text"]> = [];
    for (const n of texts) {
      const id = this.idOf(n);
      if (!id || created.has(n) || !n.isConnected) continue;
      text.push({ id, v: this.privacy.text(n.textContent || "", n.parentElement) });
    }

    if (rm.length) m.rm = rm;
    if (add.length) m.add = add;
    if (attr.length) m.attr = attr;
    if (text.length) m.text = text;
    if (m.rm || m.add || m.attr || m.text) this.hooks.onMutation(m);
  }

  /** Nearest previous sibling the player knows about. */
  private prevId(n: Node): NodeId | null {
    for (let s = n.previousSibling; s; s = s.previousSibling) {
      const id = this.idOf(s);
      if (id) return id;
    }
    return null;
  }
}

function composedParent(n: Node): Node | null {
  const p = n.parentNode;
  return p instanceof ShadowRoot ? p.host : p;
}

function markSubtree(n: Node, into: Set<Node>) {
  into.add(n);
  n.childNodes.forEach((c) => markSubtree(c, into));
  if (n instanceof Element && n.shadowRoot) n.shadowRoot.childNodes.forEach((c) => markSubtree(c, into));
}

function shadowDepth(n: Node): number {
  let d = 0;
  for (let r = n.getRootNode(); r instanceof ShadowRoot; r = r.host.getRootNode()) d++;
  return d;
}

const hostOf = (n: Node): Element => (n.getRootNode() as ShadowRoot).host;

/** Preorder comparison that also works across shadow boundaries (hosts come before their shadow content). */
function documentOrder(a: Node, b: Node): number {
  if (a === b) return 0;
  if (a.getRootNode() === b.getRootNode()) {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }
  if (shadowDepth(a) >= shadowDepth(b)) {
    const c = documentOrder(hostOf(a), b);
    return c === 0 ? 1 : c;
  }
  const c = documentOrder(a, hostOf(b));
  return c === 0 ? -1 : c;
}
