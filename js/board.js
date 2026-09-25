/* Quantum Village — writable blackboards.
 *
 * Every seminar room, lecture hall and discussion room already had a board
 * on the wall with a scrawl on it. This turns that scrawl into a canvas:
 * walk up, press E, type text and mathematics, and it goes up in chalk.
 *
 * Mathematics is written the way it is written everywhere else — between
 * dollar signs, $E = mc^2$ inline and $$ … $$ on a line of its own. MathJax
 * renders it to SVG *paths*, which matters: paths carry no font dependency,
 * so the result rasterises onto a canvas without waiting on a web font and
 * without tainting it. MathJax is fetched the first time somebody opens a
 * board and never before, so a visitor who only walks around pays nothing.
 *
 * Registering a board (campus.js does this as it builds):
 *   QVBoard.register({ id, name, parent, w, h, ox, oy, oz, wx, wz, seed })
 *
 * Nothing here talks to the network. api.onWrite is the single seam where
 * a shared board would hook in: fire it on write, call api.receive() when a
 * neighbour writes. Both sides are already in place.
 */
(function () {
  "use strict";
  var V = window.QV;
  var T = window.THREE;

  var api = {};
  var boards = {};
  var list = [];
  var hooks = {};

  var CHALK = "#E9E4D2";
  var REACH = 5.6;          /* how close you must stand to pick up the chalk */
  /* Reading is not writing. You read a board from your chair, from the back
     of the room, from wherever you happened to stop — so B reaches a good
     deal further than the chalk does. */
  var READ_REACH = 20;
  var REF = 96;             /* px per em that math is rasterised at, once */
  var PAD = 0.05;           /* clear margin, as a fraction of the board */

  api.init = function (h) { hooks = h || {}; };
  api.get = function (id) { return boards[id] || null; };
  api.all = function () { return list.slice(); };

  /* ------------------------------------------------------------ surface */
  function surfaceCanvas(w, h) {
    var px = Math.min(2048, Math.max(768, Math.round(w * 110)));
    var c = document.createElement("canvas");
    c.width = px;
    c.height = Math.max(256, Math.round(px * (h / w)));
    return c;
  }

  api.register = function (o) {
    if (!o || !o.id || !T || !V) return null;
    if (boards[o.id]) return boards[o.id];

    var canvas = surfaceCanvas(o.w, o.h);
    var tex = new T.CanvasTexture(canvas);
    tex.anisotropy = 4;
    var mat = new T.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.94, side: T.DoubleSide
    });
    var mesh = V.panel(o.parent, o.w, o.h, mat, o.ox || 0, o.oy || 0, o.oz || 0, o.ry);

    var b = {
      mesh: mesh,
      id: o.id,
      name: o.name || "the board",
      canvas: canvas,
      ctx: canvas.getContext("2d"),
      tex: tex,
      w: o.w, h: o.h,
      x: o.wx, z: o.wz,          /* where to stand; null for a board nobody can reach */
      seed: o.seed || null,      /* the chalk that was there before anyone wrote */
      src: null,                 /* null until written; "" once wiped */
      pic: null,                 /* a picture pinned to the slate, as a data URL */
      by: "",
      /* A slide takes the whole slate while it is up — see paintSlide. The
         chalk underneath is not wiped, it is covered, and it comes back the
         moment the deck comes down. */
      slide: null,
      slidePage: 0,
      slidePages: 0,
      slideBy: ""
    };
    boards[b.id] = b;
    list.push(b);

    /* A blackboard is a thing on a wall, and the first thing anybody does
       with a thing on a wall they cannot read is click it. Register the
       slate itself with the interaction layer so that a click — or a tap —
       opens the reader, wherever in the room you are standing. */
    if (window.QVInteract && mesh && b.x != null) {
      QVInteract.add({
        id: "boardsurf-" + b.id,
        x: b.x, z: b.z,
        r: 0.01,              /* clickable only; the prompt is E's job */
        pickR: READ_REACH,    /* and only from close enough to be reading it */
        object: mesh,
        label: "Read " + b.name,
        onUse: function () { api.read(b.id); }
      });
    }

    paint(b);
    return b;
  };

  /* -------------------------------------------------------- MathJax v3 */
  var mj = null;
  function mathjax() {
    if (mj) return mj;
    mj = new Promise(function (res, rej) {
      window.MathJax = {
        loader: { load: ["input/tex", "output/svg"] },
        /* Local font cache: each equation carries its own glyph paths, so a
           serialised SVG stands on its own. The global cache puts them in a
           shared <defs> elsewhere in the page, which survives on screen and
           comes out blank the moment you rasterise it. */
        svg: { fontCache: "local" },
        startup: {
          typeset: false,
          ready: function () {
            window.MathJax.startup.defaultReady();
            res(window.MathJax);
          }
        }
      };
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.js";
      s.async = true;
      s.onerror = function () { rej(new Error("MathJax could not be fetched")); };
      document.head.appendChild(s);
    });
    return mj;
  }

  /* One equation, rasterised once at REF and scaled down when drawn.
     Returns its size and how far it rises above the baseline, so inline
     mathematics sits on the same line as the words around it. */
  function render(tex, display, colour) {
    return mathjax().then(function (MJ) {
      var node = MJ.tex2svg(String(tex), { display: !!display });
      var svg = node.querySelector("svg");
      if (!svg) throw new Error("no svg");
      var bad = !!svg.querySelector('[data-mml-node="merror"]');
      var vb = (svg.getAttribute("viewBox") || "0 0 1000 1000").split(/\s+/).map(Number);
      /* MathJax works in units of 1000 to the em, and the viewBox starts
         above the baseline, so -minY is the ascent. */
      var wPx = Math.max(1, Math.round(vb[2] / 1000 * REF));
      var hPx = Math.max(1, Math.round(vb[3] / 1000 * REF));
      svg.setAttribute("width", wPx);
      svg.setAttribute("height", hPx);
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.style.color = colour || CHALK;
      var url = "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(new XMLSerializer().serializeToString(svg));
      return new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () {
          res({ img: im, w: wPx, h: hPx, asc: -vb[1] / 1000 * REF, bad: bad });
        };
        im.onerror = function () { rej(new Error("equation could not be drawn")); };
        im.src = url;
      });
    });
  }

  /* ------------------------------------------------------------- chalk */
  /* Text, newlines and mathematics. A backslash before a dollar sign is a
     literal one, for anyone who wants to write about money. */
  function tokenize(src) {
    var out = [], buf = "", i = 0, n = src.length;
    function flush() { if (buf) { out.push({ t: "text", s: buf }); buf = ""; } }
    while (i < n) {
      var ch = src.charAt(i);
      if (ch === "\\" && src.charAt(i + 1) === "$") { buf += "$"; i += 2; continue; }
      if (ch === "\n") { flush(); out.push({ t: "br" }); i++; continue; }
      if (ch === "$") {
        var disp = src.charAt(i + 1) === "$";
        var open = i + (disp ? 2 : 1);
        var close = src.indexOf(disp ? "$$" : "$", open);
        if (close < 0) { buf += ch; i++; continue; }   /* unclosed: it is just a dollar */
        flush();
        out.push({ t: "math", s: src.slice(open, close), display: disp });
        i = close + (disp ? 2 : 1);
        continue;
      }
      buf += ch; i++;
    }
    flush();
    return out;
  }

  function chalkFont(px) {
    return '600 ' + Math.round(px) + 'px Georgia, "Times New Roman", serif';
  }

  /* Lay the tokens out at one size and report how tall that came out. The
     caller shrinks and retries until it fits, which is what anyone does
     when they run out of board. */
  function layout(b, toks, fontPx) {
    var g = b.ctx;
    var maxW = b.canvas.width * (1 - 2 * PAD);
    var scale = fontPx / REF;
    g.font = chalkFont(fontPx);

    var lines = [], cur = [], curW = 0;
    function push(center) {
      lines.push({ parts: cur, w: curW, center: !!center });
      cur = []; curW = 0;
    }
    toks.forEach(function (tk) {
      if (tk.t === "br") { push(); return; }
      if (tk.t === "math") {
        if (!tk.m) return;
        var w = tk.m.w * scale, h = tk.m.h * scale, asc = tk.m.asc * scale;
        if (tk.display) {
          if (cur.length) push();
          var s = Math.min(1, maxW / w);
          cur.push({ t: "math", img: tk.m.img, w: w * s, h: h * s, asc: asc * s });
          curW = w * s;
          push(true);
          return;
        }
        if (curW + w > maxW && cur.length) push();
        cur.push({ t: "math", img: tk.m.img, w: w, h: h, asc: asc });
        curW += w;
        return;
      }
      tk.s.split(/(\s+)/).forEach(function (wd) {
        if (!wd) return;
        var ww = g.measureText(wd).width;
        if (curW + ww > maxW && cur.length && wd.trim()) push();
        if (!cur.length && !wd.trim()) return;      /* no leading space after a wrap */
        cur.push({ t: "text", s: wd, w: ww });
        curW += ww;
      });
    });
    if (cur.length) push();

    var total = 0;
    lines.forEach(function (ln) {
      var asc = fontPx * 0.76, desc = fontPx * 0.26;
      ln.parts.forEach(function (p) {
        if (p.t !== "math") return;
        asc = Math.max(asc, p.asc);
        desc = Math.max(desc, p.h - p.asc);
      });
      ln.asc = asc;
      ln.h = (asc + desc) * 1.3;
      total += ln.h;
    });
    return { lines: lines, h: total };
  }

  function drawSeed(b) {
    if (!b.seed || !b.seed.image) return;
    var g = b.ctx, c = b.canvas, im = b.seed.image;
    var s = Math.min(c.width * 0.62 / im.width, c.height * 0.8 / im.height);
    g.save();
    g.globalAlpha = 0.5;
    g.drawImage(im, (c.width - im.width * s) / 2, (c.height - im.height * s) / 2,
                im.width * s, im.height * s);
    g.restore();
  }

  function decodeImg(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error("picture")); };
      im.src = url;
    });
  }

  function paint(b) {
    var g = b.ctx, c = b.canvas;
    g.clearRect(0, 0, c.width, c.height);

    /* A deck is up: the slate is a screen until it comes down. */
    if (b.slide) return paintSlide(b);

    if (b.src == null && !b.pic) { drawSeed(b); b.tex.needsUpdate = true; return Promise.resolve(); }

    /* A picture pinned to the slate sits above whatever is written under it,
       the way a printout taped to a blackboard does. */
    var pic = b.pic ? decodeImg(b.pic).catch(function () { return null; }) : Promise.resolve(null);
    return pic.then(function (im) {
      var top = 0;
      if (im) {
        var boxH = (b.src ? 0.60 : 0.88) * c.height;
        var s = Math.min((c.width * 0.88) / im.naturalWidth, boxH / im.naturalHeight);
        var dw = im.naturalWidth * s, dh = im.naturalHeight * s;
        var dx = (c.width - dw) / 2, dy = c.height * 0.05;
        g.drawImage(im, dx, dy, dw, dh);
        g.strokeStyle = "rgba(233,228,210,.45)"; g.lineWidth = 3;
        g.strokeRect(dx, dy, dw, dh);
        top = dy + dh + c.height * 0.035;
      }
      if (!b.src) { b.tex.needsUpdate = true; return; }
      return paintText(b, top);
    });
  }

  function paintText(b, top) {
    var g = b.ctx, c = b.canvas;
    var toks = tokenize(b.src);
    var maths = toks.filter(function (t) { return t.t === "math"; });
    /* TeX that does not parse comes back from MathJax as an error box filled
       with currentColor — a solid slab of chalk, which tells the writer
       nothing. Put the source back on the board instead, delimiters and all,
       so they can see what did not take. */
    function raw(t) {
      var d = t.display ? "$$" : "$";
      t.t = "text"; t.s = d + t.s + d; t.m = null;
    }
    var jobs = maths.map(function (t) {
      return render(t.s, t.display)
        .then(function (m) { if (m.bad) raw(t); else t.m = m; })
        .catch(function () { raw(t); });
    });

    return Promise.all(jobs).then(function () {
      var room = (c.height - top) * (1 - 2 * PAD);
      var fontPx = Math.min(room / 3.4, c.height / 7.5, c.width / 16);
      var L = layout(b, toks, fontPx);
      for (var k = 0; k < 16 && L.h > room; k++) {
        fontPx *= 0.88;
        L = layout(b, toks, fontPx);
      }

      g.fillStyle = CHALK;
      g.textBaseline = "alphabetic";
      g.font = chalkFont(fontPx);
      /* chalk sits slightly proud of the slate rather than cutting into it */
      g.shadowColor = "rgba(233,228,210,0.30)";
      g.shadowBlur = fontPx * 0.14;

      var y = top + (c.height - top) * PAD + Math.max(0, (room - L.h) * 0.12);
      L.lines.forEach(function (ln) {
        var x = ln.center ? (c.width - ln.w) / 2 : c.width * PAD;
        var base = y + ln.asc;
        ln.parts.forEach(function (p) {
          if (p.t === "text") g.fillText(p.s, x, base);
          else g.drawImage(p.img, x, base - p.asc, p.w, p.h);
          x += p.w;
        });
        y += ln.h;
      });

      if (b.by) {
        g.shadowBlur = 0;
        g.globalAlpha = 0.5;
        g.font = chalkFont(Math.max(14, fontPx * 0.42));
        g.textAlign = "right";
        g.fillText("— " + b.by, c.width * (1 - PAD), c.height * (1 - PAD * 0.7));
        g.textAlign = "left";
        g.globalAlpha = 1;
      }
      g.shadowBlur = 0;
      b.tex.needsUpdate = true;
    });
  }

  /* ------------------------------------------------------------- slides
   *
   * One page of somebody's PDF, painted edge to edge on the slate. The
   * whole point of a forty-metre board is that the back row can read it, so
   * the page is drawn as large as the slate allows on a dark ground, with
   * one line under it saying which page it is — the thing everybody in a
   * seminar wants to know and nobody wants to ask.
   *
   * js/slides.js owns the deck, the page turns and the network. This only
   * knows how to put one picture on one board. */
  function slideCaption(b) {
    var s = b.slidePages ? ("Page " + b.slidePage + " of " + b.slidePages) : "";
    if (b.slideBy) s += (s ? "   \u00b7   " : "") + b.slideBy;
    return s;
  }

  function paintSlide(b) {
    var g = b.ctx, c = b.canvas;
    g.fillStyle = "#12100E";
    g.fillRect(0, 0, c.width, c.height);
    return decodeImg(b.slide).then(function (im) {
      var foot = Math.round(c.height * 0.10);
      var pad = Math.round(c.height * 0.035);
      var boxW = c.width - pad * 2, boxH = c.height - foot - pad * 2;
      var sc = Math.min(boxW / im.naturalWidth, boxH / im.naturalHeight);
      var dw = im.naturalWidth * sc, dh = im.naturalHeight * sc;
      var dx = Math.round((c.width - dw) / 2), dy = Math.round(pad + (boxH - dh) / 2);
      /* a white margin round the page, so a slide with a white ground does
         not bleed into the slate and lose its own edges */
      g.fillStyle = "#FFFFFF";
      g.fillRect(dx - 4, dy - 4, dw + 8, dh + 8);
      g.drawImage(im, dx, dy, dw, dh);
      var cap = slideCaption(b);
      if (cap) {
        g.fillStyle = CHALK;
        g.globalAlpha = 0.82;
        g.font = chalkFont(Math.round(foot * 0.58));
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(cap, c.width / 2, c.height - foot * 0.55);
        g.textAlign = "left";
        g.textBaseline = "alphabetic";
        g.globalAlpha = 1;
      }
      b.tex.needsUpdate = true;
    }).catch(function () {
      g.fillStyle = CHALK;
      g.font = chalkFont(Math.round(c.height * 0.11));
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("that slide could not be drawn", c.width / 2, c.height / 2);
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      b.tex.needsUpdate = true;
    });
  }

  /* Put a page up, or pass a falsy url to take the deck down. */
  api.setSlide = function (id, url, meta) {
    var b = boards[id];
    if (!b) return Promise.resolve();
    meta = meta || {};
    b.slide = url || null;
    b.slidePage = meta.page || 0;
    b.slidePages = meta.pages || 0;
    b.slideBy = meta.by || "";
    return paint(b);
  };
  api.slideOf = function (id) {
    var b = boards[id];
    if (!b || !b.slide) return null;
    return { url: b.slide, page: b.slidePage, pages: b.slidePages, by: b.slideBy };
  };

  /* ------------------------------------------------------------- write */
  /* Written here, by us: tell whoever is listening. */
  api.write = function (id, src, by, pic) {
    var b = boards[id];
    if (!b) return Promise.resolve();
    b.src = String(src == null ? "" : src);
    b.by = by || "";
    if (pic !== undefined) b.pic = pic || null;
    var p = paint(b);
    if (api.onWrite) { try { api.onWrite(id, b.src, b.by, b.pic); } catch (e) {} }
    return p;
  };
  /* Written by somebody else: draw it, say nothing. */
  api.receive = function (id, src, by, pic) {
    var b = boards[id];
    if (!b) return Promise.resolve();
    /* Our own write comes back off the wire; redrawing it would only make
       the board blink. */
    var same = String(src == null ? "" : src) === String(b.src == null ? "" : b.src) &&
               (pic || null) === (b.pic || null) && (by || "") === (b.by || "");
    if (same && b.src !== null) return Promise.resolve();
    b.src = String(src == null ? "" : src);
    b.by = by || "";
    if (pic !== undefined) b.pic = pic || null;
    return paint(b);
  };
  api.onWrite = null;

  /* Lent to the poster hall, so captions there are set by the same TeX
     pipeline as the chalk here rather than a second copy of it. */
  api.renderMath = function (tex, display, colour) {
    return render(tex, display, colour);
  };
  api.REF = REF;

  /* ------------------------------------------------------------- read
   *
   * A blackboard is a texture on a wall three metres up. It is legible when
   * you are standing in front of it and hopeless from anywhere else, and
   * zooming the camera into a wall is not reading. So the writing is also
   * kept as text, and this puts that text on the screen at a size made for
   * eyes rather than for the room.
   *
   * The equations go through exactly the same MathJax path as the chalk, so
   * what you read here is what is on the board rather than a second opinion
   * about it. */
  function nearestReadable(px, pz, reach) {
    var r = reach || READ_REACH;
    var best = null, bd = r * r;

    /* Inside a room, the board on that room's wall is the one you mean,
       even if another room's board happens to be a metre nearer through
       the partition. */
    var R = window.QVRooms;
    var st = R && R.state ? R.state() : null;
    if (st && st.roomId && boards[st.roomId]) return boards[st.roomId];

    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.x == null) continue;
      var dx = px - b.x, dz = pz - b.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = b; }
    }
    return best;
  }
  api.nearestReadable = nearestReadable;
  /* Is there anything worth pressing B for? Used for the on-screen button. */
  api.readableAt = function (px, pz) {
    var b = nearestReadable(px, pz);
    return b ? { id: b.id, name: b.name, written: !!(b.src || b.pic) } : null;
  };

  var reading = null, readPic = false;

  api.read = function (id, px, pz) {
    var b = (id && boards[id]) ||
            (px != null ? nearestReadable(px, pz) : null);
    if (!b) return false;
    var sheet = el("board-read");
    if (!sheet) return false;
    /* Writing wins: if the chalk box is open, reading would be a second
       overlay over the top of it saying the same thing. */
    if (open) return false;
    reading = b;
    /* If a deck is up, that is what the slate says and what the reader came
       to read — open on the page rather than on the chalk underneath it. */
    readPic = !!b.slide;
    sheet.hidden = false;
    sheet.dataset.open = "1";
    if (hooks.onOpen) hooks.onOpen();
    paintRead();

    sheet.onclick = function (e) { if (e.target === sheet) api.closeRead(); };
    var cl = el("br-close");
    if (cl) cl.onclick = function () { api.closeRead(); };
    return true;
  };

  api.closeRead = function () {
    var sheet = el("board-read");
    if (sheet) { sheet.hidden = true; sheet.dataset.open = ""; sheet.onclick = null; }
    reading = null;
    readPic = false;
    if (hooks.onClose) hooks.onClose();
  };
  api.isReading = function () { return !!reading; };

  function paintRead() {
    var b = reading;
    if (!b) return;
    var titleEl = el("br-title"), byEl = el("br-by");
    if (titleEl) titleEl.textContent = b.name;
    /* A slide stands in for the pinned picture here: it is the picture that
       is on the slate, and everything below already knows how to show one. */
    var shown = b.slide || b.pic;
    if (byEl) {
      var line = b.slide ? slideCaption(b) : (b.by ? "Chalked up by " + b.by : "");
      byEl.textContent = line;
      byEl.hidden = !line;
    }

    /* The picture. Its own button, its own view: a plot pinned to a board is
       usually the thing somebody actually wants to look at, and shrinking it
       into a column of prose helps nobody. */
    var picWrap = el("br-pic"), picBtn = el("br-picopen"), dl = el("br-picdl");
    if (picWrap) {
      picWrap.innerHTML = "";
      picWrap.hidden = !shown;
      if (shown) {
        var im = document.createElement("img");
        im.src = shown;
        im.alt = (b.slide ? "Slide on " : "Pinned to ") + b.name;
        picWrap.appendChild(im);
      }
    }
    if (picBtn) {
      picBtn.hidden = !shown;
      picBtn.textContent = readPic
        ? "Show the writing"
        : (b.slide ? "Open the slide" : "Open the picture");
      picBtn.onclick = function () { readPic = !readPic; paintRead(); };
    }
    if (dl) {
      dl.hidden = !shown;
      if (shown) {
        /* The href stays as a plain fallback; the click goes through the
           posters' downloader, which names the file after the board and
           gives it the extension its bytes actually have. */
        var base = (b.name || "board") + (b.slide ? " - slide" + (b.slidePage ? " " + b.slidePage : "") : "");
        dl.href = shown;
        dl.setAttribute("download", base.replace(/[^\w.-]+/g, "-") + (/^data:image\/png/i.test(shown) ? ".png" : ".jpg"));
        dl.onclick = function (e) {
          if (!window.QVPosters || !QVPosters.download) return;
          e.preventDefault();
          var now = reading && (reading.slide || reading.pic);
          QVPosters.download(now || shown, base).catch(function (err) {
            if (hooks.toast) hooks.toast(esc(err.message || "That download did not work."));
          });
        };
      } else {
        dl.onclick = null;
        dl.removeAttribute("href");
      }
    }

    var sheet = el("board-read");
    if (sheet) sheet.classList.toggle("picmode", !!(readPic && shown));

    /* The writing itself. */
    var host = el("br-text");
    if (!host) return;
    if (readPic && shown) { host.hidden = true; return; }
    host.hidden = false;

    var text = b.src;
    if (text == null || !String(text).trim()) {
      host.innerHTML = '<p class="br-empty">Nothing is chalked up here yet' +
        (b.slide ? ' \u2014 there is a deck on the slate.'
                 : b.pic ? ' \u2014 only the picture above.'
                         : '. Walk up to it and press E to write.') + '</p>';
      wireReadWrite();
      return;
    }

    /* Paint the words straight away and let the equations land as they are
       rasterised: MathJax is fetched on first use, and a reader should not
       be looking at an empty panel while that happens. */
    var toks = tokenize(String(text));
    host.innerHTML = "";
    var frag = document.createDocumentFragment();
    var para = document.createElement("p");
    frag.appendChild(para);
    var jobs = [];
    toks.forEach(function (tk) {
      if (tk.t === "br") {
        para = document.createElement("p");
        frag.appendChild(para);
        return;
      }
      if (tk.t === "text") {
        para.appendChild(document.createTextNode(tk.s));
        return;
      }
      var slot = document.createElement("span");
      slot.className = tk.display ? "br-math display" : "br-math";
      slot.textContent = (tk.display ? "$$" : "$") + tk.s + (tk.display ? "$$" : "$");
      if (tk.display) {
        para = document.createElement("p");
        para.className = "br-displayline";
        frag.appendChild(para);
        para.appendChild(slot);
        para = document.createElement("p");
        frag.appendChild(para);
      } else {
        para.appendChild(slot);
      }
      jobs.push(render(tk.s, tk.display, CHALK).then(function (m) {
        if (m.bad || !reading || reading !== b) return;
        var img = document.createElement("img");
        img.src = m.img.src;
        /* REF is the rasterising size; on screen an em of chalk is about
           19px in this panel, so scale to that rather than to the board. */
        var em = tk.display ? 24 : 19;
        img.width = Math.round(m.w * em / REF);
        img.height = Math.round(m.h * em / REF);
        img.alt = tk.s;
        slot.textContent = "";
        slot.appendChild(img);
      }).catch(function () {}));
    });
    /* drop the trailing empties a display equation leaves behind */
    Array.prototype.slice.call(frag.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && !n.childNodes.length) frag.removeChild(n);
    });
    host.appendChild(frag);
    wireReadWrite();
  }

  /* "Write on it" is only offered when you are actually close enough to
     pick up the chalk, because otherwise pressing it would do nothing. */
  function wireReadWrite() {
    var wb = el("br-write");
    if (!wb || !reading) return;
    var pos = hooks.position ? hooks.position() : null;
    var close = !!(pos && reading.x != null &&
                   Math.hypot(pos.x - reading.x, pos.z - reading.z) <= REACH + 1.5);
    wb.hidden = !close;
    wb.onclick = function () {
      var id = reading.id;
      api.closeRead();
      api.open(id);
    };
  }

  /* ---------------------------------------------------------- interact */
  function nearest(px, pz) {
    var best = null, bd = REACH * REACH;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.x == null) continue;
      var dx = px - b.x, dz = pz - b.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = b; }
    }
    return best;
  }

  api.prompt = function (px, pz) {
    if (open) return null;
    var R = window.QVRooms;
    /* Sitting down comes first: stand up, then pick up the chalk. */
    if (R && R.isSeated && R.isSeated()) return null;
    var b = nearest(px, pz);
    if (!b) return null;
    var p = {
      id: "board-" + b.id, key: "E", act: "write-board", board: b.id,
      label: b.src ? "Add to the board" : "Write on the board"
    };
    /* Standing at the board to speak is exactly when you want to write, so
       this takes E — but leave a way back out of the speaking slot. */
    if (R && R.isSpeaking && R.isSpeaking()) {
      p.alt = { key: "Q", label: "Finish speaking", act: "stop-speaking" };
    }
    return p;
  };

  /* -------------------------------------------------------------- edit */
  var open = null, prev = null, prevTimer = 0, pendingPic;

  function el(id) { return document.getElementById(id); }

  function myUid() { return (hooks.uid && hooks.uid()) || ""; }
  function heldByOther(id) {
    var h = hooks.holder ? hooks.holder(id) : null;
    return h && h.u && h.u !== myUid() ? h : null;
  }
  /* With no claims wired in at all (solo, or a test) the board is ours. */
  function holds(id) { return hooks.holds ? !!hooks.holds(id) : !heldByOther(id); }
  function claim(id) {
    return hooks.claim ? hooks.claim(id) : Promise.resolve({ ok: true });
  }

  api.open = function (id) {
    var b = boards[id];
    if (!b || open) return;
    var sheet = el("board");
    if (!sheet) return;
    open = b;

    el("board-title").textContent = b.name;
    var input = el("board-input");
    input.value = b.src || "";
    sheet.hidden = false;
    sheet.dataset.open = "1";
    if (hooks.onOpen) hooks.onOpen();
    setTimeout(function () { input.focus(); }, 0);
    schedulePreview();

    input.oninput = schedulePreview;
    el("board-form").onsubmit = function (e) { e.preventDefault(); commit(input.value); };
    el("board-cancel").onclick = function () { close(); };
    /* Wipe means wipe: the board goes blank there and then and the box
       closes, the same as writing does. Clearing only the text box and
       leaving the sheet sitting there looked like nothing had happened. */
    el("board-wipe").onclick = function () { commit(""); };

    /* A printout, a plot or a page of a PDF, taped up beside the chalk. The
       poster hall already knows how to turn a file into one picture, so use
       that rather than a second copy of it. */
    pendingPic = undefined;
    var pf = el("board-pic");
    /* One document per board. Chalk is for everybody, but a picture or a
       deck belongs to whoever put it up, and until they take it down the
       picker says whose it is instead of offering to replace it. */
    var other = heldByOther(b.id);
    if (pf) pf.disabled = !!other;
    var pdBtn = el("board-picoff");
    if (pdBtn) pdBtn.hidden = !!other;
    if (pf && other) {
      pf.value = "";
      pf.onchange = null;
      el("board-picnote").textContent = (other.n || "Someone else") + " has a document up on this board. " +
        "You can still write in chalk; pictures free up when they take theirs down.";
    } else if (pf) {
      pf.value = "";
      el("board-picnote").textContent = b.pic ? "A picture is pinned up. Choose another to replace it." : "";
      pf.onchange = function () {
        var file = this.files && this.files[0];
        if (!file || !window.QVPosters) return;
        el("board-picnote").textContent = "Reading " + file.name + "…";
        QVPosters.fromFile(file).then(function (url) {
          pendingPic = url;
          el("board-picnote").textContent = "Picture ready — about " + Math.round(url.length / 1024) + " kB.";
          schedulePreview();
        }).catch(function (e) {
          pendingPic = undefined;
          pf.value = "";
          el("board-picnote").textContent = e.message || "That file could not be used.";
        });
      };
    }
    var pd = el("board-picoff");
    if (pd) pd.onclick = function () {
      pendingPic = null;
      if (pf) pf.value = "";
      el("board-picnote").textContent = "The picture will come down.";
      schedulePreview();
    };
    /* Clicking the dimmed surround is the ordinary way out of a sheet, and
       a way back to the village that does not depend on finding a button. */
    sheet.onclick = function (e) { if (e.target === sheet) close(); };
    input.onkeydown = function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(input.value); }
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
  };

  function commit(text) {
    var b = open;
    if (!b) return;
    var name = hooks.name ? hooks.name() : "";
    var newPic = pendingPic;
    var hasPic = newPic !== undefined && newPic !== null;
    var wiping = !String(text).trim() && !hasPic;
    /* The picture already up is only ours to carry forward if we hold the
       board. Somebody else's stays theirs — writing chalk under it must not
       re-publish it under our name. */
    var mineUp = holds(b.id);
    close();
    if (hasPic) {
      /* Claim first. Of two people pinning at the same moment, the server
         gives the board to one; the other's chalk still goes up. */
      claim(b.id).then(function (res) {
        if (!res.ok) {
          if (hooks.toast) {
            hooks.toast("<b>" + esc((res.holder && res.holder.n) || "Someone else") + "</b> got to <b>" +
                        esc(b.name) + "</b> first — your picture was not pinned. " +
                        "It frees up when they take theirs down.");
          }
          if (String(text).trim()) finish(b, text, name, false, null);
          return;
        }
        finish(b, text, name, false, newPic);
      });
      return;
    }
    /* undefined leaves the picture on the slate exactly as it is */
    finish(b, text, name, wiping,
           newPic !== undefined ? (mineUp || newPic !== null ? newPic : undefined)
                                : (mineUp ? (wiping ? null : b.pic) : undefined));
  }

  function finish(b, text, name, wiping, pic) {
    /* Say so straight away. The chalk itself may wait on MathJax, and a
       board that goes quiet for a second should not look like a page that
       has stopped responding. */
    if (hooks.toast) {
      hooks.toast(wiping ? "Wiped <b>" + esc(b.name) + "</b> clean"
                         : "Chalking up on <b>" + esc(b.name) + "</b>…");
    }
    api.write(b.id, wiping ? "" : text.slice(0, 1200), wiping ? "" : name, pic)
      .catch(function (e) {
        if (hooks.toast) hooks.toast("The chalk would not take: " + esc((e && e.message) || "unknown"));
      });
  }

  function close() {
    var sheet = el("board");
    if (sheet) { sheet.hidden = true; sheet.dataset.open = ""; }
    var input = el("board-input");
    if (input) { input.oninput = null; input.onkeydown = null; }
    if (sheet) sheet.onclick = null;
    open = null;
    clearTimeout(prevTimer);
    if (hooks.onClose) hooks.onClose();
  }
  api.close = close;
  api.isOpen = function () { return !!open; };

  /* A small slate under the box, painted by exactly the same code as the
     real one, so what you see is what goes up. */
  function schedulePreview() {
    clearTimeout(prevTimer);
    prevTimer = setTimeout(drawPreview, 220);
  }
  function drawPreview() {
    if (!open) return;
    var host = el("board-preview");
    if (!host) return;
    if (!prev) {
      var c = document.createElement("canvas");
      prev = { canvas: c, ctx: c.getContext("2d"), tex: { needsUpdate: false }, seed: null, by: "" };
    }
    prev.canvas.width = 800;
    prev.canvas.height = Math.round(800 * (open.h / open.w));
    prev.w = open.w; prev.h = open.h;
    prev.src = el("board-input").value;
    prev.pic = (pendingPic === undefined) ? open.pic : pendingPic;
    prev.by = "";
    if (prev.canvas.parentNode !== host) {
      host.innerHTML = "";
      host.appendChild(prev.canvas);
    }
    paint(prev);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.QVBoard = api;
})();

/* The Commons used to carry a large painted activity board, redrawn every
 * few seconds from the presence stream. It has been taken down: a board you
 * have to walk to the middle of the village to read is the wrong place for
 * something that is meant to reach everybody the moment it starts.
 *
 * Its job is now split between two things that find you instead:
 *   - the announcement that slides in when an activity begins, and
 *   - the Live Activities button, which lists everything running.
 * Both live in js/activities.js.
 *
 * The old API is kept as a no-op so nothing that still calls it has to know,
 * and so removing the board costs nothing per frame.
 */
(function () {
  "use strict";
  var noop = function () {};
  window.QVActivityBoard = {
    build: noop, setPresence: noop, setSelf: noop, update: noop, removed: true
  };
})();
