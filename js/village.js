/* Quantum Village — the world. Requires THREE (r128 UMD). */
(function () {
  "use strict";
  var T = window.THREE;
  var V = (window.QV = window.QV || {});

  /* ---------- palette ---------- */
  var C = {
    grass:   0x5E8F45, grassDark: 0x47703A, sand: 0xD6C398, path: 0xBCA57C,
    water:   0x79BDBE, waterDeep: 0x559FA4,
    wall:    0xF2E8D4, wallWarm: 0xEADBBE, wallSage: 0xD6DFC6,
    roofClay:0xC9714C, roofTile: 0xB4603F, roofThatch: 0xCBA86A, roofSlate: 0x7C8B8A,
    wood:    0x9C7448, woodDark: 0x7A5836, trunk: 0x7E603F,
    leaf:    0x3F7A42, leafDark: 0x2C5A33, leafLight: 0x5E9B54,
    stone:   0xCFC7B4, metal: 0xB9C2C2, glass: 0x9FCAD2,
    forest:  0x1E4A44, cream: 0xF4EBD8, gold: 0xE8B04B, clay: 0xC4643F
  };
  V.C = C;

  var TOPIC_HUES = {
    pheno:0x4FA8B8, qft:0x7C93C8, bsm:0xA678C0, dm:0x8878C8, axion:0xE0A845,
    dp:0x4FB89A, pbh:0xD4705E, gw:0x6FB06B, nu:0x4FB8A8, coll:0xD68A4A,
    higgs:0xDDAF55, susy:0xC4718F, string:0x9282CC, xdim:0x6FB4C8, inf:0xD88FA8,
    early:0xD07F5A, baryo:0xC0A055, astro:0x5F9CC0, cr:0xC08A5F, gamma:0x9FB85F,
    bh:0x8892A8, modgrav:0x5FB8A0, qg:0x9888CC, eft:0x7FBF95, flav:0xD07F90,
    cmb:0x6FAEDC, lss:0xA898D8
  };
  V.TOPIC_HUES = TOPIC_HUES;

  /* ---------- places ---------- */
  var PLACES = [];
  function place(o) { PLACES.push(o); return o; }
  V.PLACES = PLACES;

  /* How far through the day it is, 0 at midnight and 0.5 at noon. The sun
     angle, the sky colours and the night lighting are all built on it.
     By default it is the visitor's own wall clock, so opening the village
     at nine in the evening opens it into night. dayLength is what a day
     costs in real seconds once something takes the sky off real time —
     the time button does that, and hands it back on the way round. */
  function localDayFraction() {
    var d = new Date();
    return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
            + d.getMilliseconds() / 1000) / 86400;
  }

  var state = { time: localDayFraction(), realTime: true, dayLength: 420,
                weather: "clear", paused: false };
  V.state = state;

  /* Pin the sky to one hour and let the accelerated cycle carry it on. */
  V.holdTime = function (t) { state.realTime = false; state.time = ((t % 1) + 1) % 1; };
  /* Give it back to the visitor's own clock. */
  V.useRealTime = function () { state.realTime = true; state.time = localDayFraction(); };

  var scene, camera, renderer, clock, root;
  var skyMat, sun, hemi, fill, stars;
  /* Collision and night-lighting live in engine.js; village.js shares the
     same arrays so old and new world modules light up together. */
  var blockers = (V.blockers = V.blockers || []);
  var villagers = [], tokens = [], boats = [];
  var rainPts, cloudGroup, celestial;
  var instPlots = [], instBuilt = [];
  var lampMats = (V.lampMats = V.lampMats || []);
  var windowMats = (V.windowMats = V.windowMats || []);

  V.getScene = function () { return scene; };
  V.getCamera = function () { return camera; };
  V.getRenderer = function () { return renderer; };
  V.getRoot = function () { return root; };

  /* ---------- tiny helpers ---------- */
  function mat(color, rough, flat) {
    return new T.MeshLambertMaterial({ color: color });
  }
  var M = {};
  function buildMats() {
    Object.keys(C).forEach(function (k) { M[k] = mat(C[k]); });
    M.glassLit = new T.MeshLambertMaterial({ color: 0x8FB8C0, emissive: 0xFFD79A, emissiveIntensity: 0 });
    windowMats.push(M.glassLit);
    M.lamp = new T.MeshLambertMaterial({ color: 0x4A4438, emissive: 0xFFC46B, emissiveIntensity: 0 });
    lampMats.push(M.lamp);
  }
  V.M = M;

  function box(g, w, h, d, m, x, y, z, ry) {
    var o = new T.Mesh(new T.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z); if (ry) o.rotation.y = ry;
    (g || root).add(o); return o;
  }
  function cyl(g, rt, rb, h, m, x, y, z, seg) {
    var o = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg || 12), m);
    o.position.set(x, y, z); (g || root).add(o); return o;
  }
  function sph(g, r, m, x, y, z, seg) {
    var o = new T.Mesh(new T.SphereGeometry(r, seg || 12, (seg || 12) - 4), m);
    o.position.set(x, y, z); (g || root).add(o); return o;
  }
  function prism(g, w, h, d, m, x, y, z, ry) {   /* gable roof */
    var o = new T.Mesh(new T.CylinderGeometry(0, w, h, 4, 1), m);
    o.position.set(x, y, z); o.rotation.y = (ry || 0) + Math.PI / 4;
    o.scale.set(1, 1, d / w);
    (g || root).add(o); return o;
  }
  function blocker(x, z, r) { return V.blockCircle(x, z, r); }

  /* soft contact patch under an object, in place of a real shadow */
  function patch(x, z, r, opacity) { return V.patch(x, z, r, opacity); }

  /* ---------- signs ---------- */
  /* One painted face per distinct wording, cached in the engine — the campus
     puts up thirty-odd of these and several repeat. */
  function signTexture(title, sub) { return V.signTex(title, sub); }
  function signBoard(x, z, ry, title, sub, w) {
    var g = new T.Group();
    var width = w || 7.4, h = width * 0.3125;
    var post = new T.MeshLambertMaterial({ color: C.woodDark });
    cyl(g, 0.16, 0.19, h + 3.4, post, -width / 2 + 0.5, (h + 3.4) / 2, 0, 7);
    cyl(g, 0.16, 0.19, h + 3.4, post, width / 2 - 0.5, (h + 3.4) / 2, 0, 7);
    var pl = new T.Mesh(new T.PlaneGeometry(width, h),
      new T.MeshBasicMaterial({ map: signTexture(title, sub), side: T.DoubleSide }));
    pl.position.set(0, h / 2 + 2.6, 0.12); g.add(pl);
    var back = new T.Mesh(new T.BoxGeometry(width, h, 0.18), new T.MeshLambertMaterial({ color: 0x15403A }));
    back.position.set(0, h / 2 + 2.6, 0); g.add(back);
    g.position.set(x, 0, z); g.rotation.y = ry;
    root.add(g); return g;
  }
  V.signBoard = signBoard;

  /* ---------- sky ---------- */
  var SKY_V = "varying vec3 vW; void main(){ vW = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }";
  var SKY_F = [
    "varying vec3 vW; uniform vec3 top; uniform vec3 low; uniform vec3 haze; uniform vec3 sunDir; uniform float glow;",
    "void main(){",
    "  float h = clamp(vW.y*0.5+0.5,0.0,1.0);",
    "  vec3 c = mix(low, haze, smoothstep(0.42,0.53,h));",
    "  c = mix(c, top, smoothstep(0.52,0.98,h));",
    "  float d = max(dot(normalize(vW), normalize(sunDir)),0.0);",
    "  c += vec3(1.0,0.86,0.62) * pow(d, 7.0) * glow;",
    "  gl_FragColor = vec4(c,1.0);",
    "}"
  ].join("\n");

  function buildSky() {
    skyMat = new T.ShaderMaterial({
      vertexShader: SKY_V, fragmentShader: SKY_F, side: T.BackSide, depthWrite: false,
      uniforms: {
        top:{value:new T.Color(0x8FC6CE)}, haze:{value:new T.Color(0xC3E0DC)},
        low:{value:new T.Color(0xF0E6CE)}, sunDir:{value:new T.Vector3(0,1,0)}, glow:{value:0.5}
      }
    });
    /* Sky, stars and clouds all travel with the camera.
     *
     * They used to sit at a fixed two kilometres from the origin, which meant
     * the far clip plane had to reach two kilometres for them — and so did
     * every building, tree and lamp post between here and there. Carrying the
     * dome with the viewer instead means the far plane only has to cover the
     * fog, and the culler can drop everything past it. Nothing looks any
     * different: a sky you can walk towards was never the point. */
    celestial = new T.Group(); scene.add(celestial);

    var s = new T.Mesh(new T.SphereGeometry(1180, 28, 18), skyMat);
    s.frustumCulled = false;
    s.renderOrder = -1;
    celestial.add(s);

    var n = 700, pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var u = Math.random() * Math.PI * 2, v = Math.acos(Math.random() * 0.9 + 0.05), r = 1080;
      pos[i*3] = r * Math.sin(v) * Math.cos(u);
      pos[i*3+1] = Math.abs(r * Math.cos(v)) * 0.85;
      pos[i*3+2] = r * Math.sin(v) * Math.sin(u);
    }
    var g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(pos, 3));
    stars = new T.Points(g, new T.PointsMaterial({ color:0xF2F6FF, size:2.2, sizeAttenuation:false, transparent:true, opacity:0 }));
    stars.frustumCulled = false; celestial.add(stars);

    cloudGroup = new T.Group(); celestial.add(cloudGroup);
    var cm = new T.MeshBasicMaterial({ color:0xFFFDF6, transparent:true, opacity:0.82 });
    for (var k = 0; k < 26; k++) {
      var cl = new T.Group();
      var lumps = 3 + Math.floor(Math.random() * 3);
      for (var j = 0; j < lumps; j++) {
        var b = new T.Mesh(new T.SphereGeometry(5 + Math.random() * 5, 8, 6), cm);
        b.position.set(j * 7 - lumps * 3, Math.random() * 2.4, Math.random() * 4 - 2);
        b.scale.y = 0.62; cl.add(b);
      }
      var a = Math.random() * Math.PI * 2, rad = 120 + Math.random() * 640;
      cl.position.set(Math.cos(a) * rad, 110 + Math.random() * 60, Math.sin(a) * rad);
      cl.userData.drift = 0.5 + Math.random() * 0.7;
      cloudGroup.add(cl);
    }
  }

  /* ---------- ground ---------- */
  function buildGround() {
    var g = new T.Mesh(new T.CircleGeometry(V.WORLD_R + 190, 96), M.grass);
    g.rotation.x = -Math.PI / 2; root.add(g);

    /* Meadow: drifts of colour over the base green so the ground is not one
       flat sheet. These used to be a hundred and fifty separate meshes and a
       hundred and fifty draw calls; they now go through the shared instancing
       batch, which collapses them to three. */
    var pm = [ new T.MeshBasicMaterial({ color:0x4A7238, transparent:true, opacity:0.30, depthWrite:false }),
               new T.MeshBasicMaterial({ color:0x77A24C, transparent:true, opacity:0.26, depthWrite:false }),
               new T.MeshBasicMaterial({ color:0x355C30, transparent:true, opacity:0.22, depthWrite:false }) ];
    var circ = V.U.circle(12);
    for (var i = 0; i < 220; i++) {
      var a = Math.random() * Math.PI * 2, r = 26 + Math.random() * (V.WORLD_R + 60);
      var rad = 7 + Math.random() * 22;
      V.props.add(circ, pm[i % 3],
        Math.cos(a) * r, 0.012 + (i % 4) * 0.0015, Math.sin(a) * r,
        rad, rad * (0.55 + Math.random() * 0.6), rad,
        0, Math.random() * 3.14, -Math.PI / 2);
    }

    /* Wildflowers and grass tufts, scattered well clear of the lanes. Each
       is two instanced quads, so ~900 of them are still only a few draws. */
    var tuftM = new T.MeshLambertMaterial({ color: 0x3E6B33 });
    var flowerM = [
      new T.MeshLambertMaterial({ color: 0xE8D46E }),
      new T.MeshLambertMaterial({ color: 0xF0EDE2 }),
      new T.MeshLambertMaterial({ color: 0xC98BB4 })
    ];
    var quad = V.U.plane();
    var tuftG = V.U.cone(4);        /* a tuft reads from every angle, and is
                                       six triangles instead of two quads */
    var budG = V.U.sph(5);
    /* Grass grows in clumps, not as evenly spaced spikes. Each seed puts
       down three or four blades within a metre of each other, which is what
       makes a field read as a field rather than as a lawn full of skittles. */
    for (var f = 0; f < 560; f++) {
      var fa = Math.random() * Math.PI * 2;
      var fr = 28 + Math.random() * (V.WORLD_R + 20);
      var cxf = Math.cos(fa) * fr, czf = Math.sin(fa) * fr;
      if (V.nearRoad && V.nearRoad(cxf, czf, 7)) continue;
      var blades = 3 + Math.floor(Math.random() * 3);
      for (var bl = 0; bl < blades; bl++) {
        var ba = Math.random() * Math.PI * 2, br = Math.random() * 1.1;
        var fx = cxf + Math.cos(ba) * br, fz = czf + Math.sin(ba) * br;
        var th = 0.7 + Math.random() * 0.8;
        var tw = 0.3 + Math.random() * 0.2;
        V.props.add(tuftG, tuftM, fx, th / 2, fz, tw, th, tw, Math.random() * 3.14);
      }
      if (f % 3 === 0) {
        var fm = flowerM[f % 3];
        for (var fb = 0; fb < 3; fb++) {
          var fa2 = Math.random() * Math.PI * 2, fr2 = Math.random() * 1.0;
          V.props.add(budG, fm, cxf + Math.cos(fa2) * fr2, 0.9,
                      czf + Math.sin(fa2) * fr2, 0.13);
        }
      }
    }

    /* the lane: a soft curve through the village, as one surface ribbon */
    var lane = new T.MeshLambertMaterial({ color:C.path });
    V.lanePts = [];
    for (var t = 0; t <= 1.0001; t += 0.008) {
      var x = -150 + t * 300;
      var z = 62 * Math.sin(t * Math.PI * 1.45 + 0.35) - 18;
      V.lanePts.push([x, z]);
    }
    V.ribbon(V.lanePts, 9.2, 0.02, lane, false, root);
    var branch = [];
    for (var t2 = 0; t2 <= 1.0001; t2 += 0.05) branch.push([44 + t2 * 54, -6 - t2 * 88]);
    V.ribbon(branch, 6.8, 0.02, lane, false, root);

    /* pond */
    var pond = new T.Mesh(new T.CircleGeometry(34, 40), M.water);
    pond.rotation.x = -Math.PI / 2; pond.position.set(-118, 0.05, 84); pond.scale.set(1.35, 1, 1);
    root.add(pond);
    var deep = new T.Mesh(new T.CircleGeometry(21, 32), M.waterDeep);
    deep.rotation.x = -Math.PI / 2; deep.position.set(-118, 0.06, 84); deep.scale.set(1.35, 1, 1);
    root.add(deep);
    V.pond = pond;
    blocker(-118, 84, 30);

    /* paddy strips east */
    var stripA = new T.MeshLambertMaterial({ color: 0x8FBC5E });
    var stripB = new T.MeshLambertMaterial({ color: 0x74A84E });
    var bundM = new T.MeshBasicMaterial({ color: C.path });
    for (var s = 0; s < 6; s++) {
      V.props.add(quad, s % 2 ? stripA : stripB, 176, 0.03, -30 + s * 13,
                  78, 11, 1, 0, 0.16, -Math.PI / 2);
      V.props.add(quad, bundM, 176, 0.045, -36 + s * 13,
                  78, 1.1, 1, 0, 0.16, -Math.PI / 2);
    }
  }

  /* ---------- vegetation ---------- */
  /* Trees go into the shared instancing batch: a few hundred of them cost a
     handful of draw calls rather than a few hundred. */
  function tree(x, z, scale, kind) {
    scale = scale || 1;
    var B = V.props;
    if (kind === "palm") {
      B.add(V.U.cyl(7), M.trunk, x, 5.5 * scale, z, 0.36 * scale, 11 * scale, 0.36 * scale);
      for (var f = 0; f < 7; f++) {
        var a = (f / 7) * Math.PI * 2;
        B.add(V.U.sph(7), M.leafLight,
          x + Math.cos(a) * 2.6 * scale, 10.7 * scale, z + Math.sin(a) * 2.6 * scale,
          4.65 * scale, 0.87 * scale, 1.92 * scale, -a, -0.28);
      }
      B.add(V.U.sph(8), M.roofThatch, x, 10.6 * scale, z, 0.7 * scale);
    } else if (kind === "conifer") {
      B.add(V.U.cyl(7), M.trunk, x, 1.7 * scale, z, 0.4 * scale, 3.4 * scale, 0.4 * scale);
      for (var c = 0; c < 3; c++) {
        B.add(V.U.cone(9), c % 2 ? M.leafDark : M.leaf,
          x, (4.0 + c * 2.5) * scale, z,
          (3.4 - c * 0.8) * scale, 4.2 * scale, (3.4 - c * 0.8) * scale);
      }
    } else {
      B.add(V.U.cyl(8), M.trunk, x, 2.3 * scale, z, 0.55 * scale, 4.6 * scale, 0.55 * scale);
      B.add(V.U.sph(10), M.leaf, x, 7.0 * scale, z, 3.5 * scale);
      B.add(V.U.sph(9), M.leafDark, x + 1.9 * scale, 5.9 * scale, z + 0.9 * scale, 2.5 * scale);
      B.add(V.U.sph(9), M.leafLight, x - 1.7 * scale, 6.4 * scale, z - 1.1 * scale, 2.2 * scale);
    }
    blocker(x, z, 1.3 * scale);
  }

  function bush(x, z, s) {
    s = s || 1;
    V.props.add(V.U.sph(8), M.leafDark, x, 1.1 * s, z, 1.5 * s);
    V.props.add(V.U.sph(7), M.leaf, x + 1.2 * s, 0.9 * s, z + 0.4 * s, 1.1 * s);
  }

  function fenceRun(x1, z1, x2, z2) {
    var dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
    var n = Math.max(2, Math.round(len / 3.4)), ang = Math.atan2(dx, dz);
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      V.props.add(V.U.cyl(6), M.woodDark, x1 + dx * t, 1.05, z1 + dz * t, 0.13, 2.1, 0.13);
    }
    for (var r = 0; r < 2; r++) {
      V.props.add(V.U.box(), M.wood, (x1 + x2) / 2, 0.75 + r * 0.62, (z1 + z2) / 2, 0.1, 0.16, len, ang);
    }
  }

  /* ---------- buildings ---------- */
  function cottage(opt) {
    var g = new T.Group();
    var w = opt.w || 11, h = opt.h || 6.2, d = opt.d || 9;
    var wallM = new T.MeshLambertMaterial({ color: opt.wall || C.wall });
    var roofM = new T.MeshLambertMaterial({ color: opt.roof || C.roofClay });

    box(g, w, h, d, wallM, 0, h / 2, 0);
    /* plinth */
    box(g, w + 1.2, 0.7, d + 1.2, M.stone, 0, 0.35, 0);
    /* roof */
    var rf = prism(g, Math.max(w, d) * 0.78, h * 0.62, d + 2.4, roofM, 0, h + h * 0.31 - 0.1, 0, 0);
    rf.scale.set((w + 2.2) / (Math.max(w, d) * 0.78 * 1.42), 1, (d + 2.2) / (Math.max(w, d) * 0.78 * 1.42));
    /* door */
    box(g, 2.0, 3.3, 0.24, new T.MeshLambertMaterial({ color: C.woodDark }), 0, 1.75, d / 2 + 0.02);
    box(g, 2.5, 0.3, 0.9, roofM, 0, 3.7, d / 2 + 0.35);
    /* windows */
    var wm = new T.MeshLambertMaterial({ color: 0x9FC2C4, emissive: 0xFFD79A, emissiveIntensity: 0 });
    windowMats.push(wm);
    var wy = h * 0.58;
    [-1, 1].forEach(function (s) {
      box(g, 1.7, 1.8, 0.2, wm, s * w * 0.27, wy, d / 2 + 0.03);
      box(g, 0.2, 1.8, 1.7, wm, s * (w / 2 + 0.03), wy, 0);
    });
    if (opt.chimney) {
      box(g, 1.2, 3.0, 1.2, M.stone, w * 0.3, h + 2.4, -d * 0.2);
    }
    if (opt.veranda) {
      box(g, w + 2, 0.24, 3.4, M.wood, 0, 0.72, d / 2 + 1.7);
      [-1, 1].forEach(function (s) {
        cyl(g, 0.16, 0.2, 3.5, M.wood, s * (w / 2 - 0.3), 2.4, d / 2 + 3.1, 7);
      });
      box(g, w + 2.4, 0.4, 0.5, roofM, 0, 4.2, d / 2 + 3.2);
    }
    g.position.set(opt.x, 0, opt.z); g.rotation.y = opt.ry || 0;
    root.add(g);
    patch(opt.x, opt.z, Math.max(w, d) * 0.78, 0.2);
    blocker(opt.x, opt.z, Math.max(w, d) * 0.55);
    return g;
  }

  function hall(opt) {
    /* a bigger public building: portico + tall windows */
    var g = new T.Group();
    var w = opt.w || 22, h = opt.h || 10, d = opt.d || 14;
    var wallM = new T.MeshLambertMaterial({ color: opt.wall || C.wallWarm });
    var roofM = new T.MeshLambertMaterial({ color: opt.roof || C.roofTile });
    box(g, w + 2.4, 0.9, d + 2.4, M.stone, 0, 0.45, 0);
    box(g, w, h, d, wallM, 0, h / 2, 0);
    var rf = prism(g, w * 0.76, h * 0.5, d, roofM, 0, h + h * 0.25 - 0.1, 0, 0);
    rf.scale.set((w + 2.6) / (w * 0.76 * 1.42), 1, (d + 2.6) / (w * 0.76 * 1.42));
    /* portico */
    for (var i = 0; i < 4; i++) {
      cyl(g, 0.5, 0.58, h * 0.78, M.stone, -w * 0.32 + i * (w * 0.213), h * 0.39, d / 2 + 2.2, 10);
    }
    box(g, w * 0.78, 0.7, 5.2, roofM, 0, h * 0.82, d / 2 + 1.6);
    box(g, w * 0.8, 0.3, 5.4, M.stone, 0, 0.5, d / 2 + 2.4);
    box(g, 3.4, 4.6, 0.3, new T.MeshLambertMaterial({ color: C.woodDark }), 0, 2.4, d / 2 + 0.05);
    var wm = new T.MeshLambertMaterial({ color: 0x9FC2C4, emissive: 0xFFD79A, emissiveIntensity: 0 });
    windowMats.push(wm);
    for (var k = 0; k < 5; k++) {
      var px = -w * 0.36 + k * (w * 0.18);
      if (Math.abs(px) < 2.4) continue;
      box(g, 1.9, 3.2, 0.2, wm, px, h * 0.56, d / 2 + 0.04);
      box(g, 1.9, 3.2, 0.2, wm, px, h * 0.56, -d / 2 - 0.04);
    }
    g.position.set(opt.x, 0, opt.z); g.rotation.y = opt.ry || 0;
    root.add(g);
    patch(opt.x, opt.z, Math.max(w, d) * 0.72, 0.2);
    blocker(opt.x, opt.z, Math.max(w, d) * 0.5);
    return g;
  }

  function barn(opt) {
    var g = new T.Group();
    var w = opt.w || 20, h = opt.h || 9, d = opt.d || 13;
    var wallM = new T.MeshLambertMaterial({ color: opt.wall || 0xC98C63 });
    box(g, w, h, d, wallM, 0, h / 2, 0);
    var arc = new T.Mesh(new T.CylinderGeometry(d / 2 + 0.6, d / 2 + 0.6, w + 1.2, 16, 1, false, 0, Math.PI),
      new T.MeshLambertMaterial({ color: opt.roof || C.roofSlate }));
    arc.rotation.z = Math.PI / 2; arc.position.y = h; g.add(arc);
    box(g, 5.4, 5.6, 0.3, new T.MeshLambertMaterial({ color: C.woodDark }), 0, 2.8, d / 2 + 0.05);
    box(g, w + 0.4, 0.4, 0.4, M.wood, 0, 5.9, d / 2 + 0.1);
    g.position.set(opt.x, 0, opt.z); g.rotation.y = opt.ry || 0;
    root.add(g);
    patch(opt.x, opt.z, Math.max(w, d) * 0.72, 0.2);
    blocker(opt.x, opt.z, Math.max(w, d) * 0.5);
    return g;
  }

  /* ---------- the Grand Refectory restaurant ---------- */
  function buildRestaurant() {
    var rx = 80, rz = 58;   /* building centre */

    var wallM  = new T.MeshLambertMaterial({ color: 0xF0DEC5 });
    var roofM  = new T.MeshLambertMaterial({ color: 0xC06838 });
    var stoneM = new T.MeshLambertMaterial({ color: C.stone });
    var woodM  = M.wood;
    var darkM  = M.woodDark;
    var winM   = new T.MeshLambertMaterial({ color: 0xA0CCD0, emissive: 0xFFD898, emissiveIntensity: 0.15 });
    V.windowMats.push(winM);

    /* — Main Storefront Building (Compact, clean & welcoming) — */
    var cafeG = new T.Group();
    box(cafeG, 16, 5.4, 8, wallM, 0, 2.7, 0);              /* shop body */
    box(cafeG, 16.6, 0.4, 8.6, stoneM, 0, 0.2, 0);         /* stone foundation */
    /* Timber corner pilasters */
    [-7.8, 7.8].forEach(function (px) {
      box(cafeG, 0.5, 5.4, 0.5, woodM, px, 2.7, 3.8);
      box(cafeG, 0.5, 5.4, 0.5, woodM, px, 2.7, -3.8);
    });
    /* Gable roof */
    var rf = prism(cafeG, 14, 4.0, 9.4, roofM, 0, 5.4 + 2.0 - 0.1, 0, 0);
    rf.scale.set(17 / (14 * 1.42), 1, 9.6 / (9.4 * 1.42));
    /* Chimney with cozy kitchen smoke stack */
    box(cafeG, 1.2, 4.2, 1.2, stoneM, 6.2, 7.2, -1.8);
    cafeG.position.set(rx, 0, rz);
    root.add(cafeG);

    /* — ROOFTOP SIGNBOARD (Erected on top of the building, completely unobstructing the ground) — */
    var roofSignG = new T.Group();
    /* Two sturdy timber roof struts */
    box(roofSignG, 0.22, 2.2, 0.22, darkM, -2.6, 1.1, 0);
    box(roofSignG, 0.22, 2.2, 0.22, darkM, 2.6, 1.1, 0);
    /* Sign backing frame */
    box(roofSignG, 6.8, 1.5, 0.2, darkM, 0, 1.8, 0);
    box(roofSignG, 6.6, 1.3, 0.24, new T.MeshLambertMaterial({ color: 0x2A1A10 }), 0, 1.8, 0);
    /* Sign face on roof */
    var roofSignMesh = new T.Mesh(
      new T.PlaneGeometry(6.4, 1.2),
      new T.MeshBasicMaterial({ map: V.signTex("THE GRAND REFECTORY", "food · quiet table · good company"), side: T.DoubleSide })
    );
    roofSignMesh.position.set(0, 1.8, 0.14);
    roofSignG.add(roofSignMesh);
    roofSignG.position.set(rx, 7.4, rz + 2.4);
    root.add(roofSignG);

    /* — Front Facade: Large Shop Windows & Serving Counter — */
    var cz = rz + 4.1; /* front wall line */

    /* Large picture windows flanking the counter */
    box(root, 3.2, 2.8, 0.18, winM, rx - 5.5, 2.8, cz);
    box(root, 3.4, 0.15, 0.25, woodM, rx - 5.5, 1.35, cz + 0.05); /* sill */
    box(root, 3.2, 2.8, 0.18, winM, rx + 5.5, 2.8, cz);
    box(root, 3.4, 0.15, 0.25, woodM, rx + 5.5, 1.35, cz + 0.05);

    /* Clean awning canopy over the counter */
    box(root, 8.4, 0.2, 2.4, roofM, rx, 4.2, cz + 1.0);
    box(root, 8.5, 0.35, 0.15, darkM, rx, 4.2, cz + 2.2);

    /* Serving Counter (Front and open) */
    var counterMat = new T.MeshLambertMaterial({ color: 0x5C381E });
    var topMat     = new T.MeshLambertMaterial({ color: 0xBA8848 });
    var brassMat   = new T.MeshLambertMaterial({ color: 0xD8A83A });
    var chromeMat  = new T.MeshLambertMaterial({ color: 0xCFD8DC });
    var glassMat   = new T.MeshLambertMaterial({ color: 0xDCEEFF, transparent: true, opacity: 0.45 });

    var counterZ = cz + 0.8;
    box(root, 6.8, 1.1, 1.2, counterMat, rx, 0.55, counterZ);
    box(root, 7.2, 0.12, 1.4, topMat, rx, 1.15, counterZ);
    /* Counter front mouldings */
    [-1.8, 0, 1.8].forEach(function (ox) {
      box(root, 1.4, 0.8, 0.06, new T.MeshLambertMaterial({ color: 0x482810 }), rx + ox, 0.55, counterZ + 0.62);
    });

    /* Espresso coffee machine on counter left */
    var emG = new T.Group();
    box(emG, 1.3, 0.8, 0.8, chromeMat, 0, 0.4, 0);
    box(emG, 1.4, 0.1, 0.9, brassMat, 0, 0.82, 0);
    cyl(emG, 0.04, 0.04, 0.35, brassMat, -0.3, 0.2, 0.42, 6);
    cyl(emG, 0.04, 0.04, 0.35, brassMat, 0.3, 0.2, 0.42, 6);
    /* Ceramic cups */
    [-0.25, 0, 0.25].forEach(function (cox) {
      cyl(emG, 0.09, 0.07, 0.16, new T.MeshLambertMaterial({ color: 0xF5F0E6 }), cox, 0.94, 0, 8);
    });
    emG.position.set(rx - 2.2, 1.22, counterZ);
    root.add(emG);

    /* Pastry display case on counter right */
    var pdG = new T.Group();
    box(pdG, 1.8, 0.7, 0.8, glassMat, 0, 0.38, 0);
    box(pdG, 1.84, 0.05, 0.84, brassMat, 0, 0.75, 0);
    box(pdG, 1.84, 0.05, 0.84, counterMat, 0, 0.03, 0);
    /* Pastries */
    cyl(pdG, 0.12, 0.14, 0.10, new T.MeshLambertMaterial({ color: 0xD48830 }), -0.4, 0.18, -0.1, 8);
    cyl(pdG, 0.12, 0.14, 0.10, new T.MeshLambertMaterial({ color: 0xD48830 }), -0.05, 0.18, 0.1, 8);
    cyl(pdG, 0.12, 0.12, 0.14, new T.MeshLambertMaterial({ color: 0x982838 }), 0.35, 0.20, 0, 8);
    pdG.position.set(rx + 2.1, 1.22, counterZ);
    root.add(pdG);

    /* Antique brass cash register in the middle */
    var regG = new T.Group();
    box(regG, 0.6, 0.4, 0.5, brassMat, 0, 0.22, 0);
    box(regG, 0.45, 0.25, 0.35, new T.MeshLambertMaterial({ color: 0x2A2A2A }), 0, 0.50, -0.04);
    cyl(regG, 0.05, 0.05, 0.12, brassMat, 0, 0.68, -0.04, 6);
    regG.position.set(rx + 0.1, 1.22, counterZ);
    root.add(regG);

    /* Two warm pendant lanterns under canopy */
    [-1.8, 1.8].forEach(function (lx) {
      cyl(root, 0.02, 0.02, 0.9, darkM, rx + lx, 3.8, counterZ, 4);
      var lampMesh = new T.Mesh(new T.BoxGeometry(0.45, 0.55, 0.45), M.lamp);
      lampMesh.position.set(rx + lx, 3.2, counterZ);
      root.add(lampMesh);
    });

    /* — A Few Spaced Bistro Tables (Exactly 3 tables, 2 chairs each — NO large clusters!) — */
    var tableM = new T.MeshLambertMaterial({ color: 0xD4B080 });
    var cozyTables = [
      { x: rx - 9, z: rz + 10 }, /* Left patio */
      { x: rx + 9, z: rz + 10 }, /* Right patio */
      { x: rx + 9, z: rz + 16 }  /* Front-right corner */
    ];
    V.refectoryTables = cozyTables;

    cozyTables.forEach(function (pos, tIdx) {
      /* Table top & slender pedestal */
      cyl(root, 1.3, 1.3, 0.1, tableM, pos.x, 1.8, pos.z, 16);
      cyl(root, 0.08, 0.10, 1.8, darkM, pos.x, 0.9, pos.z, 6);

      /* Just 2 chairs per table (facing each other) */
      [-1, 1].forEach(function (side) {
        var cx = pos.x + side * 1.6, cz = pos.z;
        /* Seat */
        box(root, 0.8, 0.10, 0.8, tableM, cx, 1.0, cz);
        /* Legs */
        [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].forEach(function (lp) {
          box(root, 0.08, 1.0, 0.08, darkM, cx + lp[0], 0.5, cz + lp[1]);
        });
        /* Backrest */
        box(root, 0.10, 0.6, 0.8, tableM, cx + side * 0.38, 1.5, cz);
      });

      patch(pos.x, pos.z, 2.8, 0.14);
    });

    /* Decorative flower planters flanking the cafe front */
    [-7.8, 7.8].forEach(function (px) {
      cyl(root, 0.5, 0.65, 0.9, stoneM, rx + px, 0.45, cz + 1.2, 10);
      sph(root, 0.7, M.leaf, rx + px, 1.4, cz + 1.2, 8);
    });

    /* Ground shadow patch */
    patch(rx, rz, 12, 0.22);
    patch(rx, rz + 8, 10, 0.15);

    /* Blocker: blocks only the compact building interior so player can't walk through shop walls */
    V.blockCircle(rx, rz - 0.5, 5.5);

    /* — Register as a PLACE — */
    place({ id:"restaurant", name:"The Grand Refectory", kind:"restaurant", x:rx, z:66, r:8.5,
            sub:"Queue for food, earn your keep", tag:"Restaurant", topic:null });

    /* Build queue lane, staff, and customer NPCs */
    if (window.QVRestaurant) {
      QVRestaurant.build(root);
    }
  }

  /* ---------- the village ---------- */
  function buildVillage() {
    /* ---- the Commons: big tree, noticeboard, benches ---- */
    tree(0, 4, 1.7);
    blockers[blockers.length - 1].r = 2.6;
    for (var b = 0; b < 5; b++) {
      var ba = (b / 5) * Math.PI * 2 + 0.5;
      var bench = new T.Group();
      var seat = new T.Mesh(new T.BoxGeometry(3.2, 0.22, 1.0), M.wood);
      seat.position.y = 0.78; bench.add(seat);
      var backr = new T.Mesh(new T.BoxGeometry(3.2, 0.7, 0.16), M.wood);
      backr.position.set(0, 1.2, -0.42); bench.add(backr);
      [-1.2, 1.2].forEach(function (lx) {
        var leg = new T.Mesh(new T.BoxGeometry(0.2, 0.78, 0.78), M.woodDark);
        leg.position.set(lx, 0.39, 0); bench.add(leg);
      });
      bench.position.set(Math.cos(ba) * 13, 0, 4 + Math.sin(ba) * 13);
      bench.rotation.y = -ba + Math.PI / 2;
      root.add(bench);
      patch(bench.position.x, bench.position.z, 2.0, 0.13);
      blocker(bench.position.x, bench.position.z, 1.5);
    }
    /* noticeboard */
    signBoard(0, 22, 0, "Quantum Village", "the commons", 9);
    place({ id:"commons", name:"The Commons", kind:"commons", x:0, z:16, r:9,
            sub:"Village green", tag:"Start here", topic:null });

    /* well */
    cyl(root, 2.0, 2.2, 1.5, M.stone, -16, 0.75, 18, 14);
    cyl(root, 1.7, 1.7, 0.3, M.waterDeep, -16, 1.45, 18, 12);
    [-1, 1].forEach(function (s) { cyl(root, 0.14, 0.14, 4, M.woodDark, -16 + s * 1.9, 2.6, 18, 6); });
    box(root, 5.0, 0.3, 2.2, M.roofThatch, -16, 4.7, 18);
    blocker(-16, 18, 2.4);

    /* ---- Institute House (founding institutes) ---- */
    hall({ x:-56, z:-44, ry:0.22, w:26, h:11, d:15, wall:C.wall, roof:C.roofTile });
    signBoard(-56, -30, 0.22, "Institute House", "theory · qft · eft", 8.4);
    place({ id:"inst-theory", name:"Institute House", kind:"institute", x:-54, z:-28, r:8,
            sub:"Theory & field theory", tag:"Institute", topic:"qft", uni:"lit" });

    hall({ x:56, z:-48, ry:-0.26, w:24, h:10.5, d:14, wall:C.wallSage, roof:C.roofClay });
    signBoard(56, -34, -0.26, "Phenomenology Hall", "hep-ph · colliders · bsm", 8.4);
    place({ id:"inst-pheno", name:"Phenomenology Hall", kind:"institute", x:54, z:-33, r:8,
            sub:"Models meet detectors", tag:"Institute", topic:"pheno", uni:"php" });

    /* ---- The Archive (library) ---- */
    hall({ x:-6, z:-72, ry:0, w:28, h:12, d:16, wall:C.wallWarm, roof:C.roofSlate });
    signBoard(-6, -56, 0, "The Archive", "every shelf, every topic", 9.6);
    place({ id:"archive", name:"The Archive", kind:"library", x:-6, z:-54, r:9,
            sub:"Village library", tag:"Library", topic:null });
    for (var t1 = 0; t1 < 4; t1++) tree(-30 + t1 * 16, -88, 1.1, "conifer");

    /* ---- Lecture Barn ---- */
    barn({ x:34, z:34, ry:-0.4, w:21, h:8.4, d:13 });
    signBoard(34, 46, -0.4, "Lecture Barn", "seminars · journal club", 8);
    place({ id:"barn", name:"Lecture Barn", kind:"seminar", x:36, z:45, r:8,
            sub:"Seminars and journal club", tag:"Seminar", topic:"pheno" });
    for (var h1 = 0; h1 < 3; h1++) {
      cyl(root, 1.7, 2.0, 2.6, M.roofThatch, 52 + h1 * 5, 1.3, 26 + (h1 % 2) * 5, 9);
      sph(root, 1.8, M.roofThatch, 52 + h1 * 5, 2.8, 26 + (h1 % 2) * 5, 8);
    }

    /* ---- Tea House ---- */
    cottage({ x:-40, z:26, ry:0.5, w:12, h:5.6, d:9, wall:0xF0DFC0, roof:C.roofThatch, veranda:true, chimney:true });
    signBoard(-40, 38, 0.5, "The Tea House", "open late", 7);
    place({ id:"tea", name:"The Tea House", kind:"cafe", x:-38, z:36, r:7,
            sub:"Where the arguments happen", tag:"Café", topic:null });

    /* ---- The Grand Refectory (restaurant) ---- */
    buildRestaurant();
    for (var tb = 0; tb < 4; tb++) {
      var tx = -52 + tb * 4.5, tz = 34 + (tb % 2) * 4;
      cyl(root, 1.0, 1.0, 0.2, M.wall, tx, 1.5, tz, 10);
      cyl(root, 0.14, 0.14, 1.5, M.woodDark, tx, 0.75, tz, 6);
    }

    /* ---- Observatory Knoll ---- */
    var knoll = new T.Mesh(new T.SphereGeometry(46, 26, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      new T.MeshLambertMaterial({ color: 0xB4C68F }));
    knoll.scale.set(1, 0.26, 1); knoll.position.set(104, 0, -104); root.add(knoll);
    var kbase = cyl(root, 7, 7.6, 7, M.wall, 104, 11.9 + 3.5, -104, 20);
    var dome = new T.Mesh(new T.SphereGeometry(7.3, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.metal);
    dome.position.set(104, 18.9, -104); root.add(dome);
    box(root, 1.7, 7.4, 0.4, new T.MeshLambertMaterial({ color:0x2A3A3A }), 104, 22.2, -96.9);
    blocker(104, -104, 9);
    signBoard(104, -88, 0, "Observatory Knoll", "seeing 0.9 arcsec", 8);
    place({ id:"observatory", name:"Observatory Knoll", kind:"observatory", x:104, z:-86, r:8,
            sub:"Optical dome on the ridge", tag:"Observatory", topic:"astro" });
    /* small dish beside it */
    cyl(root, 0.6, 0.8, 4, M.metal, 86, 11.5, -84, 8);
    var dish = new T.Mesh(new T.SphereGeometry(4.2, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2.5), M.wall);
    dish.position.set(86, 15.4, -84); dish.rotation.x = -0.8; root.add(dish);

    /* ---- Detector Shed ---- */
    cottage({ x:-104, z:-18, ry:-0.35, w:14, h:6.6, d:11, wall:C.wallSage, roof:C.roofSlate });
    cyl(root, 4.2, 4.2, 9, new T.MeshLambertMaterial({ color:0xA8BCC0 }), -122, 4.5, -6, 20);
    cyl(root, 4.5, 4.5, 0.6, M.metal, -122, 9.2, -6, 20);
    blocker(-122, -6, 5);
    signBoard(-104, -6, -0.35, "Detector Shed", "low background counting", 7.6);
    place({ id:"detector", name:"The Detector Shed", kind:"lab", x:-102, z:-5, r:7.5,
            sub:"Direct detection, quietly", tag:"Lab", topic:"dm" });

    /* ---- Field Station (cosmic-ray array in the paddy) ---- */
    cottage({ x:150, z:34, ry:0.3, w:10, h:5.4, d:8, wall:C.wall, roof:C.roofClay });
    for (var a1 = 0; a1 < 9; a1++) {
      var ax = 150 + (a1 % 3) * 17 - 17, az = 62 + Math.floor(a1 / 3) * 15;
      box(root, 2.2, 1.1, 2.2, M.metal, ax, 0.8, az, (a1 * 0.4));
      box(root, 0.16, 2.4, 0.16, M.woodDark, ax, 2.4, az);
      sph(root, 0.42, new T.MeshLambertMaterial({ color:0x2A3A3A, emissive:0x4FB8A8, emissiveIntensity:0.5 }), ax, 3.7, az, 7);
    }
    signBoard(150, 44, 0.3, "Field Station", "air-shower array", 7.4);
    place({ id:"field", name:"The Field Station", kind:"lab", x:150, z:44, r:7.5,
            sub:"Cosmic-ray array in the paddy", tag:"Field", topic:"cr" });

    /* ---- The Workshop ---- */
    barn({ x:-142, z:-56, ry:0.5, w:17, h:7.6, d:11, wall:0xBE8A66, roof:0x8A9695 });
    cyl(root, 1.5, 1.8, 11, M.stone, -156, 5.5, -46, 10);
    blocker(-156, -46, 2);
    signBoard(-142, -44, 0.5, "The Workshop", "magnets & mirrors", 7.4);
    place({ id:"workshop", name:"The Workshop", kind:"workshop", x:-140, z:-44, r:7.5,
            sub:"Where instruments get made", tag:"Workshop", topic:"coll" });

    /* ---- Pond, jetty, boats ---- */
    var jetty = new T.Group();
    box(jetty, 3.2, 0.3, 18, M.wood, 0, 1.0, 0);
    for (var jp = 0; jp < 6; jp++) {
      cyl(jetty, 0.2, 0.24, 2.2, M.woodDark, -1.3, 0.1, -8 + jp * 3.2, 6);
      cyl(jetty, 0.2, 0.24, 2.2, M.woodDark, 1.3, 0.1, -8 + jp * 3.2, 6);
    }
    jetty.position.set(-92, 0, 74); jetty.rotation.y = 0.5; root.add(jetty);
    signBoard(-80, 62, 0.5, "The Jetty", "ferry to anywhere", 7);
    place({ id:"jetty", name:"The Jetty", kind:"travel", x:-84, z:66, r:7,
            sub:"Ferry across the village", tag:"Travel", topic:null });
    for (var bo = 0; bo < 3; bo++) {
      var boat = new T.Group();
      var hull = new T.Mesh(new T.SphereGeometry(2.6, 10, 7, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        new T.MeshLambertMaterial({ color: bo === 1 ? C.clay : C.wood }));
      hull.scale.set(0.5, 0.55, 2.1); hull.position.y = 0.9; boat.add(hull);
      boat.position.set(-118 + bo * 14, 0, 90 + bo * 6);
      root.add(boat);
      boats.push({ g:boat, ph:Math.random() * 6.28, base:0 });
    }
    for (var pt = 0; pt < 9; pt++) {
      var pa = Math.random() * Math.PI * 2, pr = 36 + Math.random() * 12;
      tree(-118 + Math.cos(pa) * pr * 1.3, 84 + Math.sin(pa) * pr, 0.95, "palm");
    }

    /* ---- Guest Cottages ---- */
    var cottagePlots = [
      { x:-72, z:56, ry:0.9 }, { x:-52, z:74, ry:0.5 }, { x:-26, z:66, ry:0.1 },
      { x:6, z:78, ry:-0.2 }, { x:34, z:70, ry:-0.5 }, { x:66, z:60, ry:-0.8 }
    ];
    cottagePlots.forEach(function (p, i) {
      cottage({ x:p.x, z:p.z, ry:p.ry, w:9 + (i % 2) * 2, h:5.4, d:8,
                wall: i % 3 === 0 ? C.wall : (i % 3 === 1 ? 0xF0E2C6 : C.wallSage),
                roof: i % 2 ? C.roofClay : C.roofThatch, chimney: i % 2 === 0 });
      fenceRun(p.x - 7, p.z + 7, p.x + 7, p.z + 7);
      bush(p.x - 6, p.z + 5.6, 0.9); bush(p.x + 6, p.z + 5.6, 1.1);
    });
    signBoard(-26, 56, 0.1, "Guest Cottages", "visiting fellows", 7.2);
    place({ id:"cottages", name:"Guest Cottages", kind:"lodging", x:-26, z:56, r:7,
            sub:"Where visiting fellows stay", tag:"Lodging", topic:null });

    /* ---- plots for resident-founded institutes ---- */
    instPlots = [
      { x:-92, z:-92, ry:0.4 }, { x:-46, z:-108, ry:0.2 }, { x:22, z:-112, ry:-0.1 },
      { x:64, z:-96, ry:-0.4 }, { x:-130, z:-96, ry:0.6 }, { x:110, z:-46, ry:-0.7 },
      { x:-152, z:16, ry:1.0 }, { x:-120, z:-130, ry:0.5 }, { x:0, z:-140, ry:0 },
      { x:96, z:-140, ry:-0.3 }, { x:-70, z:-146, ry:0.3 }, { x:150, z:-88, ry:-0.6 }
    ];

    /* ---- scatter: trees, bushes, haystacks, lamps ---- */
    var kinds = ["round", "round", "conifer", "palm"];
    for (var s = 0; s < 70; s++) {
      var sa = Math.random() * Math.PI * 2, sr = 46 + Math.random() * 250;
      var sx = Math.cos(sa) * sr, sz = Math.sin(sa) * sr;
      var clear = true;
      for (var bi = 0; bi < blockers.length; bi++) {
        if (Math.hypot(sx - blockers[bi].x, sz - blockers[bi].z) < blockers[bi].r + 10) { clear = false; break; }
      }
      if (!clear) continue;
      if (V.nearRoad && V.nearRoad(sx, sz, 9)) continue;   /* not in the carriageway */
      tree(sx, sz, 0.8 + Math.random() * 0.8, kinds[s % 4]);
      if (s % 3 === 0) bush(sx + 5, sz + 3, 0.8 + Math.random() * 0.6);
    }
    /* lamp posts along the lane */
    for (var L = 0; L < V.lanePts.length; L += 16) {
      var lp = V.lanePts[L];
      cyl(root, 0.13, 0.17, 5.2, M.woodDark, lp[0], 2.6, lp[1] + 6.2, 6);
      var lantern = new T.Mesh(new T.BoxGeometry(0.9, 1.1, 0.9), M.lamp);
      lantern.position.set(lp[0], 5.5, lp[1] + 6.2); root.add(lantern);
    }
  }

  /* ---------- people ----------
   *
   * A resident is a chibi figure built from rounded stock — a big sphere
   * for the head, a bean of a torso, stubby limbs, mitten hands and
   * oversized shoes — so a figure reads as a person at walking distance
   * while staying small beside the buildings. Everything is still a scaled instance of the dozen unit
   * geometries in engine.js, so the extra detail costs uploads, not draw
   * calls: one material per colour, shared across the whole village.
   *
   * The look object is small and serialisable, because it travels in the
   * presence record:
   *   { skin, hair, shirt, trouser, outfit, style, glasses, beard, bag }
   */
  var SKIN = [0xF3D3B6, 0xE8BE99, 0xD3A074, 0xB07B4E, 0x8A5A34, 0x5E3A22, 0xF7E0C8, 0x9C6B44];
  var HAIR = [0x1E1712, 0x33241A, 0x0D0A08, 0x6B4A2A, 0x9A9A96, 0x4A2C1A, 0xC2A05C, 0x7A3A22];
  var SHIRT = [0xC4643F, 0x3E7A6E, 0x4A6FA8, 0xD4A24A, 0x8A5A96, 0x5A8A4A, 0xB84A5A, 0x2E5A66,
               0xE8E4DA, 0x2B3140, 0x76A3C4, 0xA8493C];
  var TROUSER = [0xE8E2D2, 0x3A4450, 0x6A5A46, 0x8A9A8A, 0x2E3A44, 0x4A3B52, 0x1F242B];

  /* Attire. Everything an academic actually turns up in, and nothing that
     needs its own geometry: each entry only says how the torso is dressed. */
  var OUTFITS = [
    { id:"labcoat",   name:"Lab coat",        coat:0xF4F1E8, coatLen:1.05, lapel:true,  badge:true },
    { id:"blazer",    name:"Blazer",          coat:null,     jacket:true,  lapel:true },
    { id:"cardigan",  name:"Cardigan",        coat:null,     jacket:true,  soft:true },
    { id:"shirt",     name:"Shirt & tie",     coat:null,     tie:true,     collar:true },
    { id:"turtle",    name:"Turtleneck",      coat:null,     turtle:true },
    { id:"hoodie",    name:"Hoodie",          coat:null,     hood:true },
    { id:"kurta",     name:"Kurta",           coat:null,     tunic:true },
    { id:"tee",       name:"T-shirt",         coat:null,     shortSleeve:true },
    { id:"gown",      name:"Academic gown",   coat:0x241E28, coatLen:1.35, hood:true, badge:false },
    { id:"suit",      name:"Suit",            coat:null,     jacket:true,  lapel:true, tie:true }
  ];
  var HAIRSTYLES = [
    { id:"short",  name:"Short" },
    { id:"long",   name:"Long" },
    { id:"bun",    name:"Bun" },
    { id:"curly",  name:"Curly" },
    { id:"crop",   name:"Close crop" },
    { id:"bald",   name:"Bald" },
    { id:"pony",   name:"Ponytail" }
  ];
  /* A small, deliberately cohesive cast.  These are presets, not separate
     models: the same rig and material library keeps every resident equally
     light to draw and ensures a look always travels as a tiny data object. */
  var BODY_TYPES = [
    { id:"standard", name:"Standard", shoulder:1.00, hip:1.00, build:1.00 },
    { id:"slender",  name:"Slender",  shoulder:0.92, hip:0.94, build:0.91 },
    { id:"broad",    name:"Broad",    shoulder:1.10, hip:1.04, build:1.10 }
  ];
  var AVATARS = [
    { id:"maya",   name:"Dr. Maya Singh",    note:"Lab researcher",  skin:3, hair:0, shirt:10, trouser:1, outfit:0, style:3, glasses:true,  beard:false, bag:true,  body:1 },
    { id:"noah",   name:"Dr. Noah Park",     note:"Theory faculty",  skin:1, hair:1, shirt:9,  trouser:6, outfit:9, style:0, glasses:true,  beard:true,  bag:false, body:2 },
    { id:"amina",  name:"Dr. Amina Okafor",  note:"Field scientist", skin:5, hair:2, shirt:5,  trouser:4, outfit:1, style:4, glasses:false, beard:false, bag:true,  body:0 },
    { id:"li",     name:"Dr. Li Wen",        note:"Quantum engineer",skin:2, hair:0, shirt:2,  trouser:1, outfit:2, style:1, glasses:true,  beard:false, bag:false, body:1 },
    { id:"elena",  name:"Dr. Elena Rossi",   note:"Research fellow", skin:0, hair:5, shirt:8,  trouser:0, outfit:3, style:6, glasses:false, beard:false, bag:true,  body:0 },
    { id:"omar",   name:"Dr. Omar Haddad",   note:"Data scientist",  skin:4, hair:1, shirt:7,  trouser:4, outfit:4, style:0, glasses:true,  beard:true,  bag:false, body:2 },
    { id:"sofia",  name:"Dr. Sofia Alvarez", note:"Materials lead",  skin:2, hair:7, shirt:6,  trouser:1, outfit:6, style:2, glasses:false, beard:false, bag:true,  body:1 },
    { id:"jordan", name:"Dr. Jordan Bell",   note:"Visiting scholar",skin:6, hair:4, shirt:3,  trouser:2, outfit:8, style:5, glasses:true,  beard:false, bag:false, body:0 }
  ];
  V.SKIN = SKIN; V.HAIR = HAIR; V.SHIRT = SHIRT; V.TROUSER = TROUSER;
  V.OUTFITS = OUTFITS; V.HAIRSTYLES = HAIRSTYLES; V.BODY_TYPES = BODY_TYPES; V.AVATARS = AVATARS;

  function indexOf(id, list) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }
  function indexValue(value, length, fallback) {
    return typeof value === "number" && isFinite(value) ? Math.abs(Math.floor(value)) % length : fallback;
  }
  V.avatarLook = function (id) {
    var n = indexOf(id, AVATARS), a = AVATARS[n < 0 ? 0 : n], out = {};
    Object.keys(a).forEach(function (k) { if (k !== "id" && k !== "name" && k !== "note") out[k] = a[k]; });
    out.avatar = a.id;
    return out;
  };
  V.normalizeLook = function (source) {
    var raw = source || {}, base = indexOf(raw.avatar, AVATARS) >= 0 ? V.avatarLook(raw.avatar) : {};
    var value = function (key, list, fallback) {
      return indexValue(raw[key], list.length, indexValue(base[key], list.length, fallback));
    };
    return {
      avatar: indexOf(raw.avatar, AVATARS) >= 0 ? raw.avatar : "custom",
      skin:value("skin", SKIN, 0), hair:value("hair", HAIR, 0), shirt:value("shirt", SHIRT, 0),
      trouser:value("trouser", TROUSER, 0), outfit:value("outfit", OUTFITS, 0),
      style:indexValue(raw.style, HAIRSTYLES.length, raw.long ? 1 : indexValue(base.style, HAIRSTYLES.length, 0)),
      body:value("body", BODY_TYPES, 0),
      glasses:raw.glasses != null ? !!raw.glasses : !!base.glasses,
      beard:raw.beard != null ? !!raw.beard : !!base.beard,
      bag:raw.bag != null ? !!raw.bag : !!base.bag
    };
  };
  V.lookSignature = function (look) { return JSON.stringify(V.normalizeLook(look)); };

  /* one Lambert per colour, shared by every resident wearing it */
  var personMats = {};
  function pm(hex, surface) {
    surface = surface || "fabric";
    var key = surface + "." + hex, m = personMats[key];
    if (!m) {
      var opt = { color:hex, roughness:0.76, metalness:0 };
      if (surface === "skin") { opt.roughness = 0.62; }
      else if (surface === "hair") { opt.roughness = 0.46; }
      else if (surface === "leather") { opt.roughness = 0.42; }
      else if (surface === "eye") { opt.roughness = 0.20; }
      else if (surface === "metal") { opt.roughness = 0.32; opt.metalness = 0.72; }
      m = personMats[key] = new T.MeshStandardMaterial(opt);
    }
    return m;
  }
  /* a slightly darker shade of a colour, for seams, shadow and trim */
  function shade(hex, k, surface) {
    var c = new T.Color(hex);
    c.multiplyScalar(k == null ? 0.78 : k);
    return pm(c.getHex(), surface);
  }

  function mesh(parent, geo, m, x, y, z, sx, sy, sz, ry) {
    var o = new T.Mesh(geo, m);
    o.position.set(x, y, z);
    o.scale.set(sx, sy == null ? sx : sy, sz == null ? sx : sz);
    if (ry) o.rotation.y = ry;
    parent.add(o);
    return o;
  }

  /* Chibi scale. A resident stands about 2.85 units: taller than a park
     bench's backrest, a third of the way up a street light, and small
     beside any hall. The head is a third of that, a 1:2 head-to-body
     ratio, so faces still read at the normal camera distance.

     Other modules hang props on a person (aprons, hats, trays) and sit
     them on chairs, so the landmarks they need live here rather than as
     magic numbers scattered across files. */
  var PERSON = {
    height:  2.85,
    hipY:    0.92,   /* leg pivot */
    waistY:  1.05,
    chestY:  1.44,   /* middle of the chest, for badges and buttons */
    chestZ:  0.28,   /* front of the chest */
    neckY:   1.70,
    headY:   2.28,   /* centre of the skull */
    headTop: 2.82,   /* crown of the hair */
    handY:   0.90,   /* hands at rest */
    /* chair seats top out at 1.09; the thigh is 0.15 thick */
    sitLift: 1.24 - 0.92
  };
  V.PERSON = PERSON;

  /* a skin tone nudged towards rose, so blush reads on every complexion */
  function blush(hex) {
    var c = new T.Color(hex).lerp(new T.Color(0xE36F6A), 0.38);
    return pm(c.getHex(), "skin");
  }

  function makePerson(look) {
    look = V.normalizeLook(look);
    var skin = SKIN[look.skin], hairC = HAIR[look.hair], shirtC = SHIRT[look.shirt];
    var trouserC = TROUSER[look.trouser], fit = OUTFITS[look.outfit], style = HAIRSTYLES[look.style];
    var body = BODY_TYPES[look.body];
    var P = PERSON;

    var g = new T.Group();
    var skinM = pm(skin, "skin"), hairM = pm(hairC, "hair"), shirtM = pm(shirtC, "fabric"), trouserM = pm(trouserC, "fabric");
    var shoeM = pm(0x3A2E24, "leather");
    var sph = V.U.sph(12), cyl = V.U.cyl(10), box = V.U.box();
    var headSph = V.U.sph(24), bodySph = V.U.sph(18);

    /* ---------------------------------------------------------- legs ---- */
    /* Two hinges, hip and knee, as before: short stubby legs still have to
       fold onto a chair. The shoes are deliberately oversized and rounded,
       which is most of what makes a chibi figure look planted. */
    function leg(side) {
      var L = new T.Group();
      mesh(L, cyl, trouserM, 0, -0.18, 0, 0.15 * body.build, 0.40, 0.15 * body.build);   /* thigh */
      mesh(L, sph, trouserM, 0, -0.38, 0, 0.14 * body.build);                             /* knee */
      var S = new T.Group();
      S.position.y = -0.38;
      mesh(S, cyl, trouserM, 0, -0.14, 0, 0.13 * body.build, 0.28, 0.13 * body.build);
      mesh(S, sph, shoeM, 0, -0.43, 0.07, 0.17 * body.build, 0.12, 0.26);                /* shoe */
      mesh(S, box, shade(0x3A2E24, 0.55, "leather"), 0, -0.515, 0.07, 0.30 * body.build, 0.05, 0.46); /* sole */
      L.add(S);
      L.position.set(side * 0.17 * body.hip, P.hipY, 0);
      L.userData.shin = S;
      g.add(L);
      return L;
    }
    var lLeg = leg(-1), rLeg = leg(1);

    /* --------------------------------------------------------- torso ---- */
    /* A soft bean rather than a slab: pelvis, a round belly and a chest
       that rounds over at the shoulders. */
    var jacketM = fit.jacket ? shade(shirtC, fit.soft ? 0.86 : 0.62, "fabric") : null;
    var torsoC = fit.coat != null ? fit.coat : shirtC;
    var torsoM = jacketM || pm(torsoC, "fabric");
    var sw = body.shoulder;

    mesh(g, bodySph, fit.coat != null ? torsoM : trouserM, 0, 0.98, 0, 0.35 * body.hip, 0.22, 0.28);
    mesh(g, bodySph, torsoM, 0, 1.18, 0, 0.37 * body.build, 0.28, 0.295);
    var chest = mesh(g, V.U.cyl(18), torsoM, 0, 1.36, 0, 0.36 * sw, 0.58, 0.265);
    mesh(g, bodySph, torsoM, 0, 1.64, 0, 0.38 * sw, 0.14, 0.25);                                /* shoulders */

    var tails = null;
    if (fit.coat != null) {
      /* coat tails hang below the waist, split up the middle; they hang
         from a pivot at the waist so they can fold up on a seat */
      var len = (fit.coatLen || 1.05) * 0.5;
      tails = new T.Group();
      tails.position.y = 1.06;
      mesh(tails, box, torsoM, -0.19, -len / 2, 0, 0.34, len, 0.50);
      mesh(tails, box, torsoM, 0.19, -len / 2, 0, 0.34, len, 0.50);
      g.add(tails);
      mesh(g, box, shirtM, 0, 1.38, 0.265, 0.15, 0.52, 0.03);    /* shirt down the opening */
    }
    if (fit.jacket) {
      /* an open jacket: shirt showing down the front, lapels either side */
      mesh(g, box, pm(0xF2EDE0), 0, 1.40, 0.262, 0.14, 0.50, 0.03);
      mesh(g, box, shade(shirtC, fit.soft ? 0.74 : 0.5), -0.09, 1.50, 0.27, 0.05, 0.34, 0.03).rotation.z = -0.32;
      mesh(g, box, shade(shirtC, fit.soft ? 0.74 : 0.5), 0.09, 1.50, 0.27, 0.05, 0.34, 0.03).rotation.z = 0.32;
    }
    if (fit.tunic) {
      mesh(g, cyl, torsoM, 0, 0.94, 0, 0.39, 0.38, 0.31);
      mesh(g, box, shade(torsoC, 0.84), 0, 1.36, 0.275, 0.06, 0.52, 0.03);
    }
    if (fit.turtle) {
      mesh(g, cyl, torsoM, 0, 1.74, 0, 0.16, 0.14, 0.16);       /* rolled collar */
    }
    if (fit.hood) {
      mesh(g, sph, shade(torsoC, 0.88), 0, 1.72, -0.20, 0.30, 0.17, 0.19);
    }
    if (fit.collar || fit.lapel) {
      var collarM = pm(0xF4EFE2);
      mesh(g, box, collarM, -0.09, 1.70, 0.19, 0.14, 0.09, 0.10, 0.45);
      mesh(g, box, collarM, 0.09, 1.70, 0.19, 0.14, 0.09, 0.10, -0.45);
    }
    if (fit.tie) {
      mesh(g, box, pm(0x8C2F39), 0, 1.42, 0.285, 0.07, 0.38, 0.03);
      mesh(g, box, pm(0x8C2F39), 0, 1.63, 0.265, 0.06, 0.07, 0.03);
    }
    if (fit.badge) {
      /* conference lanyard: the one accessory every one of these people owns */
      mesh(g, box, pm(0x2E5A66), -0.08, 1.56, 0.27, 0.03, 0.22, 0.02, 0.3);
      mesh(g, box, pm(0x2E5A66), 0.08, 1.56, 0.27, 0.03, 0.22, 0.02, -0.3);
      mesh(g, box, pm(0xF7F3E6), 0, 1.40, 0.29, 0.14, 0.18, 0.02);
    }

    /* ---------------------------------------------------------- arms ---- */
    /* Short arms that end in oversized mitten hands, splayed a touch so
       they clear the belly when they swing. */
    function arm(side) {
      var A = new T.Group();
      var sleeveM = fit.coat != null || fit.jacket ? torsoM : shirtM;
      var bare = !!fit.shortSleeve;
      mesh(A, sph, sleeveM, 0, 0, 0, 0.14);                                                   /* shoulder */
      mesh(A, cyl, sleeveM, 0, -0.17, 0, 0.11 * body.build, 0.30, 0.11 * body.build);        /* upper */
      mesh(A, cyl, bare ? skinM : sleeveM, 0, -0.42, 0, 0.10 * body.build, 0.26, 0.10 * body.build);
      mesh(A, sph, skinM, 0, -0.62, 0.01, 0.13, 0.14, 0.12);                                  /* hand */
      mesh(A, sph, skinM, -side * 0.08, -0.57, 0.07, 0.05, 0.06, 0.05);                       /* thumb */
      A.position.set(side * 0.41 * sw, 1.60, 0);
      A.rotation.z = side * 0.12;
      g.add(A);
      return A;
    }
    var lArm = arm(-1), rArm = arm(1);

    if (look.bag) {
      /* a satchel on a strap slung from the right shoulder */
      mesh(g, cyl, pm(0x6A4A30), 0, 1.34, 0, 0.385, 0.05, 0.30).rotation.z = 0.62;
      mesh(g, box, pm(0x7C5638), -0.24, 1.02, -0.30, 0.30, 0.26, 0.12);
      mesh(g, box, pm(0x6A4A30), -0.24, 1.10, -0.365, 0.30, 0.12, 0.02);                      /* flap */
    }

    /* ---------------------------------------------------------- head ---- */
    var head = new T.Group();
    mesh(head, cyl, skinM, 0, -0.50, 0, 0.11, 0.20, 0.11);        /* neck */
    mesh(head, headSph, skinM, 0, 0, 0, 0.50, 0.47, 0.47);        /* skull */
    mesh(head, headSph, skinM, 0, -0.18, 0.06, 0.43, 0.30, 0.41); /* round cheeks */
    mesh(head, sph, shade(skin, 0.92, "skin"), 0, -0.11, 0.47, 0.035, 0.03, 0.03);   /* nose */
    [-1, 1].forEach(function (s) {
      mesh(head, sph, skinM, s * 0.49, -0.04, 0.02, 0.07, 0.10, 0.06);                /* ears */
    });

    /* Big eyes carry the face at this size: white, iris, pupil and a catch
       light, each turned to sit flush with the curve of the skull. */
    var whiteM = pm(0xF7F3EC, "eye"), iris = pm(0x3A2A1C, "eye"), pupil = pm(0x11100E, "eye");
    [-1, 1].forEach(function (s) {
      var ry = s * 0.36;
      mesh(head, sph, whiteM, s * 0.17, -0.02, 0.43, 0.085, 0.105, 0.04, ry);
      mesh(head, sph, iris, s * 0.168, -0.03, 0.452, 0.064, 0.08, 0.03, ry);
      mesh(head, sph, pupil, s * 0.166, -0.03, 0.47, 0.034, 0.044, 0.02, ry);
      mesh(head, sph, whiteM, s * 0.166 + 0.026, 0.005, 0.482, 0.02, 0.022, 0.012, ry);  /* catch light */
      mesh(head, box, hairM, s * 0.17, 0.125, 0.445, 0.13, 0.028, 0.03, ry);           /* brow */
      mesh(head, sph, blush(skin), s * 0.29, -0.14, 0.37, 0.07, 0.04, 0.02, s * 0.62);
    });
    mesh(head, sph, pm(0x7A3B34, "skin"), 0, -0.22, 0.47, 0.06, 0.022, 0.02);          /* mouth */

    if (look.glasses) {
      var frameM = pm(0x2B2B2B, "metal");
      [-1, 1].forEach(function (s) {
        mesh(head, V.U.torus(), frameM, s * 0.17, -0.02, 0.475, 0.125, 0.125, 0.125, s * 0.36);
        mesh(head, box, frameM, s * 0.39, 0.0, 0.21, 0.02, 0.02, 0.42, -s * 0.42);    /* arm, back to the ear */
      });
      mesh(head, box, frameM, 0, 0.0, 0.49, 0.10, 0.02, 0.02);                          /* bridge */
    }

    /* hair: a cap sitting back on the skull, and a fringe over the brow */
    if (style.id !== "bald") {
      var crop = style.id === "crop";
      mesh(head, headSph, hairM, 0, crop ? 0.12 : 0.10, -0.07, crop ? 0.52 : 0.54, crop ? 0.42 : 0.44, crop ? 0.50 : 0.52);
      if (!crop) {
        [-1, 1].forEach(function (s) {
          mesh(head, sph, hairM, s * 0.16, 0.25, 0.34, 0.25, 0.14, 0.15, -s * 0.3);    /* fringe */
        });
      }
      if (style.id === "short" || crop) {
        mesh(head, sph, hairM, 0, -0.10, -0.24, 0.46, 0.30, 0.28);                     /* nape */
      }
      if (style.id === "curly") {
        for (var ci = 0; ci < 10; ci++) {
          var ca = (ci / 10) * Math.PI * 2;
          if (Math.cos(ca) > 0.8) continue;           /* keep the face clear */
          mesh(head, sph, hairM, Math.sin(ca) * 0.46, 0.20 + Math.cos(ca * 3) * 0.06,
               Math.cos(ca) * 0.40 - 0.06, 0.17);
        }
        mesh(head, sph, hairM, 0, 0.48, -0.04, 0.24, 0.14, 0.24);
      }
      if (style.id === "long" || style.id === "pony") {
        mesh(head, sph, hairM, 0, -0.18, -0.22, 0.50, 0.46, 0.30);                     /* back */
      }
      if (style.id === "long") {
        [-1, 1].forEach(function (s) {
          mesh(head, sph, hairM, s * 0.45, -0.22, 0.10, 0.12, 0.34, 0.18);            /* side locks */
        });
        mesh(head, sph, hairM, 0, -0.48, -0.20, 0.44, 0.26, 0.26);
      }
      if (style.id === "pony") {
        mesh(head, sph, hairM, 0, 0.12, -0.52, 0.10);                                  /* tie */
        mesh(head, sph, hairM, 0, -0.18, -0.62, 0.14, 0.32, 0.14).rotation.x = 0.35;
      }
      if (style.id === "bun") {
        mesh(head, sph, hairM, 0, 0.46, -0.16, 0.22);
      }
    }
    if (look.beard) {
      mesh(head, headSph, hairM, 0, -0.30, 0.12, 0.40, 0.24, 0.34);
      mesh(head, sph, hairM, 0, -0.165, 0.475, 0.11, 0.03, 0.03);                        /* moustache */
    }

    head.position.y = P.headY;
    g.add(head);

    g.userData.rig = { lLeg:lLeg, rLeg:rLeg, lArm:lArm, rArm:rArm, head:head, chest:chest,
                       lShin:lLeg.userData.shin, rShin:rLeg.userData.shin, sitLift:P.sitLift, tails:tails };
    g.userData.look = look;

    /* contact patch travels with the person */
    var sh = new T.Mesh(V.U.circle(14),
      new T.MeshBasicMaterial({ color:0x4E5C46, transparent:true, opacity:0.22, depthWrite:false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.04; sh.scale.setScalar(0.62);
    g.add(sh);
    return g;
  }
  V.makePerson = makePerson;
  V.randomLook = function (seed) {
    var s = seed == null ? Math.floor(Math.random() * 99999) : seed;
    return { avatar:"custom", skin:s % SKIN.length, hair:(s >> 2) % HAIR.length, shirt:(s >> 4) % SHIRT.length,
             trouser:(s >> 6) % TROUSER.length, outfit:(s >> 8) % OUTFITS.length,
             style:(s >> 11) % HAIRSTYLES.length, body:(s >> 13) % BODY_TYPES.length,
             glasses:((s >> 3) % 3) === 0, beard:((s >> 5) % 5) === 0, bag:((s >> 7) % 4) === 0 };
  };

  /* ---------- riding ----------
   * A bike rides as a child of its rider (transport.js, app.js and
   * ambient.js all attach it that way), so whoever carries one is riding.
   * Each leg is a two-bone chain solved onto its pedal every frame, so the
   * feet stay on the pedals as the cranks turn; the hands rest on the grips. */
  function vehicleOf(g) {
    var kids = g.children;
    for (var i = 0; i < kids.length; i++) if (kids[i].userData.ride || kids[i].userData.drive) return kids[i];
    return null;
  }
  var THIGH = 0.38, SHIN = 0.54;               /* hip-to-knee, knee-to-sole */
  function legOnPedal(leg, shin, hipY, py, pz) {
    var dy = py - hipY, dz = pz;
    var d = Math.min(THIGH + SHIN - 0.001, Math.max(Math.abs(SHIN - THIGH) + 0.001, Math.hypot(dy, dz)));
    /* rotation.x = a points a limb along (z, y) = (-sin a, -cos a) */
    var aim = Math.atan2(-dz, -dy);
    var hip = Math.acos((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d));
    var knee = Math.acos((THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN));
    leg.rotation.x = aim - hip;                /* knee forward */
    if (shin) shin.rotation.x = Math.PI - knee;
  }
  function ride(g, r, bike, t) {
    var cfg = bike.userData.ride, P = PERSON;
    var a = bike.userData.pedals ? bike.userData.pedals.rotation.x : 0;
    var by = bike.position.y + cfg.bbY + cfg.pedalTop, bz = bike.position.z + cfg.bbZ, K = cfg.crank;
    g.position.y = g.userData.yOffset = 0;
    /* left foot on the pedal that starts up, right on the one that starts down */
    legOnPedal(r.lLeg, r.lShin, P.hipY, by + K * Math.cos(a), bz + K * Math.sin(a));
    legOnPedal(r.rLeg, r.rShin, P.hipY, by - K * Math.cos(a), bz - K * Math.sin(a));
    /* arms forward to the grips, turning a little with the bars */
    var reach = Math.atan2(cfg.grip[1], 1.60 - cfg.grip[0]);   /* from the shoulder pivot */
    var steer = bike.userData.fork ? bike.userData.fork.rotation.y : 0;
    r.lArm.rotation.x = -reach + steer * 0.35;
    r.rArm.rotation.x = -reach - steer * 0.35;
    if (r.chest) r.chest.rotation.z = 0;
    if (r.tails) r.tails.scale.y = 0.3;
    r.head.rotation.z = Math.sin(a) * 0.03;
    r.head.rotation.y *= 0.9;
  }
  /* Driving a jeep: seated, thighs along the seat (its top is built at the
     underside of the thighs), shins down to the floor, hands on the rim. */
  function drive(g, r, jeep, t) {
    var cfg = jeep.userData.drive, P = PERSON;
    g.position.y = g.userData.yOffset = 0;
    r.lLeg.rotation.x = r.rLeg.rotation.x = -Math.PI / 2;
    if (r.lShin) r.lShin.rotation.x = Math.PI / 2;
    if (r.rShin) r.rShin.rotation.x = Math.PI / 2;
    var reach = Math.atan2(cfg.wheel[1], 1.60 - cfg.wheel[0]);
    var sw = jeep.userData.steer && jeep.userData.steer[0] ? jeep.userData.steer[0].rotation.y : 0;
    r.lArm.rotation.x = -reach + sw * 0.5;
    r.rArm.rotation.x = -reach - sw * 0.5;
    if (r.chest) r.chest.rotation.z = 0;
    if (r.tails) r.tails.scale.y = 0.3;
    r.head.rotation.z *= 0.9;
    r.head.rotation.y = Math.sin(t * 0.5) * 0.12;
  }

  /* walk cycle */
  V.animatePerson = function (g, moving, t, speed) {
    var r = g.userData.rig; if (!r) return;
    var vehicle = vehicleOf(g);
    if (vehicle) {
      if (vehicle.userData.drive) drive(g, r, vehicle, t); else ride(g, r, vehicle, t);
      return;
    }
    var pose = g.userData.pose;
    /* coat tails tuck up on a seat and hang again once standing */
    if (r.tails) r.tails.scale.y = pose === "sit" ? 0.3 : 1;
    if (pose === "sit") {
      /* seated: the legs stay folded, only the head moves */
      r.head.rotation.y = Math.sin(t * 0.6) * 0.2;
      g.position.y = g.userData.yOffset || 0;
      return;
    }
    if (pose === "speak") {
      /* one arm up at the board, weight shifting */
      r.rArm.rotation.x = -1.15 + Math.sin(t * 1.6) * 0.28;
      r.lArm.rotation.x = -0.2 + Math.sin(t * 1.1) * 0.12;
      r.head.rotation.y = Math.sin(t * 0.9) * 0.34;
      g.position.y = (g.userData.yOffset || 0) + Math.abs(Math.sin(t * 1.4)) * 0.03;
      return;
    }
    if (moving) {
      var sw = Math.sin(t * (7.0 * (speed || 1))) * 0.58;
      r.lLeg.rotation.x = sw; r.rLeg.rotation.x = -sw;
      /* the trailing knee bends; the leading one straightens */
      if (r.lShin) r.lShin.rotation.x = Math.max(0, -sw) * 1.15;
      if (r.rShin) r.rShin.rotation.x = Math.max(0, sw) * 1.15;
      r.lArm.rotation.x = -sw * 0.78; r.rArm.rotation.x = sw * 0.78;
      /* a touch of roll and bob, which is most of what sells a walk */
      r.head.rotation.z = Math.sin(t * (7.0 * (speed || 1))) * 0.05;
      if (r.chest) r.chest.rotation.z = -sw * 0.035;
      g.position.y = Math.abs(Math.sin(t * (14 * (speed || 1)))) * 0.07;
    } else {
      r.lLeg.rotation.x *= 0.85; r.rLeg.rotation.x *= 0.85;
      if (r.lShin) r.lShin.rotation.x *= 0.85;
      if (r.rShin) r.rShin.rotation.x *= 0.85;
      r.lArm.rotation.x *= 0.85; r.rArm.rotation.x *= 0.85;
      r.head.rotation.z *= 0.85;
      if (r.chest) r.chest.rotation.z *= 0.82;
      r.head.rotation.y = Math.sin(t * 0.7) * 0.22;
      g.position.y *= 0.8;
    }
  };

  var VILLAGER_NAMES = [
    "Dr.Kang", "Prof.Tseng", "Sister Vera", "Old Iyer", "Maya", "Thomas", "Leela", "Dr. Abel",
    "Prof. Marek", "Nila", "Samir", "Grandma Rosa", "Ines", "Kwesi", "Tariq", "Hannah",
    "Prof. Okoye", "Yusuf", "Mira", "Dr. Sandoval", "Anush", "Betty", "Kenji", "Fatima"
  ];
  var VILLAGER_ROLES = [
    { r:"Professor", t:"pheno" }, { r:"cosmologist", t:"inf" }, { r:"observer", t:"astro" },
    { r:"tea maker", t:null }, { r:"librarian", t:null }, { r:"Assistant professor", t:"coll" },
    { r:"student", t:"gw" }, { r:"student", t:"dp" }, { r:"boatman", t:null },
    { r:"farmer", t:null }, { r:"postdoc", t:"pbh" }, { r:"professor", t:"qg" },
    { r:"Professor", t:"nu" }, { r:"child", t:null }, { r:"gardener", t:null }, { r:"postdoc", t:"axion" }
  ];

  function buildVillagers() {
    var spots = PLACES.slice();
    for (var i = 0; i < 18; i++) {
      var role = VILLAGER_ROLES[i % VILLAGER_ROLES.length];
      var home = spots[i % spots.length];
      var look = V.randomLook(i * 37 + 11);
      var g = makePerson(look);
      if (role.r === "child") g.scale.setScalar(0.72);
      var a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 13;
      g.position.set(home.x + Math.cos(a) * r, 0, home.z + Math.sin(a) * r);
      root.add(g);
      villagers.push({
        g:g, name:VILLAGER_NAMES[i % VILLAGER_NAMES.length], role:role.r,
        topic: role.t || home.topic, home:home,
        tx:g.position.x, tz:g.position.z, idle:Math.random() * 5, t:Math.random() * 10
      });
    }
    V.villagers = villagers;
  }

  /* ---------- collectible paper tokens ---------- */
  function makeToken(p) {
    var hue = TOPIC_HUES[p.t] || 0x4FA8B8;
    var g = new T.Group();
    var disc = new T.Mesh(new T.CylinderGeometry(0.9, 0.9, 0.12, 18),
      new T.MeshLambertMaterial({ color: 0xF6EEDC, emissive: hue, emissiveIntensity: 0.22 }));
    disc.rotation.x = Math.PI / 2; g.add(disc);
    var ring = new T.Mesh(new T.TorusGeometry(1.05, 0.09, 6, 20), new T.MeshBasicMaterial({ color: hue }));
    g.add(ring);
    var lines = new T.Mesh(new T.BoxGeometry(0.9, 0.1, 0.02), new T.MeshBasicMaterial({ color: hue }));
    lines.position.set(0, 0.22, 0.08); g.add(lines);
    var lines2 = lines.clone(); lines2.position.y = 0; lines2.scale.x = 0.7; g.add(lines2);
    var lines3 = lines.clone(); lines3.position.y = -0.22; lines3.scale.x = 0.85; g.add(lines3);
    g.position.set(p.x, 2.0, p.z);
    root.add(g);
    var halo = patch(p.x, p.z, 1.5, 0.18);
    return { g:g, halo:halo, ph:Math.random() * 6.28 };
  }

  V.spawnTokens = function (list) {
    tokens.forEach(function (t) { root.remove(t.g); root.remove(t.halo); });
    tokens = [];
    list.forEach(function (item) {
      var tk = makeToken(item);
      tk.data = item;
      tokens.push(tk);
    });
    V.tokens = tokens;
    return tokens;
  };
  V.removeToken = function (tk) {
    var i = tokens.indexOf(tk);
    if (i >= 0) tokens.splice(i, 1);
    root.remove(tk.g); root.remove(tk.halo);
  };
  V.tokens = tokens;

  /* ---------- resident-founded institutes ---------- */
  V.plotFor = function (i) { return instPlots[i % instPlots.length]; };
  V.foundInstitute = function (uni, index, animate) {
    var plot = V.plotFor(index);
    var hue = TOPIC_HUES[uni.topic] || 0x4FB89A;
    var g = hall({ x:plot.x, z:plot.z, ry:plot.ry, w:20, h:9.5, d:13,
                   wall: index % 2 ? C.wallSage : C.wall,
                   roof: index % 3 === 0 ? C.roofClay : (index % 3 === 1 ? C.roofTile : C.roofSlate) });
    var fx = plot.x + Math.sin(plot.ry) * 13, fz = plot.z + Math.cos(plot.ry) * 13;
    signBoard(fx, fz, plot.ry, uni.name, uni.topicName || "founded by a resident", 8);
    var flag = new T.Mesh(new T.PlaneGeometry(2.6, 1.7), new T.MeshLambertMaterial({ color: hue, side: T.DoubleSide }));
    flag.position.set(plot.x - 9, 13.5, plot.z); root.add(flag);
    cyl(root, 0.1, 0.12, 8, M.woodDark, plot.x - 10.3, 10, plot.z, 6);
    place({ id:"inst-" + uni.id, name:uni.name, kind:"institute",
            x:fx, z:fz + 3, r:8, sub:uni.topicName || "Resident institute", tag:"Institute",
            topic:uni.topic, uni:uni.id });
    instBuilt.push(g);
    if (animate) { g.scale.y = 0.02; g.userData.rise = 0; }
    return g;
  };

  /* ---------- weather ---------- */
  function buildWeather() {
    var n = 2400, pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      pos[i*3] = (Math.random() - 0.5) * 210;
      pos[i*3+1] = Math.random() * 70;
      pos[i*3+2] = (Math.random() - 0.5) * 210;
    }
    var g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(pos, 3));
    rainPts = new T.Points(g, new T.PointsMaterial({ color:0xBFD8DC, size:0.5, transparent:true, opacity:0.6, depthWrite:false }));
    rainPts.visible = false; rainPts.frustumCulled = false; scene.add(rainPts);
  }

  /* ---------- init ---------- */
  V.init = function (canvas) {
    scene = new T.Scene();
    root = new T.Group(); scene.add(root);
    scene.fog = new T.Fog(0xE0EADF, 330, 1150);

    /* The far plane used to sit at 3400, two and a half kilometres past the
       point where the fog has already turned everything to flat haze. Every
       one of those buildings was still being submitted, shaded and thrown
       away. Pulling the plane in just behind the fog means the culler drops
       them for free, and nothing visible changes. The sky dome is excluded
       from culling below, because it is meant to be behind everything. */
    camera = new T.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.6, 1400);
    camera.position.set(0, 26, 44);

    /* A phone and a laptop want different starting points, and both want the
       ratio to move afterwards — see V.quality below. Antialiasing is the
       other fixed cost worth refusing on a small panel, where the pixels are
       already too small to see the stair-stepping it removes. */
    var small = Math.min(window.innerWidth, window.innerHeight) < 780;
    var coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    renderer = new T.WebGLRenderer({
      canvas: canvas,
      antialias: !small && !coarse,
      powerPreference: "high-performance",
      /* neither is used, and both cost memory on every resize */
      stencil: false,
      depth: true
    });
    V.quality.max = Math.min(window.devicePixelRatio || 1, small || coarse ? 1.5 : 2);
    V.quality.min = small || coarse ? 0.6 : 0.75;
    V.quality.ratio = Math.min(V.quality.max, small || coarse ? 1.25 : 1.6);
    renderer.setPixelRatio(V.quality.ratio);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputEncoding = T.sRGBEncoding;
    clock = new T.Clock();

    buildMats();
    buildSky();

    /* The greens only read as greens if the scene is not over-lit: three
       lights all near full strength on a Lambert surface clips it towards
       white, which is how a meadow ends up looking like a car park. */
    hemi = new T.HemisphereLight(0xDCEBDA, 0x7E8C5A, 0.62); scene.add(hemi);
    sun = new T.DirectionalLight(0xFFF2D8, 0.72);
    sun.position.set(60, 90, 40); scene.add(sun);
    fill = new T.DirectionalLight(0xCFE4E8, 0.20);
    fill.position.set(-70, 40, -60); scene.add(fill);

    V.root = root;
    /* Modules declare their roads and districts first, as plain data, so the
       village's own scatter can keep out of the way of them. */
    modules("plan");
    /* One instancing batch for the whole world's scenery. */
    V.props = V.batch();
    buildGround();
    buildVillage();

    /* The wider campus, its transport and its wildlife are separate modules;
       each is optional, and a failure in one must not cost you the village. */
    modules("build");

    buildVillagers();
    buildWeather();

    /* Emit the batched scenery as a handful of InstancedMesh draw calls. */
    V.props.flush(root);
    V.props = null;

    /* One pass to bucket every solid into the collision grid. */
    V.buildIndex();

    /* Nothing the player is meant to reach may sit inside something solid:
       nudge every marker, seat and stage out onto clear ground. A sign that
       drifted a metre into a hedge is the sort of thing that only shows up
       as "I cannot get to the library", so it is fixed here once. */
    PLACES.forEach(function (p) {
      var c = V.clearSpot(p.x, p.z, 1.6);
      p.x = c.x; p.z = c.z;
    });
    (V.seats || []).forEach(function (st) {
      if (!V.blockedAt(st.x, st.z, 0.9)) return;
      var c = V.clearSpot(st.x, st.z, 1.0);
      st.x = c.x; st.z = c.z;
    });
    (V.ROOMS || []).forEach(function (r) {
      if (!r.stage) return;
      var c = V.clearSpot(r.stage.x, r.stage.z, 1.3);
      r.stage.x = c.x; r.stage.z = c.z;
    });

    window.addEventListener("resize", V.resize);
    return { scene:scene, camera:camera, renderer:renderer };
  };

  /* Optional world modules, called in order. A module that throws is
     reported once and then skipped, so the village still runs. */
  var MODULES = ["QVCampus", "QVTransport", "QVAmbient"];
  var moduleFailed = {};
  function modules(phase, a, b) {
    for (var i = 0; i < MODULES.length; i++) {
      var m = window[MODULES[i]];
      if (!m || typeof m[phase] !== "function") continue;
      if (moduleFailed[MODULES[i] + phase]) continue;
      try { m[phase](a, b); }
      catch (e) {
        moduleFailed[MODULES[i] + phase] = true;
        console.warn("[village] " + MODULES[i] + "." + phase + " failed:", e && e.message);
      }
    }
  }
  V.modules = modules;

  var resizeTimer = null;
  V.resize = function () {
    if (!renderer) return;
    /* A phone rotating, or a desktop window being dragged, fires this dozens
       of times a second and each one reallocates the drawing buffer. */
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    }, 120);
  };

  /* clearSpot / freeSpot / blockedAt all live in engine.js */

  V.placeAt = function (x, z) {
    var best = null, bd = 1e9;
    PLACES.forEach(function (p) {
      var d = Math.hypot(x - p.x, z - p.z);
      if (d < bd) { bd = d; best = p; }
    });
    if (bd < 40) return best;
    var inside = V.insideOf && V.insideOf(x, z);
    if (inside) return { name: inside.name || "Indoors", sub:"Inside" };
    var zone = V.zoneAt && V.zoneAt(x, z);
    if (zone) return zone;
    var r = Math.hypot(x, z);
    if (r > 560) return { name:"The Outskirts", sub:"Fields and footpaths" };
    if (r > 210) return { name:"Campus Grounds", sub:"Between the districts" };
    return { name:"Village Lane", sub:"Between the houses" };
  };

  /* ---------- palettes across the day ---------- */
  var SKY = {
    dayTop:new T.Color(0x7FC0CE), dayHaze:new T.Color(0xBCDCDA), dayLow:new T.Color(0xEDE7D2),
    goldTop:new T.Color(0x4E7F9E), goldHaze:new T.Color(0xE0A878), goldLow:new T.Color(0xF6D9A8),
    nightTop:new T.Color(0x0E1C33), nightHaze:new T.Color(0x1E3350), nightLow:new T.Color(0x39506A)
  };
  var cT = new T.Color(), cH = new T.Color(), cL = new T.Color();
  var sunCol = new T.Color(), hemiCol = new T.Color(), groundCol = new T.Color();
  var warmCol = new T.Color(0xFFD3A0), dayCol = new T.Color(0xE8F2E4);
  var earthCol = new T.Color(0xB9A87E), emberCol = new T.Color(0xCE9A66);

  V.update = function (dt, playerPos) {
    if (state.paused) { /* held where it is */ }
    else if (state.realTime) state.time = localDayFraction();
    else state.time = (state.time + dt / state.dayLength) % 1;
    if (playerPos) {
      V.updateInteriors(playerPos.x, playerPos.z, dt);
      V.updateDoors(playerPos.x, playerPos.z, dt);
      V.updateLods(playerPos.x, playerPos.z);
    }
    var t = state.time;
    var ang = (t - 0.25) * Math.PI * 2;
    var sy = Math.sin(ang), sx = Math.cos(ang);

    var day = Math.max(0, Math.min(1, (sy - 0.06) / 0.30));
    var gold = Math.max(0, 1 - Math.abs(sy - 0.10) / 0.26);
    cT.copy(SKY.nightTop).lerp(SKY.dayTop, day).lerp(SKY.goldTop, gold * 0.9);
    cH.copy(SKY.nightHaze).lerp(SKY.dayHaze, day).lerp(SKY.goldHaze, gold * 0.9);
    cL.copy(SKY.nightLow).lerp(SKY.dayLow, day).lerp(SKY.goldLow, gold * 0.95);
    skyMat.uniforms.top.value.copy(cT);
    skyMat.uniforms.haze.value.copy(cH);
    skyMat.uniforms.low.value.copy(cL);
    skyMat.uniforms.sunDir.value.set(sx * 0.85, sy, 0.4).normalize();
    skyMat.uniforms.glow.value = 0.25 + gold * 0.85;
    scene.fog.color.copy(cH).lerp(cL, 0.5);

    sun.position.set(sx * 140, Math.max(sy, 0.05) * 150, 60);
    sun.intensity = 0.14 + Math.max(0, sy) * 0.74 + gold * 0.42;
    sunCol.setHex(0xFFF4DC).lerp(warmCol, gold);
    sun.color.copy(sunCol);
    hemi.intensity = 0.24 + Math.max(0, sy) * 0.46 + gold * 0.20;
    hemiCol.setHex(0x7C93B4).lerp(dayCol, day);
    hemiCol.lerp(warmCol, gold * 0.8);
    hemi.color.copy(hemiCol);
    groundCol.setHex(0x44504E).lerp(earthCol, day);
    groundCol.lerp(emberCol, gold * 0.75);
    hemi.groundColor.copy(groundCol);
    fill.intensity = 0.09 + day * 0.14;
    fill.color.setHex(gold > 0.35 ? 0xD8C0E0 : 0xCFE4E8);

    var night = Math.max(0, Math.min(1, (0.08 - sy) / 0.18));
    V.night = night;
    stars.material.opacity = night * 0.85;
    cloudGroup.visible = night < 0.7;
    for (var i = 0; i < windowMats.length; i++) windowMats[i].emissiveIntensity = night * 0.95;
    for (var j = 0; j < lampMats.length; j++) lampMats[j].emissiveIntensity = night * 1.4;

    /* the dome rides with the viewer, and the clouds drift across it */
    celestial.position.x = camera.position.x;
    celestial.position.z = camera.position.z;
    cloudGroup.children.forEach(function (cl) {
      cl.position.x += cl.userData.drift * dt * 2.6;
      if (cl.position.x > 800) cl.position.x = -800;
    });

    /* villagers wander — only the ones near enough to matter */
    villagers.forEach(function (n) {
      if (playerPos) {
        var far = Math.abs(n.g.position.x - playerPos.x) + Math.abs(n.g.position.z - playerPos.z);
        n.g.visible = far < 420;
        if (far > 260) return;
      }
      n.t += dt;
      var dx = n.tx - n.g.position.x, dz = n.tz - n.g.position.z;
      var d = Math.hypot(dx, dz);
      if (d < 0.9) {
        n.idle -= dt;
        V.animatePerson(n.g, false, n.t, 1);
        if (n.idle <= 0) {
          var a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 15;
          var spot = V.clearSpot(n.home.x + Math.cos(a) * r, n.home.z + Math.sin(a) * r, 1.4);
          n.tx = spot.x; n.tz = spot.z;
          n.idle = 2 + Math.random() * 7;
        }
      } else {
        var sp = 2.1 * dt;
        n.g.position.x += (dx / d) * sp; n.g.position.z += (dz / d) * sp;
        var want = Math.atan2(dx, dz);
        var diff = ((want - n.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        n.g.rotation.y += diff * Math.min(1, dt * 7);
        V.animatePerson(n.g, true, n.t, 1);
      }
    });

    /* tokens bob and spin */
    var now = performance.now() * 0.001;
    tokens.forEach(function (tk) {
      tk.g.rotation.y = Math.atan2(camera.position.x - tk.g.position.x,
                                   camera.position.z - tk.g.position.z);
      tk.g.rotation.z = Math.sin(now * 1.2 + tk.ph) * 0.09;
      tk.g.position.y = 2.0 + Math.sin(now * 1.8 + tk.ph) * 0.28;
    });

    /* boats rock */
    boats.forEach(function (b) {
      b.g.rotation.z = Math.sin(now * 0.9 + b.ph) * 0.05;
      b.g.position.y = Math.sin(now * 1.1 + b.ph) * 0.12;
    });

    /* institutes rising */
    instBuilt.forEach(function (g) {
      if (g.userData.rise !== undefined && g.userData.rise < 1) {
        g.userData.rise = Math.min(1, g.userData.rise + dt * 0.55);
        var e = 1 - Math.pow(1 - g.userData.rise, 3);
        g.scale.y = 0.02 + e * 0.98;
      }
    });

    /* rain */
    rainPts.visible = (state.weather === "rain");
    if (rainPts.visible && playerPos) {
      var arr = rainPts.geometry.attributes.position.array;
      for (var k = 0; k < arr.length; k += 3) {
        arr[k+1] -= 48 * dt;
        if (arr[k+1] < 0) {
          arr[k+1] = 70;
          arr[k] = playerPos.x + (Math.random() - 0.5) * 200;
          arr[k+2] = playerPos.z + (Math.random() - 0.5) * 200;
        }
      }
      rainPts.geometry.attributes.position.needsUpdate = true;
    }
    if (state.weather === "rain") { scene.fog.near = 200; scene.fog.far = 720; }
    else if (state.weather === "mist") { scene.fog.near = 90; scene.fog.far = 420; }
    else { scene.fog.near = 330; scene.fog.far = 1150; }

    modules("update", dt, playerPos);
  };

  /* ------------------------------------------------------------ quality
   *
   * The village has to run on a laptop on battery and on a phone in a
   * pocket, and the single biggest lever on both is how many pixels the
   * fragment shader is asked for. So rather than pick a device pixel ratio
   * at boot and hope, measure the frame and move the ratio to fit:
   *
   *   slow frames  -> fewer pixels, and the fog pulls in so there is less
   *                   geometry behind it
   *   fast frames  -> creep back up, but never past what the panel can show
   *
   * The steps are deliberately coarse and the cooldown long, because a ratio
   * that oscillates looks far worse than one that is slightly too low.
   */
  var quality = {
    ratio: 1, max: 1, min: 0.6, ema: 16.7, last: 0, cooldown: 0, auto: true
  };
  V.quality = quality;

  V.setQualityAuto = function (on) { quality.auto = !!on; };

  function applyRatio() {
    if (!renderer) return;
    renderer.setPixelRatio(quality.ratio);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  function tickQuality(now) {
    if (!quality.auto || !renderer) return;
    if (quality.last) {
      var ms = now - quality.last;
      /* ignore the spike a tab restore or a long GC produces */
      if (ms < 250) quality.ema += (ms - quality.ema) * 0.06;
    }
    quality.last = now;
    if (quality.cooldown > now) return;

    if (quality.ema > 23 && quality.ratio > quality.min) {
      quality.ratio = Math.max(quality.min, quality.ratio - 0.2);
      applyRatio();
      quality.cooldown = now + 2500;
      quality.ema = 16.7;
    } else if (quality.ema < 13.5 && quality.ratio < quality.max) {
      quality.ratio = Math.min(quality.max, quality.ratio + 0.15);
      applyRatio();
      quality.cooldown = now + 4000;
      quality.ema = 16.7;
    }
  }

  /* Nothing is drawn while the tab is in the background. A hidden canvas
     still costs a full frame of GPU work otherwise, which on a laptop is
     the difference between a warm fan and a quiet one. */
  var hidden = false;
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", function () {
      hidden = document.hidden;
      /* the clock has been running while we were away; do not hand the
         world a two-minute delta when we come back */
      if (!hidden && clock) clock.getDelta();
    });
  }
  V.isHidden = function () { return hidden; };

  V.render = function () {
    if (hidden) return;
    var now = performance.now();
    tickQuality(now);
    renderer.render(scene, camera);
  };
  V.delta = function () { return Math.min(clock.getDelta(), 0.06); };
  V.clockLabel = function () {
    var mins = Math.floor(state.time * 1440);
    var h = Math.floor(mins / 60), m = mins % 60;
    var ap = h < 12 ? "am" : "pm", hh = h % 12 === 0 ? 12 : h % 12;
    return hh + ":" + (m < 10 ? "0" : "") + m + ap;
  };
  V.phaseLabel = function () {
    var t = state.time;
    if (t < 0.24 || t > 0.84) return "Night";
    if (t < 0.31) return "Dawn";
    if (t < 0.70) return "Daylight";
    if (t < 0.79) return "Golden hour";
    return "Dusk";
  };
})();
