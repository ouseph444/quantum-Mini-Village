/* Quantum Village — slides in the seminar halls.
 *
 * A seminar is somebody standing in front of a board with a deck. This is
 * the deck: the presenter picks a PDF off their own machine, it goes up on
 * the hall's blackboard at full size, and every page turn they make lands
 * on everybody else's board in the same room at the same moment.
 *
 * What travels, and what does not.
 *
 *   The PDF never leaves the presenter's browser. Cloud Storage has needed
 *   a billing account since February 2026 and this project is on the free
 *   plan, so there is nowhere to upload a forty-page deck to and no reason
 *   to want one: at any instant a room is looking at exactly one page. So
 *   PDF.js opens the file locally, the current page is rendered to a canvas
 *   and re-encoded as a JPEG, and that one page — about half a megabyte —
 *   is what goes on the wire, under slides/<room>/<uid>.
 *
 *   That is also what makes a page turn feel like a page turn rather than a
 *   download. Turning to page seven sends page seven, not the deck.
 *
 *   The record carries the same onDisconnect hook as the chalk (see
 *   net.js), so a presenter who closes the tab takes their deck down with
 *   them rather than leaving a hall staring at page four for ever.
 *
 * Who is presenting. Whoever put the deck up, and nobody else until they
 * take it down. Putting a deck up claims the hall's board first (see
 * "one document per surface" in net.js); while somebody holds it the panel
 * says who, and the server refuses anybody else's slides. If a presenter
 * drops off the network long enough for the board to be claimed by
 * someone else, they are told and stand down rather than the two of them
 * fighting over the page number.
 *
 * Nothing here talks to Firebase directly. api.onChange is the single seam,
 * and app.js wires it to QVNet; with no network it all still works, for one
 * person, in one browser, which is what "solo" means everywhere else here.
 */
