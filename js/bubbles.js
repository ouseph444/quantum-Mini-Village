/* Quantum Village — speech bubbles over heads.
 *
 * When somebody says something in the chat, it comes up over their head as
 * a bubble in the world: a sprite in the scene, not a line of HTML, so it
 * rides along with them wherever they walk, cycle or drive.
 *
 * Each bubble is one small canvas drawn once, when the message arrives, and
 * uploaded once as a texture. Every frame costs a projection and a little
 * arithmetic per bubble on screen — there are only ever a handful — and
 * nothing at all when nobody is talking.
 *
 * Sizing. A sprite of fixed world size is unreadable at forty metres and
 * enormous at four, so the bubble is scaled with the camera distance up to
 * FULL_SIZE_TO metres (it holds a steady size on screen, like the name
 * tags), and past that it is left to shrink with distance like anything
 * else in the world. Past HIDE_BEYOND it is not drawn.
 *
 * Crowds. Bubbles that would cover each other on screen are stacked: the
 * nearest speaker keeps their place, and anybody behind is lifted clear.
 *
 *   QVBubbles.say(key, getObject, text, { name, ann, clearPx })
 *     key        one bubble per key: a second message replaces the first
 *     getObject  returns the avatar's Object3D, or nothing once they have
 *                gone (the bubble goes with them)
 *     clearPx    how many screen pixels above the head to leave free, for
 *                the name tag; a number, or a function returning one
 *   QVBubbles.clear(key)
 *   QVBubbles.update(dt, viewerPosition)   — once a frame, before render
 */
