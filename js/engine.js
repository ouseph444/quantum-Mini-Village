/* Quantum Village — world engine.
 *
 * The primitives every other world module is built from. Loaded before
 * village.js, which extends the same QV namespace.
 *
 *   caches      one geometry and one material per distinct shape/colour, so a
 *               thousand props cost a handful of GPU uploads
 *   batching    repeated props (trees, flowers, fences) collapse into
 *               InstancedMesh draw calls
 *   collision   circles for props, rotated boxes for walls, both looked up
 *               through a uniform grid instead of a linear scan
 *   structure   a building with real walls, real door gaps and a real inside
 *   interiors   roofs lift and walls go glassy when you walk in
 *
 * Nothing here touches the DOM or the network.
 */
(function () {
  "use strict";
  var T = window.THREE;
  var V = (window.QV = window.QV || {});

  /* How far from the origin the world goes. Movement is clamped to this. */
  V.WORLD_R = 900;

  /* ------------------------------------------------------------- caches */
  var GEO = {}, LAMBERT = {}, BASIC = {};

  V.geo = function (key, make) {
    var g = GEO[key];
    if (!g) { g = GEO[key] = make(); }
    return g;
  };
  /* Unit primitives. Everything is a scaled instance of one of these, so the
     whole village ships about a dozen geometries rather than thousands. */
  V.U = {
    box: function () { return V.geo("u.box", function () { return new T.BoxGeometry(1, 1, 1); }); },
    cyl: function (seg) {
      seg = seg || 12;
      return V.geo("u.cyl" + seg, function () { return new T.CylinderGeometry(1, 1, 1, seg); });
    },
    cone: function (seg) {
      seg = seg || 10;
      return V.geo("u.cone" + seg, function () { return new T.ConeGeometry(1, 1, seg); });
    },
    sph: function (seg) {
      seg = seg || 10;
      return V.geo("u.sph" + seg, function () { return new T.SphereGeometry(1, seg, Math.max(4, seg - 3)); });
    },
    dome: function (seg) {
      seg = seg || 16;
      return V.geo("u.dome" + seg, function () {
        return new T.SphereGeometry(1, seg, Math.max(6, seg >> 1), 0, Math.PI * 2, 0, Math.PI / 2);
      });
    },
    plane: function () { return V.geo("u.plane", function () { return new T.PlaneGeometry(1, 1); }); },
    circle: function (seg) {
      seg = seg || 20;
      return V.geo("u.circle" + seg, function () { return new T.CircleGeometry(1, seg); });
    },
    torus: function () { return V.geo("u.torus", function () { return new T.TorusGeometry(1, 0.1, 6, 20); }); }
  };

  /* Lambert is what the rest of the village uses; one material per colour. */
  V.color = function (hex) {
    var m = LAMBERT[hex];
    if (!m) { m = LAMBERT[hex] = new T.MeshLambertMaterial({ color: hex }); }
    return m;
  };
  V.flat = function (hex, opacity) {
    var key = hex + "|" + (opacity == null ? 1 : opacity);
    var m = BASIC[key];
    if (!m) {
      m = BASIC[key] = new T.MeshBasicMaterial({
        color: hex,
        transparent: opacity != null && opacity < 1,
        opacity: opacity == null ? 1 : opacity,
        depthWrite: !(opacity != null && opacity < 1)
      });
    }
    return m;
  };
  /* Windows and lamps brighten after dark; village.js walks these lists. */
  V.windowMats = V.windowMats || [];
  V.lampMats = V.lampMats || [];
  V.litGlass = function (tint) {
    var m = new T.MeshLambertMaterial({ color: tint || 0x9FC2C4, emissive: 0xFFD79A, emissiveIntensity: 0 });
    V.windowMats.push(m); return m;
  };
  V.litLamp = function (tint, glow) {
    var m = new T.MeshLambertMaterial({ color: tint || 0x4A4438, emissive: glow || 0xFFC46B, emissiveIntensity: 0 });
    V.lampMats.push(m); return m;
  };

  /* --------------------------------------------------------- mesh sugar */
  function parentOf(p) { return p || V.root; }

  V.bx = function (p, w, h, d, m, x, y, z, ry) {
    var o = new T.Mesh(V.U.box(), m);
    o.scale.set(w, h, d); o.position.set(x, y, z);
    if (ry) o.rotation.y = ry;
    parentOf(p).add(o); return o;
  };
  V.cy = function (p, rt, rb, h, m, x, y, z, seg) {
    var o;
    if (Math.abs(rt - rb) < 1e-4) {
      o = new T.Mesh(V.U.cyl(seg), m);
      o.scale.set(rt, h, rt);
    } else {
      o = new T.Mesh(V.geo("cyl." + rt.toFixed(2) + "." + rb.toFixed(2) + "." + (seg || 12), function () {
        return new T.CylinderGeometry(rt, rb, 1, seg || 12);
      }), m);
      o.scale.set(1, h, 1);
    }
    o.position.set(x, y, z); parentOf(p).add(o); return o;
  };
  V.sp = function (p, r, m, x, y, z, seg) {
    var o = new T.Mesh(V.U.sph(seg), m);
    o.scale.setScalar(r); o.position.set(x, y, z);
    parentOf(p).add(o); return o;
  };
  V.cn = function (p, r, h, m, x, y, z, seg) {
    var o = new T.Mesh(V.U.cone(seg), m);
    o.scale.set(r, h, r); o.position.set(x, y, z);
    parentOf(p).add(o); return o;
  };
  /* A flat piece of ground: circle lying in the xz plane. */
  V.ci = function (p, r, m, x, y, z, seg) {
    var o = new T.Mesh(V.U.circle(seg), m);
    o.scale.set(r, r, 1); o.rotation.x = -Math.PI / 2;
    o.position.set(x, y, z);
    parentOf(p).add(o); return o;
  };
  /* A flat rectangle lying in the xz plane (roads, floors, markings). */
  V.slab = function (p, w, d, m, x, y, z, ry) {
    var o = new T.Mesh(V.U.plane(), m);
    o.scale.set(w, d, 1);
    o.rotation.x = -Math.PI / 2;
    if (ry) o.rotation.z = -ry;
    o.position.set(x, y, z);
    parentOf(p).add(o); return o;
  };
  /* An upright billboard-ish rectangle (posters, boards, screens). */
  V.panel = function (p, w, h, m, x, y, z, ry) {
    var o = new T.Mesh(V.U.plane(), m);
    o.scale.set(w, h, 1); o.position.set(x, y, z);
    if (ry) o.rotation.y = ry;
    parentOf(p).add(o); return o;
  };

  /* ------------------------------------------------------- prop batching
   * Collect transforms, then emit one InstancedMesh per geometry+material.
   * Used for vegetation and street furniture, which dominate the object
   * count. A batch must be flushed before it renders. */
  V.batch = function () {
    var bins = {}, mtx = new T.Matrix4(), q = new T.Quaternion(),
        pos = new T.Vector3(), scl = new T.Vector3(), eul = new T.Euler();
    var api = {
      /* geometry, material, position, scale (vec3-ish), then rotations.
         rx is last because only ground-lying planes need it. */
      add: function (geometry, material, x, y, z, sx, sy, sz, ry, rz, rx) {
        var key = geometry.uuid + "|" + material.uuid;
        var bin = bins[key];
        if (!bin) { bin = bins[key] = { g: geometry, m: material, list: [] }; }
        eul.set(rx || 0, ry || 0, rz || 0);
        q.setFromEuler(eul);
        pos.set(x, y, z); scl.set(sx, sy == null ? sx : sy, sz == null ? sx : sz);
        bin.list.push(new T.Matrix4().compose(pos, q, scl));
        return api;
      },
      count: function () {
        var n = 0; Object.keys(bins).forEach(function (k) { n += bins[k].list.length; });
        return n;
      },
      flush: function (parent) {
        var out = [];
        Object.keys(bins).forEach(function (k) {
          var bin = bins[k];
          if (!bin.list.length) return;
          var im = new T.InstancedMesh(bin.g, bin.m, bin.list.length);
          for (var i = 0; i < bin.list.length; i++) im.setMatrixAt(i, bin.list[i]);
          im.instanceMatrix.needsUpdate = true;
          /* These never move, so let three.js skip the matrix maths. */
          im.matrixAutoUpdate = false;
          parentOf(parent).add(im);
          out.push(im);
        });
        bins = {};
        return out;
      }
    };
    return api;
  };

  /* ----------------------------------------------------------- collision
   * Two shapes: circles (props, trees, round things) and rotated boxes
   * (walls, platforms, long solids). Both go in one uniform grid. */
  var circles = (V.blockers = V.blockers || []);
  var boxes = (V.boxes = V.boxes || []);
  var CELL = 56, grid = null;

  V.blockCircle = function (x, z, r) {
    var c = { x: x, z: z, r: r };
    circles.push(c);
    if (grid) indexOne(c, "c");
    return c;
  };
  V.blockBox = function (x, z, hw, hd, ry) {
    var b = { x: x, z: z, hw: hw, hd: hd, ry: ry || 0,
              cos: Math.cos(ry || 0), sin: Math.sin(ry || 0) };
    boxes.push(b);
    if (grid) indexOne(b, "b");
    return b;
  };
  /* Remove a blocker again (a door that opens, a prop that is cleared). */
  V.unblock = function (b) {
    var i = circles.indexOf(b); if (i >= 0) circles.splice(i, 1);
    i = boxes.indexOf(b); if (i >= 0) boxes.splice(i, 1);
    V.buildIndex();
  };

  function cellKey(ix, iz) { return ix + ":" + iz; }
  /* Objects are inserted into every cell their bounds touch, grown by the
     largest query pad we ever use — so a query only has to look at the one
     cell the point falls in. */
  var PAD_MAX = 6;
  function indexOne(o, kind) {
    var reach = (kind === "c" ? o.r : Math.hypot(o.hw, o.hd)) + PAD_MAX;
    var x0 = Math.floor((o.x - reach) / CELL), x1 = Math.floor((o.x + reach) / CELL);
    var z0 = Math.floor((o.z - reach) / CELL), z1 = Math.floor((o.z + reach) / CELL);
    for (var ix = x0; ix <= x1; ix++) {
      for (var iz = z0; iz <= z1; iz++) {
        var k = cellKey(ix, iz);
        var cell = grid[k] || (grid[k] = { c: [], b: [] });
        cell[kind].push(o);
      }
    }
  }
  V.buildIndex = function () {
    grid = {};
    for (var i = 0; i < circles.length; i++) indexOne(circles[i], "c");
    for (var j = 0; j < boxes.length; j++) indexOne(boxes[j], "b");
    V.indexStats = { circles: circles.length, boxes: boxes.length, cells: Object.keys(grid).length };
    return V.indexStats;
  };
  var EMPTY = { c: [], b: [] };
  function cellAt(x, z) {
    if (!grid) return null;
    return grid[cellKey(Math.floor(x / CELL), Math.floor(z / CELL))] || EMPTY;
  }

  /* Push a point out of anything solid, then back inside the world edge.
     Returns a fresh {x,z}; the input is never mutated. */
  V.clearSpot = function (x, z, pad) {
    pad = Math.min(pad == null ? 1.1 : pad, PAD_MAX);
    for (var pass = 0; pass < 4; pass++) {
      var moved = false;
      var cell = cellAt(x, z);
      var cs = cell ? cell.c : circles, bs = cell ? cell.b : boxes;

      for (var i = 0; i < cs.length; i++) {
        var c = cs[i], dx = x - c.x, dz = z - c.z, rr = c.r + pad;
        var d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          var d = Math.sqrt(d2);
          if (d < 1e-4) { x = c.x + rr; z = c.z; }
          else { x = c.x + (dx / d) * rr; z = c.z + (dz / d) * rr; }
          moved = true;
        }
      }
      for (var j = 0; j < bs.length; j++) {
        var b = bs[j], ox = x - b.x, oz = z - b.z;
        var lx = ox * b.cos - oz * b.sin;
        var lz = ox * b.sin + oz * b.cos;
        var ew = b.hw + pad, ed = b.hd + pad;
        var px = ew - Math.abs(lx), pz = ed - Math.abs(lz);
        if (px > 0 && pz > 0) {
          /* leave by the nearest face */
          if (px < pz) lx = (lx < 0 ? -1 : 1) * ew;
          else lz = (lz < 0 ? -1 : 1) * ed;
          x = b.x + lx * b.cos + lz * b.sin;
          z = b.z - lx * b.sin + lz * b.cos;
          moved = true;
        }
      }
      if (!moved) break;
    }
    var lim = V.WORLD_R, rad = Math.hypot(x, z);
    if (rad > lim) { x = x / rad * lim; z = z / rad * lim; }
    return { x: x, z: z };
  };

  /* Is this point inside something solid? Used by the camera and by spawn
     placement; cheaper than clearSpot because it stops at the first hit. */
  V.blockedAt = function (x, z, pad) {
    pad = Math.min(pad == null ? 0 : pad, PAD_MAX);
    var cell = cellAt(x, z);
    var cs = cell ? cell.c : circles, bs = cell ? cell.b : boxes;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i], rr = c.r + pad;
      if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < rr * rr) return true;
    }
    for (var j = 0; j < bs.length; j++) {
      var b = bs[j], ox = x - b.x, oz = z - b.z;
      var lx = ox * b.cos - oz * b.sin, lz = ox * b.sin + oz * b.cos;
      if (Math.abs(lx) < b.hw + pad && Math.abs(lz) < b.hd + pad) return true;
    }
    return false;
  };

  /* An open patch of ground, for scattering things that must not overlap. */
  V.freeSpot = function (minR, maxR, clearance) {
    clearance = clearance || 3.2;
    minR = minR == null ? 20 : minR;
    maxR = maxR == null ? V.WORLD_R - 60 : maxR;
    for (var attempt = 0; attempt < 90; attempt++) {
      var a = Math.random() * Math.PI * 2;
      var r = minR + Math.random() * (maxR - minR);
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!V.blockedAt(x, z, clearance)) return { x: x, z: z };
    }
    return { x: 20, z: 30 };
  };

  /* A flat ribbon of surface following a polyline — roads, paths, lanes.
     One mesh per run, rather than a line of overlapping discs. */
  V.ribbon = function (pts, width, y, material, closed, parent) {
    pts = closed ? pts.concat([pts[0]]) : pts;
    var n = pts.length;
    if (n < 2) return null;
    var pos = new Float32Array(n * 2 * 3), idx = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i];
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      var tx = b[0] - a[0], tz = b[1] - a[1];
      var len = Math.hypot(tx, tz) || 1;
      var nx = -tz / len * (width / 2), nz = tx / len * (width / 2);
      pos[i * 6]     = p[0] + nx; pos[i * 6 + 1] = y; pos[i * 6 + 2] = p[1] + nz;
      pos[i * 6 + 3] = p[0] - nx; pos[i * 6 + 4] = y; pos[i * 6 + 5] = p[1] - nz;
      if (i < n - 1) { var k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    var g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    var m = new T.Mesh(g, material);
    m.matrixAutoUpdate = false;
    parentOf(parent).add(m);
    return m;
  };

  /* -------------------------------------------------------- soft shadow */
  V.patch = function (x, z, r, opacity) {
    var o = V.ci(V.root, r, V.flat(0x6E7F63, opacity || 0.17), x, 0.03, z, 18);
    return o;
  };

  /* --------------------------------------------------------- interiors
   * A room you can walk into. While the player is inside, the roof lifts
   * away and the walls go glassy, so the camera can still see them. */
  V.interiors = V.interiors || [];
  var insideNow = null;

  V.addInterior = function (o) {
    o.cos = Math.cos(o.ry || 0); o.sin = Math.sin(o.ry || 0);
    V.interiors.push(o);
    return o;
  };
  V.localOf = function (o, x, z) {
    var ox = x - o.x, oz = z - o.z;
    return { x: ox * o.cos - oz * o.sin, z: ox * o.sin + oz * o.cos };
  };
  V.isInside = function (o, x, z, slack) {
    var l = V.localOf(o, x, z);
    var s = slack || 0;
    return Math.abs(l.x) < o.hw + s && Math.abs(l.z) < o.hd + s;
  };
  V.insideOf = function (x, z) {
    for (var i = 0; i < V.interiors.length; i++) {
      if (V.isInside(V.interiors[i], x, z, -0.2)) return V.interiors[i];
    }
    return null;
  };
  V.currentInterior = function () { return insideNow; };

  V.updateInteriors = function (x, z, dt) {
    var now = V.insideOf(x, z);
    if (now !== insideNow) {
      if (insideNow) setOpen(insideNow, false);
      insideNow = now;
      if (now) setOpen(now, true);
      if (V.onInteriorChange) V.onInteriorChange(now);
    }
    /* ease the roof and the walls */
    for (var i = 0; i < V.interiors.length; i++) {
      var it = V.interiors[i];
      if (it.k === undefined) it.k = 0;
      var want = it.open ? 1 : 0;
      if (Math.abs(it.k - want) < 0.005) { it.k = want; continue; }
      it.k += (want - it.k) * Math.min(1, (dt || 0.016) * 7);
      applyOpen(it);
    }
  };
  function setOpen(it, open) { it.open = open; applyOpen(it); }
  function applyOpen(it) {
    var k = it.k == null ? (it.open ? 1 : 0) : it.k;
    if (it.roof) {
      it.roof.visible = k < 0.98;
      it.roof.position.y = (it.roofY || 0) + k * (it.h || 9) * 0.9;
      var rm = it.roofMats || [];
      for (var i = 0; i < rm.length; i++) {
        rm[i].transparent = k > 0.02;
        rm[i].opacity = 1 - k * 0.92;
      }
    }
    var wm = it.wallMats || [];
    for (var j = 0; j < wm.length; j++) {
      wm[j].transparent = k > 0.02;
      wm[j].opacity = 1 - k * 0.72;
    }
  }

  /* -------------------------------------------------------------- seats
   * Registered once at build time; rooms.js claims and releases them. */
  V.seats = V.seats || [];
  V.addSeat = function (o) { o.index = V.seats.length; V.seats.push(o); return o; };

  /* -------------------------------------------------------------- poses */
  V.setPose = function (g, pose) {
    var r = g && g.userData && g.userData.rig;
    if (!r) return;
    g.userData.pose = pose;
    if (pose === "sit") {
      /* thighs along the seat, shins hanging — the rig says how far the
         hip has to move for the thighs to rest on a chair seat */
      r.lLeg.rotation.x = -Math.PI / 2; r.rLeg.rotation.x = -Math.PI / 2;
      if (r.lShin) r.lShin.rotation.x = Math.PI / 2;
      if (r.rShin) r.rShin.rotation.x = Math.PI / 2;
      r.lArm.rotation.x = -0.45; r.rArm.rotation.x = -0.45;
      g.userData.yOffset = r.sitLift != null ? r.sitLift : (r.lShin ? -0.42 : 0.22);
    } else if (pose === "speak") {
      r.lLeg.rotation.x = 0; r.rLeg.rotation.x = 0;
      if (r.lShin) r.lShin.rotation.x = 0;
      if (r.rShin) r.rShin.rotation.x = 0;
      r.lArm.rotation.x = -0.2; r.rArm.rotation.x = -1.15;
      g.userData.yOffset = 0;
    } else {
      r.lLeg.rotation.x = 0; r.rLeg.rotation.x = 0;
      if (r.lShin) r.lShin.rotation.x = 0;
      if (r.rShin) r.rShin.rotation.x = 0;
      r.lArm.rotation.x = 0; r.rArm.rotation.x = 0;
      g.userData.yOffset = 0;
    }
  };

  /* ------------------------------------------------------ canvas labels */
  var texCache = {};
  function canvas(w, h) {
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    return c;
  }
  function finish(c) {
    var tex = new T.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }
  /* A painted sign face: dark board, cream lettering. */
  V.signTex = function (title, sub, tone) {
    var key = "s|" + title + "|" + sub + "|" + tone;
    if (texCache[key]) return texCache[key];
    var c = canvas(512, 160), g = c.getContext("2d");
    g.fillStyle = tone || "#1E4A44"; g.fillRect(0, 0, 512, 160);
    g.strokeStyle = "#E8D9B0"; g.lineWidth = 4; g.strokeRect(9, 9, 494, 142);
    g.fillStyle = "#F4EBD8"; g.textAlign = "center"; g.textBaseline = "middle";
    var t = String(title).slice(0, 26);
    g.font = (t.length > 18 ? "600 34px " : "600 44px ") + "Georgia, 'Times New Roman', serif";
    g.fillText(t, 256, sub ? 64 : 80);
    if (sub) {
      g.fillStyle = "#C9D6C0";
      g.font = "500 22px Arial, sans-serif";
      g.fillText(String(sub).slice(0, 36).toUpperCase(), 256, 108);
    }
    return (texCache[key] = finish(c));
  };
  /* A road-side direction blade. */
  V.bladeTex = function (label, arrow) {
    var key = "d|" + label + "|" + arrow;
    if (texCache[key]) return texCache[key];
    var c = canvas(512, 116), g = c.getContext("2d");
    g.fillStyle = "#F4EBD8"; g.fillRect(0, 0, 512, 116);
    g.fillStyle = "#1E4A44";
    g.font = "600 40px Arial, sans-serif";
    g.textBaseline = "middle";
    g.textAlign = arrow === "left" ? "left" : "right";
    g.fillText(String(label).slice(0, 20), arrow === "left" ? 78 : 434, 58);
    g.beginPath();
    if (arrow === "left") { g.moveTo(24, 58); g.lineTo(62, 30); g.lineTo(62, 86); }
    else { g.moveTo(488, 58); g.lineTo(450, 30); g.lineTo(450, 86); }
    g.closePath(); g.fill();
    return (texCache[key] = finish(c));
  };

  /* -------------------------------------------------------- content LOD
   *
   * The shell of a building is a handful of meshes. What is inside it — the
   * chairs, the shelves, the boards, the coffee pots — is a hundred more,
   * and from four hundred metres away they cover about six pixels between
   * them. Three.js will happily cull a mesh that is outside the frustum, but
   * a lecture hall at the far end of the campus is usually inside it.
   *
   * So each building's contents live in one group, and the group is switched
   * off past the distance at which it stops being legible. One boolean, and
   * the renderer never walks the subtree.
   */
  V.lods = V.lods || [];
  V.addLod = function (o) {
    o.shown = true;
    V.lods.push(o);
    return o;
  };
  V.updateLods = function (px, pz) {
    var list = V.lods;
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      var want = Math.abs(l.x - px) + Math.abs(l.z - pz) < l.r;
      if (want !== l.shown) { l.shown = want; l.g.visible = want; }
    }
  };

  /* ------------------------------------------------------------- doors
   *
   * Every doorway gets a leaf (or a pair of them) on a hinge. They swing
   * open when somebody walks up and close behind them, which is the only
   * way the thresholds read as doors rather than holes in a wall.
   *
   * The leaves are decoration: the doorway is already a gap in the collision
   * wall, so an open or shut door never traps anybody. */
  V.doors = V.doors || [];

  V.addDoor = function (o) {
    o.k = 0; o.open = false; o.shown = false;
    showDoor(o, false);
    V.doors.push(o);
    return o;
  };

  V.updateDoors = function (px, pz, dt) {
    var list = V.doors;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      var far = Math.abs(d.x - px) + Math.abs(d.z - pz);
      /* Out of sight, out of the update loop — and out of the render, which
         matters more: two leaves apiece across forty doorways is eighty
         draw calls for something nobody within a hundred metres can see
         move. */
      if (far > 130) {
        if (d.shown) { d.shown = false; showDoor(d, false); }
        if (d.k !== 0) { d.k = 0; applyDoor(d); }
        continue;
      }
      if (!d.shown) { d.shown = true; showDoor(d, true); }
      d.open = far < d.r;
      var want = d.open ? 1 : 0;
      if (Math.abs(d.k - want) < 0.004) {
        if (d.k !== want) { d.k = want; applyDoor(d); }
        continue;
      }
      /* opening is quick, closing is slow and slightly sprung */
      var rate = want > d.k ? 7.5 : 3.4;
      d.k += (want - d.k) * Math.min(1, (dt || 0.016) * rate);
      applyDoor(d);
    }
  };

  function showDoor(d, on) {
    for (var i = 0; i < d.leaves.length; i++) d.leaves[i].g.visible = on;
  }

  function applyDoor(d) {
    /* ease-out, so the leaf slows as it reaches the jamb */
    var e = 1 - Math.pow(1 - d.k, 2.2);
    for (var i = 0; i < d.leaves.length; i++) {
      var lf = d.leaves[i];
      lf.g.rotation.y = lf.sign * e * d.swing;
    }
  }

  /* Procedural physics posters — Feynman diagrams, spectra, equations, sky
     maps. Drawn rather than downloaded, so they cost nothing to ship. */
  V.posterTex = function (kind, seed) {
    var key = "p|" + kind + "|" + (seed || 0);
    if (texCache[key]) return texCache[key];
    var c = canvas(256, 340), g = c.getContext("2d");
    var rnd = (function (s) {
      s = (seed || 1) * 9301 + 49297;
      return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    })();
    g.fillStyle = "#F6F1E2"; g.fillRect(0, 0, 256, 340);
    g.strokeStyle = "#1E4A44"; g.lineWidth = 3; g.strokeRect(8, 8, 240, 324);
    g.strokeStyle = "#2E4A46"; g.fillStyle = "#2E4A46"; g.lineWidth = 2;

    if (kind === "feynman") {
      /* two incoming legs, a wavy propagator, two outgoing legs */
      g.beginPath(); g.moveTo(40, 70); g.lineTo(110, 140); g.moveTo(216, 70); g.lineTo(146, 140); g.stroke();
      g.beginPath(); g.moveTo(40, 280); g.lineTo(110, 210); g.moveTo(216, 280); g.lineTo(146, 210); g.stroke();
      g.beginPath();
      for (var i = 0; i <= 40; i++) {
        var yy = 140 + (i / 40) * 70, xx = 128 + Math.sin(i * 0.8) * 9;
        if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.stroke();
      g.beginPath(); g.arc(110, 140, 5, 0, 6.283); g.arc(146, 140, 5, 0, 6.283);
      g.arc(110, 210, 5, 0, 6.283); g.arc(146, 210, 5, 0, 6.283); g.fill();
      g.font = "italic 17px Georgia, serif";
      g.fillText("e⁻", 26, 64); g.fillText("e⁺", 222, 64);
      g.fillText("μ⁻", 26, 298); g.fillText("μ⁺", 222, 298);
      g.fillText("γ", 168, 180);
    } else if (kind === "spectrum") {
      g.strokeStyle = "#8A9A92"; g.lineWidth = 1;
      for (var k = 1; k < 6; k++) {
        g.beginPath(); g.moveTo(30, 60 + k * 44); g.lineTo(226, 60 + k * 44); g.stroke();
      }
      g.strokeStyle = "#C4643F"; g.lineWidth = 2.4; g.beginPath();
      for (var x = 0; x <= 196; x++) {
        var t = x / 196;
        var y = 280 - (Math.exp(-Math.pow((t - 0.52) * 7, 2)) * 150 + (1 - t) * 40);
        if (x === 0) g.moveTo(30 + x, y); else g.lineTo(30 + x, y);
      }
      g.stroke();
      g.strokeStyle = "#2E4A46"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(30, 288); g.lineTo(226, 288); g.moveTo(30, 288); g.lineTo(30, 56); g.stroke();
      g.font = "13px Arial, sans-serif"; g.fillText("events / GeV", 30, 44); g.fillText("m", 214, 308);
    } else if (kind === "sky") {
      g.fillStyle = "#16233A"; g.fillRect(20, 60, 216, 160);
      for (var s = 0; s < 260; s++) {
        var a = rnd(), b = rnd();
        g.fillStyle = "rgba(" + (150 + a * 100 | 0) + "," + (170 + b * 80 | 0) + ",255," + (0.25 + a * 0.7) + ")";
        g.fillRect(22 + a * 210, 62 + b * 156, 1.6, 1.6);
      }
      g.fillStyle = "#2E4A46"; g.font = "600 15px Arial, sans-serif";
      g.fillText("ALL-SKY SURVEY", 40, 250); g.font = "12px Arial, sans-serif";
      g.fillText("galactic coordinates", 40, 272);
    } else if (kind === "detector") {
      g.strokeStyle = "#2E4A46";
      for (var r = 1; r <= 4; r++) { g.beginPath(); g.arc(128, 170, r * 24, 0, 6.283); g.stroke(); }
      g.strokeStyle = "#C4643F"; g.lineWidth = 1.8;
      for (var tr = 0; tr < 14; tr++) {
        var ang = rnd() * 6.283, bend = (rnd() - 0.5) * 0.8;
        g.beginPath(); g.moveTo(128, 170);
        for (var st = 1; st <= 20; st++) {
          var rr = st * 5.2, aa = ang + bend * (st / 20);
          g.lineTo(128 + Math.cos(aa) * rr, 170 + Math.sin(aa) * rr);
        }
        g.stroke();
      }
      g.fillStyle = "#2E4A46"; g.font = "600 14px Arial, sans-serif";
      g.fillText("EVENT DISPLAY", 62, 300);
    } else { /* equation */
      g.fillStyle = "#1E4A44";
      g.font = "italic 26px Georgia, serif";
      var lines = [["ℒ = −¼ FμνF", "μν"], ["+ iψ̄ D̸ ψ", ""], ["+ |Dμφ|² − V(φ)", ""], ["+ ψ̄ᵢ yᵢⱼ ψⱼ φ", ""]];
      lines.forEach(function (ln, i) { g.fillText(ln[0] + ln[1], 26, 110 + i * 46); });
      g.font = "600 13px Arial, sans-serif"; g.fillStyle = "#6A7A72";
      g.fillText("THE STANDARD MODEL", 26, 300);
    }
    return (texCache[key] = finish(c));
  };

  /* A texture-mapped, double-sided upright board. */
  V.board = function (parent, tex, w, h, x, y, z, ry) {
    var m = new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide, transparent: false });
    return V.panel(parent, w, h, m, x, y, z, ry);
  };

  /* ---------------------------------------------------------- structure
   * A building with walls you cannot walk through and doors you can.
   *
   *   opt.doors  [{ side:"n"|"s"|"e"|"w", at: offset along that wall,
   *                 width: gap in metres }]
   *   opt.inside true to build a floor and register the interior
   *
   * Returns helpers for placing furniture in local coordinates. */
  V.structure = function (opt) {
    var w = opt.w, d = opt.d, h = opt.h || 9;
    var tw = opt.thick || 1.0;
    var ry = opt.ry || 0, cos = Math.cos(ry), sin = Math.sin(ry);
    var g = new T.Group();
    g.position.set(opt.x, 0, opt.z); g.rotation.y = ry;
    (opt.parent || V.root).add(g);

    var roofG = new T.Group(); g.add(roofG);
    /* One material per building so the walls can fade independently. */
    var wallM = new T.MeshLambertMaterial({ color: opt.wall == null ? 0xF2E8D4 : opt.wall });
    var roofM = new T.MeshLambertMaterial({ color: opt.roof == null ? 0xB4603F : opt.roof });
    var trimM = new T.MeshLambertMaterial({ color: opt.trim == null ? 0xCFC7B4 : opt.trim });
    var winM = V.litGlass(opt.glass);

    function toWorld(lx, lz) {
      return { x: opt.x + lx * cos + lz * sin, z: opt.z - lx * sin + lz * cos };
    }

    /* ---- plinth: deliberately low, so an avatar reads as standing on it ---- */
    V.bx(g, w + 1.8, 0.34, d + 1.8, trimM, 0, 0.17, 0);

    /* ---- walls, with gaps where the doors are ---- */
    var doors = (opt.doors || []).slice();
    var doorH = opt.doorH || Math.min(5.2, h - 1.6);
    var sides = [
      { s: "s", L: w, fixed: d / 2, axis: "x" },
      { s: "n", L: w, fixed: -d / 2, axis: "x" },
      { s: "e", L: d, fixed: w / 2, axis: "z" },
      { s: "w", L: d, fixed: -w / 2, axis: "z" }
    ];
    var wallMeshes = [];
    sides.forEach(function (side) {
      var gaps = doors.filter(function (dr) { return dr.side === side.s; })
        .map(function (dr) {
          var half = (dr.width || 7) / 2;
          return { a: (dr.at || 0) - half, b: (dr.at || 0) + half, door: dr };
        })
        .sort(function (a, b) { return a.a - b.a; });

      var cursor = -side.L / 2;
      var spans = [];
      gaps.forEach(function (gp) {
        var a = Math.max(cursor, -side.L / 2), b = Math.min(gp.a, side.L / 2);
        if (b - a > 0.2) spans.push([a, b]);
        cursor = Math.max(cursor, gp.b);
      });
      if (side.L / 2 - cursor > 0.2) spans.push([cursor, side.L / 2]);

      spans.forEach(function (sp) {
        var len = sp[1] - sp[0], mid = (sp[0] + sp[1]) / 2;
        var lx, lz, hw, hd;
        if (side.axis === "x") { lx = mid; lz = side.fixed; hw = len / 2; hd = tw / 2; }
        else { lx = side.fixed; lz = mid; hw = tw / 2; hd = len / 2; }
        var m = side.axis === "x"
          ? V.bx(g, len, h, tw, wallM, lx, h / 2, lz)
          : V.bx(g, tw, h, len, wallM, lx, h / 2, lz);
        wallMeshes.push(m);
        var wp = toWorld(lx, lz);
        V.blockBox(wp.x, wp.z, hw, hd, ry);
      });

      /* lintel above each doorway, plus a step and a frame outside it */
      gaps.forEach(function (gp) {
        var width = gp.b - gp.a, mid = (gp.a + gp.b) / 2;
        var lx, lz;
        if (side.axis === "x") { lx = mid; lz = side.fixed; } else { lx = side.fixed; lz = mid; }
        if (h - doorH > 0.3) {
          if (side.axis === "x") V.bx(g, width, h - doorH, tw, wallM, lx, doorH + (h - doorH) / 2, lz);
          else V.bx(g, tw, h - doorH, width, wallM, lx, doorH + (h - doorH) / 2, lz);
        }
        /* threshold slab, so the doorway reads as an entrance */
        var out = 2.6, sx, sz;
        if (side.s === "s") { sx = lx; sz = lz + out / 2; }
        else if (side.s === "n") { sx = lx; sz = lz - out / 2; }
        else if (side.s === "e") { sx = lx + out / 2; sz = lz; }
        else { sx = lx - out / 2; sz = lz; }
        if (side.axis === "x") V.bx(g, width + 1.6, 0.3, out, trimM, sx, 0.15, sz);
        else V.bx(g, out, 0.3, width + 1.6, trimM, sx, 0.15, sz);
        gp.door.worldAt = toWorld(sx, sz);

        /* ---- the door itself: a pair of leaves on hinges ---- */
        if (opt.doorLeaves !== false) {
          var leafW = width / 2;
          var leafM = V.color(opt.doorColor == null ? 0x5A3A26 : opt.doorColor);
          var handleM = V.color(0xD8C48A);
          var leaves = [];
          [-1, 1].forEach(function (sgn) {
            var hinge = new T.Group();
            /* hinge on the outer jamb, leaf reaching in towards the middle */
            if (side.axis === "x") hinge.position.set(mid + sgn * leafW, 0, lz);
            else hinge.position.set(lx, 0, mid + sgn * leafW);
            g.add(hinge);

            var panelM = new T.Mesh(V.U.box(), leafM);
            if (side.axis === "x") {
              panelM.scale.set(leafW - 0.06, doorH - 0.25, 0.24);
              panelM.position.set(-sgn * leafW / 2, (doorH - 0.25) / 2, 0);
            } else {
              panelM.scale.set(0.24, doorH - 0.25, leafW - 0.06);
              panelM.position.set(0, (doorH - 0.25) / 2, -sgn * leafW / 2);
            }
            hinge.add(panelM);

            /* a recessed centre panel and a handle, so it reads as a door */
            var inset = new T.Mesh(V.U.box(), V.color(opt.doorColor == null ? 0x6B4830 : opt.doorColor));
            if (side.axis === "x") {
              inset.scale.set((leafW - 0.06) * 0.62, (doorH - 0.25) * 0.52, 0.30);
              inset.position.set(-sgn * leafW / 2, (doorH - 0.25) * 0.55, 0);
            } else {
              inset.scale.set(0.30, (doorH - 0.25) * 0.52, (leafW - 0.06) * 0.62);
              inset.position.set(0, (doorH - 0.25) * 0.55, -sgn * leafW / 2);
            }
            hinge.add(inset);

            var knob = new T.Mesh(V.U.sph(7), handleM);
            knob.scale.setScalar(0.13);
            if (side.axis === "x") knob.position.set(-sgn * (leafW - 0.45), doorH * 0.48, 0.2);
            else knob.position.set(0.2, doorH * 0.48, -sgn * (leafW - 0.45));
            hinge.add(knob);

            /* which way it swings: always away from the inside of the room */
            var outward = (side.s === "s" || side.s === "e") ? 1 : -1;
            leaves.push({ g: hinge, sign: sgn * outward * (side.axis === "x" ? -1 : 1) });
          });

          var dw = toWorld(sx, sz);
          V.addDoor({
            x: dw.x, z: dw.z, r: Math.max(5.5, width * 0.9),
            swing: 1.45, leaves: leaves
          });
        }
      });
    });

    /* ---- windows ---- */
    if (opt.windows !== false) {
      var wy = Math.min(h * 0.58, h - 2.2);
      var stepX = Math.max(6, w / Math.max(2, Math.round(w / 8)));
      for (var px = -w / 2 + stepX * 0.8; px < w / 2 - 1; px += stepX) {
        if (!doorGapAt("s", px, 5) ) V.bx(g, 2.2, 2.6, 0.3, winM, px, wy, d / 2 + 0.06);
        if (!doorGapAt("n", px, 5)) V.bx(g, 2.2, 2.6, 0.3, winM, px, wy, -d / 2 - 0.06);
      }
      var stepZ = Math.max(6, d / Math.max(2, Math.round(d / 8)));
      for (var pz = -d / 2 + stepZ * 0.8; pz < d / 2 - 1; pz += stepZ) {
        if (!doorGapAt("e", pz, 5)) V.bx(g, 0.3, 2.6, 2.2, winM, w / 2 + 0.06, wy, pz);
        if (!doorGapAt("w", pz, 5)) V.bx(g, 0.3, 2.6, 2.2, winM, -w / 2 - 0.06, wy, pz);
      }
    }
    function doorGapAt(side, at, slack) {
      return doors.some(function (dr) {
        return dr.side === side && Math.abs((dr.at || 0) - at) < (dr.width || 7) / 2 + (slack || 0);
      });
    }

    /* ---- roof ---- */
    var style = opt.roofStyle || "gable";
    var roofY = h;
    if (style === "flat") {
      V.bx(roofG, w + 1.6, 0.7, d + 1.6, roofM, 0, h + 0.35, 0);
      V.bx(roofG, w + 1.8, 0.9, 0.5, trimM, 0, h + 0.9, d / 2 + 0.65);
      V.bx(roofG, w + 1.8, 0.9, 0.5, trimM, 0, h + 0.9, -d / 2 - 0.65);
      V.bx(roofG, 0.5, 0.9, d + 1.8, trimM, w / 2 + 0.65, h + 0.9, 0);
      V.bx(roofG, 0.5, 0.9, d + 1.8, trimM, -w / 2 - 0.65, h + 0.9, 0);
    } else if (style === "hip") {
      var pyr = new T.Mesh(V.U.cone(4), roofM);
      pyr.rotation.y = Math.PI / 4;
      pyr.position.y = h + h * 0.16;
      pyr.scale.set((w + 2.6) * 0.707, h * 0.32, (d + 2.6) * 0.707);
      roofG.add(pyr);
    } else if (style === "dome") {
      var dm = new T.Mesh(V.U.dome(20), roofM);
      dm.scale.set(w * 0.52, h * 0.5, d * 0.52); dm.position.y = h;
      roofG.add(dm);
    } else if (style === "vault") {
      var arc = new T.Mesh(V.geo("vault", function () {
        return new T.CylinderGeometry(1, 1, 1, 18, 1, false, 0, Math.PI);
      }), roofM);
      arc.rotation.z = Math.PI / 2;
      arc.scale.set(d / 2 + 0.9, w + 1.6, d / 2 + 0.9);
      arc.position.y = h; roofG.add(arc);
    } else { /* gable */
      var pr = new T.Mesh(V.U.cone(4), roofM);
      pr.rotation.y = Math.PI / 4;
      pr.position.y = h + h * 0.24;
      pr.scale.set((w + 2.4) * 0.707, h * 0.48, (d + 2.4) * 0.707);
      roofG.add(pr);
    }

    /* ---- inside ---- */
    var interior = null;
    if (opt.inside) {
      V.slab(g, w - tw, d - tw, V.color(opt.floor == null ? 0xD9CDAF : opt.floor), 0, 0.36, 0);
      /* ceiling lamps */
      var lampM = V.litLamp(0x50493C, 0xFFE2AE);
      var nx = Math.max(1, Math.round(w / 24)), nz = Math.max(1, Math.round(d / 24));
      for (var li = 0; li < nx; li++) {
        for (var lj = 0; lj < nz; lj++) {
          var lxp = -w / 2 + (li + 0.5) * (w / nx), lzp = -d / 2 + (lj + 0.5) * (d / nz);
          V.bx(g, 1.6, 0.3, 1.6, lampM, lxp, h - 0.7, lzp);
        }
      }
      interior = V.addInterior({
        id: opt.id, name: opt.name, x: opt.x, z: opt.z, ry: ry,
        hw: w / 2, hd: d / 2, h: h, roof: roofG, roofY: 0,
        roofMats: [roofM], wallMats: [wallM], kind: opt.kind || "building"
      });
    }

    V.patch(opt.x, opt.z, Math.max(w, d) * 0.72, 0.16);

    return {
      group: g, roof: roofG, interior: interior,
      wallMat: wallM, roofMat: roofM,
      w: w, d: d, h: h, ry: ry, x: opt.x, z: opt.z,
      /* local (metres from the centre, before rotation) → world */
      at: toWorld,
      /* world → local */
      local: function (x, z) {
        var ox = x - opt.x, oz = z - opt.z;
        return { x: ox * cos - oz * sin, z: ox * sin + oz * cos };
      },
      /* put something in the room; f receives the group in local space */
      fit: function (f) { f(g, toWorld); return this; }
    };
  };
})();