(function () {
  "use strict";

  var api = {};
  var halls = {};             /* roomId -> { id, name, board, x, z } */
  var decks = {};             /* roomId -> deck */
  var hooks = {};
  var openRoom = null;        /* the hall whose panel is on screen, if any */

  /* A page is read from the back of a hall on the board and close up on a
     phone, and it has to fit in a database record either way. */
  var MAX_EDGE  = 1600;
  var MAX_BYTES = 620000;
  var CACHE_KEEP = 6;         /* rendered pages held in memory at once */

  api.init = function (h) { hooks = h || {}; wire(); };
  api.onChange = null;        /* (roomId, payload|null) — the network seam */

  api.registerHall = function (o) {
    if (!o || !o.id) return;
    halls[o.id] = { id: o.id, name: o.name || "the hall", board: o.board || o.id,
                    x: o.x, z: o.z };
  };
  api.isHall = function (id) { return !!(id && halls[id]); };
  api.hallName = function (id) { return halls[id] ? halls[id].name : ""; };
  api.deck = function (id) { return decks[id] || null; };
  api.isOpen = function () { return !!openRoom; };

  /* The hall the player is standing in, or null. Asked of rooms.js rather
     than worked out again here, so there is one answer to "which room am I
     in" in the whole village. */
  function here() {
    var id = hooks.roomId ? hooks.roomId() : null;
    return id && halls[id] ? id : null;
  }
  api.here = here;

  /* The hall we are presenting in, if any. */
  api.presenting = function () {
    var ids = Object.keys(decks);
    for (var i = 0; i < ids.length; i++) if (decks[ids[i]].mine) return ids[i];
    return null;
  };

  function myUid() {
    return (hooks.uid && hooks.uid()) || window.QVLocalId || "guest";
  }
  function myName() { return (hooks.name && hooks.name()) || "someone"; }
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function say(msg, ok) {
    var n = el("sl-note");
    if (!n) return;
    n.textContent = msg || "";
    n.hidden = !msg;
    n.classList.toggle("ok", !!ok);
  }

  /* ------------------------------------------------------------ opening */
  function readBuf(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error("that file could not be read")); };
      r.readAsArrayBuffer(file);
    });
  }
  function readUrl(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error("that file could not be read")); };
      r.readAsDataURL(file);
    });
  }
  function decode(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error("that image could not be decoded")); };
      im.src = url;
    });
  }

  /* A page, at a size a hall can read and a record can hold. Quality steps
     down until it fits rather than the upload refusing outright. */
  function encode(source, sw, sh) {
    var scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    var g = c.getContext("2d");
    g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(source, 0, 0, c.width, c.height);
    var q = 0.86, url = c.toDataURL("image/jpeg", q);
    while (url.length > MAX_BYTES && q > 0.34) {
      q -= 0.08;
      url = c.toDataURL("image/jpeg", q);
    }
    if (url.length > MAX_BYTES) {
      throw new Error("that page is too detailed to send — try a simpler PDF");
    }
    return url;
  }

  /* Nothing may hang the panel for ever. */
  function within(ms, work, what) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        rej(new Error(what + " took too long — try a smaller file."));
      }, ms);
      work.then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
                function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }

  function renderPage(d, n) {
    if (d.cache[n]) return Promise.resolve(d.cache[n]);
    if (!d.pdf) return Promise.reject(new Error("the deck is not open here"));
    return d.pdf.getPage(n).then(function (page) {
      var v1 = page.getViewport({ scale: 1 });
      var scale = Math.min(3, MAX_EDGE / Math.max(v1.width, v1.height));
      var vp = page.getViewport({ scale: scale });
      var c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      var g = c.getContext("2d");
      g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, c.width, c.height);
      return page.render({ canvasContext: g, viewport: vp }).promise.then(function () {
        var url = encode(c, c.width, c.height);
        d.cache[n] = url;
        return url;
      });
    });
  }

  /* Forty pages of rendered JPEG is twenty megabytes of string. Hold the
     handful either side of where the presenter is and let the rest go; any
     page can always be drawn again from the PDF, which is still open. */
  function trimCache(d) {
    var keys = Object.keys(d.cache);
    if (keys.length <= CACHE_KEEP) return;
    keys.sort(function (a, b) {
      return Math.abs(a - d.page) - Math.abs(b - d.page);
    });
    keys.slice(CACHE_KEEP).forEach(function (k) { delete d.cache[k]; });
  }

  /* The next page is the one they are about to ask for. */
  function prefetch(d) {
    if (!d.pdf) return;
    [d.page + 1, d.page - 1].forEach(function (n) {
      if (n >= 1 && n <= d.pages && !d.cache[n]) {
        renderPage(d, n).catch(function () {});
      }
    });
  }

  /* ---------------------------------------------------------- the board */
  /* One place where a deck becomes something you can see: the slate in the
     hall, the panel if it happens to be open, and the rail. */
  function apply(roomId) {
    var hall = halls[roomId], d = decks[roomId];
    if (hall && window.QVBoard && QVBoard.setSlide) {
      QVBoard.setSlide(hall.board, d ? d.img : null,
        d ? { page: d.page, pages: d.pages, by: d.by } : null);
    }
    if (openRoom === roomId) paintPanel();
    lastSig = "";
    updateHud();
    if (hooks.onState) { try { hooks.onState(roomId); } catch (e) {} }
  }

  function broadcast(roomId) {
    if (!api.onChange) return;
    var d = decks[roomId];
    try {
      api.onChange(roomId, (d && d.mine && d.img) ? {
        s: d.img, i: d.page, n: d.pages, by: d.by, u: d.uid, at: Date.now()
      } : null);
    } catch (e) {}
  }

  /* --------------------------------------------------------- presenting */
  api.present = function (roomId, file) {
    var hall = halls[roomId];
    if (!hall) return Promise.reject(new Error("slides go up in a seminar hall"));
    if (!file) return Promise.reject(new Error("no file"));
    var other = occupant(roomId);
    if (other) return Promise.reject(new Error(busyMsg(roomId, other)));
    var had = !!(decks[roomId] && decks[roomId].mine);
    /* Claim the board before opening anything: a forty-page PDF takes a
       while, and finding out afterwards that somebody else got there first
       would waste it. */
    return claim(roomId).then(function (res) {
      if (!res.ok) throw new Error(busyMsg(roomId, (res.holder && res.holder.n) || "someone else"));
      return load(roomId, file);
    }).catch(function (e) {
      /* nothing went up, so the board goes straight back */
      if (!had && !(decks[roomId] && decks[roomId].mine) && hooks.release) hooks.release(roomId);
      throw e;
    });
  };

  function load(roomId, file) {

    var name = (file.name || "").toLowerCase();
    var isPdf = file.type === "application/pdf" || /\.pdf$/.test(name);
    var isImg = /^image\/(png|jpeg|jpg)$/.test(file.type) || /\.(png|jpe?g)$/.test(name);
    if (!isPdf && !isImg) {
      return Promise.reject(new Error("A deck goes up as a PDF. A single slide may be a PNG or a JPG."));
    }
    if (file.size > 80 * 1024 * 1024) {
      return Promise.reject(new Error("That file is over 80 MB — too big to open in a browser."));
    }

    /* A one-page deck from a picture: no PDF.js, no worker, no wait. */
    if (isImg) {
      return readUrl(file).then(decode).then(function (im) {
        var url = encode(im, im.naturalWidth, im.naturalHeight);
        var d = decks[roomId] = newDeck(roomId, null, 1, file.name);
        d.cache[1] = url;
        return show(roomId, 1);
      });
    }

    return within(60000, readBuf(file).then(function (buf) {
      if (!window.QVPosters || !QVPosters.pdfjs) throw new Error("the PDF reader is not available");
      return QVPosters.pdfjs().then(function (lib) {
        return lib.getDocument({ data: new Uint8Array(buf) }).promise;
      });
    }), "That PDF").then(function (doc) {
      if (!doc.numPages) throw new Error("that PDF has no pages in it");
      decks[roomId] = newDeck(roomId, doc, doc.numPages, file.name);
      return show(roomId, 1);
    });
  }

  /* Who has this hall's board, if it is somebody other than us: the claim
     if the server has told us about one, otherwise a deck on screen that
     is not ours. */
  function occupant(roomId) {
    var h = hooks.holder ? hooks.holder(roomId) : null;
    if (h && h.u && h.u !== myUid()) return h.n || "someone else";
    var d = decks[roomId];
    if (d && !d.mine && d.uid && d.uid !== myUid()) return d.by || "someone else";
    return null;
  }
  api.occupant = occupant;
  /* The claims changed: an open panel may need to say the board is free,
     or that it is not. */
  api.refresh = function () { if (openRoom) paintPanel(); };
  function busyMsg(roomId, who) {
    return who + " is using the board in " + (halls[roomId] ? halls[roomId].name : "this hall") +
           ". It frees up when they take their slides down.";
  }
  function claim(roomId) {
    return hooks.claim ? hooks.claim(roomId) : Promise.resolve({ ok: true });
  }

  function newDeck(roomId, pdf, pages, title) {
    var old = decks[roomId];
    /* Taking the screen off somebody: drop what they were showing rather
       than blending the two decks' page counts together. */
    if (old && old.pdf && old.pdf.destroy) { try { old.pdf.destroy(); } catch (e) {} }
    return {
      roomId: roomId, pdf: pdf, cache: {},
      pages: pages, page: 0, img: null,
      by: myName(), uid: myUid(), mine: true,
      title: title || "", busy: false
    };
  }

  /* Turn to a page: render it, put it up here, and tell the room. */
  function show(roomId, n) {
    var d = decks[roomId];
    if (!d || !d.mine) return Promise.resolve(false);
    n = Math.max(1, Math.min(d.pages, Math.round(n)));
    if (d.busy) return Promise.resolve(false);
    d.busy = true;
    if (openRoom === roomId) paintPanel();
    return renderPage(d, n).then(function (url) {
      d.busy = false;
      if (decks[roomId] !== d) return false;      /* superseded while rendering */
      d.page = n;
      d.img = url;
      trimCache(d);
      apply(roomId);
      broadcast(roomId);
      prefetch(d);
      return true;
    }, function (e) {
      d.busy = false;
      apply(roomId);
      throw e;
    });
  }
  api.go = function (roomId, n) {
    return show(roomId, n).catch(function (e) {
      say((e && e.message) || "that page could not be drawn");
      if (hooks.toast) hooks.toast(esc((e && e.message) || "That page could not be drawn."));
      return false;
    });
  };
  api.next = function (roomId) {
    var d = decks[roomId];
    if (!d || !d.mine || d.page >= d.pages) return Promise.resolve(false);
    return api.go(roomId, d.page + 1);
  };
  api.prev = function (roomId) {
    var d = decks[roomId];
    if (!d || !d.mine || d.page <= 1) return Promise.resolve(false);
    return api.go(roomId, d.page - 1);
  };

  api.end = function (roomId) {
    var d = decks[roomId];
    if (!d || !d.mine) return false;
    if (d.pdf && d.pdf.destroy) { try { d.pdf.destroy(); } catch (e) {} }
    delete decks[roomId];
    broadcast(roomId);
    apply(roomId);
    stoodDown(roomId);
    return true;
  };

  /* We are no longer the one presenting here — because we took the deck
     down, or because somebody else took the screen. Either way the village
     was told a seminar was running in this hall, and it is not any more. */
  function stoodDown(roomId) {
    if (hooks.onEnd) { try { hooks.onEnd(roomId); } catch (e) {} }
  }

  /* ------------------------------------------------------------ the room
   *
   * A page somebody else turned to. This is the whole of "everybody sees
   * the same page": the record changed, so the board changes. */
  api.receive = function (roomId, v) {
    if (!halls[roomId]) return;
    var d = decks[roomId];
    var mine = myUid();

    if (!v || !v.s) {
      /* The deck came down. If it is ours it came down because we took it
         down, and apply() has already run. */
      if (d && d.mine) return;
      if (!d) return;
      delete decks[roomId];
      apply(roomId);
      return;
    }

    if (d && d.mine) {
      if (!v.u || v.u === mine) return;          /* our own write, coming back */
      /* Somebody else has taken the screen. Stand down rather than fight
         over the page number, and take our own record out of the way. */
      if (d.pdf && d.pdf.destroy) { try { d.pdf.destroy(); } catch (e) {} }
      delete decks[roomId];
      if (api.onChange) { try { api.onChange(roomId, null); } catch (e) {} }
      if (hooks.toast) {
        hooks.toast("You lost the board in " + esc(halls[roomId].name) + " while you were offline — " +
                    "<b>" + esc(v.by || "someone else") + "</b> is presenting there now.");
      }
      stoodDown(roomId);
    }

    var cur = decks[roomId];
    if (cur && !cur.mine && cur.page === v.i && cur.img === v.s) return;

    decks[roomId] = {
      roomId: roomId, pdf: null, cache: {},
      pages: v.n || 1, page: v.i || 1, img: v.s,
      by: v.by || "", uid: v.u || "", mine: false, title: "", busy: false
    };
    apply(roomId);
  };

  /* Everything this browser owns, taken down — used on sign-out. */
  api.dropMine = function () {
    Object.keys(decks).forEach(function (id) { if (decks[id].mine) api.end(id); });
  };

  /* ============================================================== panel */
  var wired = false;
  function wire() {
    if (wired) return;
    wired = true;

    var sheet = el("slides");
    if (!sheet) return;

    sheet.onclick = function (e) { if (e.target === sheet) api.close(); };
    var cl = el("sl-close");
    if (cl) cl.onclick = function () { api.close(); };

    var file = el("sl-file");
    if (file) {
      file.onchange = function () {
        var f = this.files && this.files[0];
        var room = openRoom;
        if (!f || !room) return;
        say("Opening " + f.name + "…");
        setBusy(true);
        api.present(room, f).then(function () {
          say("Up on the board. Everyone in the hall is looking at page 1.", true);
          if (hooks.onPresent) hooks.onPresent(room, halls[room], decks[room]);
        }).catch(function (e) {
          say((e && e.message) || "That file could not be used.");
        }).then(function () {
          setBusy(false);
          if (file) file.value = "";
          paintPanel();
        });
      };
    }

    var prev = el("sl-prev"), next = el("sl-next"), end = el("sl-end");
    if (prev) prev.onclick = function () { if (openRoom) api.prev(openRoom); };
    if (next) next.onclick = function () { if (openRoom) api.next(openRoom); };
    if (end) end.onclick = function () {
      if (!openRoom) return;
      var nm = halls[openRoom] ? halls[openRoom].name : "the hall";
      api.end(openRoom);
      say("");
      if (hooks.toast) hooks.toast("Slides taken down in <b>" + esc(nm) + "</b>");
    };

    /* On a phone, a deck is turned the way every other deck on a phone is
       turned. Presenter only: a swipe from the room would change nothing
       and feel broken. */
    var view = el("sl-view");
    if (view) {
      var sx = 0, sy = 0, tracking = false;
      view.addEventListener("pointerdown", function (e) {
        var d = openRoom && decks[openRoom];
        tracking = !!(d && d.mine);
        sx = e.clientX; sy = e.clientY;
      });
      view.addEventListener("pointerup", function (e) {
        if (!tracking) return;
        tracking = false;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        if (!openRoom) return;
        if (dx < 0) api.next(openRoom); else api.prev(openRoom);
      });
      view.addEventListener("pointercancel", function () { tracking = false; });
    }

    /* the compact bar in the side rail, for a presenter who has closed the
       panel and is watching the room instead of the screen */
    var bp = el("sb-prev"), bn = el("sb-next"), be = el("sb-end"), bo = el("sb-open");
    var room = function () { return api.presenting(); };
    if (bp) bp.onclick = function () { var r = room(); if (r) api.prev(r); };
    if (bn) bn.onclick = function () { var r = room(); if (r) api.next(r); };
    if (bo) bo.onclick = function () { var r = room(); if (r) api.open(r); };
    if (be) be.onclick = function () {
      var r = room();
      if (!r) return;
      var nm = halls[r] ? halls[r].name : "the hall";
      api.end(r);
      if (hooks.toast) hooks.toast("Slides taken down in <b>" + esc(nm) + "</b>");
    };

    var btn = el("slides-btn");
    if (btn) btn.onclick = function (e) {
      e.preventDefault();
      api.toggle();
    };
  }

  function setBusy(on) {
    var f = el("sl-file");
    if (f) f.disabled = !!on;
    var card = el("sl-card");
    if (card) card.classList.toggle("busy", !!on);
  }

  api.open = function (roomId) {
    roomId = roomId || here();
    if (!roomId || !halls[roomId]) return false;
    var sheet = el("slides");
    if (!sheet) return false;
    openRoom = roomId;
    sheet.hidden = false;
    sheet.dataset.open = "1";
    say("");
    paintPanel();
    if (hooks.onOpen) hooks.onOpen();
    lastSig = "";
    updateHud();
    return true;
  };

  api.close = function () {
    var sheet = el("slides");
    if (sheet) { sheet.hidden = true; sheet.dataset.open = ""; }
    openRoom = null;
    if (hooks.onClose) hooks.onClose();
    lastSig = "";
    updateHud();
  };

  api.toggle = function () {
    if (openRoom) { api.close(); return true; }
    var room = here() || api.presenting();
    if (!room) {
      if (hooks.toast) {
        hooks.toast("Slides go up in a seminar hall. Walk into <b>Seminar Hall α</b> " +
                    "or <b>β</b> and press <b>P</b>.");
      }
      return false;
    }
    return api.open(room);
  };

  var panelImg = null;
  function paintPanel() {
    if (!openRoom) return;
    var hall = halls[openRoom], d = decks[openRoom];
    var mine = !!(d && d.mine);

    var t = el("sl-title");
    if (t) t.textContent = hall ? hall.name : "Slides";

    var sub = el("sl-sub");
    if (sub) {
      sub.textContent = d
        ? ("Page " + d.page + " of " + d.pages + (d.by ? "  ·  " + d.by : "") +
           (mine ? "  ·  you are presenting" : ""))
        : "The board is clear — nothing is up yet.";
    }

    var view = el("sl-view");
    if (view) {
      view.classList.toggle("turning", !!(d && d.busy));
      if (d && d.img) {
        /* The same <img> across a page turn, so the browser swaps one
           decoded picture for another rather than tearing the element out
           of the document and building it again forty times a talk. */
        if (!panelImg || panelImg.parentNode !== view) {
          view.innerHTML = "";
          panelImg = document.createElement("img");
          panelImg.id = "sl-img";
          view.appendChild(panelImg);
        }
        if (panelImg.src !== d.img) panelImg.src = d.img;
        panelImg.alt = "Page " + d.page + " of " + d.pages;
      } else {
        panelImg = null;
        view.innerHTML = "";
        var note = document.createElement("p");
        note.className = "sl-empty";
        note.textContent = mine
          ? "Choose a PDF below and it goes straight up on the blackboard."
          : "Nothing is on the board in this hall yet. Put a deck up and " +
            "everybody here will be looking at it.";
        view.appendChild(note);
      }
    }

    var page = el("sl-page");
    if (page) page.textContent = d ? (d.page + " / " + d.pages) : "—";

    var prev = el("sl-prev"), next = el("sl-next"), end = el("sl-end");
    if (prev) { prev.hidden = !mine; prev.disabled = !d || d.page <= 1 || d.busy; }
    if (next) { next.hidden = !mine; next.disabled = !d || d.page >= d.pages || d.busy; }
    if (end)  { end.hidden = !mine; }
    if (page) page.hidden = !d;

    var busy = mine ? null : occupant(openRoom);
    var lab = el("sl-filelabel");
    if (lab) {
      lab.textContent = busy ? busy + " is using this board — it frees up when they finish"
                     : mine ? "Replace your deck — PDF, PNG or JPG"
                            : "Put a deck up — PDF, PNG or JPG";
    }
    var fileIn = el("sl-file");
    if (fileIn) fileIn.disabled = !!busy;
    var pick = fileIn && fileIn.closest ? fileIn.closest(".sl-pick") : null;
    if (pick) pick.classList.toggle("busy", !!busy);
    var hint = el("sl-hint");
    if (hint) {
      hint.innerHTML = mine
        ? "<b>←</b> <b>→</b> turn the page · <b>Esc</b> closes"
        : "Everyone in this hall sees the page the presenter is on.";
    }
  }

  /* ----------------------------------------------------------- the rail
   *
   * Called ten times a second off the frame loop, so it works out what it
   * would draw before it draws anything. Writing the same `hidden` and the
   * same `title` sixty times a second is layout work for nothing. */
  var lastSig = "";
  function updateHud() {
    var room = here();
    var presentingIn = api.presenting();
    var d = room ? decks[room] : null;
    var pd = presentingIn ? decks[presentingIn] : null;
    var barOn = !!pd && !openRoom;

    var sig = [
      room || "",
      d ? d.page + "/" + d.pages : "",
      barOn ? pd.page + "/" + pd.pages + "/" + (pd.busy ? 1 : 0) : ""
    ].join("|");
    if (sig === lastSig) return;
    lastSig = sig;

    var btn = el("slides-btn");
    if (btn) {
      btn.hidden = !room;
      btn.classList.toggle("has-content", !!(d && d.img));
      if (room) {
        btn.title = (d && d.img ? "Slides are up in " : "Put slides up in ") +
                    halls[room].name + " (P)";
      }
    }

    var bar = el("slidebar");
    if (bar) {
      bar.hidden = !barOn;
      if (barOn) {
        var pg = el("sb-page");
        if (pg) pg.textContent = pd.page + " / " + pd.pages;
        var bp = el("sb-prev"), bn = el("sb-next");
        if (bp) bp.disabled = pd.page <= 1 || pd.busy;
        if (bn) bn.disabled = pd.page >= pd.pages || pd.busy;
      }
    }
  }
  api.updateHud = updateHud;

  /* Arrow keys, for a presenter with the panel open. Deliberately not bound
     while the panel is shut: the same keys walk the avatar. */
  api.key = function (k) {
    if (!openRoom) return false;
    var d = decks[openRoom];
    if (!d || !d.mine) return false;
    if (k === "arrowright" || k === "pagedown" || k === " ") { api.next(openRoom); return true; }
    if (k === "arrowleft" || k === "pageup") { api.prev(openRoom); return true; }
    return false;
  };

  window.QVSlides = api;
})();
