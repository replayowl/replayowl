// Privacy rules applied before anything leaves the page.
//
// - Form fields are masked by default. `data-ro-unmask` on the field (or an ancestor) opts it in,
//   except for fields that are always sensitive (passwords, card data, credentials).
// - `data-ro-mask` masks all text and text-like attributes in a subtree.
// - `data-ro-block` replaces an element with a same-size placeholder; nothing inside is recorded.
// - Outside those, emails and card-like digit runs are masked inside plain text.
// Masking keeps the length of every word so the replayed layout does not shift.

export interface PrivacyOptions {
  maskAllInputs: boolean;
  maskAllText: boolean;
  maskEmails: boolean;
  maskCardNumbers: boolean;
  maskDigits: boolean;
}

export const DEFAULT_PRIVACY: PrivacyOptions = {
  maskAllInputs: true,
  maskAllText: false,
  maskEmails: true,
  maskCardNumbers: true,
  maskDigits: false,
};

const MASK_ATTR = "data-ro-mask";
const UNMASK_ATTR = "data-ro-unmask";
const BLOCK_ATTR = "data-ro-block";

const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "range", "color", "file", "hidden"]);

// Field names and autocomplete tokens that are masked even when the page opts the field in.
const ALWAYS_SENSITIVE = [
  "password", "passwd", "pwd", "pass", "passcode", "pin", "secret", "token", "otp", "totp", "mfa",
  "ssn", "socialsecurity", "taxid", "iban", "bic", "swift", "routing", "accountnumber", "sortcode",
  "cc", "ccnum", "ccnumber", "cardnumber", "creditcard", "cvc", "cvv", "csc", "ccexp", "expiry", "expdate",
  "kennwort", "passwort", "motdepasse", "contrasena", "senha", "parola", "wachtwoord", "haslo", "heslo", "salasana",
];
const ALWAYS_SENSITIVE_RE = new RegExp("(" + ALWAYS_SENSITIVE.join("|") + ")", "i");
const AUTOCOMPLETE_SENSITIVE_RE = /^(cc-|current-password|new-password|one-time-code)/i;

const EMAIL_RE = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[A-Za-z]{2,}/g;
// 12 to 19 digits with optional single separators: card numbers, IBAN tails, long account ids.
const CARD_RE = /\b\d(?:[ -]?\d){11,18}\b/g;
const DIGITS_RE = /\d+/g;

const maskWordChars = (s: string): string => s.replace(/\S/g, "*");

export class Privacy {
  readonly opts: PrivacyOptions;

  constructor(opts: Partial<PrivacyOptions> = {}) {
    this.opts = { ...DEFAULT_PRIVACY, ...opts };
  }

  isBlocked(el: Element): boolean {
    return el.hasAttribute(BLOCK_ATTR);
  }

  /** True when text inside `el` must be fully masked. */
  isTextMasked(el: Element | null): boolean {
    if (this.opts.maskAllText) return true;
    return !!el && !!closestComposed(el, "[" + MASK_ATTR + "]");
  }

  isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || "text").toLowerCase());
  }

  /** Whether the value of a form control must be masked. Choice controls and selects are kept. */
  isValueMasked(el: Element): boolean {
    if (!this.isTextField(el)) return this.isTextMasked(el);
    if (this.isAlwaysSensitive(el)) return true;
    if (closestComposed(el, "[" + UNMASK_ATTR + "]")) return this.isTextMasked(el);
    return this.opts.maskAllInputs || this.isTextMasked(el);
  }

  private isAlwaysSensitive(el: HTMLInputElement | HTMLTextAreaElement): boolean {
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "password") return true;
    const auto = el.getAttribute("autocomplete") || "";
    if (AUTOCOMPLETE_SENSITIVE_RE.test(auto)) return true;
    const key = ((el.getAttribute("name") || "") + " " + (el.id || "")).replace(/[\s_-]+/g, "");
    return ALWAYS_SENSITIVE_RE.test(key);
  }

  maskValue(el: Element, value: string): string {
    if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "password") return value ? "********" : "";
    return maskWordChars(value);
  }

  /** Text node content as it should be recorded. */
  text(text: string, parent: Element | null): string {
    if (!text || !text.trim()) return text;
    if (parent) {
      const tag = parent.tagName;
      if (tag === "STYLE" || tag === "SCRIPT") return text;
      if (tag === "TEXTAREA" && this.isValueMasked(parent)) return maskWordChars(text);
    }
    if (this.isTextMasked(parent)) return maskWordChars(text);
    return this.scrub(text);
  }

  /** Masks PII patterns inside otherwise visible text. */
  scrub(text: string): string {
    let out = text;
    if (this.opts.maskEmails && out.indexOf("@") >= 0) out = out.replace(EMAIL_RE, maskWordChars);
    if (this.opts.maskDigits) out = out.replace(DIGITS_RE, maskWordChars);
    else if (this.opts.maskCardNumbers) out = out.replace(CARD_RE, (m) => m.replace(/\d/g, "*"));
    return out;
  }

  /** Attribute value as it should be recorded, or null to drop it. */
  attribute(el: Element, name: string, value: string): string | null {
    if (name === "value" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      return this.isValueMasked(el) ? this.maskValue(el, value) : value;
    }
    if (name === "title" || name === "alt" || name === "placeholder" || name === "aria-label") {
      return this.isTextMasked(el) ? maskWordChars(value) : this.scrub(value);
    }
    if (el.tagName === "OPTION" && (name === "label" || name === "value")) {
      return this.isTextMasked(el) ? maskWordChars(value) : value;
    }
    return value;
  }
}

/** Element.closest that also walks out of shadow roots. */
export function closestComposed(el: Element, selector: string): Element | null {
  let node: Element | null = el;
  while (node) {
    const hit: Element | null = node.closest(selector);
    if (hit) return hit;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}
