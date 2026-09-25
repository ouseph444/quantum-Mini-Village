/* The smallest DOM that voice.js and board.js actually touch. */
function makeEl(tag) {
  var el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    children: [], parentNode: null, style: {}, dataset: {},
    _attrs: {}, _listeners: {},
    className: "", textContent: "", innerHTML: "", hidden: false,
    muted: false, volume: 1, paused: true, autoplay: false, playsInline: false,
    srcObject: null, src: "",
    classList: {
      _s: {},
      add: function (c) { this._s[c] = 1; },
      remove: function (c) { delete this._s[c]; },
      toggle: function (c, v) { if (v === undefined) v = !this._s[c]; if (v) this._s[c] = 1; else delete this._s[c]; return !!v; },
      contains: function (c) { return !!this._s[c]; }
    },
    setAttribute: function (k, v) { this._attrs[k] = v; },
    getAttribute: function (k) { return this._attrs[k]; },
    removeAttribute: function (k) { delete this._attrs[k]; },
    appendChild: function (c) {
      /* a DocumentFragment hands over its children and leaves empty */
      if (c && c.nodeType === 11) {
        var kids = c.children.slice();
        c.children.length = 0;
        for (var i = 0; i < kids.length; i++) { kids[i].parentNode = this; this.children.push(kids[i]); }
        return c;
      }
      c.parentNode = this; this.children.push(c); return c;
    },
    removeChild: function (c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener: function () {},
    dispatch: function (t, e) { (this._listeners[t] || []).forEach(function (f) { f(e || {}); }); },
    play: function () { this.paused = false; return Promise.resolve(); },
    pause: function () { this.paused = true; },
    load: function () {},
    focus: function () {}, blur: function () {}
  };
  /* the real thing exposes both, and code walks either */
  el.childNodes = el.children;
  /* setting innerHTML empties the element, which is how most of the village
     clears a list before rebuilding it */
  var html = "";
  Object.defineProperty(el, "innerHTML", {
    get: function () { return html; },
    set: function (v) { html = String(v); el.children.length = 0; }
  });
  return el;
}

function install(g) {
  var byId = {};
  g.document = {
    _byId: byId,
    body: makeEl("body"),
    documentElement: makeEl("html"),
    head: makeEl("head"),
    createElement: makeEl,
    createTextNode: function (t) { return { nodeType: 3, textContent: t }; },
    createDocumentFragment: function () { var f = makeEl("frag"); f.nodeType = 11; return f; },
    getElementById: function (id) { return byId[id] || null; },
    addEventListener: function () {},
    readyState: "complete"
  };
  g.window = g;
  g.navigator = { mediaDevices: null, userAgent: "node" };
  g.localStorage = {
    _d: {},
    getItem: function (k) { return k in this._d ? this._d[k] : null; },
    setItem: function (k, v) { this._d[k] = String(v); },
    removeItem: function (k) { delete this._d[k]; }
  };
  g.addEventListener = function () {};
  g.removeEventListener = function () {};
  g.Audio = function () { return makeEl("audio"); };
  g.AudioContext = null;
  g.URL = { createObjectURL: function () { return "blob:x"; } };
  g.makeEl = makeEl;
  g.mount = function (id) { var e = makeEl("div"); byId[id] = e; return e; };
  return g;
}
module.exports = { install: install, makeEl: makeEl };
