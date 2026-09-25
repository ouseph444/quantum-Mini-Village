/* Quantum Village — ambient life.
 *
 * Animals, researchers on their way between buildings, birds, butterflies
 * and an optional sound bed. All of it is budgeted: nothing more than 300
 * metres from the player is animated, and the whole system ticks at 12 Hz
 * rather than at the frame rate.
 */
(function () {
  "use strict";
  var T = window.THREE;
  var V = window.QV;

  var animals = [], walkers = [], flyers = [], flutter = [];
  var group = null, ready = false;
  var tick = 0, TICK = 1 / 12;

  /* ------------------------------------------------------------ models */
  function makeAnimal(kind) {
    var g = new T.Group();
    var body, legs = [];
    if (kind === "duck") {
      body = V.color(0xF2EDDF);
      V.sp(g, 0.62, body, 0, 0.62, 0, 8).scale.set(0.62, 0.5, 0.9);
      V.sp(g, 0.3, body, 0, 1.1, 0.5, 7);
      V.cn(g, 0.16, 0.44, V.color(0xE8B04B), 0, 1.06, 0.82, 6).rotation.x = Math.PI / 2;
      g.userData.float = true;
    } else if (kind === "deer") {
      body = V.color(0xA8794C);
      V.bx(g, 0.9, 1.0, 2.2, body, 0, 1.5, 0);
      V.bx(g, 0.6, 0.65, 0.8, body, 0, 2.2, 1.2);
      V.bx(g, 0.18, 0.5, 0.18, V.color(0x6B4A2A), -0.2, 2.7, 1.2);
      V.bx(g, 0.18, 0.5, 0.18, V.color(0x6B4A2A), 0.2, 2.7, 1.2);
      legs = legSet(g, body, 0.35, 0.9, 1.0, 0.16);
    } else if (kind === "cow") {
      body = V.color(0xF0EBE0);
      V.bx(g, 1.3, 1.4, 2.8, body, 0, 1.7, 0);
      V.bx(g, 0.9, 0.5, 1.4, V.color(0x3A3632), 0.2, 2.1, -0.3);
      V.bx(g, 0.8, 0.8, 0.9, body, 0, 2.1, 1.6);
      legs = legSet(g, V.color(0x3A3632), 0.5, 1.0, 1.2, 0.22);
    } else if (kind === "sheep") {
      body = V.color(0xEEE9DC);
      V.sp(g, 0.82, body, 0, 1.2, 0, 8).scale.set(1, 0.8, 1.25);
      V.bx(g, 0.55, 0.55, 0.72, V.color(0x4A4038), 0, 1.35, 1.0);
      legs = legSet(g, V.color(0x4A4038), 0.35, 0.65, 0.9, 0.14);
    } else if (kind === "cat") {
      body = V.color(Math.random() < 0.5 ? 0x4A4038 : 0xC9A06B);
      V.bx(g, 0.34, 0.36, 0.9, body, 0, 0.52, 0);
      V.sp(g, 0.24, body, 0, 0.72, 0.52, 7);
      V.cn(g, 0.1, 0.16, body, -0.1, 0.94, 0.5, 5);
      V.cn(g, 0.1, 0.16, body, 0.1, 0.94, 0.5, 5);
      V.cy(g, 0.07, 0.07, 0.7, body, 0, 0.7, -0.6, 6).rotation.x = 0.7;
      legs = legSet(g, body, 0.13, 0.34, 0.32, 0.08);
    } else { /* dog */
      body = V.color(0xB08050);
      V.bx(g, 0.42, 0.46, 1.1, body, 0, 0.66, 0);
      V.sp(g, 0.3, body, 0, 0.9, 0.62, 7);
      V.cy(g, 0.08, 0.08, 0.6, body, 0, 0.95, -0.6, 6).rotation.x = -0.8;
      legs = legSet(g, body, 0.16, 0.44, 0.4, 0.1);
    }
    g.userData.legs = legs;
    return g;
  }
  function legSet(g, mat, spread, height, along, thick) {
    var out = [];
    [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(function (c) {
      var leg = new T.Group();
      var m = V.bx(leg, thick * 2, height, thick * 2, mat, 0, -height / 2, 0);
      leg.position.set(c[0] * spread, height, c[1] * along / 2);
      g.add(leg); out.push(leg);
    });
    return out;
  }

  function makeBird() {
    var g = new T.Group();
    var m = V.color(0x3A3A38);
    var l = V.bx(g, 1.5, 0.08, 0.4, m, -0.7, 0, 0);
    var r = V.bx(g, 1.5, 0.08, 0.4, m, 0.7, 0, 0);
    V.bx(g, 0.35, 0.22, 0.8, m, 0, 0, 0);
    g.userData.wings = [l, r];
    return g;
  }
  function makeButterfly(hue) {
    var g = new T.Group();
    var m = V.flat(hue, 0.9);
    var l = V.panel(g, 0.5, 0.36, m, -0.22, 0, 0);
    var r = V.panel(g, 0.5, 0.36, m, 0.22, 0, 0);
    g.userData.wings = [l, r];
    return g;
  }

  /* ---------------------------------------------------------- placement */
  var HERDS = [
    { kind:"duck", at:[[-118, 84, 26], [-740, 240, 34]], n:4, water:true },
    { kind:"deer", at:[[-250, 520, 60], [640, -560, 70], [-640, -420, 60]], n:3 },
    { kind:"cow",  at:[[560, 200, 50], [180, 250, 40]], n:3 },
    { kind:"sheep", at:[[300, 360, 55], [-260, 300, 45]], n:4 },
    { kind:"cat",  at:[[-450, 186, 14], [150, -392, 14], [-40, 30, 16]], n:1 },
    { kind:"dog",  at:[[-680, -100, 30], [-500, -240, 26]], n:1 }
  ];

  function build() {
    group = new T.Group();
    V.getRoot().add(group);

    HERDS.forEach(function (h) {
      h.at.forEach(function (spot) {
        for (var i = 0; i < h.n; i++) {
          var a = Math.random() * 6.283, r = Math.random() * spot[2];
          var x = spot[0] + Math.cos(a) * r, z = spot[1] + Math.sin(a) * r;
          if (!h.water && V.blockedAt(x, z, 2)) continue;
          var g = makeAnimal(h.kind);
          g.position.set(x, h.water ? 0.5 : 0, z);
          group.add(g);
          animals.push({
            g: g, kind: h.kind, home: { x: spot[0], z: spot[1], r: spot[2] },
            tx: x, tz: z, idle: Math.random() * 6, t: Math.random() * 10,
            speed: h.kind === "cat" ? 2.2 : (h.kind === "duck" ? 1.1 : 1.8),
            water: !!h.water
          });
        }
      });
    });

    buildWalkers();

    /* a couple of skeins of birds */
    for (var b = 0; b < 14; b++) {
      var bird = makeBird();
      group.add(bird);
      flyers.push({ g: bird, ph: Math.random() * 6.283, r: 120 + Math.random() * 400,
                    y: 44 + Math.random() * 40, sp: 0.06 + Math.random() * 0.05,
                    cx: (Math.random() - 0.5) * 600, cz: (Math.random() - 0.5) * 600 });
    }
    /* butterflies over the flower beds */
    var BEDS = [[-150,-370],[150,-370],[0,-700],[-680,290],[-450,180]];
    BEDS.forEach(function (p) {
      for (var i = 0; i < 3; i++) {
        var bf = makeButterfly([0xE8C45A, 0xE86F8A, 0xF2F0E4][i % 3]);
        group.add(bf);
        flutter.push({ g: bf, cx: p[0], cz: p[1], ph: Math.random() * 6.283, r: 4 + Math.random() * 6 });
      }
    });
    ready = true;
  }

  /* ------------------------------------------------ researchers on foot */
  var WALKER_NAMES = [
    "Dr. Halvorsen", "Prof. Adeyemi", "Ines", "Dr. Rao", "Tomas", "Prof. Ferreira",
    "Yuki", "Dr. Mensah", "Aisha", "Prof. Lindqvist", "Marco", "Dr. Petrova",
    "Nadia", "Sam", "Prof. Nakamura", "Ravi"
  ];
  var WALKER_ROLES = [
    { r:"postdoc", t:"pheno" }, { r:"PhD student", t:"gw" }, { r:"professor", t:"qg" },
    { r:"lecturer", t:"cmb" }, { r:"research fellow", t:"dm" }, { r:"technician", t:"coll" },
    { r:"librarian", t:null }, { r:"visiting fellow", t:"nu" }
  ];

  function buildWalkers() {
    /* they patrol between the campus places, which is what makes the
       pavements feel used rather than decorated */
    var stops = (V.PLACES || []).filter(function (p) { return p.walkin; });
    if (stops.length < 2) return;
    for (var i = 0; i < 16; i++) {
      var look = V.randomLook(i * 61 + 7);
      var g = V.makePerson(look);
      var from = stops[(i * 3) % stops.length];
      var spot = V.clearSpot(from.x + (Math.random() - 0.5) * 16, from.z + (Math.random() - 0.5) * 16, 1.6);
      g.position.set(spot.x, 0, spot.z);
      group.add(g);
      var role = WALKER_ROLES[i % WALKER_ROLES.length];
      walkers.push({
        g: g, name: WALKER_NAMES[i % WALKER_NAMES.length], role: role.r, topic: role.t,
        home: from, stops: stops, tx: spot.x, tz: spot.z, t: Math.random() * 10,
        idle: Math.random() * 5, speed: 3.2 + Math.random() * 1.6,
        cycleCheck: 8 + Math.random() * 12, cycle: null
      });
    }
    V.walkers = walkers;
  }

  /* -------------------------------------------------------------- update */
  function update(dt, playerPos) {
    if (!ready) return;
    tick += dt;
    var px = playerPos ? playerPos.x : 0, pz = playerPos ? playerPos.z : 0;

    /* wings and water bob run every frame; they are almost free */
    var now = performance.now() * 0.001;
    for (var f = 0; f < flyers.length; f++) {
      var fl = flyers[f];
      fl.ph += fl.sp * dt * 6;
      var x = fl.cx + Math.cos(fl.ph) * fl.r, z = fl.cz + Math.sin(fl.ph) * fl.r;
      fl.g.position.set(x, fl.y + Math.sin(now * 0.8 + f) * 3, z);
      fl.g.rotation.y = -fl.ph;
      var flap = Math.sin(now * 9 + f) * 0.7;
      fl.g.userData.wings[0].rotation.z = flap;
      fl.g.userData.wings[1].rotation.z = -flap;
      fl.g.visible = Math.abs(x - px) + Math.abs(z - pz) < 520;
    }
    for (var bf = 0; bf < flutter.length; bf++) {
      var bt = flutter[bf];
      var near = Math.abs(bt.cx - px) + Math.abs(bt.cz - pz) < 120;
      bt.g.visible = near;
      if (!near) continue;
      bt.ph += dt * 1.6;
      bt.g.position.set(bt.cx + Math.cos(bt.ph * 1.3) * bt.r,
                        1.6 + Math.sin(bt.ph * 2.1) * 0.8,
                        bt.cz + Math.sin(bt.ph) * bt.r);
      var w = Math.sin(now * 16 + bf) * 1.1;
      bt.g.userData.wings[0].rotation.y = w;
      bt.g.userData.wings[1].rotation.y = -w;
    }

    if (tick < TICK) return;
    var step = tick; tick = 0;

    /* animals */
    for (var i = 0; i < animals.length; i++) {
      var an = animals[i];
      var far = Math.abs(an.g.position.x - px) + Math.abs(an.g.position.z - pz);
      an.g.visible = far < 340;
      if (far > 300) continue;
      an.t += step;
      var dx = an.tx - an.g.position.x, dz = an.tz - an.g.position.z;
      var d = Math.hypot(dx, dz);
      if (d < 0.8) {
        an.idle -= step;
        legsIdle(an, step);
        if (an.idle <= 0) {
          var a = Math.random() * 6.283, r = Math.random() * an.home.r;
          var nx = an.home.x + Math.cos(a) * r, nz = an.home.z + Math.sin(a) * r;
          if (!an.water) { var c = V.clearSpot(nx, nz, 1.4); nx = c.x; nz = c.z; }
          an.tx = nx; an.tz = nz;
          an.idle = 2 + Math.random() * 8;
        }
      } else {
        var sp = an.speed * step;
        an.g.position.x += (dx / d) * sp;
        an.g.position.z += (dz / d) * sp;
        var want = Math.atan2(dx, dz);
        var diff = ((want - an.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        an.g.rotation.y += diff * Math.min(1, step * 5);
        legsWalk(an, step);
      }
      if (an.water) an.g.position.y = 0.42 + Math.sin(an.t * 1.4) * 0.07;
    }

    /* researchers */
    for (var w2 = 0; w2 < walkers.length; w2++) {
      var wk = walkers[w2];
      var fw = Math.abs(wk.g.position.x - px) + Math.abs(wk.g.position.z - pz);
      wk.g.visible = fw < 420;
      if (fw > 330) continue;
      wk.t += step;
      if (!wk.cycle) {
        wk.cycleCheck -= step;
        if (wk.cycleCheck <= 0 && window.QVTransport && QVTransport.takeParkedCycleForNpc) {
          wk.cycleCheck = 8 + Math.random() * 12;
          var borrowed = QVTransport.takeParkedCycleForNpc(wk.g.position.x, wk.g.position.z, 7);
          if (borrowed) {
            /* ridden, not pushed: the saddle sits under the rider's hips */
            borrowed.position.set(0, 0.05, 0);
            borrowed.rotation.set(0, 0, 0);
            wk.g.add(borrowed);
            wk.cycle = borrowed;
            wk.idle = 0;
          }
        }
      }
      var wdx = wk.tx - wk.g.position.x, wdz = wk.tz - wk.g.position.z;
      var wd = Math.hypot(wdx, wdz);
      if (wd < 1.4) {
        wk.idle -= step;
        V.animatePerson(wk.g, false, wk.t, 1);
        if (wk.idle <= 0) {
          var dest = wk.stops[Math.floor(Math.random() * wk.stops.length)];
          var ds = V.clearSpot(dest.x + (Math.random() - 0.5) * 18, dest.z + (Math.random() - 0.5) * 18, 1.6);
          wk.tx = ds.x; wk.tz = ds.z;
          wk.idle = 3 + Math.random() * 9;
        }
      } else {
        var ws = wk.speed * step;
        /* step out, and slide round anything solid on the way */
        var nx2 = wk.g.position.x + (wdx / wd) * ws;
        var nz2 = wk.g.position.z + (wdz / wd) * ws;
        var out = V.clearSpot(nx2, nz2, 1.2);
        if (Math.hypot(out.x - wk.g.position.x, out.z - wk.g.position.z) < ws * 0.2) {
          /* wedged: pick somewhere else next tick */
          wk.idle = 0; wk.tx = wk.g.position.x; wk.tz = wk.g.position.z;
        }
        wk.g.position.x = out.x; wk.g.position.z = out.z;
        var wantY = Math.atan2(wdx, wdz);
        var dY = ((wantY - wk.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        wk.g.rotation.y += dY * Math.min(1, step * 6);
        if (wk.cycle) {
          /* wheels roll with the distance covered, the cranks geared to them */
          var wh = wk.cycle.userData.wheels || [];
          for (var wi = 0; wi < wh.length; wi++) wh[wi].rotation.x -= ws / 0.42;
          if (wk.cycle.userData.pedals) wk.cycle.userData.pedals.rotation.x -= (ws / 0.42) * 0.42;
        }
        V.animatePerson(wk.g, true, wk.t, 1);
      }
    }
  }
  function legsWalk(an, dt) {
    var legs = an.g.userData.legs; if (!legs || !legs.length) return;
    var sw = Math.sin(an.t * 7) * 0.5;
    legs[0].rotation.x = sw; legs[3].rotation.x = sw;
    legs[1].rotation.x = -sw; legs[2].rotation.x = -sw;
  }
  function legsIdle(an, dt) {
    var legs = an.g.userData.legs; if (!legs || !legs.length) return;
    for (var i = 0; i < legs.length; i++) legs[i].rotation.x *= 0.8;
  }

  /* ============================================================== sound
   * Everything is synthesised — no audio files to ship or to 404. Browsers
   * will not start audio without a gesture, so this stays off until asked. */
  var audio = null, on = false, nodes = {}, cycling = false, pedalSoundAt = 0;
  function startAudio() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      audio = new Ctx();
      var master = audio.createGain();
      master.gain.value = 0.0;
      master.connect(audio.destination);
      nodes.master = master;

      /* wind: filtered noise */
      var len = audio.sampleRate * 2;
      var buf = audio.createBuffer(1, len, audio.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
      var src = audio.createBufferSource();
      src.buffer = buf; src.loop = true;
      var lp = audio.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 420;
      var wg = audio.createGain(); wg.gain.value = 0.22;
      src.connect(lp); lp.connect(wg); wg.connect(master);
      src.start();
      nodes.wind = wg;

      master.gain.linearRampToValueAtTime(0.5, audio.currentTime + 1.2);
      scheduleBirds();
      return true;
    } catch (e) {
      console.warn("[village] audio unavailable:", e && e.message);
      audio = null;
      return false;
    }
  }
  function blip(freq, dur, type, gain) {
    if (!audio || !on) return;
    try {
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = type || "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0, audio.currentTime);
      g.gain.linearRampToValueAtTime(gain == null ? 0.07 : gain, audio.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
      o.connect(g); g.connect(nodes.master);
      o.start(); o.stop(audio.currentTime + dur + 0.05);
    } catch (e) { /* a browser that dislikes this is not a reason to stop */ }
  }
  var birdTimer = null;
  function scheduleBirds() {
    clearTimeout(birdTimer);
    birdTimer = setTimeout(function () {
      if (on && (V.night == null || V.night < 0.5)) {
        var base = 1600 + Math.random() * 1400;
        blip(base, 0.09, "sine", 0.05);
        setTimeout(function () { blip(base * 1.2, 0.07, "sine", 0.04); }, 120);
      }
      scheduleBirds();
    }, 3500 + Math.random() * 7000);
  }
  /* a two-tone horn when a train pulls in */
  V.onTrainStop = function () {
    if (!on) return;
    blip(330, 0.5, "sawtooth", 0.05);
    setTimeout(function () { blip(262, 0.7, "sawtooth", 0.045); }, 260);
  };

  function setCycling(moving) {
    var was = cycling;
    cycling = !!moving;
    if (cycling && !was) blip(880, 0.12, "sine", 0.035);
  }

  function updateCycleSound(dt) {
    if (!cycling || !on) return;
    pedalSoundAt -= dt;
    if (pedalSoundAt <= 0) {
      pedalSoundAt = 0.55;
      blip(180, 0.055, "triangle", 0.018);
    }
  }

  function toggleSound(want) {
    var next = want == null ? !on : !!want;
    if (next && !audio) { if (!startAudio()) return false; }
    on = next;
    if (audio) {
      if (audio.state === "suspended" && on) audio.resume().catch(function () {});
      try {
        nodes.master.gain.cancelScheduledValues(audio.currentTime);
        nodes.master.gain.linearRampToValueAtTime(on ? 0.5 : 0.0, audio.currentTime + 0.4);
      } catch (e) {}
    }
    if (on) scheduleBirds(); else clearTimeout(birdTimer);
    return on;
  }

  window.QVAmbient = {
    build: build, update: function (dt, playerPos) {
      update(dt, playerPos);
      updateCycleSound(dt);
    }, toggleSound: toggleSound, setCycling: setCycling,
    soundOn: function () { return on; },
    walkers: function () { return walkers; },
    counts: function () { return { animals: animals.length, walkers: walkers.length, birds: flyers.length }; }
  };
})();
