/* Quantum Village — interactive papers.
 *
 * Every paper icon in the world stands for an arXiv archive. Pressing E or
 * clicking one opens a panel *inside the page*: the game keeps running
 * behind it and one button puts you back.
 *
 * The panel has two sides:
 *   Reading room   records from the village's own index for that archive.
 *                  Always works, needs no network, and is the default.
 *   arXiv listing  the live archive page in a frame. Many sites refuse to
 *                  be framed (X-Frame-Options / frame-ancestors); when that
 *                  happens we notice and say so rather than showing a blank
 *                  rectangle.
 *
 * To add an archive, add a row to ARCHIVES. Placement is automatic: campus.js
 * publishes the spots, and they are dealt out round-robin.
 */
(function () {
  "use strict";
  var T = window.THREE;
  var V = window.QV;

  /* ---------------------------------------------------------- registry */
  var ARCHIVES = [
    { id:"hep-ph",   name:"High Energy Physics — Phenomenology",
      url:"https://arxiv.org/archive/hep-ph",   match:["hep-ph"],      hue:0x4FA8B8,
      blurb:"Where the Lagrangian meets the detector." },
    { id:"hep-th",   name:"High Energy Physics — Theory",
      url:"https://arxiv.org/archive/hep-th",   match:["hep-th"],      hue:0x7C93C8,
      blurb:"Amplitudes, strings, holography, the machinery under everything." },
    { id:"astro-ph", name:"Astrophysics",
      url:"https://arxiv.org/archive/astro-ph", match:["astro-ph"],    hue:0x5F9CC0,
      blurb:"The sky as a laboratory, from the CMB to the highest energies." },
    { id:"gr-qc",    name:"General Relativity & Quantum Cosmology",
      url:"https://arxiv.org/archive/gr-qc",    match:["gr-qc"],       hue:0x6FB06B,
      blurb:"Gravitational waves, black holes, and the hard parts of gravity." },
    { id:"hep-ex",   name:"High Energy Physics — Experiment",
      url:"https://arxiv.org/archive/hep-ex",   match:["hep-ex","coll"], hue:0xD68A4A,
      blurb:"What the machines actually saw." },
    { id:"quant-ph", name:"Quantum Physics",
      url:"https://arxiv.org/archive/quant-ph", match:["quant-ph"],    hue:0x9888CC,
      blurb:"Information, measurement, and the experiments that sharpen them." },
    { id:"nucl-th",  name:"Nuclear Theory",
      url:"https://arxiv.org/archive/nucl-th",  match:["nucl-th"],     hue:0xC0A055,
      blurb:"Dense matter, heavy ions, and the equation of state." },
    { id:"cond-mat", name:"Condensed Matter",
      url:"https://arxiv.org/archive/cond-mat", match:["cond-mat"],    hue:0x5FB8A0,
      blurb:"Emergence, and the many-body problem in all its disguises." },
    { id:"physics",  name:"Physics (instrumentation & general)",
      url:"https://arxiv.org/archive/physics",  match:["physics"],     hue:0xC08A5F,
      blurb:"Detectors, accelerators, optics, and the craft of measurement." },
    { id:"math-ph",  name:"Mathematical Physics",
      url:"https://arxiv.org/archive/math-ph",  match:["math-ph"],     hue:0xA898D8,
      blurb:"Where the proofs live." }
  ];
  var byId = {};
  ARCHIVES.forEach(function (a) { byId[a.id] = a; });

  var api = { ARCHIVES: ARCHIVES };
  var icons = [], group = null, hooks = {};
  var current = null, lastFocus = null;

  /* ----------------------------------------------------------- the icon */
  var texCache = {};
  function pageTex(arch) {
    if (texCache[arch.id]) return texCache[arch.id];
    var c = document.createElement("canvas"); c.width = 192; c.height = 248;
    var g = c.getContext("2d");
    g.fillStyle = "#F8F3E6"; g.fillRect(0, 0, 192, 248);
    var hex = "#" + arch.hue.toString(16).padStart(6, "0");
    g.fillStyle = hex; g.fillRect(0, 0, 192, 26);
    g.fillStyle = "#FFFFFF"; g.font = "600 15px Arial, sans-serif";
    g.fillText(arch.id, 10, 19);
    g.fillStyle = "#2E3A36"; g.font = "600 13px Georgia, serif";
    g.fillText("arXiv listing", 10, 48);
    g.fillStyle = "#9AA49E";
    for (var i = 0; i < 11; i++) {
      g.fillRect(10, 64 + i * 14, 120 + Math.sin(i * 2.1) * 48, 5);
    }
    g.fillStyle = hex; g.fillRect(10, 218, 60, 6);
    var tex = new T.CanvasTexture(c); tex.anisotropy = 4;
    return (texCache[arch.id] = tex);
  }

  function makeIcon(arch) {
    var g = new T.Group();
    /* a small reading stand */
    V.cy(g, 0.26, 0.38, 1.5, V.color(0x7A5836), 0, 0.75, 0, 8);
    V.bx(g, 1.5, 0.12, 1.0, V.color(0x9C7448), 0, 1.5, 0);
    /* the page, tilted up to be read */
    var page = V.panel(g, 1.25, 1.6, new T.MeshBasicMaterial({
      map: pageTex(arch), side: T.DoubleSide, transparent: true
    }), 0, 2.25, 0.16);
    page.rotation.x = -0.34;
    /* a halo that answers when you get close */
    var halo = new T.Mesh(V.U.torus(), new T.MeshBasicMaterial({
      color: arch.hue, transparent: true, opacity: 0.0
    }));
    halo.scale.set(1.25, 1.25, 1.25);
    halo.position.y = 2.2;
    g.add(halo);
    var glow = V.ci(g, 1.5, V.flat(arch.hue, 0.0), 0, 0.04, 0, 18);
    return { g: g, page: page, halo: halo, glow: glow };
  }

  /* ------------------------------------------------------------- build */
  api.build = function (h) {
    hooks = h || {};
    group = new T.Group();
    V.getRoot().add(group);
    var spots = V.PAPER_SPOTS || [];
    spots.forEach(function (spot, i) {
      var arch = ARCHIVES[i % ARCHIVES.length];
      var made = makeIcon(arch);
      made.g.position.set(spot.x, 0, spot.z);
      made.g.rotation.y = spot.ry || 0;
      group.add(made.g);
      var rec = {
        id: "paper-" + i, arch: arch, x: spot.x, z: spot.z, where: spot.where,
        g: made.g, page: made.page, halo: made.halo, glow: made.glow, k: 0
      };
      icons.push(rec);
      if (window.QVInteract) {
        window.QVInteract.add({
          id: rec.id, x: spot.x, z: spot.z, r: 4.4, kind: "paper",
          label: "Read " + arch.id, verb: "read paper",
          object: made.g,
          onUse: function () { api.open(arch.id); },
          onNear: function (near) { rec.near = near; }
        });
      }
    });
    api.count = icons.length;
    return icons.length;
  };

  /* Icons bob, turn to face you, and brighten when you are close enough
     to read them. Cheap: only the ones nearby are touched. */
  api.update = function (dt, playerPos, camera) {
    if (!icons.length) return;
    var now = performance.now() * 0.001;
    for (var i = 0; i < icons.length; i++) {
      var ic = icons[i];
      var dx = ic.x - playerPos.x, dz = ic.z - playerPos.z;
      var far = Math.abs(dx) + Math.abs(dz);
      ic.g.visible = far < 150;
      if (!ic.g.visible) continue;
      var want = ic.near ? 1 : 0;
      ic.k += (want - ic.k) * Math.min(1, dt * 6);
      ic.halo.material.opacity = 0.25 + ic.k * 0.6;
      ic.halo.rotation.z = now * (0.6 + ic.k * 1.6);
      ic.halo.rotation.x = Math.PI / 2;
      ic.glow.material.opacity = 0.06 + ic.k * 0.3;
      ic.page.position.y = 2.25 + Math.sin(now * 1.5 + i) * 0.06 + ic.k * 0.12;
    }
  };

  /* Which icon is under this screen point, if any. */
  api.pick = function (raycaster) {
    if (!group) return null;
    var hits = raycaster.intersectObject(group, true);
    if (!hits.length) return null;
    var o = hits[0].object;
    while (o && o.parent !== group) o = o.parent;
    if (!o) return null;
    for (var i = 0; i < icons.length; i++) if (icons[i].g === o) return icons[i];
    return null;
  };

  /* ============================================================== panel */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }

  /* Records from the village index that belong to this archive. */
  function localRecords(arch) {
    var topics = window.QC_TOPICS || [], papers = window.QC_PAPERS || [];
    var ids = {};
    topics.forEach(function (t) {
      var a = t.arch || "";
      for (var i = 0; i < arch.match.length; i++) {
        var m = arch.match[i];
        if (a === m || a.indexOf(m + ".") === 0 || t.id === m) { ids[t.id] = 1; break; }
      }
    });
    return papers.filter(function (p) { return ids[p.t]; });
  }

  var frameTimer = null;

  api.open = function (archId) {
    var arch = byId[archId] || ARCHIVES[0];
    var modal = $("paper-modal");
    if (!modal) { window.open(arch.url, "_blank", "noopener"); return; }
    current = arch;
    lastFocus = document.activeElement;

    $("pm-eyebrow").textContent = "arXiv archive";
    $("pm-title").textContent = arch.name;
    $("pm-blurb").textContent = arch.blurb;
    var link = $("pm-open");
    link.href = arch.url;
    modal.hidden = false;
    modal.classList.add("on");
    document.body.classList.add("modal-open");
    setTab("reading");
    var close = $("pm-close");
    if (close) close.focus();
    if (hooks.onOpen) hooks.onOpen(arch);
  };

  api.close = function () {
    var modal = $("paper-modal");
    if (!modal || modal.hidden) return false;
    modal.classList.remove("on");
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    clearTimeout(frameTimer);
    var f = $("pm-frame");
    if (f) f.src = "about:blank";
    current = null;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    if (hooks.onClose) hooks.onClose();
    return true;
  };
  api.isOpen = function () { var m = $("paper-modal"); return !!m && !m.hidden; };
  api.current = function () { return current; };

  function setTab(which) {
    var arch = current; if (!arch) return;
    var tabs = document.querySelectorAll("#pm-tabs button");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("on", tabs[i].dataset.tab === which);
    var reading = $("pm-reading"), listing = $("pm-listing");
    reading.hidden = which !== "reading";
    listing.hidden = which !== "listing";
    if (which === "reading") renderReading(arch);
    else loadFrame(arch);
  }

  function renderReading(arch) {
    var recs = localRecords(arch);
    var box = $("pm-reading");
    if (!recs.length) {
      box.innerHTML = '<p class="fine">The village index has nothing filed under ' + esc(arch.id) +
        " yet. The listing tab goes to the archive itself.</p>";
      return;
    }
    recs = recs.slice(0, 40);
    box.innerHTML =
      '<p class="fine">' + recs.length + " record" + (recs.length === 1 ? "" : "s") +
      " from the village index. Every identifier is a real arXiv entry; the links are derived from it.</p>" +
      recs.map(function (p) {
        return '<article class="rec"><div class="rec-top">' +
          '<span class="tag-pill" style="--c:' + (p.hue || "#4FA8B8") + '">' + esc(p.tname || p.t) + "</span>" +
          '<span class="mono">' + esc(p.i) + '</span><span class="mono when">' + esc(p.when || "") + "</span></div>" +
          "<h4>" + esc(p.n) + "</h4>" +
          '<div class="rec-act">' +
          '<a class="btn small ghost" href="https://arxiv.org/abs/' + esc(p.i) + '" target="_blank" rel="noopener">Abstract</a>' +
          '<a class="btn small ghost" href="https://arxiv.org/pdf/' + esc(p.i) + '" target="_blank" rel="noopener">PDF</a>' +
          "</div></article>";
      }).join("");
  }

  /* Try the live archive in a frame, and be honest when it will not go. */
  function loadFrame(arch) {
    var wrap = $("pm-listing");
    var frame = $("pm-frame"), note = $("pm-note");
    if (!frame) return;
    wrap.classList.remove("blocked");
    note.innerHTML = '<span class="spin"></span> Asking arXiv for the ' + esc(arch.id) + " listing…";
    note.hidden = false;
    frame.classList.remove("ready");

    var settled = false;
    function blocked(why) {
      if (settled) return;
      settled = true;
      clearTimeout(frameTimer);
      wrap.classList.add("blocked");
      note.innerHTML =
        "<b>arXiv will not display inside another page.</b> That is the site's own " +
        "security policy (<code>X-Frame-Options</code>), not a fault here — nothing in the " +
        "village is broken, and the reading room beside this tab still works." +
        '<div class="rec-act" style="margin-top:10px">' +
        '<a class="btn small" href="' + esc(arch.url) + '" target="_blank" rel="noopener">Open ' + esc(arch.id) + ' on arXiv</a>' +
        '<button class="btn small ghost" data-tab="reading">Back to the reading room</button></div>';
      var back = note.querySelector("[data-tab]");
      if (back) back.addEventListener("click", function () { setTab("reading"); });
    }
    function ok() {
      if (settled) return;
      settled = true;
      clearTimeout(frameTimer);
      note.hidden = true;
      frame.classList.add("ready");
    }

    frame.onload = function () {
      /* A cross-origin document that really loaded throws on access, which
         is the signal we want. A frame that was refused stays on about:blank
         and does not throw. */
      try {
        var doc = frame.contentDocument;
        if (doc && (doc.location.href === "about:blank" || !doc.body || !doc.body.childNodes.length)) {
          blocked("empty");
          return;
        }
        ok();
      } catch (e) {
        ok();                          /* cross-origin: it loaded */
      }
    };
    frame.onerror = function () { blocked("error"); };

    clearTimeout(frameTimer);
    frameTimer = setTimeout(function () { blocked("timeout"); }, 5000);
    try { frame.src = arch.url; }
    catch (e) { blocked("src"); }
  }

  /* --------------------------------------------------------------- wire */
  api.wire = function () {
    var modal = $("paper-modal");
    if (!modal) return;
    /* start closed no matter what markup arrived */
    modal.hidden = true;
    modal.classList.remove("on");
    var close = $("pm-close");
    if (close) close.addEventListener("click", api.close);
    var back = $("pm-back");
    if (back) back.addEventListener("click", api.close);
    var scrim = $("pm-scrim");
    if (scrim) scrim.addEventListener("click", api.close);
    var tabs = document.querySelectorAll("#pm-tabs button");
    for (var i = 0; i < tabs.length; i++) {
      (function (b) { b.addEventListener("click", function () { setTab(b.dataset.tab); }); })(tabs[i]);
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && api.isOpen()) { e.stopPropagation(); api.close(); }
    }, true);
  };

  api.byId = function (id) { return byId[id]; };
  window.QVArchives = api;
})();
