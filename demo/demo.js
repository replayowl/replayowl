// Shared behaviour for the Owl Outfitters demo shop. Every feature here exists to exercise a recorder path.
(function () {
  "use strict";

  // CSS-in-JS: rules are added only through insertRule, the <style> element text stays empty.
  var cssInJs = document.createElement("style");
  cssInJs.id = "css-in-js";
  document.head.appendChild(cssInJs);
  var sheet = cssInJs.sheet;
  sheet.insertRule(".badge-new { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #2f7d5b; color: #fff; font-size: 12px; font-weight: 600; }", 0);
  sheet.insertRule(".badge-new:hover { background: #1f5a40; }", 1);
  window.addRuntimeRule = function (rule) {
    return sheet.insertRule(rule, sheet.cssRules.length);
  };

  // Document-level constructed stylesheet.
  if ("adoptedStyleSheets" in Document.prototype && typeof CSSStyleSheet.prototype.replaceSync === "function") {
    var docSheet = new CSSStyleSheet();
    docSheet.replaceSync(".adopted-outline { outline: 2px dashed #e8a33d; outline-offset: 4px; }");
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat([docSheet]);
  }

  // Custom element with open shadow root and its own adopted sheet.
  if (!customElements.get("owl-rating")) {
    customElements.define("owl-rating", class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        var root = this.attachShadow({ mode: "open" });
        var s = new CSSStyleSheet();
        s.replaceSync(":host { display: inline-flex; gap: 2px; } button { border: 0; background: none; font-size: 22px; color: #d8c8b0; cursor: pointer; padding: 0 2px; } button.on { color: #e8a33d; } button:hover { transform: scale(1.2); }");
        root.adoptedStyleSheets = [s];
        var value = Number(this.getAttribute("value") || 3);
        for (var i = 1; i <= 5; i++) {
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = "★";
          b.dataset.v = String(i);
          if (i <= value) b.className = "on";
          root.appendChild(b);
        }
        root.addEventListener("click", (e) => {
          var t = e.target;
          if (!t.dataset || !t.dataset.v) return;
          var v = Number(t.dataset.v);
          this.setAttribute("value", String(v));
          root.querySelectorAll("button").forEach(function (btn) {
            btn.className = Number(btn.dataset.v) <= v ? "on" : "";
          });
        });
      }
    });
  }

  // Toasts
  var toastHost = document.createElement("div");
  toastHost.className = "toast-host";
  toastHost.id = "toast-host";
  document.body.appendChild(toastHost);
  window.toast = function (msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    toastHost.appendChild(t);
    setTimeout(function () { t.remove(); }, 2500);
  };

  // Modal
  var modal = document.getElementById("modal");
  document.querySelectorAll("[data-open-modal]").forEach(function (b) {
    b.addEventListener("click", function () { modal && modal.classList.add("open"); });
  });
  document.querySelectorAll("[data-close-modal]").forEach(function (b) {
    b.addEventListener("click", function () { modal && modal.classList.remove("open"); });
  });

  // Tabs
  document.querySelectorAll(".tabs").forEach(function (tabs) {
    tabs.addEventListener("click", function (e) {
      var tab = e.target.closest(".tab");
      if (!tab) return;
      tabs.querySelectorAll(".tab").forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
    });
  });

  // Cart, persisted per tab so it survives page navigation.
  var cartList = document.getElementById("cart-list");
  var CART_KEY = "owl-cart";
  function loadCart() {
    try { return JSON.parse(sessionStorage.getItem(CART_KEY) || "null") || ["Night Vision Lantern", "Feather Down Scarf"]; }
    catch (e) { return []; }
  }
  function saveCart(items) {
    try { sessionStorage.setItem(CART_KEY, JSON.stringify(items)); } catch (e) { /* ignore */ }
  }
  function renderCart() {
    var items = loadCart();
    document.querySelectorAll(".cart-count").forEach(function (el) { el.textContent = String(items.length); });
    if (!cartList) return;
    cartList.textContent = "";
    items.forEach(function (name, i) {
      var li = document.createElement("li");
      li.id = "cart-item-" + i;
      li.innerHTML = "<span></span><button class=\"btn secondary\" type=\"button\" data-remove=\"" + i + "\">Remove</button>";
      li.firstChild.textContent = name;
      cartList.appendChild(li);
    });
  }
  window.addToCart = function (name) {
    var items = loadCart();
    items.push(name);
    saveCart(items);
    renderCart();
    window.toast("Added " + name + " to cart");
  };
  document.addEventListener("click", function (e) {
    var add = e.target.closest("[data-add]");
    if (add) window.addToCart(add.getAttribute("data-add"));
    var rm = e.target.closest("[data-remove]");
    if (rm) {
      var items = loadCart();
      items.splice(Number(rm.getAttribute("data-remove")), 1);
      saveCart(items);
      renderCart();
    }
  });
  var reorder = document.getElementById("cart-reorder");
  if (reorder) reorder.addEventListener("click", function () {
    var items = loadCart();
    if (items.length > 1) items.unshift(items.pop());
    saveCart(items);
    // Move the existing node instead of re-rendering, so a DOM move is recorded.
    if (cartList && cartList.lastElementChild) cartList.insertBefore(cartList.lastElementChild, cartList.firstElementChild);
  });
  var highlight = document.getElementById("cart-highlight");
  if (highlight) highlight.addEventListener("click", function () {
    var first = cartList && cartList.firstElementChild;
    if (first) first.classList.toggle("highlight");
  });
  renderCart();

  // Uncaught error plus console.error, for log capture.
  var buggy = document.getElementById("buggy-btn");
  if (buggy) buggy.addEventListener("click", function () {
    console.error("Payment widget failed to load", { code: 502 });
    setTimeout(function () { throw new Error("Demo crash: undefined is not a function"); }, 0);
  });
})();
