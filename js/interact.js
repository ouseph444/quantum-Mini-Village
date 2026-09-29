/* Quantum Village — player interaction.
 *
 * One registry for everything the player can act on: doors, papers, chairs,
 * blackboards, platforms. Each frame it works out the best candidate near
 * the player, shows a prompt for it, and routes E (or the touch button, or a
 * tap on the object itself) to that one thing.
 *
 * Registering an interactable:
 *   QVInteract.add({ id, x, z, r, label, verb, onUse, onNear, object })
 *
 * A source can also answer dynamically — rooms.js does, because whether a
 * chair says "sit" or "stand" depends on what you are already doing. Those
 * go in through QVInteract.source(fn).
 */
(function () {
  "use strict";
  var api = {};
  var items = [], sources = [];
  var best = null, bestSource = null, hovered = null;
  var el = null, touchBtn = null;
  var enabled = true;

  api.add = function (o) {
    o.r = o.r || 5;
    items.push(o);
    return o;
  };
  api.remove = function (id) {
    for (var i = items.length - 1; i >= 0; i--) if (items[i].id === id) items.splice(i, 1);
  };
  /* A dynamic source returns {label, key, act, verb, weight} or null. */
  api.source = function (fn) { sources.push(fn); };
  api.all = function () { return items; };
  api.setEnabled = function (v) { enabled = v; if (!v) show(null); };
  api.enabled = function () { return enabled; };

  api.wire = function (opts) {
    el = document.getElementById("enter");
    touchBtn = document.getElementById("act-btn");
    api.opts = opts || {};
    if (touchBtn) {
      touchBtn.addEventListener("click", function (e) {
        e.preventDefault();
        api.use();
      });
    }
  };

  /* --------------------------------------------------------------- pick */
  var lastSig = "";
  api.update = function (px, pz) {
    if (!enabled) return;
    var pick = null, from = null, bd = 1e9;

    /* Dynamic sources win: they know about state — whether a chair means
       "sit" or "stand" — and the static list does not. */
    for (var s = 0; s < sources.length; s++) {
      var r = null;
      try { r = sources[s](px, pz); } catch (e) { r = null; }
      if (r) { pick = r; from = "source"; break; }
    }

    /* One pass: update every item's near flag, and keep the closest. */
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var dx = px - it.x, dz = pz - it.z;
      var d2 = dx * dx + dz * dz;
      var near = d2 <= it.r * it.r;
      if (near !== !!it.near) { it.near = near; if (it.onNear) it.onNear(near); }
      /* pickR, when set, is how far away the object may still be clicked.
         Without it a blackboard could be clicked through three walls from
         the other side of the village, because the hover raycast only tests
         the objects that registered — nothing occludes them. */
      it.pickable = it.pickR == null ? true : d2 <= it.pickR * it.pickR;
      if (!pick && near && d2 < bd) { bd = d2; pick = it; from = "item"; }
    }

    best = pick; bestSource = from;
    /* Dynamic sources hand back a fresh object every frame, so compare what
       the prompt actually says rather than object identity — otherwise this
       rewrites the DOM sixty times a second for no reason. */
    var sig = pick ? [pick.id || "", pick.act || "", pick.label || "", pick.key == null ? "E" : pick.key,
                      pick.alt ? pick.alt.act : ""].join("|") : "";
    if (sig !== lastSig) { lastSig = sig; show(pick); }
  };

  function show(pick) {
    if (!el) return;
    if (!pick) {
      el.classList.remove("on");
      el.innerHTML = "";
      if (touchBtn) { touchBtn.classList.remove("on"); touchBtn.setAttribute("aria-hidden", "true"); }
      var b = document.getElementById("btn-enter");
      if (b) b.classList.remove("on");
      return;
    }
    var key = pick.key == null ? "E" : pick.key;
    var label = pick.label || ("Use " + (pick.verb || "this"));
    el.innerHTML = (key ? '<span class="ekey">' + key + "</span>" : "") +
      '<span class="elines"><span class="etxt">' + escape_(label) + "</span>" +
      (pick.alt ? '<span class="ealt"><b>' + escape_(pick.alt.key) + "</b> " + escape_(pick.alt.label) + "</span>" : "") +
      "</span>";
    el.classList.add("on");
    if (touchBtn) {
      touchBtn.classList.add("on");
      touchBtn.removeAttribute("aria-hidden");
      var lab = touchBtn.querySelector(".act-label");
      if (lab) lab.textContent = label;
    }
    var be = document.getElementById("btn-enter");
    if (be) be.classList.add("on");
  }
  function escape_(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }

  /* --------------------------------------------------------------- act */
  api.use = function () {
    if (!best || !enabled) return false;
    if (bestSource === "source") {
      if (api.opts && api.opts.onSourceAct) api.opts.onSourceAct(best);
      return true;
    }
    if (best.onUse) { best.onUse(best); return true; }
    return false;
  };
  /* The secondary action, when a prompt offers one (Q by default). */
  api.useAlt = function () {
    if (!best || !best.alt || !enabled) return false;
    if (api.opts && api.opts.onSourceAct) api.opts.onSourceAct(best.alt);
    return true;
  };
  api.current = function () { return best; };

  /* -------------------------------------------------------- mouse hover */
  /* Hover and click work on anything that registered a 3D object. */
  api.hover = function (raycaster) {
    /* One intersectObjects call over everything clickable, rather than one
       raycast per item — this runs off pointermove. */
    var objs = [], owner = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.object || !it.object.visible || it.pickable === false) continue;
      objs.push(it.object); owner.push(it);
    }
    var hit = null;
    if (objs.length) {
      var res = raycaster.intersectObjects(objs, true);
      if (res.length) {
        var o = res[0].object;
        while (o && owner.length) {
          var k = objs.indexOf(o);
          if (k >= 0) { hit = owner[k]; break; }
          o = o.parent;
        }
      }
    }
    if (hit !== hovered) {
      if (hovered && hovered.onHover) hovered.onHover(false);
      hovered = hit;
      if (hovered && hovered.onHover) hovered.onHover(true);
      document.body.style.cursor = hovered ? "pointer" : "";
    }
    return hovered;
  };
  api.clickAt = function (raycaster) {
    var hit = api.hover(raycaster);
    if (hit && hit.onUse) { hit.onUse(hit); return true; }
    return false;
  };

  window.QVInteract = api;
})();