(function () {
  "use strict";
  var T = window.THREE;
  var V = window.QV;

  var R = 2;                  /* canvas pixels per CSS pixel: crisp on retina */
  var MAX_W = 240;            /* text width before wrapping, CSS px */
  var FONT = 15, LINE = 20, MAX_LINES = 6;
  var PAD_X = 13, PAD_Y = 10, RADIUS = 13, TAIL = 9, MARGIN = 8;
  var FULL_SIZE_TO = 38;      /* metres: steady on-screen size up to here */
  var HIDE_BEYOND = 95;       /* metres from the viewer */
  var MAX_BUBBLES = 20;
  var FADE_MS = 450, POP_MS = 160;
  var SANS = '"Archivo", system-ui, -apple-system, "Segoe UI", sans-serif';

  var bubbles = {};           /* key -> bubble */
  var count = 0;
  var v1 = T ? new T.Vector3() : null, v2 = T ? new T.Vector3() : null;

  function now() { return performance.now(); }

  /* ------------------------------------------------------------ drawing */
  function wrap(ctx, text, width) {
    var words = String(text).replace(/\s+/g, " ").trim().split(" ");
    var lines = [], line = "";
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      /* a single word longer than the bubble is broken where it has to be */
      while (ctx.measureText(w).width > width) {
        var cut = w.length - 1;
        while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > width) cut--;
        if (line) { lines.push(line); line = ""; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      var test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > width && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    if (lines.length > MAX_LINES) {
      lines = lines.slice(0, MAX_LINES);
      var last = lines[MAX_LINES - 1];
      while (last && ctx.measureText(last + "…").width > width) last = last.slice(0, -1);
      lines[MAX_LINES - 1] = last.replace(/\s+$/, "") + "…";
    }
    return lines;
  }

  function roundedWithTail(ctx, x, y, w, h, r, tail) {
    var cx = x + w / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(cx + tail * 0.8, y + h);
    ctx.lineTo(cx, y + h + tail);
    ctx.lineTo(cx - tail * 0.8, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* Paint a message onto the bubble's canvas, sized to fit it. */
  function paint(b, text, opt) {
    var c = b.canvas, ctx = c.getContext("2d");
    var body = "500 " + FONT + "px " + SANS, head = "700 10.5px " + SANS;
    var name = opt.name ? String(opt.name).toUpperCase() : "";
    ctx.font = body;
    var lines = wrap(ctx, text, MAX_W);
    var tw = 0;
    lines.forEach(function (l) { tw = Math.max(tw, ctx.measureText(l).width); });
    ctx.font = head;
    var nameText = (opt.ann ? "📢 " : "") + name;
    var nw = nameText ? Math.min(MAX_W, ctx.measureText(nameText).width) : 0;
    var headH = nameText ? 15 : 0;

    var w = Math.ceil(Math.max(tw, nw, 28) + PAD_X * 2);
    var h = Math.ceil(PAD_Y * 2 + headH + lines.length * LINE - (LINE - FONT) * 0.5);
    var cw = w + MARGIN * 2, ch = h + TAIL + MARGIN * 2;
    c.width = cw * R; c.height = ch * R;           /* resizing also clears it */
    ctx = c.getContext("2d");
    ctx.setTransform(R, 0, 0, R, 0, 0);

    /* the card, with a soft shadow under it */
    ctx.save();
    ctx.shadowColor = "rgba(20,52,47,.30)";
    ctx.shadowBlur = 7; ctx.shadowOffsetY = 2;
    roundedWithTail(ctx, MARGIN, MARGIN, w, h, RADIUS, TAIL);
    ctx.fillStyle = "rgba(250,245,233,.97)";
    ctx.fill();
    ctx.restore();
    roundedWithTail(ctx, MARGIN, MARGIN, w, h, RADIUS, TAIL);
    ctx.lineWidth = opt.ann ? 2 : 1;
    ctx.strokeStyle = opt.ann ? "#E8B04B" : "rgba(30,74,68,.22)";
    ctx.stroke();

    var y = MARGIN + PAD_Y;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    if (nameText) {
      ctx.font = head;
      ctx.fillStyle = "#8A6212";
      ctx.fillText(nameText, MARGIN + PAD_X, y, MAX_W);
      y += headH;
    }
    ctx.font = body;
    ctx.fillStyle = "#1E4A44";
    lines.forEach(function (l, i) { ctx.fillText(l, MARGIN + PAD_X, y + i * LINE); });

    b.cssW = cw; b.cssH = ch;
    /* the tip of the tail is the point that sits over the head */
    b.sprite.center.set(0.5, MARGIN / ch);
    b.tex.needsUpdate = true;
  }

  function make() {
    var canvas = document.createElement("canvas");
    var tex = new T.CanvasTexture(canvas);
    tex.minFilter = T.LinearFilter;
    tex.generateMipmaps = false;
    var mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    var sprite = new T.Sprite(mat);
    sprite.renderOrder = 999;       /* over the scenery, never clipped by a head or a wall edge */
    sprite.visible = false;
    V.getScene().add(sprite);
    return { canvas: canvas, tex: tex, mat: mat, sprite: sprite, lift: 0 };
  }

  function drop(key) {
    var b = bubbles[key];
    if (!b) return;
    if (b.sprite.parent) b.sprite.parent.remove(b.sprite);
    b.tex.dispose(); b.mat.dispose();
    delete bubbles[key];
    count--;
  }

  /* ---------------------------------------------------------------- api */
  function say(key, getObj, text, opt) {
    if (!T || !V || !V.getScene || !key || !getObj) return;
    text = String(text || "").trim();
    if (!text) return;
    opt = opt || {};
    var b = bubbles[key];
    if (!b) {
      /* too many at once: the one about to disappear anyway makes room */
      if (count >= MAX_BUBBLES) {
        var soonest = null;
        Object.keys(bubbles).forEach(function (k) { if (!soonest || bubbles[k].until < bubbles[soonest].until) soonest = k; });
        if (soonest) drop(soonest);
      }
      b = bubbles[key] = make();
      count++;
    }
    b.getObj = getObj;
    b.clearPx = opt.clearPx == null ? 8 : opt.clearPx;
    paint(b, text, opt);
    /* long enough to read: a few seconds, and more for more words */
    var ms = Math.max(4500, Math.min(13000, 3000 + text.length * 60));
    b.born = now();
    b.until = b.born + ms;
  }

  var api = {
    say: say,
    clear: drop,
    count: function () { return count; },

    update: function (dt, viewer) {
      if (!count) return;
      var cam = V.getCamera && V.getCamera();
      if (!cam) return;
      var t = now(), H = window.innerHeight || 800, W = window.innerWidth || 1200;
      var tanHalf = Math.tan((cam.fov || 50) * Math.PI / 360);
      var headY = (V.PERSON && V.PERSON.headTop) || 2.8;
      var shown = [];

      Object.keys(bubbles).forEach(function (key) {
        var b = bubbles[key];
        var obj = b.getObj();
        if (!obj || t >= b.until) { drop(key); return; }
        var ox = obj.position.x, oy = obj.position.y + headY + 0.5, oz = obj.position.z;
        if (viewer && Math.hypot(ox - viewer.x, oz - viewer.z) > HIDE_BEYOND) { b.sprite.visible = false; return; }
        var d = cam.position.distanceTo(v1.set(ox, oy, oz));
        v1.project(cam);
        if (v1.z > 1 || v1.z < -1) { b.sprite.visible = false; return; }
        /* how many screen pixels one metre upright is, just here */
        v2.set(ox, oy + 1, oz).project(cam);
        var pxUp = Math.max(1, (v1.y - v2.y) * -0.5 * H);
        var pxPerM = H / (2 * Math.max(0.1, d) * tanHalf);
        var k = Math.min(1, FULL_SIZE_TO / Math.max(0.1, d));   /* on-screen scale */
        var clear = typeof b.clearPx === "function" ? b.clearPx() : b.clearPx;
        shown.push({
          b: b, d: d, ox: ox, oy: oy, oz: oz, pxUp: pxUp, pxPerM: pxPerM, k: k, clear: clear,
          sx: (v1.x * 0.5 + 0.5) * W, sy: (-v1.y * 0.5 + 0.5) * H - clear,
          w: b.cssW * k, h: b.cssH * k
        });
      });

      /* Stack them: nearest first keeps its place, the rest are lifted
         above whatever they would otherwise cover. */
      shown.sort(function (a, c) { return a.d - c.d; });
      var placed = [];
      shown.forEach(function (s) {
        var bottom = s.sy, left = s.sx - s.w / 2, right = s.sx + s.w / 2;
        for (var pass = 0; pass < 8; pass++) {
          var hit = null;
          for (var i = 0; i < placed.length; i++) {
            var p = placed[i];
            if (left < p.r && right > p.l && bottom > p.t && bottom - s.h < p.b) { hit = p; break; }
          }
          if (!hit) break;
          bottom = hit.t - 3;
        }
        placed.push({ l: left, r: right, t: bottom - s.h, b: bottom });
        var want = s.sy - bottom;                         /* lift, screen px */
        s.b.lift += (want - s.b.lift) * Math.min(1, dt * 10);

        var b = s.b, age = t - b.born;
        var fade = Math.min(1, (b.until - t) / FADE_MS);
        var pop = age < POP_MS ? 0.86 + 0.14 * (age / POP_MS) : 1;
        /* world size that shows the canvas at k times its CSS size */
        var sc = (s.k / s.pxPerM) * pop;
        b.sprite.scale.set(b.cssW * sc, b.cssH * sc, 1);
        b.sprite.position.set(s.ox, s.oy + (s.clear + b.lift) / s.pxUp, s.oz);
        b.mat.opacity = Math.max(0, fade);
        b.sprite.visible = true;
      });
    }
  };

  window.QVBubbles = api;
})();
