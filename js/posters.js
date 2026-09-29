/* Quantum Village — posters.
 *
 * A poster session: pin a PNG, a JPG or a PDF to a board, give it a title
 * with mathematics in it if the title needs mathematics, and let anyone walk
 * up and read it full size.
 *
 * Where the files go. Cloud Storage has needed a billing account since
 * February 2026, and this project is on the free plan, so nothing is
 * uploaded anywhere: the picture is decoded in the browser, scaled down to
 * poster size, re-encoded as a JPEG and kept as a data URL. A PDF is opened
 * with PDF.js and its first page becomes that picture — which is what a
 * poster is anyway. Both libraries load the first time somebody pins
 * something and never before.
 *
 * That puts a ceiling on it: a poster has to come in under about 700 kB
 * once compressed, because that is what fits in a Firestore document with
 * room to spare. api.store is the seam — give it a function that uploads
 * and returns a URL and the ceiling goes away without anything else here
 * changing.
 */
(function () {
  "use strict";
  var V = window.QV;
  var T = window.THREE;

  var api = {};
  var frames = {};
  var list = [];
  var hallWinnerFrames = {};
  var hooks = {};
  var winnerFrame = null;
  var winnerFrames = [];
  var bySlot = {};            /* hallId -> number -> frame, for registered stands */
  var likeCounts = {}, likeMine = {};

  var MAX_EDGE = 1500;        /* a poster is read from a few feet away */
  var MAX_BYTES = 700000;     /* comfortably inside a Firestore document */
  var REACH = 6.0;
  var PAPER = "#F6F1E4";
  var INK = "#1A2B28";

  api.init = function (h) {
    hooks = h || {};
    if (window.QVInteract) {
      Object.keys(frames).forEach(function (id) {
        bindInteract(frames[id]);
      });
    }
  };
  api.get = function (id) { return frames[id] || null; };
  api.all = function (hallId) {
    if (hallId) {
      return list.filter(function (f) { return f.hallId === hallId; });
    }
    return list.slice();
  };
  /* The nearest stand in a hall that is free for us: empty, and not held
     by somebody else. For the hall's "Upload Poster" button. */
  api.freeFrame = function (hallId, px, pz) {
    var best = null, bd = Infinity, me = myUid();
    for (var i = 0; i < list.length; i++) {
      var r = list[i].reg;
      if (list[i].hallId === hallId && r && r.uid === me && me) return list[i].id;
    }
    list.forEach(function (f) {
      if (f.hallId !== hallId || f.src || f.reg || heldByOther(f.id)) return;
      var d = (f.x == null) ? 1e12 : (px - f.x) * (px - f.x) + (pz - f.z) * (pz - f.z);
      if (d < bd) { bd = d; best = f; }
    });
    return best ? best.id : null;
  };
  /* Swap in a real uploader and the size ceiling goes with it. */
  api.store = null;
  api.onPin = null;
  /* The stand that carries a hall's poster number, if there is one. */
  api.frameForSlot = function (hallId, num) { return (bySlot[hallId] && bySlot[hallId][num]) || null; };
  api.slotCount = function (hallId) { return Object.keys(bySlot[hallId] || {}).length; };

  /* ------------------------------------------------------------- frames */
  function bindInteract(f) {
    if (!window.QVInteract || !f || !f.panel) return;
    window.QVInteract.add({
      id: "click-poster-" + f.id,
      object: f.panel,
      x: f.x, z: f.z, r: f.displayOnly ? 9.0 : 6.0,
      label: f.displayOnly
        ? (f.src ? "View BEST POSTER" : "BEST POSTER · Waiting for live votes")
        : (f.src ? ("Read " + (plain(f.title) || "poster")) : f.reg ? ("Poster " + f.num + " · reserved") : "Pin up a poster"),
      verb: f.displayOnly ? "view poster" : (f.src ? "read poster" : "pin poster"),
      onUse: function () {
        if (f.displayOnly) {
          if (f.src) {
            api.openView(f.id);
          } else if (hooks.toast) {
            hooks.toast("The <b>BEST POSTER</b> display is waiting for live votes.");
          }
        } else {
          if (f.src) {
            api.openView(f.id);
          } else {
            api.openPin(f.id);
          }
        }
      }
    });
  }

  api.register = function (o) {
    if (!o || !o.id || !T || !V) return null;
    if (frames[o.id]) return frames[o.id];

    var hallId = o.hallId || (o.id.indexOf("poster-hall-2") === 0 ? "poster-hall-2" : "poster-hall");
    var c = document.createElement("canvas");
    var px = Math.min(1400, Math.max(640, Math.round(o.w * 120)));
    c.width = px;
    c.height = Math.max(320, Math.round(px * (o.h / o.w)));

    var tex = new T.CanvasTexture(c);
    tex.anisotropy = 4;
    var mat = new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide });
    var panel = V.panel(o.parent, o.w, o.h, mat, o.ox || 0, o.oy || 0, o.oz || 0, o.ry);

    var f = {
      id: o.id,
      hallId: hallId,
      name: o.name || "a poster board",
      canvas: c, ctx: c.getContext("2d"), tex: tex,
      w: o.w, h: o.h,
      x: o.wx, z: o.wz,
      src: null,          /* the picture, as a data URL */
      title: "",          /* its caption, TeX and all */
      by: "",
      likes: 0,
      liked: false,
      displayOnly: !!o.displayOnly,
      img: null,
      panel: panel,
      num: o.num || 0,      /* its poster number in the hall */
      likeKey: o.id,        /* what its likes are filed under */
      live: null,           /* what the live village has pinned here */
      reg: null,            /* the registered participant who holds it, if any */
      slot: null            /* what the number plate under it says */
    };
    frames[f.id] = f;
    if (f.num && !f.displayOnly) {
      (bySlot[hallId] || (bySlot[hallId] = {}))[f.num] = f;
      makePlate(f, o);
    }
    if (!f.displayOnly) list.push(f);
    if (f.displayOnly) {
      hallWinnerFrames[hallId] = f;
      winnerFrames.push(f);
      if (!winnerFrame) winnerFrame = f;
    }
    paintEmpty(f);
    bindInteract(f);
    return f;
  };

  function paintEmpty(f) {
    var g = f.ctx, W = f.canvas.width, H = f.canvas.height;
    if (f.reg && !f.displayOnly) { paintReserved(f); return; }
    g.fillStyle = "#E7E0CE"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(26,43,40,.18)"; g.lineWidth = 3;
    g.setLineDash([12, 9]);
    g.strokeRect(16, 16, W - 32, H - 32);
    g.setLineDash([]);
    g.fillStyle = "rgba(26,43,40,.38)";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "600 " + Math.round(H * 0.075) + 'px Georgia, "Times New Roman", serif';
    g.fillText(f.displayOnly ? "BEST POSTER" : "Poster space", W / 2, H / 2 - H * 0.035);
    g.font = Math.round(H * 0.045) + "px system-ui, sans-serif";
    g.fillText(f.displayOnly ? "waiting for live likes" : "press E to pin one up", W / 2, H / 2 + H * 0.06);
    f.tex.needsUpdate = true;
  }

  /* Held for a registered participant who has not pinned their poster yet. */
  function paintReserved(f) {
    var g = f.ctx, W = f.canvas.width, H = f.canvas.height, r = f.reg;
    g.fillStyle = "#EDE6D3"; g.fillRect(0, 0, W, H);
    g.strokeStyle = r.comp ? "rgba(184,134,47,.8)" : "rgba(26,43,40,.35)"; g.lineWidth = 6;
    g.strokeRect(14, 14, W - 28, H - 28);
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = INK;
    g.font = "700 " + Math.round(H * 0.13) + 'px Georgia, "Times New Roman", serif';
    g.fillText("Poster " + f.num, W / 2, H * 0.22);
    g.font = "600 " + Math.round(H * 0.05) + "px system-ui, sans-serif";
    g.fillStyle = "rgba(26,43,40,.6)";
    g.fillText((r.comp ? "\uD83C\uDFC6 COMPETITION ENTRY · " : "") + (r.pending ? "AWAITING APPROVAL" : "RESERVED"), W / 2, H * 0.36);
    g.fillStyle = INK;
    g.font = "600 " + Math.round(H * 0.06) + 'px Georgia, "Times New Roman", serif';
    wrap(g, r.title || "", W / 2, H * 0.5, W * 0.84, H * 0.075, 3);
    g.font = Math.round(H * 0.045) + "px system-ui, sans-serif";
    g.fillStyle = "rgba(26,43,40,.7)";
    g.fillText(r.name + (r.inst ? " · " + r.inst : ""), W / 2, H * 0.8, W * 0.9);
    g.font = Math.round(H * 0.036) + "px system-ui, sans-serif";
    g.fillStyle = "rgba(26,43,40,.45)";
    g.fillText("poster not yet pinned up", W / 2, H * 0.89);
    f.tex.needsUpdate = true;
  }
  function wrap(g, text, x, y, maxW, lineH, maxLines) {
    var words = String(text).split(/\s+/), line = "", n = 0;
    for (var i = 0; i < words.length && n < maxLines; i++) {
      var t = line ? line + " " + words[i] : words[i];
      if (g.measureText(t).width > maxW && line) {
        g.fillText(n === maxLines - 1 ? line + "…" : line, x, y + n * lineH);
        n++; line = words[i];
      } else line = t;
    }
    if (line && n < maxLines) g.fillText(line, x, y + n * lineH);
  }

  /* A stand wears its number on a small plate underneath, with what is
     happening on it when a poster event is running in the hall. */
  function makePlate(f, o) {
    var c = document.createElement("canvas");
    c.width = 512; c.height = 112;
    var tex = new T.CanvasTexture(c);
    var lw = Math.min(o.w * 0.62, 5.2), lh = lw * (c.height / c.width);
    var off = 0.12, ry = o.ry || 0;
    V.panel(o.parent, lw, lh, new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide }),
            (o.ox || 0) + Math.sin(ry) * off, (o.oy || 0) - o.h / 2 - lh / 2 - 0.08,
            (o.oz || 0) + Math.cos(ry) * off, ry);
    f.plate = { canvas: c, ctx: c.getContext("2d"), tex: tex };
    paintPlate(f);
  }
  var PLATE = {
    available:   { bg: "#2F5D50", fg: "#E9F5EE", label: "Available" },
    registered:  { bg: "#8A6A2B", fg: "#FFF4DC", label: "Registered" },
    pending:     { bg: "#6B6B6B", fg: "#F2F2F2", label: "Awaiting approval" },
    uploaded:    { bg: "#1F4E79", fg: "#E6F0FA", label: "Poster uploaded" },
    competition: { bg: "#B8862F", fg: "#1A2B28", label: "Competition entry" }
  };
  function paintPlate(f) {
    if (!f.plate) return;
    var g = f.plate.ctx, W = f.plate.canvas.width, H = f.plate.canvas.height;
    var st = f.slot && PLATE[f.slot.state];
    g.clearRect(0, 0, W, H);
    g.fillStyle = st ? st.bg : "#1A2B28";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(244,235,216,.55)"; g.lineWidth = 4;
    g.strokeRect(3, 3, W - 6, H - 6);
    g.fillStyle = st ? st.fg : "#F4EBD8";
    g.textBaseline = "middle";
    if (!st) {
      g.textAlign = "center";
      g.font = "700 58px Georgia, serif";
      g.fillText("POSTER " + f.num, W / 2, H / 2 + 2);
    } else {
      g.textAlign = "left";
      g.font = "700 50px Georgia, serif";
      var head = "P" + f.num;
      g.fillText(head, 22, H / 2 + 2);
      var hx = 22 + g.measureText(head).width + 18;
      g.font = "700 30px system-ui, sans-serif";
      g.fillText((f.slot.state === "competition" ? "\uD83C\uDFC6 " : "") + st.label, hx, f.slot.name ? H * 0.34 : H / 2);
      if (f.slot.name) {
        g.font = "26px system-ui, sans-serif";
        var nm = f.slot.name;
        while (nm.length > 3 && g.measureText(nm).width > W - hx - 18) nm = nm.slice(0, -2);
        g.fillText(nm === f.slot.name ? nm : nm + "…", hx, H * 0.7);
      }
    }
    f.plate.tex.needsUpdate = true;
  }
  /* state: available | registered | pending | uploaded | competition, or
     null when no poster event is running in the hall. */
  api.setSlot = function (id, state, name) {
    var f = frames[id];
    if (!f) return;
    var next = state ? { state: state, name: name || "" } : null;
    if (JSON.stringify(next) === JSON.stringify(f.slot)) return;
    f.slot = next;
    paintPlate(f);
  };

  /* ------------------------------------------------------------- import */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = function () { rej(new Error("could not fetch " + src.split("/").pop())); };
      document.head.appendChild(s);
    });
  }

  var pdfLib = null;
  function pdfjs() {
    if (pdfLib) return pdfLib;
    var base = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
    pdfLib = loadScript(base + "pdf.min.js").then(function () {
      var lib = window.pdfjsLib;
      if (!lib) throw new Error("PDF.js did not start");
      /* The worker has to be same-origin — a browser will not build one
         straight from a CDN URL, and PDF.js then sits there waiting on a
         worker that never starts. Fetch the script and run it from a blob
         of our own instead. */
      return fetch(base + "pdf.worker.min.js").then(function (r) {
        if (!r.ok) throw new Error("worker " + r.status);
        return r.text();
      }).then(function (code) {
        lib.GlobalWorkerOptions.workerSrc =
          URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        return lib;
      });
    });
    return pdfLib;
  }

  /* Lent to the seminar halls. A deck there is the same PDF.js, loaded the
     same once-only way — a second copy of this loader would mean a second
     copy of the library and a second worker blob for no reason. */
  api.pdfjs = function () { return pdfjs(); };

  /* Nothing here may hang the sheet for ever; a poster that will not open
     should say so and let the visitor pick another file. */
  function within(ms, work, what) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        rej(new Error(what + " took too long — try a smaller file, or an image."));
      }, ms);
      work.then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
                function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }

  function readAs(file, how) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error("that file could not be read")); };
      how === "buf" ? r.readAsArrayBuffer(file) : r.readAsDataURL(file);
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

  /* Down to poster size, on white — a JPEG has no transparency, and a PNG
     with a clear background would otherwise come out on black. */
  function encode(source, sw, sh) {
    var scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    var g = c.getContext("2d");
    g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(source, 0, 0, c.width, c.height);

    var q = 0.86, url = c.toDataURL("image/jpeg", q);
    /* Step the quality down until it fits rather than refusing outright. */
    while (url.length > MAX_BYTES && q > 0.4) {
      q -= 0.1;
      url = c.toDataURL("image/jpeg", q);
    }
    if (url.length > MAX_BYTES) {
      throw new Error("That is a very large poster. Try a smaller or simpler image.");
    }
    return url;
  }

  /* A file from the visitor's machine, whatever kind, becomes one picture. */
  api.fromFile = function (file) {
    if (!file) return Promise.reject(new Error("no file"));
    var name = (file.name || "").toLowerCase();
    var isPdf = file.type === "application/pdf" || /\.pdf$/.test(name);
    var isImg = /^image\/(png|jpeg|jpg)$/.test(file.type) || /\.(png|jpe?g)$/.test(name);

    if (!isPdf && !isImg) {
      return Promise.reject(new Error("Posters go up as PNG, JPG or PDF."));
    }
    if (file.size > 40 * 1024 * 1024) {
      return Promise.reject(new Error("That file is over 40 MB — too big to open in a browser."));
    }

    if (isImg) {
      return readAs(file, "url").then(decode).then(function (im) {
        return encode(im, im.naturalWidth, im.naturalHeight);
      });
    }
    /* A poster is its first page. */
    return within(45000, readAs(file, "buf").then(function (buf) {
      return pdfjs().then(function (lib) {
        return lib.getDocument({ data: new Uint8Array(buf) }).promise;
      });
    }), "That PDF").then(function (doc) {
      return doc.getPage(1);
    }).then(function (page) {
      var v1 = page.getViewport({ scale: 1 });
      var scale = Math.min(3, MAX_EDGE / Math.max(v1.width, v1.height));
      var vp = page.getViewport({ scale: scale });
      var c = document.createElement("canvas");
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      var g = c.getContext("2d");
      g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, c.width, c.height);
      return page.render({ canvasContext: g, viewport: vp }).promise.then(function () {
        return encode(c, c.width, c.height);
      });
    });
  };

  /* -------------------------------------------------------- the caption */
  /* Short, centred, and able to hold mathematics, because a poster title
     usually does. Built on the same TeX pipeline as the blackboards. */
  function drawTitle(g, text, W, y, maxW, fontPx, colour) {
    var toks = tokenize(text);
    var jobs = toks.filter(function (t) { return t.t === "math"; }).map(function (t) {
      return window.QVBoard.renderMath(t.s, false, colour)
        .then(function (m) { if (!m.bad) t.m = m; else { t.t = "text"; t.s = "$" + t.s + "$"; } })
        .catch(function () { t.t = "text"; t.s = "$" + t.s + "$"; });
    });
    return Promise.all(jobs).then(function () {
      var REF = window.QVBoard.REF || 96;
      g.font = titleFont(fontPx);
      var lines = [], cur = [], curW = 0;
      function push() { lines.push({ parts: cur, w: curW }); cur = []; curW = 0; }
      toks.forEach(function (tk) {
        if (tk.t === "math" && tk.m) {
          var s = fontPx / REF, w = tk.m.w * s;
          if (curW + w > maxW && cur.length) push();
          cur.push({ t: "math", img: tk.m.img, w: w, h: tk.m.h * s, asc: tk.m.asc * s });
          curW += w;
          return;
        }
        String(tk.s || "").split(/(\s+)/).forEach(function (wd) {
          if (!wd) return;
          var ww = g.measureText(wd).width;
          if (curW + ww > maxW && cur.length && wd.trim()) push();
          if (!cur.length && !wd.trim()) return;
          cur.push({ t: "text", s: wd, w: ww });
          curW += ww;
        });
      });
      if (cur.length) push();

      g.fillStyle = colour;
      g.textAlign = "left";
      g.textBaseline = "alphabetic";
      lines.slice(0, 3).forEach(function (ln, i) {
        var x = (W - ln.w) / 2, base = y + (i + 1) * fontPx * 1.28;
        ln.parts.forEach(function (p) {
          if (p.t === "text") g.fillText(p.s, x, base);
          else g.drawImage(p.img, x, base - p.asc, p.w, p.h);
          x += p.w;
        });
      });
      return lines.length;
    });
  }
  function titleFont(px) {
    return '600 ' + Math.round(px) + 'px Georgia, "Times New Roman", serif';
  }
  /* Same rule as the blackboards: $…$ is mathematics, \$ is a dollar. */
  function tokenize(src) {
    var out = [], buf = "", i = 0, n = String(src || "").length;
    src = String(src || "");
    function flush() { if (buf) { out.push({ t: "text", s: buf }); buf = ""; } }
    while (i < n) {
      var ch = src.charAt(i);
      if (ch === "\\" && src.charAt(i + 1) === "$") { buf += "$"; i += 2; continue; }
      if (ch === "$") {
        var close = src.indexOf("$", i + 1);
        if (close < 0) { buf += ch; i++; continue; }
        flush();
        out.push({ t: "math", s: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      buf += ch; i++;
    }
    flush();
    return out;
  }

  /* --------------------------------------------------------- the boards */
  function paint(f) {
    if (!f.src) { paintEmpty(f); return Promise.resolve(); }
    return decode(f.src).then(function (im) {
      f.img = im;
      var g = f.ctx, W = f.canvas.width, H = f.canvas.height;
      g.fillStyle = PAPER; g.fillRect(0, 0, W, H);

      var pad = Math.round(W * 0.035);
      var capH = f.title ? Math.round(H * 0.17) : Math.round(H * 0.05);
      var boxW = W - pad * 2, boxH = H - pad - capH;
      var s = Math.min(boxW / im.naturalWidth, boxH / im.naturalHeight);
      var dw = im.naturalWidth * s, dh = im.naturalHeight * s;
      var dx = (W - dw) / 2, dy = pad + (boxH - dh) / 2;

      g.fillStyle = "rgba(26,43,40,.10)";
      g.fillRect(dx + 4, dy + 5, dw, dh);
      g.drawImage(im, dx, dy, dw, dh);
      g.strokeStyle = "rgba(26,43,40,.22)"; g.lineWidth = 2;
      g.strokeRect(dx, dy, dw, dh);

      /* Keep the live vote total on every poster, like a conference badge. */
      var voteLabel = "♥ " + (f.likes || 0);
      g.font = "700 " + Math.round(H * 0.045) + "px system-ui, sans-serif";
      var voteW = g.measureText(voteLabel).width + Math.round(W * 0.035);
      g.fillStyle = "rgba(26,43,40,.88)";
      g.fillRect(W - voteW - pad, pad, voteW, Math.round(H * 0.075));
      g.fillStyle = "#F4EBD8"; g.textAlign = "right"; g.textBaseline = "middle";
      g.fillText(voteLabel, W - pad - Math.round(W * 0.017), pad + Math.round(H * 0.037));

      if (f.comp || (f.reg && f.reg.comp)) {
        var compLabel = "\uD83C\uDFC6 COMPETITION";
        g.font = "700 " + Math.round(H * 0.04) + "px system-ui, sans-serif";
        var compW = g.measureText(compLabel).width + Math.round(W * 0.035);
        g.fillStyle = "rgba(232,176,75,.95)";
        g.fillRect(pad, pad, compW, Math.round(H * 0.075));
        g.fillStyle = INK; g.textAlign = "left";
        g.fillText(compLabel, pad + Math.round(W * 0.017), pad + Math.round(H * 0.037));
      }

      var done = f.title
        ? drawTitle(g, f.title, W, pad + boxH + Math.round(H * 0.012),
                    boxW, Math.round(H * 0.052), INK)
        : Promise.resolve(0);

      return done.then(function () {
        if (f.by) {
          g.font = Math.round(H * 0.032) + "px system-ui, sans-serif";
          g.fillStyle = "rgba(26,43,40,.55)";
          g.textAlign = "center";
          g.fillText("— " + f.by, W / 2, H - Math.round(H * 0.022));
        }
        f.tex.needsUpdate = true;
      });
    }).catch(function () { paintEmpty(f); });
  }

  api.pin = function (id, src, title, by) {
    var f = frames[id];
    if (!f || f.displayOnly) return Promise.resolve();
    f.live = { src: src || null, title: title || "", by: by || "", u: src ? myUid() : "",
               comp: src && f.live ? f.live.comp : null };
    f.pinnedAt = Date.now();
    var p = f.reg ? Promise.resolve() : show(f, f.live, true);
    if (api.onPin) { try { api.onPin(id, src || null, title || "", by || "", f.pinnedAt); } catch (e) {} }
    return p;
  };
  /* What a stand shows: its registered participant's poster (or their
     reservation) if it has one, otherwise whatever the live village has
     pinned there. */
  function show(f, v, fresh) {
    v = v || { src: null, title: "", by: "", u: "", comp: null };
    var key = f.reg ? f.reg.likeKey : f.id;
    var keySwap = key !== f.likeKey;
    f.likeKey = key;
    f.u = v.src ? (v.u || "") : "";
    var newComp = (v.src && v.comp && v.comp.competitionId) ? v.comp : null;
    var compSwap = (newComp ? newComp.competitionId : "") !== (f.comp ? f.comp.competitionId : "");
    f.comp = newComp;
    var srcSwap = (v.src || null) !== (f.src || null);
    if (!fresh && !srcSwap && !keySwap && !compSwap && (v.title || "") === f.title && (v.by || "") === f.by &&
        f.regSig === regSig(f)) return Promise.resolve();
    f.regSig = regSig(f);
    if (fresh || keySwap || srcSwap) {
      f.likes = fresh && !f.reg ? 0 : (likeCounts[key] || 0);
      f.liked = fresh && !f.reg ? false : !!likeMine[key];
    }
    f.src = v.src || null; f.title = v.title || ""; f.by = v.by || "";
    return paint(f);
  }
  function regSig(f) { var r = f.reg; return r ? [r.uid, r.name, r.inst, r.title, r.comp, r.pending].join("|") : ""; }
  function regView(f) {
    var r = f.reg;
    return { src: r.src || null, title: r.src ? (r.ptitle || r.title) : "", by: r.name, u: r.uid, comp: null };
  }
  /* `comp`, for a poster pinned during a poster competition, is
     { competitionId, expiresAt }; the board wears a small badge for it. */
  api.receive = function (id, src, title, by, u, comp) {
    var f = frames[id];
    if (!f) return Promise.resolve();
    f.live = { src: src || null, title: title || "", by: by || "",
               u: u !== undefined ? u : (f.live && f.live.u), comp: comp || null };
    if (f.reg) return Promise.resolve();
    return show(f, f.live);
  };
  /* reg: { eid, uid, name, inst, title, comp, pending, src, ptitle } or
     null. The stand belongs to that participant for as long as it is set,
     whatever the live village pins. */
  api.setReg = function (id, reg) {
    var f = frames[id];
    if (!f || f.displayOnly) return Promise.resolve();
    if (reg) reg.likeKey = "r-" + reg.eid + "-" + reg.uid;
    var had = !!f.reg;
    f.reg = reg || null;
    if (reg) return show(f, regView(f));
    return had ? show(f, f.live) : Promise.resolve();
  };
  api.reg = function (id) { return (frames[id] && frames[id].reg) || null; };
  /* Likes, as counted by the database: key -> count, and which of those
     keys this resident has liked. A stand looks itself up by its likeKey. */
  api.syncLikes = function (counts, mine) {
    likeCounts = counts || {};
    likeMine = mine || {};
    list.forEach(function (f) {
      var n = likeCounts[f.likeKey] || 0, l = !!likeMine[f.likeKey];
      if (n === f.likes && l === f.liked) return;
      f.likes = n; f.liked = l;
      if (f.src) paint(f);
    });
  };
  api.setLikes = function (id, count) {
    var f = frames[id];
    if (f) {
      f.likes = Math.max(0, Number(count) || 0);
      if (f.src) paint(f);
    }
  };
  api.setLiked = function (id, liked) {
    var f = frames[id];
    if (f) f.liked = !!liked;
  };
  /* Like, or take the like back: one per resident per poster, toggled. */
  function toggleLike(f, after) {
    if (!f || !f.src || f.displayOnly || f.liking) return false;
    var hook = f.liked ? hooks.unlike : hooks.like;
    if (!hook) return false;
    var was = f.liked;
    f.liking = true;
    hook(f.likeKey, function (ok) {
      f.liking = false;
      /* The database's own echo usually lands before this does, and has
         already set the count; only step it if it has not. */
      if (ok !== false && f.liked === was) {
        f.liked = !was;
        f.likes = Math.max(0, (f.likes || 0) + (was ? -1 : 1));
        likeMine[f.likeKey] = f.liked;
        paint(f);
      }
      if (after) after();
    });
    return true;
  }
  api.like = function (id) {
    var f = frames[id];
    return toggleLike(f, function () {
      if (hooks.toast) hooks.toast(f.liked ? "♥ You liked this poster." : "Like removed.");
    });
  };
  api.setWinner = function (hallId, winner) {
    if (typeof hallId === "object") {
      winner = hallId;
      hallId = null;
    }
    var targets = [];
    if (hallId && hallWinnerFrames[hallId]) {
      targets = [hallWinnerFrames[hallId]];
    } else if (!hallId) {
      targets = winnerFrames.slice();
    }
    if (!targets.length) return;
    targets.forEach(function (wf) {
      if (!wf) return;
      if (!winner || !winner.src || (winner.likes == null || Number(winner.likes) <= 0)) {
        wf.sourceId = null;
        wf.src = null;
        wf.title = "";
        wf.by = "";
        wf.likes = 0;
        wf.liked = false;
        paintEmpty(wf);
        return;
      }
      wf.sourceId = winner.id || null;
      wf.src = winner.src || null;
      wf.title = winner.title || "Most liked poster";
      wf.by = winner.by || "";
      wf.likes = Math.max(0, Number(winner.likes) || 0);
      wf.liked = false;
      paint(wf);
    });
  };

  /* ---------------------------------------------------------- interact */
  function nearest(px, pz) {
    var best = null, bd = REACH * REACH;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (f.x == null) continue;
      var dx = px - f.x, dz = pz - f.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = f; }
    }
    var wReach = 8.5;
    var wReach2 = wReach * wReach;
    for (var j = 0; j < winnerFrames.length; j++) {
      var wf = winnerFrames[j];
      if (wf.x == null) continue;
      var wdx = px - wf.x, wdz = pz - wf.z, wd2 = wdx * wdx + wdz * wdz;
      if (wd2 < wReach2 && wd2 < bd) { bd = wd2; best = wf; }
    }
    return best;
  }
  api.prompt = function (px, pz) {
    if (viewing || pinning) return null;
    var R = window.QVRooms;
    if (R && R.isSeated && R.isSeated()) return null;
    var f = nearest(px, pz);
    if (!f) return null;
    if (f.displayOnly) {
      if (f.src) {
        return {
          id: "poster-" + f.id, key: "E", act: "view-poster", poster: f.id,
          label: "View BEST POSTER · " + (plain(f.title) || "Most liked research")
        };
      }
      return {
        id: "poster-" + f.id, key: "", act: "", poster: f.id,
        label: "BEST POSTER · Waiting for live votes"
      };
    }
    if (f.reg && !f.src) {
      return f.reg.uid === myUid()
        ? { id: "poster-" + f.id, key: "E", act: "pin-poster", poster: f.id, label: "Pin up your poster · Poster " + f.num }
        : { id: "poster-" + f.id, key: "", act: "", poster: f.id,
            label: "Poster " + f.num + " · reserved for " + (f.reg.name || "a participant") };
    }
    if (!f.src) {
      var h = heldByOther(f.id);
      return { id: "poster-" + f.id, key: "E", act: "pin-poster", poster: f.id,
               label: h ? (h.n || "Someone") + " is pinning up here" : "Pin up a poster" };
    }
    return { id: "poster-" + f.id, key: "E", act: "view-poster", poster: f.id,
             label: "Read " + (plain(f.title) || "this poster"),
         alt: { key: "L", label: (f.liked ? "Unlike (" : "Like (") + (f.likes || 0) + ")", act: "like-poster", poster: f.id } };
  };
  function plain(t) {
    return String(t || "").replace(/\$[^$]*\$/g, "…").replace(/\s+/g, " ").trim().slice(0, 34);
  }

  /* ------------------------------------------------------------ pin box */
  var pinning = null, viewing = null, picked = null;

  function el(id) { return document.getElementById(id); }

  function myUid() { return (hooks.uid && hooks.uid()) || ""; }
  /* The claim on a stand, if somebody other than us holds it. */
  function heldByOther(id) {
    var h = hooks.holder ? hooks.holder(id) : null;
    return h && h.u && h.u !== myUid() ? h : null;
  }
  function claim(id) {
    return hooks.claim ? hooks.claim(id) : Promise.resolve({ ok: true });
  }
  function occupiedMsg(f, who) {
    return "<b>" + esc(f.name) + "</b> is in use by <b>" + esc(who || "someone else") +
           "</b>. It frees up when they take their poster down.";
  }

  api.openPin = function (id) {
    var f = frames[id];
    if (!f || f.displayOnly || pinning || viewing) return;
    if (f.reg) {
      if (f.reg.uid === myUid()) return openPinReg(f);
      if (hooks.toast) hooks.toast("<b>Poster " + f.num + "</b> is registered to <b>" + esc(f.reg.name) +
                                   "</b> for a poster event. Only they can pin a poster here.");
      return;
    }
    /* One poster per stand. Whoever has it keeps it until they take it
       down, and the stand says whose it is rather than letting a second
       person pick a file and find out afterwards. */
    var h = heldByOther(f.id);
    if (h || (f.src && f.u && f.u !== myUid())) {
      if (hooks.toast) {
        hooks.toast(occupiedMsg(f, h ? h.n : f.by));
      }
      return;
    }
    pinning = f;
    picked = null;
    var sheet = el("poster-pin");
    if (!sheet) return;
    el("pp-where").textContent = f.name;
    if (el("pp-down")) el("pp-down").hidden = false;
    paintPinMode();
    el("pp-title").value = f.title || "";
    el("pp-file").value = "";
    ppSay("");
    ppPreview(f.src || null);
    sheet.hidden = false;
    if (hooks.onOpen) hooks.onOpen();

    el("pp-file").onchange = function () {
      var file = this.files && this.files[0];
      if (!file) return;
      ppSay("Reading " + file.name + "…");
      el("pp-go").disabled = true;
      api.fromFile(file).then(function (url) {
        picked = url;
        ppPreview(url);
        ppSay("Ready — about " + Math.round(url.length / 1024) + " kB.", true);
      }).catch(function (e) {
        picked = null;
        ppPreview(f.src || null);
        ppSay(e.message || "That file could not be used.");
      }).then(function () { el("pp-go").disabled = false; });
    };
    el("pp-form").onsubmit = function (e) {
      e.preventDefault();
      var src = picked || f.src;
      if (!src) return ppSay("Choose a PNG, JPG or PDF first.");
      var title = el("pp-title").value.slice(0, 160);
      var by = hooks.name ? hooks.name() : "";
      var go = el("pp-go");
      go.disabled = true;
      ppSay("Reserving " + f.name + "…", true);
      /* The claim is what makes the stand ours, and the server hands it to
         exactly one of two people who press this at the same moment. */
      claim(f.id).then(function (res) {
        go.disabled = false;
        if (pinning !== f) {
          /* closed while we waited: give the stand straight back */
          if (res.ok && hooks.release) hooks.release(f.id);
          return;
        }
        if (!res.ok) {
          ppSay("");
          closePin();
          if (hooks.toast) hooks.toast(occupiedMsg(f, res.holder && res.holder.n));
          return;
        }
        closePin();
        if (hooks.toast) hooks.toast("Pinning up on <b>" + esc(f.name) + "</b>…");
        api.pin(f.id, src, title, by);
      });
    };
    el("pp-cancel").onclick = closePin;
    el("pp-down").onclick = function () {
      closePin();
      api.pin(f.id, null, "", "");
      if (hooks.toast) hooks.toast("Took the poster down from <b>" + esc(f.name) + "</b>");
    };
    sheet.onclick = function (e) { if (e.target === sheet) closePin(); };
  };
  /* Our own registered stand: the poster goes to the registration and
     stays up until we take it down, whether or not we are here. */
  function openPinReg(f) {
    var sheet = el("poster-pin");
    if (!sheet || !hooks.pinReg) return;
    pinning = f;
    picked = null;
    el("pp-where").textContent = "Poster " + f.num + ", " + f.name;
    var head = el("pp-head"), note = el("pp-comp"), go = el("pp-go");
    if (head) head.textContent = "Pin up your registered poster";
    if (go) go.textContent = f.reg.src ? "Replace it" : "Pin it up";
    if (note) {
      note.hidden = false;
      note.innerHTML = (f.reg.comp ? "\uD83C\uDFC6 Competition entry · " : "") + "Your stand for <b>" +
        esc(f.reg.eventTitle || "the poster event") + "</b>. It stays up after you leave, until you take it down.";
    }
    el("pp-title").value = f.reg.ptitle || f.reg.title || "";
    el("pp-file").value = "";
    ppSay("");
    ppPreview(f.reg.src || null);
    var down = el("pp-down");
    if (down) down.hidden = !f.reg.src;
    sheet.hidden = false;
    if (hooks.onOpen) hooks.onOpen();
    el("pp-file").onchange = function () {
      var file = this.files && this.files[0];
      if (!file) return;
      ppSay("Reading " + file.name + "…");
      el("pp-go").disabled = true;
      api.fromFile(file).then(function (url) {
        picked = url;
        ppPreview(url);
        ppSay("Ready — about " + Math.round(url.length / 1024) + " kB.", true);
      }).catch(function (e) {
        picked = null;
        ppPreview(f.reg && f.reg.src || null);
        ppSay(e.message || "That file could not be used.");
      }).then(function () { el("pp-go").disabled = false; });
    };
    el("pp-form").onsubmit = function (e) {
      e.preventDefault();
      var src = picked || (f.reg && f.reg.src);
      if (!src) return ppSay("Choose a PNG, JPG or PDF first.");
      var go2 = el("pp-go");
      go2.disabled = true;
      ppSay("Pinning it up…", true);
      hooks.pinReg(f.id, src, el("pp-title").value.slice(0, 200)).then(function () {
        go2.disabled = false;
        closePin();
        if (hooks.toast) hooks.toast("\uD83D\uDCCC Your poster is up on <b>Poster " + f.num + "</b>.");
      }, function (err) {
        go2.disabled = false;
        ppSay((err && err.message) || "That did not go through.");
      });
    };
    el("pp-cancel").onclick = closePin;
    el("pp-down").onclick = function () {
      closePin();
      hooks.unpinReg(f.id).then(function () {
        if (hooks.toast) hooks.toast("Took your poster down. <b>Poster " + f.num + "</b> is still reserved for you.");
      }, function () {});
    };
    sheet.onclick = function (e) { if (e.target === sheet) closePin(); };
  }

  /* Pinning in a hall that is running a poster competition makes a
     competition poster, and the sheet says so, and what that means. */
  function paintPinMode() {
    if (!pinning) return;
    var c = hooks.competition ? hooks.competition(pinning.hallId) : null;
    var head = el("pp-head"), note = el("pp-comp"), go = el("pp-go");
    if (head) head.textContent = c ? "Pin up a competition poster" : "Pin up a poster";
    if (go) go.textContent = c ? "Enter the competition" : "Pin it up";
    if (note) {
      note.hidden = !c;
      note.innerHTML = c
        ? "\uD83C\uDFC6 <b>" + esc(c.title) + "</b> is running here. Your poster stays up " +
          "until the competition ends — " + esc(new Date(c.expiresAt).toLocaleString()) +
          " — even after you leave the village."
        : "";
    }
  }
  api.refreshMode = function () { paintPinMode(); };
  function ppSay(msg, ok) {
    var e = el("pp-err");
    if (!e) return;
    e.textContent = msg || "";
    e.hidden = !msg;
    e.classList.toggle("ok", !!ok);
  }
  function ppPreview(url) {
    var box = el("pp-prev");
    if (!box) return;
    box.innerHTML = url ? '<img alt="">' : '<span class="fine">Nothing chosen yet</span>';
    if (url) box.querySelector("img").src = url;
  }
  function closePin() {
    var sheet = el("poster-pin");
    if (sheet) { sheet.hidden = true; sheet.onclick = null; }
    if (el("pp-file")) el("pp-file").onchange = null;
    pinning = null; picked = null;
    if (hooks.onClose) hooks.onClose();
  }

  /* ----------------------------------------------------- the big screen */
  api.openView = function (id) {
    var f = frames[id];
    if (!f || !f.src || viewing || pinning) return;
    viewing = f;
    var sheet = el("poster-view");
    if (!sheet) return;
    el("pv-img").src = f.src;
    el("pv-by").textContent = (f.reg ? "Poster " + f.num + " · " : "") +
      ((f.comp || (f.reg && f.reg.comp)) && !f.displayOnly ? "\uD83C\uDFC6 Competition poster · " : "") + (f.by
      ? (f.displayOnly ? "★ Most Liked · Pinned up by " : "Pinned up by ") + f.by
      : (f.displayOnly ? "★ Most Liked Poster" : ""));
    var cap = el("pv-title");
    cap.textContent = "";
    sheet.hidden = false;
    if (hooks.onOpen) hooks.onOpen();
    /* The caption is typeset, so the mathematics in a title is real. */
    typesetInto(cap, f.title);
    var like = el("pv-like");
    if (like) {
      if (f.displayOnly) {
        like.style.display = "none";
        like.onclick = null;
      } else {
        like.style.display = "";
        var paintLike = function () {
          like.disabled = false;
          like.classList.toggle("liked", !!f.liked);
          like.setAttribute("aria-pressed", f.liked ? "true" : "false");
          like.textContent = (f.liked ? "♥ Liked (" : "♡ Like (") + (f.likes || 0) + ")";
          like.title = f.liked ? "Click again to remove your like" : "Like this poster";
        };
        paintLike();
        like.onclick = function () {
          like.disabled = true;
          if (!toggleLike(f, paintLike)) like.disabled = false;
        };
      }
    }
    var down = el("pv-down");
    if (down) {
      var own = !f.displayOnly && !!f.src && !!f.u && f.u === myUid();
      down.hidden = !own;
      down.onclick = own ? function () {
        closeView();
        if (f.reg) {
          if (hooks.unpinReg) hooks.unpinReg(f.id).catch(function () {});
          return;
        }
        api.pin(f.id, null, "", "");
        if (hooks.toast) hooks.toast("Took your poster down from <b>" + esc(f.name) +
                                     "</b> — the stand is free for someone else.");
      } : null;
    }
    var save = el("pv-save");
    if (save) {
      save.hidden = !f.src;
      save.disabled = false;
      save.onclick = function () {
        /* the stand's live copy, in case it changed while this was open */
        var src = (frames[f.id] && frames[f.id].src) || f.src;
        var base = [f.reg ? "Poster " + f.num : "", String(f.title || "").trim() || f.name || "poster"]
          .filter(Boolean).join(" - ");
        save.disabled = true;
        api.download(src, base).catch(function (e) {
          if (hooks.toast) hooks.toast(esc(e.message || "That download did not work."));
        }).then(function () { save.disabled = false; });
      };
    }
    /* Reporting a poster goes to the administrators with the poster named,
       so they know exactly which one without having to ask. */
    var rep = el("pv-report");
    if (rep) {
      rep.hidden = f.displayOnly || !f.src || !hooks.report;
      rep.onclick = rep.hidden ? null : function () {
        var what = 'Poster "' + (plain(f.title) || "untitled") + '" on ' + f.name +
                   (f.by ? ", pinned up by " + f.by : "") + (f.u ? " (" + f.u + ")" : "");
        closeView();
        hooks.report({ reportType: "inappropriate_content", subject: what.slice(0, 200) });
      };
    }
    el("pv-close").onclick = closeView;
    sheet.onclick = function (e) { if (e.target === sheet) closeView(); };
    openTalk(f);
  };
  function closeView() {
    closeTalk();
    var sheet = el("poster-view");
    if (sheet) { sheet.hidden = true; sheet.onclick = null; }
    var like = el("pv-like");
    if (like) { like.onclick = null; }
    var down = el("pv-down");
    if (down) { down.onclick = null; }
    var save = el("pv-save");
    if (save) { save.onclick = null; }
    var rep = el("pv-report");
    if (rep) { rep.onclick = null; }
    viewing = null;
    if (hooks.onClose) hooks.onClose();
  }
  /* ----------------------------------------------- questions and replies
   *
   * Every poster carries its own thread, filed under the same two keys as
   * the poster (see QVNet.watchPosterComments): a registered poster under
   * its event and its participant, a pinned one under its stand and whoever
   * pinned it. That last key is the poster's author, so "who may answer" is
   * decided by the path and the rules, never by a name typed into a form.
   * The BEST POSTER display shows the thread of the poster it is showing.
   */
  var talk = null;

  function Net() { return window.QVNet; }
  function threadOf(f) {
    if (!f) return null;
    if (f.displayOnly) return f.sourceId && frames[f.sourceId] ? threadOf(frames[f.sourceId]) : null;
    if (f.reg) return f.reg.src ? { kind: "reg", a: f.reg.eid, b: f.reg.uid } : null;
    return f.src && f.u ? { kind: "live", a: f.id, b: f.u } : null;
  }
  function isAdmin() { return !!(hooks.isAdmin && hooks.isAdmin()); }

  function openTalk(f) {
    closeTalk();
    var box = el("pv-talk"), N = Net(), t = threadOf(f);
    if (!box || !N || !N.watchPosterComments || !t) return;
    talk = { f: f, t: t, items: [], loaded: false, failed: false, sending: false, pendingId: "",
             replyTo: "", replyId: "", replySending: false, unwatch: null, tick: null };
    box.hidden = false;
    var pvbox = box.parentNode;
    if (pvbox) pvbox.classList.add("talk");

    var mine = myUid() === t.b;
    var live = N.posterCommentsLive && N.posterCommentsLive() && N.user && N.user();
    var form = el("pvt-form"), text = el("pvt-text");
    form.classList.toggle("off", !live);
    /* the author has nothing to ask themselves; what they add is a note */
    var kinds = form.querySelector(".pvt-kinds");
    if (kinds) kinds.hidden = mine;
    var q = form.querySelector('input[value="question"]');
    if (q) q.checked = true;
    text.value = "";
    text.placeholder = mine ? "Add a note for your visitors…" : "Ask the author a question…";
    talkSay(live ? "" : "Questions need the live village — sign in to take part.");
    el("pvt-send").disabled = false;
    el("pvt-send").textContent = "Post";
    Array.prototype.forEach.call(form.querySelectorAll('input[name="pvt-kind"]'), function (r) {
      r.onchange = function () {
        if (!mine) text.placeholder = r.value === "comment" ? "Leave a comment for the author…" : "Ask the author a question…";
      };
    });
    form.onsubmit = function (e) { e.preventDefault(); sendTop(); };
    text.onkeydown = function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTop(); }
    };
    var clear = el("pvt-clear");
    clear.onclick = clearAll;

    paintTalk();
    var cur = talk;
    talk.unwatch = N.watchPosterComments(t, function (list) {
      if (talk !== cur) return;
      talk.items = list || [];
      talk.loaded = true;
      talk.failed = false;
      paintTalk();
    }, function () {
      if (talk !== cur) return;
      talk.loaded = true;
      talk.failed = true;
      paintTalk();
    });
    /* "3 min ago" should not stay 3 min ago while the sheet is open */
    talk.tick = setInterval(function () {
      var list = el("pvt-list");
      if (!list) return;
      Array.prototype.forEach.call(list.querySelectorAll("[data-ts]"), function (n) {
        n.textContent = when(+n.getAttribute("data-ts"));
      });
    }, 60000);
  }

  function closeTalk() {
    if (!talk) return;
    if (talk.unwatch) talk.unwatch();
    if (talk.tick) clearInterval(talk.tick);
    talk = null;
    var box = el("pv-talk");
    if (box) {
      box.hidden = true;
      if (box.parentNode) box.parentNode.classList.remove("talk");
    }
    var form = el("pvt-form");
    if (form) form.onsubmit = null;
    var text = el("pvt-text");
    if (text) text.onkeydown = null;
    var clear = el("pvt-clear");
    if (clear) clear.onclick = null;
    var list = el("pvt-list");
    if (list) { list.innerHTML = ""; list.onclick = null; }
  }

  function talkSay(msg, err) {
    var n = el("pvt-note");
    if (!n) return;
    n.textContent = msg || "";
    n.classList.toggle("err", !!err);
  }

  function when(ts) {
    if (!ts) return "just now";
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    var d = new Date(ts), now = new Date();
    return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }) +
      ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  function fullTime(ts) { return ts ? new Date(ts).toLocaleString() : ""; }

  function msgHtml(c, author, reply) {
    var me = myUid();
    var byAuthor = c.userId === author;
    var tag = reply ? '<span class="pvt-tag author">Author reply</span>'
      : (byAuthor ? '<span class="pvt-tag author">Author</span>' : "") +
        (c.type === "question" ? '<span class="pvt-tag q">Question</span>' : '<span class="pvt-tag">Comment</span>');
    var acts = "";
    if (!reply && me && me === author && talk && !talk.replyTo) {
      acts += '<button type="button" class="pvt-link" data-act="reply" data-id="' + esc(c.id) + '">Reply</button>';
    }
    if (me && (c.userId === me || isAdmin())) {
      acts += '<button type="button" class="pvt-link del" data-act="del" data-id="' + esc(c.id) + '">Delete</button>';
    }
    return '<div class="pvt-msg' + (reply ? " reply" : "") + '">' +
      '<div class="pvt-meta"><span class="pvt-name">' + esc(c.userName || "Resident") + "</span>" + tag +
      '<span class="pvt-time" title="' + esc(fullTime(c.timestamp)) + '" data-ts="' + (c.timestamp || 0) + '">' +
      esc(when(c.timestamp)) + "</span></div>" +
      (c.userInst ? '<div class="pvt-meta"><span class="pvt-inst">' + esc(c.userInst) + "</span></div>" : "") +
      '<p class="pvt-body">' + esc(c.text) + "</p>" +
      (acts ? '<div class="pvt-acts">' + acts + "</div>" : "") +
      "</div>";
  }

  function paintTalk() {
    if (!talk) return;
    var list = el("pvt-list"), count = el("pvt-count"), clear = el("pvt-clear");
    if (!list) return;
    var t = talk.t, author = t.b;
    var tops = [], replies = {};
    talk.items.forEach(function (c) {
      if (c.type === "author_reply") (replies[c.parentCommentId] || (replies[c.parentCommentId] = [])).push(c);
      else tops.push(c);
    });
    talk.replies = replies;
    /* the question being answered was deleted under us */
    if (talk.replyTo && !tops.some(function (c) { return c.id === talk.replyTo; })) {
      talk.replyTo = ""; talk.replyId = ""; talk.replyDraft = ""; talk.replySending = false;
    }
    var shown = tops.length;
    if (count) count.textContent = talk.loaded && !talk.failed ? (shown ? shown + (shown === 1 ? " post" : " posts") : "") : "";
    if (clear) clear.hidden = !(isAdmin() && talk.items.length);

    /* keep the reader where they were, unless they were at the bottom */
    var atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    var draft = el("pvt-reply-text");
    var draftVal = draft ? draft.value : talk.replyDraft || "";
    var draftFocus = draft && document.activeElement === draft;

    var html;
    if (!talk.loaded) {
      html = '<div class="pvt-empty"><span class="pvt-spin" aria-hidden="true"></span>Loading questions…</div>';
    } else if (talk.failed) {
      html = '<div class="pvt-empty">The questions could not be loaded. Check your connection, or ask an ' +
             "administrator to publish the latest database rules.</div>";
    } else if (!tops.length) {
      html = '<div class="pvt-empty">No questions yet.' +
             (myUid() === author ? " Visitors' questions will appear here as they are asked." : " Be the first to ask the author something.") +
             "</div>";
    } else {
      html = tops.map(function (c) {
        var rs = replies[c.id] || [];
        var inner = msgHtml(c, author, false);
        if (rs.length) inner += '<div class="pvt-replies">' + rs.map(function (r) { return msgHtml(r, author, true); }).join("") + "</div>";
        if (talk.replyTo === c.id) {
          inner += '<form class="pvt-reply-form" id="pvt-reply-form" autocomplete="off">' +
            '<textarea id="pvt-reply-text" class="field pvt-text" rows="2" maxlength="1000" ' +
            'aria-label="Your reply as the poster\'s author" placeholder="Reply as the author…"></textarea>' +
            '<div class="pvt-row"><span class="pvt-note" id="pvt-reply-note" role="status"></span>' +
            '<button type="button" class="btn ghost small" data-act="cancel-reply">Cancel</button>' +
            '<button type="submit" class="btn small" id="pvt-reply-send">' + (talk.replySending ? "Posting…" : "Reply") + "</button></div></form>";
        }
        return '<div class="pvt-item" data-id="' + esc(c.id) + '">' + inner + "</div>";
      }).join("");
    }
    list.innerHTML = html;
    list.onclick = onListClick;

    var rf = el("pvt-reply-form");
    if (rf) {
      var rt = el("pvt-reply-text");
      rt.value = draftVal;
      el("pvt-reply-send").disabled = talk.replySending;
      rf.onsubmit = function (e) { e.preventDefault(); sendReply(); };
      rt.onkeydown = function (e) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(); }
      };
      rt.oninput = function () { if (talk) talk.replyDraft = rt.value; };
      if (draftFocus || talk.focusReply) {
        talk.focusReply = false;
        rt.focus();
        try { rt.setSelectionRange(rt.value.length, rt.value.length); } catch (e) {}
      }
      if (talk.replyErr) { var rn = el("pvt-reply-note"); if (rn) { rn.textContent = talk.replyErr; rn.classList.add("err"); } }
    }
    if (atEnd && talk.stickToEnd !== false) list.scrollTop = list.scrollHeight;
  }

  function onListClick(e) {
    var b = e.target.closest && e.target.closest("[data-act]");
    if (!b || !talk) return;
    var act = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    if (act === "reply") {
      talk.replyTo = id; talk.replyDraft = ""; talk.replyErr = ""; talk.focusReply = true;
      talk.stickToEnd = false;
      paintTalk();
      talk.stickToEnd = true;
      var rf = el("pvt-reply-form");
      if (rf && rf.scrollIntoView) rf.scrollIntoView({ block: "nearest" });
    } else if (act === "cancel-reply") {
      if (talk.replySending) return;
      talk.replyTo = ""; talk.replyDraft = ""; talk.replyId = ""; talk.replyErr = "";
      paintTalk();
    } else if (act === "del") {
      removeOne(id, b);
    }
  }

  /* Why a write was refused, in words a resident can act on. */
  function refusal(e) {
    var s = String((e && (e.code || "")) + " " + (e && e.message || ""));
    if (/permission|denied/i.test(s)) {
      return talk && talk.f && !threadOf(talk.f)
        ? "This poster has been taken down."
        : "The database refused it. The poster may have just come down, or the administrator " +
          "may need to publish the latest database rules.";
    }
    if (navigator.onLine === false) return "You are offline — connect and try again.";
    return "That did not go through — check your connection and try again.";
  }
  /* The database queues a write while offline rather than failing it, so
     a send can sit waiting; say so instead of looking stuck. A refusal is
     a real refusal — nothing was written — and the same id is reused on
     the next try. */
  function waitNote(cur, busy, say) {
    setTimeout(function () {
      if (talk === cur && busy()) say("Waiting for the connection — it will post when you are back online.");
    }, 6000);
  }

  function sendTop() {
    if (!talk || talk.sending) return;
    var N = Net(), text = el("pvt-text"), send = el("pvt-send");
    var body = String(text.value || "").trim();
    if (!body) { talkSay("Write something first.", true); text.focus(); return; }
    if (body.length > 1000) { talkSay("That is over 1000 characters.", true); return; }
    var mine = myUid() === talk.t.b;
    var pick = el("pvt-form").querySelector('input[name="pvt-kind"]:checked');
    var type = mine ? "comment" : (pick && pick.value === "comment" ? "comment" : "question");
    /* one id per message, kept until it is known to have landed */
    if (!talk.pendingId) talk.pendingId = N.newPosterCommentId(talk.t);
    var cur = talk, id = talk.pendingId;
    talk.sending = true;
    send.disabled = true; send.textContent = "Posting…";
    talkSay("");
    waitNote(cur, function () { return cur.sending; }, function (m) { talkSay(m); });
    N.addPosterComment(talk.t, id, {
      text: body, type: type, userName: hooks.name ? hooks.name() : "",
      userInst: hooks.inst ? hooks.inst() : ""
    }).then(function () { return true; }, function (e) {
      if (talk === cur) talkSay(refusal(e), true);
      return false;
    }).then(function (ok) {
      if (talk !== cur) return;
      talk.sending = false;
      send.disabled = false; send.textContent = "Post";
      if (!ok) return;
      talk.pendingId = "";
      text.value = "";
      talkSay("");
      var list = el("pvt-list");
      if (list) list.scrollTop = list.scrollHeight;
    });
  }

  function sendReply() {
    if (!talk || talk.replySending || !talk.replyTo) return;
    var N = Net(), rt = el("pvt-reply-text");
    var body = String(rt ? rt.value : "").trim();
    if (!body) { talk.replyErr = "Write your reply first."; paintTalk(); return; }
    if (myUid() !== talk.t.b) return;
    if (!talk.replyId) talk.replyId = N.newPosterCommentId(talk.t);
    var cur = talk, id = talk.replyId, parent = talk.replyTo;
    talk.replyDraft = body;
    talk.replySending = true; talk.replyErr = "";
    paintTalk();
    waitNote(cur, function () { return cur.replySending; }, function (m) {
      var rn = el("pvt-reply-note"); if (rn) rn.textContent = m;
    });
    N.addPosterComment(talk.t, id, {
      text: body, type: "author_reply", parentCommentId: parent,
      userName: hooks.name ? hooks.name() : "", userInst: hooks.inst ? hooks.inst() : ""
    }).then(function () { return true; }, function (e) {
      if (talk === cur) talk.replyErr = refusal(e);
      return false;
    }).then(function (ok) {
      if (talk !== cur) return;
      talk.replySending = false;
      if (ok) { talk.replyTo = ""; talk.replyId = ""; talk.replyDraft = ""; }
      paintTalk();
    });
  }

  function removeOne(id, btn) {
    if (!talk) return;
    var c = null;
    talk.items.forEach(function (x) { if (x.id === id) c = x; });
    if (!c) return;
    var kids = (talk.replies && talk.replies[id]) || [];
    var others = c.userId !== myUid();
    var what = c.type === "author_reply" ? "this reply" : c.type === "question" ? "this question" : "this comment";
    if (!window.confirm("Delete " + what + (others ? " by " + (c.userName || "this resident") : "") +
                        (kids.length ? " and the author's " + (kids.length === 1 ? "reply" : kids.length + " replies") + " to it" : "") +
                        "?\n\nThis cannot be undone.")) return;
    btn.disabled = true;
    var cur = talk;
    Net().deletePosterComment(talk.t, id, kids.map(function (r) { return r.id; })).then(function () {
      if (talk === cur && talk.replyTo === id) { talk.replyTo = ""; talk.replyId = ""; paintTalk(); }
    }, function (e) {
      btn.disabled = false;
      if (talk === cur) talkSay(refusal(e), true);
    });
  }

  /* Administrator: the whole thread on this one poster. */
  function clearAll() {
    if (!talk || !isAdmin()) return;
    var n = talk.items.length;
    if (!n) return;
    if (!window.confirm("Delete all " + n + (n === 1 ? " comment and reply" : " comments and replies") +
                        " on this poster?\n\nOther posters are not affected. This cannot be undone.")) return;
    var clear = el("pvt-clear"), cur = talk;
    clear.disabled = true;
    Net().clearPosterComments(talk.t).then(function () {
      if (talk === cur) talkSay("Every comment on this poster was deleted.");
    }, function (e) {
      if (talk === cur) talkSay(refusal(e), true);
    }).then(function () { clear.disabled = false; });
  }

  /* ------------------------------------------------------------ download */
  /* Save what is on a stand or a board as a file, exactly as it is stored.
   *
   * A data URL is decoded straight to its bytes — no canvas, no re-encoding —
   * so the file is byte-for-byte what the database holds, with the type the
   * data URL declares and an extension to match. An http(s) URL (what
   * api.store would hand back if uploads are ever switched on) is fetched as
   * a blob so the filename sticks; if the host will not allow that, the
   * browser is sent to the file directly. Nothing is uploaded anywhere.
   *
   * Resolves once the browser has the file; rejects with a sentence fit for
   * a toast. Works for board pictures and slides too — board.js calls it. */
  var EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
              "image/gif": "gif", "image/svg+xml": "svg", "application/pdf": "pdf" };
  function fileBase(name) {
    var s = String(name || "").replace(/\$[^$]*\$/g, " ").replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ").trim().slice(0, 80).replace(/[. ]+$/, "");
    return s || "poster";
  }
  function dataToBlob(src) {
    var comma = src.indexOf(",");
    if (comma < 0) throw new Error("bad data URL");
    var head = src.slice(5, comma), data = src.slice(comma + 1);
    var type = (head.split(";")[0] || "application/octet-stream").toLowerCase();
    if (!/;base64/i.test(head)) return new Blob([decodeURIComponent(data)], { type: type });
    var bin = atob(data), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type });
  }
  function saveBlob(blob, filename) {
    if (window.navigator && navigator.msSaveOrOpenBlob) { navigator.msSaveOrOpenBlob(blob, filename); return; }
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    /* long enough for a slow phone to start the download before it goes */
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 30000);
  }
  function named(base, type, src) {
    var ext = EXT[type] || (/\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(src || "") || [])[1] || "";
    base = fileBase(base);
    return ext && !new RegExp("\\." + ext + "$", "i").test(base) ? base + "." + ext.toLowerCase() : base;
  }
  api.download = function (src, baseName) {
    src = String(src || "");
    if (!src) return Promise.reject(new Error("There is no file here to download — it may have just been taken down."));
    if (/^data:/i.test(src)) {
      try {
        var blob = dataToBlob(src);
        saveBlob(blob, named(baseName, blob.type, ""));
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(new Error("That file could not be read in this browser."));
      }
    }
    if (!/^(https?:|blob:)/i.test(src)) return Promise.reject(new Error("That file cannot be downloaded."));
    if (typeof fetch !== "function") { window.open(src, "_blank", "noopener"); return Promise.resolve(); }
    return fetch(src, { mode: "cors", credentials: "omit" }).then(function (r) {
      if (r.status === 404 || r.status === 410) throw Object.assign(new Error("gone"), { gone: true });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error("denied"), { denied: true });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    }).then(function (blob) {
      saveBlob(blob, named(baseName, (blob.type || "").split(";")[0].toLowerCase(), src));
    }).catch(function (e) {
      if (e && e.gone) throw new Error("That file is no longer there — it may have been deleted.");
      if (e && e.denied) throw new Error("You do not have permission to download that file.");
      if (navigator.onLine === false) throw new Error("You are offline — connect and try again.");
      /* a host that will not share with scripts will still hand the file to
         the browser itself */
      window.open(src, "_blank", "noopener");
    });
  };

  api.close = function () { if (viewing) closeView(); if (pinning) closePin(); };
  api.isOpen = function () { return !!(viewing || pinning); };

  /* A caption in the page rather than on a canvas: text nodes and little
     images of the equations, side by side. */
  function typesetInto(host, text) {
    host.innerHTML = "";
    var toks = tokenize(text);
    toks.forEach(function (tk) {
      if (tk.t === "text") {
        host.appendChild(document.createTextNode(tk.s));
        return;
      }
      var slot = document.createElement("span");
      slot.textContent = "$" + tk.s + "$";
      host.appendChild(slot);
      window.QVBoard.renderMath(tk.s, false, "#F4EBD8").then(function (m) {
        if (m.bad) return;
        var im = new Image();
        im.src = m.img.src;
        im.style.height = "1.05em";
        im.style.verticalAlign = "-0.18em";
        slot.textContent = "";
        slot.appendChild(im);
      }).catch(function () {});
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.QVPosters = api;
})();
