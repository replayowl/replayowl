// Wire format shared by the recorder, the ingestion server and the player.
//
// A session is an ordered list of events. Every page load inside the session starts with a
// `meta` event followed by a `snapshot`; everything after that until the next `meta` is an
// incremental change to that page. All nodes are addressed by numeric ids assigned by the
// recorder, so the player never has to guess elements from selectors.

export const PROTOCOL_VERSION = 1;

/** Id 0 is reserved for "the page viewport" (window scroll, document-level sheets). */
export const DOCUMENT_ID = 0;

export type NodeId = number;

export interface SerializedElement {
  id: NodeId;
  type: 1;
  tag: string;
  attrs: Record<string, string>;
  children: SerializedNode[];
  /** Namespace when not XHTML (svg, mathml). */
  ns?: string;
  /** Children of an open shadow root attached to this element. */
  shadow?: SerializedNode[];
  /** Constructed stylesheets adopted by the shadow root, one rule list per sheet. */
  shadowSheets?: string[][];
  /** Live form state that is not reflected in attributes. */
  value?: string;
  checked?: boolean;
  /** Full CSS text for <link rel=stylesheet> and CSSOM-built <style> elements. */
  css?: string;
  /** Element is blocked by privacy rules; the player renders a placeholder of this size. */
  blocked?: { w: number; h: number };
}

export interface SerializedText {
  id: NodeId;
  type: 3 | 8;
  text: string;
}

export interface SerializedDoctype {
  id: NodeId;
  type: 10;
  name: string;
  publicId: string;
  systemId: string;
}

/** A node the player already knows, moved to a new position. */
export interface SerializedRef {
  id: NodeId;
  type: 0;
}

export type SerializedNode = SerializedElement | SerializedText | SerializedDoctype | SerializedRef;

export interface Snapshot {
  /** Doctype source, parsed first so the replay renders in the same mode as the original. */
  doctype: string;
  children: SerializedNode[];
  /** Constructed stylesheets adopted by the document. */
  sheets?: string[][];
}

export interface AddedNode {
  /** Parent node id. */
  p: NodeId;
  /** Previous sibling id, null when the node is the first child. */
  prev: NodeId | null;
  /** True when inserted into the shadow root of the parent. */
  sr?: boolean;
  node: SerializedNode;
}

export interface MutationData {
  /** Removed node ids. */
  rm?: NodeId[];
  /** Added or moved nodes, parents before children. */
  add?: AddedNode[];
  /** Attribute changes, null value means removed. */
  attr?: { id: NodeId; a: Record<string, string | null> }[];
  /** Character data changes. */
  text?: { id: NodeId; v: string }[];
  /** Stylesheet text for <link> elements that finished loading, or <style> sheets rebuilt in the CSSOM. */
  css?: { id: NodeId; v: string }[];
}

interface Base {
  /** Wall clock milliseconds. */
  ts: number;
}

/** Set on events that no recent user input explains, so page script caused them. */
interface Auto {
  auto?: true;
}

export interface MetaEvent extends Base {
  k: "meta";
  url: string;
  title: string;
  w: number;
  h: number;
  ua: string;
  /** Page view id, unique per page load. */
  view: string;
  /** User id given to identify() earlier in this session, carried into later page loads. */
  uid?: string;
}
export interface SnapshotEvent extends Base { k: "snapshot"; snap: Snapshot }
export interface MutationEvent extends Base { k: "mutation"; m: MutationData }
export interface MoveEvent extends Base { k: "move"; x: number; y: number }
export interface ClickEvent extends Base { k: "click"; x: number; y: number; id: NodeId | null; label?: string }
export interface ScrollEvent extends Base, Auto { k: "scroll"; id: NodeId; x: number; y: number }
export interface InputEvent extends Base, Auto {
  k: "input";
  id: NodeId;
  v?: string;
  c?: boolean;
  masked?: boolean;
  /** Control type when it is not a text field. */
  field?: "select" | "checkbox" | "radio";
}
export interface ResizeEvent extends Base { k: "resize"; w: number; h: number }
export interface CssEvent extends Base {
  k: "css";
  /** Owner <style> or <link> element id. */
  id: NodeId;
  op: "insert" | "delete";
  rule?: string;
  index: number;
}
export interface AdoptEvent extends Base {
  k: "adopt";
  /** DOCUMENT_ID for the document, otherwise the shadow host id. */
  id: NodeId;
  sheets: string[][];
}
export interface MediaEvent extends Base { k: "media"; id: NodeId; op: "play" | "pause"; time: number }
export interface VisibilityEvent extends Base { k: "visibility"; visible: boolean }
export interface FocusEvent extends Base, Auto { k: "focus"; id: NodeId | null }
export interface LogEvent extends Base { k: "log"; level: "error" | "warn" | "info"; msg: string; stack?: string }
/** The site named the signed-in visitor; the whole session is attributed to this id. */
export interface IdentifyEvent extends Base { k: "identify"; uid: string }

export type ReplayEvent =
  | MetaEvent
  | SnapshotEvent
  | MutationEvent
  | MoveEvent
  | ClickEvent
  | ScrollEvent
  | InputEvent
  | ResizeEvent
  | CssEvent
  | AdoptEvent
  | MediaEvent
  | VisibilityEvent
  | FocusEvent
  | LogEvent
  | IdentifyEvent;

export type EventKind = ReplayEvent["k"];

/** Body of POST /api/ingest. */
export interface IngestBatch {
  v: number;
  /** Session id, shared by every page load in one browser tab until it goes idle. */
  sid: string;
  /** Monotonic batch counter per page view, used to drop duplicates on retry. */
  seq: number;
  view: string;
  events: ReplayEvent[];
}

export type Device = "desktop" | "mobile" | "tablet";

/** Summary kept by the server for listing. */
export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  duration: number;
  firstUrl: string;
  lastUrl: string;
  pages: number;
  ua: string;
  device: Device;
  w: number;
  h: number;
  events: number;
  clicks: number;
  rageClicks: number;
  errors: number;
  inputs: number;
  /** Ids given to identify() during the session, at most five. */
  userIds: string[];
}

/** Full session as served to the player. */
export interface SessionData {
  summary: SessionSummary;
  events: ReplayEvent[];
}
