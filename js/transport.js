/* Quantum Village — transport.
 *
 * Traffic, trains and aircraft are all driven from one shared clock rather
 * than from per-client random numbers, so two people standing on the same
 * corner see the same bus. Nothing here is synchronised over the network:
 * the world agrees because the arithmetic agrees.
 *
 * Adding a route means adding a row to FLEET or SERVICES.
 */
(function () {
  "use strict";
  var T = window.THREE;
  var V = window.QV;

  /* A fixed origin for the shared clock. Everything below is a pure
     function of seconds since this instant. */
  var EPOCH = Date.UTC(2026, 0, 1);
  function clockNow() { return (Date.now() - EPOCH) / 1000; }

  var vehicles = [], trains = [], planes = [], crossingLights = [];
  var group = null, playerRef = { x: 0, z: 0 };
  var ready = false;
  var cycleRider = null, cycleMesh = null, parkedCycles = [];
  /* `jeep` is where that area's jeep station goes. At the Refectory the
     cycle rack stands west of the patio and the jeeps park behind the
     building, so neither blocks the view of the counter and the queue. */
  var CYCLE_STATIONS = [
    { x: -18, z: 28, name: "The Commons", jeep: { x: 6, z: 38 } },
    { x: 58, z: 78, name: "The Grand Refectory", jeep: { x: 80, z: 42 } },
    { x: 520, z: -20, name: "Research Park", jeep: { x: 496, z: -30 } },
    { x: -500, z: 180, name: "Noether Park", jeep: { x: -474, z: 180 } }
  ];
  var cycleMotion = 0, cycleMoving = false;

  /* ------------------------------------------------------------- routes */
  function offsetLine(pts, lane) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      var tx = b[0] - a[0], tz = b[1] - a[1], len = Math.hypot(tx, tz) || 1;
      /* right-hand side of the direction of travel */
      out.push([pts[i][0] - (tz / len) * lane, pts[i][1] + (tx / len) * lane]);
    }
    return out;
  }
  function makeRoute(pts, closed) {
    var cum = [0], total = 0;
    var list = closed ? pts.concat([pts[0]]) : pts;
    for (var i = 1; i < list.length; i++) {
      total += Math.hypot(list[i][0] - list[i-1][0], list[i][1] - list[i-1][1]);
      cum.push(total);
    }
    return {
      pts: list, cum: cum, len: total,
      at: function (s) {
        if (total <= 0) return { x: list[0][0], z: list[0][1], a: 0 };
        s = ((s % total) + total) % total;
        var lo = 0, hi = cum.length - 1;
        while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
        var a = list[lo], b = list[lo + 1] || list[0];
        var seg = (cum[lo + 1] - cum[lo]) || 1;
        var t = (s - cum[lo]) / seg;
        return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t,
                 a: Math.atan2(b[0] - a[0], b[1] - a[1]) };
      }
    };
  }
  /* A straight street becomes a there-and-back loop with proper lanes. */
  function lollipop(pts, lane) {
    var there = offsetLine(pts, lane);
    var back = offsetLine(pts.slice().reverse(), lane);
    return makeRoute(there.concat(back), true);
  }

  /* ------------------------------------------------------------ models */
  var CAR_COLOURS = [0xC4643F, 0x3E7A6E, 0x4A6FA8, 0xD4A24A, 0xF4EBD8, 0x8A5A96, 0x5A8A4A, 0x39423E];

  function makeCar(colour, kind) {
    var g = new T.Group();
    var body = V.color(colour);
    var glass = V.color(0x8FB8C0);
    var tyre = V.color(0x2A2A28);
    if (kind === "van") {
      V.bx(g, 3.0, 2.2, 6.4, body, 0, 1.7, 0);
      V.bx(g, 2.8, 1.3, 2.2, glass, 0, 2.4, 2.2);
      V.bx(g, 3.1, 0.5, 6.5, V.color(0xE8E2D2), 0, 2.9, 0);
    } else {
      V.bx(g, 2.6, 1.1, 5.4, body, 0, 1.1, 0);
      V.bx(g, 2.2, 1.0, 2.6, glass, 0, 2.05, -0.2);
      V.bx(g, 2.3, 0.22, 2.7, body, 0, 2.6, -0.2);
    }
    [[-1.25, 1.7], [1.25, 1.7], [-1.25, -1.7], [1.25, -1.7]].forEach(function (w) {
      var wh = V.cy(g, 0.55, 0.55, 0.42, tyre, w[0], 0.55, w[1], 10);
      wh.rotation.z = Math.PI / 2;
    });
    /* lamps, lit after dark */
    V.bx(g, 0.5, 0.3, 0.12, V.litLamp(0xE8E2D2, 0xFFF0C0), -0.85, 1.0, 2.75);
    V.bx(g, 0.5, 0.3, 0.12, V.litLamp(0xE8E2D2, 0xFFF0C0), 0.85, 1.0, 2.75);
    V.bx(g, 0.5, 0.25, 0.12, V.litLamp(0x8C3A30, 0xFF5A3A), -0.85, 1.0, -2.75);
    V.bx(g, 0.5, 0.25, 0.12, V.litLamp(0x8C3A30, 0xFF5A3A), 0.85, 1.0, -2.75);
    return g;
  }

  function makeBus() {
    var g = new T.Group();
    var body = V.color(0x2E6A62), glass = V.litGlass(0x9FCAD2);
    V.bx(g, 3.2, 3.0, 12.4, body, 0, 2.1, 0);
    V.bx(g, 3.3, 0.5, 12.5, V.color(0xF4EBD8), 0, 3.7, 0);
    for (var w = 0; w < 5; w++) {
      V.bx(g, 3.26, 1.2, 1.7, glass, 0, 2.7, -4.6 + w * 2.3);
    }
    V.bx(g, 2.9, 1.5, 0.14, glass, 0, 2.7, 6.25);
    [[-1.5, 4.2], [1.5, 4.2], [-1.5, -3.8], [1.5, -3.8]].forEach(function (p) {
      var wh = V.cy(g, 0.75, 0.75, 0.5, V.color(0x2A2A28), p[0], 0.75, p[1], 10);
      wh.rotation.z = Math.PI / 2;
    });
    V.bx(g, 0.6, 0.35, 0.12, V.litLamp(0xE8E2D2, 0xFFF0C0), -1.0, 1.2, 6.3);
    V.bx(g, 0.6, 0.35, 0.12, V.litLamp(0xE8E2D2, 0xFFF0C0), 1.0, 1.2, 6.3);
    /* route blind */
    var m = new T.MeshBasicMaterial({ map: V.signTex("Ring", "all stops"), side: T.DoubleSide });
    V.panel(g, 2.4, 0.75, m, 0, 3.35, 6.28);
    return g;
  }

  /* A chibi town bike, built to the residents rather than to real metres.
     Everything is laid out in the rider's own frame: ground at y = 0, the
     rider's hips over z = 0, facing +z. The saddle sits under the hips,
     the cranks sit where a 0.92-unit leg can reach round the whole pedal
     circle, and the grips sit where the short arms land. village.js reads
     `userData.ride` to put the feet on the pedals as they turn.

     Riders carry the bike at y = 0.05 (a little road bob is added on top),
     so the frame lives in an inner group dropped by the same amount. */
  var CYCLE = {
    R: 0.42,                      /* wheel radius: small, chunky tyres */
    rearZ: -0.56, frontZ: 0.98,
    bb: [0.244, 0.18],            /* bottom bracket [y, z] */
    crank: 0.15,
    saddleTop: 0.76,              /* where the rider's pelvis rests */
    grip: [1.30, 0.55],           /* [y, z] of the grips */
    mountY: 0.05
  };
  function makeCycle(colour) {
    var outer = new T.Group();
    var g = new T.Group();
    g.position.y = -CYCLE.mountY;
    outer.add(g);
    var frameC = colour == null ? 0xC4322B : colour;
    var frameM = V.color(frameC);
    var frameDark = V.color(new T.Color(frameC).multiplyScalar(0.7).getHex());
    var metal = V.color(0xC9CDC8), chrome = V.color(0xE2E6E1);
    var tyreM = V.color(0x1B1F1D);
    var leather = V.color(0x4A2F1E);
    var R = CYCLE.R, BB = CYCLE.bb, K = CYCLE.crank;

    var wheels = [];

    /* ---- wheels: fat tyre, rim, hub and spokes ---- */
    function wheel(parent, y, z) {
      var W = new T.Group();
      var tyre = new T.Mesh(V.geo("bike.tyre2", function () {
        return new T.TorusGeometry(R, 0.065, 8, 26);
      }), tyreM);
      tyre.rotation.y = Math.PI / 2; W.add(tyre);
      var rim = new T.Mesh(V.geo("bike.rim2", function () {
        return new T.TorusGeometry(R - 0.07, 0.026, 5, 24);
      }), chrome);
      rim.rotation.y = Math.PI / 2; W.add(rim);
      /* Spokes are one geometry scaled six ways, not six geometries. */
      var spokeG = V.U.cyl(4);
      for (var s = 0; s < 6; s++) {
        var sp = new T.Mesh(spokeG, metal);
        sp.scale.set(0.012, (R - 0.08) * 2, 0.012);
        sp.rotation.x = s * (Math.PI / 6);
        W.add(sp);
      }
      var hub = new T.Mesh(V.U.cyl(8), metal);
      hub.scale.set(0.06, 0.20, 0.06);
      hub.rotation.z = Math.PI / 2; W.add(hub);
      W.position.set(0, y, z);
      parent.add(W);
      wheels.push(W);
      return W;
    }
    var rearHub = [0, R, CYCLE.rearZ];
    wheel(g, R, CYCLE.rearZ);

    /* ---- a tube between two points, which is most of a bicycle ---- */
    var up = new T.Vector3(0, 1, 0), dir = new T.Vector3();
    function tube(parent, a, b, radius, material) {
      dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      var len = dir.length();
      var m = new T.Mesh(V.U.cyl(8), material);
      m.scale.set(radius, len, radius);
      m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      m.quaternion.setFromUnitVectors(up, dir.normalize());
      parent.add(m);
      return m;
    }

    /* ---- frame, measured off the hubs and the rider ---- */
    var bb       = [0, BB[0], BB[1]];
    var seatTop  = [0, 0.62, -0.04];
    var headTop  = [0, 0.92, 0.86];
    var headBot  = [0, 0.72, 0.90];

    tube(g, rearHub, bb, 0.034, frameDark);       /* chainstay */
    tube(g, rearHub, seatTop, 0.032, frameM);     /* seatstay */
    tube(g, bb, seatTop, 0.044, frameM);          /* seat tube */
    tube(g, bb, headBot, 0.048, frameM);          /* down tube */
    tube(g, seatTop, headTop, 0.040, frameM);     /* top tube, low enough to clear the thighs */
    tube(g, headBot, headTop, 0.046, frameDark);  /* head tube */

    /* ---- saddle: broad, because the rider is ---- */
    tube(g, seatTop, [0, 0.70, -0.06], 0.026, chrome);
    V.bx(g, 0.30, 0.08, 0.34, leather, 0, CYCLE.saddleTop - 0.04, -0.08);
    var nose = V.sp(g, 0.09, leather, 0, CYCLE.saddleTop - 0.04, 0.08, 8);
    nose.scale.set(0.09, 0.04, 0.12);
    [-0.08, 0.08].forEach(function (ox) {
      V.cy(g, 0.02, 0.02, 0.08, chrome, ox, CYCLE.saddleTop - 0.12, -0.18, 6);
    });

    /* ---- the steering group: fork, front wheel, bars, basket, lamp ---- */
    var fork = new T.Group();
    fork.position.set(0, headTop[1], headTop[2]);
    g.add(fork);
    var hubY = R - headTop[1], hubZ = CYCLE.frontZ - headTop[2];
    wheel(fork, hubY, hubZ);
    tube(fork, [0, -0.20, 0.04], [-0.08, hubY, hubZ], 0.026, frameDark);
    tube(fork, [0, -0.20, 0.04], [0.08, hubY, hubZ], 0.026, frameDark);

    /* a tall stem and swept-back bars, so short arms reach them sitting up */
    var bar = [0, 0.32, -0.14];
    var gripAt = [0.44, CYCLE.grip[0] - headTop[1], CYCLE.grip[1] - headTop[2]];
    tube(fork, [0, -0.02, 0.0], bar, 0.028, chrome);                       /* stem */
    V.bx(fork, 0.62, 0.04, 0.04, chrome, 0, bar[1], bar[2]);               /* crossbar */
    [-1, 1].forEach(function (s) {
      var end = [s * gripAt[0], gripAt[1], gripAt[2]];
      tube(fork, [s * 0.31, bar[1], bar[2]], end, 0.022, chrome);
      tube(fork, [s * 0.40, gripAt[1] - 0.012, gripAt[2] + 0.05],
                      [s * 0.47, gripAt[1] + 0.01, gripAt[2] - 0.06], 0.045, V.color(0x24211D));
      V.bx(fork, 0.035, 0.035, 0.14, chrome, s * 0.30, bar[1] - 0.02, bar[2] + 0.07).rotation.x = 0.5;
    });

    /* a wicker basket over the front wheel — the most common thing on a campus bike */
    V.bx(fork, 0.44, 0.28, 0.32, V.color(0xB98A4E), 0, 0.12, 0.26);
    V.bx(fork, 0.46, 0.03, 0.34, V.color(0x8C6636), 0, 0.27, 0.26);
    V.sp(fork, 0.06, V.litLamp(0xE8E4D6, 0xFFE9A8), 0, 0.08, 0.44, 8);     /* headlamp */

    /* ---- chainset: ring, cranks and pedals, all on one turning group ---- */
    var pedals = new T.Group();
    pedals.position.set(0, bb[1], bb[2]);
    var ring = new T.Mesh(V.geo("bike.ring2", function () {
      return new T.TorusGeometry(0.12, 0.016, 5, 18);
    }), metal);
    ring.rotation.y = Math.PI / 2; ring.position.x = 0.07; pedals.add(ring);
    var axle = new T.Mesh(V.U.cyl(8), chrome);
    axle.scale.set(0.024, 0.28, 0.024); axle.rotation.z = Math.PI / 2;
    pedals.add(axle);
    [[-0.13, 1], [0.13, -1]].forEach(function (c) {
      /* crank arm out to the pedal, half a turn apart */
      var arm = new T.Mesh(V.U.box(), chrome);
      arm.scale.set(0.035, K, 0.045);
      arm.position.set(c[0], c[1] * K / 2, 0);
      pedals.add(arm);
      var pedal = new T.Mesh(V.U.box(), V.color(0x2A2E2B));
      pedal.scale.set(0.12, 0.03, 0.16);
      pedal.position.set(c[0] + (c[0] < 0 ? -0.06 : 0.06), c[1] * K, 0);
      pedals.add(pedal);
    });
    g.add(pedals);

    /* ---- chain: two straight runs and a rear sprocket ---- */
    tube(g, [0.07, bb[1] + 0.12, bb[2]], [0.07, R + 0.07, rearHub[2]], 0.012, V.color(0x6E7370));
    tube(g, [0.07, bb[1] - 0.12, bb[2]], [0.07, R - 0.07, rearHub[2]], 0.012, V.color(0x6E7370));
    var sprocket = new T.Mesh(V.geo("bike.sprocket", function () {
      return new T.TorusGeometry(0.075, 0.014, 4, 12);
    }), metal);
    sprocket.rotation.y = Math.PI / 2; sprocket.position.set(0.07, R, rearHub[2]);
    g.add(sprocket);

    /* ---- mudguards: a half-cylinder shell over each wheel ---- */
    var guardG = V.geo("bike.guard", function () {
      return new T.CylinderGeometry(1, 1, 1, 14, 1, true, 0, Math.PI);
    });
    var guardM = new T.MeshLambertMaterial({ color: frameC, side: T.DoubleSide });
    function guard(parent, y, z) {
      var m = new T.Mesh(guardG, guardM);
      m.scale.set(R + 0.09, 0.16, R + 0.09);
      m.rotation.z = Math.PI / 2;
      m.position.set(0, y, z);
      parent.add(m);
    }
    guard(g, R, rearHub[2]);
    guard(fork, hubY, hubZ);

    /* ---- rack over the back wheel, clear of the rider, and a rear light ---- */
    V.bx(g, 0.28, 0.03, 0.42, metal, 0, R + 0.52, rearHub[2] - 0.06);
    [-0.12, 0.12].forEach(function (ox) {
      tube(g, [ox, R + 0.51, rearHub[2] + 0.10], [ox, R, rearHub[2]], 0.012, metal);
    });
    V.bx(g, 0.12, 0.07, 0.03, V.litLamp(0x8C2F39, 0xFF6B5A), 0, R + 0.44, rearHub[2] - 0.30);

    /* ---- kickstand, so a parked bike stands up rather than floats ---- */
    tube(g, [0.10, 0.28, -0.12], [0.24, 0.02, -0.24], 0.018, chrome);

    outer.userData.wheels = wheels;
    outer.userData.pedals = pedals;
    outer.userData.fork = fork;
    outer.userData.sprocket = sprocket;
    /* what a rider needs to sit on it, in the bike's own frame */
    outer.userData.ride = {
      bbY: BB[0] - CYCLE.mountY, bbZ: BB[1], crank: K,
      pedalTop: 0.015, grip: CYCLE.grip
    };
    return outer;
  }

  function buildCycleStation(station) {
    var x = station.x, z = station.z;
    V.bx(V.getRoot(), 16, 0.25, 5, V.color(0x6F7C72), x, 0.2, z);
    var rackColours = [0xC4322B, 0x2E6E5E, 0x3A5A8C, 0xD09A3C, 0x7A4A86];
    for (var i = -2; i <= 2; i++) {
      var bike = makeCycle(rackColours[(i + 2) % rackColours.length]);
      bike.position.set(x + i * 2.8, 0.325 + CYCLE.mountY, z);     /* on the platform */
      bike.rotation.y = Math.PI / 2;
      bike.rotation.z = 0.12;              /* resting on the kickstand */
      V.getRoot().add(bike);
    }
    V.panel(V.getRoot(), 8, 1.5,
      new T.MeshBasicMaterial({ map: V.signTex("CYCLE STATION", station.name || "take a cycle · visit every location"), side: T.DoubleSide }),
      x, 3.2, z - 2.4, 0);
  }

  /* ------------------------------------------------------- open jeeps
   * A little open-top jeep, built the same way as the town bike: in the
   * driver's own frame, so it rides as a child of whoever is driving.
   * The origin is the driver's hips over the ground (left-hand drive, so
   * the body sits off to the driver's right) and +z is forward. The seat
   * top is where a seated resident's thighs rest, the floor is where their
   * feet land, and the wheel is where their short arms reach. */
  var JEEP = {
    R: 0.6,                       /* wheel radius */
    track: 1.15,                  /* wheel x from the centreline */
    frontZ: 1.5, rearZ: -1.35,
    driverX: 0.48,                /* driver's seat, off the centreline */
    seatTop: 0.77,
    floor: 0.38,
    wheel: [1.42, 0.58]           /* [y, z] of the steering wheel rim */
  };
  var JEEP_COLOURS = [0xC9B27C, 0x6B7A3A, 0x2E6E6A, 0xB5452F];
  var jeepGlassM = null;
  function makeJeep(colour) {
    var outer = new T.Group();
    var b = new T.Group();
    b.position.x = -JEEP.driverX;          /* put the driver's seat on the origin */
    outer.add(b);
    var bodyC = colour == null ? JEEP_COLOURS[0] : colour;
    var body = V.color(bodyC);
    var bodyDark = V.color(new T.Color(bodyC).multiplyScalar(0.72).getHex());
    var trim = V.color(new T.Color(bodyC).lerp(new T.Color(0xF4EBD8), 0.55).getHex());
    var dark = V.color(0x2B2F2C), metal = V.color(0x8E9690), tyreM = V.color(0x1E211F);
    var seatM = V.color(0x5A4632), seatDark = V.color(0x46372A);
    var R = JEEP.R, TX = JEEP.track;

    /* ---- wheels: fat tyres with a hub you can see turning ---- */
    var wheels = [], steer = [];
    function wheel(parent) {
      var W = new T.Group();
      var tyre = new T.Mesh(V.U.cyl(16), tyreM);
      tyre.scale.set(R, 0.44, R); tyre.rotation.z = Math.PI / 2; W.add(tyre);
      var hub = new T.Mesh(V.U.cyl(6), V.color(0xD8D4C8));
      hub.scale.set(R * 0.52, 0.46, R * 0.52); hub.rotation.z = Math.PI / 2; W.add(hub);
      V.bx(W, 0.47, 0.07, R * 0.9, metal, 0, 0, 0);          /* spoke bar, shows the roll */
      parent.add(W);
      wheels.push(W);
      return W;
    }
    [-1, 1].forEach(function (s) {
      var rear = wheel(b);
      rear.position.set(s * TX, R, JEEP.rearZ);
      var st = new T.Group();
      st.position.set(s * TX, R, JEEP.frontZ);
      wheel(st);
      b.add(st);
      steer.push(st);
    });

    /* ---- chassis and floor ---- */
    V.bx(b, 1.7, 0.24, 4.1, dark, 0, 0.56, 0.2);
    V.bx(b, 1.86, 0.08, 2.9, dark, 0, JEEP.floor - 0.04, -0.5);

    /* ---- the tub: low sides with a scoop where you climb in ---- */
    [-1, 1].forEach(function (s) {
      V.bx(b, 0.08, 0.52, 3.0, body, s * 0.95, 0.62, -0.45);
      V.bx(b, 0.08, 0.28, 0.9, body, s * 0.95, 1.01, 0.6);
      V.bx(b, 0.08, 0.28, 1.05, body, s * 0.95, 1.01, -1.42);
      V.bx(b, 0.02, 0.09, 2.96, trim, s * 0.995, 0.78, -0.45);           /* side stripe */
    });
    V.bx(b, 1.98, 0.8, 0.08, body, 0, 0.76, -1.95);                       /* tailgate */
    V.bx(b, 1.9, 0.52, 0.3, body, 0, 0.92, 1.0);                          /* cowl */
    V.bx(b, 1.7, 0.08, 0.34, dark, 0, 1.2, 0.96);                         /* dash top */

    /* ---- bonnet, grille, lamps, bumpers ---- */
    V.bx(b, 1.7, 0.42, 1.34, body, 0, 1.0, 1.8);
    V.bx(b, 1.72, 0.05, 1.36, bodyDark, 0, 1.23, 1.8);
    V.bx(b, 1.5, 0.66, 0.1, dark, 0, 0.93, 2.47);
    for (var gi = -2; gi <= 2; gi++) V.bx(b, 0.07, 0.5, 0.04, trim, gi * 0.2, 0.93, 2.53);
    [-1, 1].forEach(function (s) {
      V.sp(b, 0.14, V.litLamp(0xE8E4D6, 0xFFE9A8), s * 0.6, 1.02, 2.5, 10);
      V.bx(b, 0.14, 0.1, 0.03, V.litLamp(0x8C2F39, 0xFF5A3A), s * 0.72, 0.98, -2.0);
      /* flat fenders over every wheel */
      V.bx(b, 0.56, 0.06, 1.5, bodyDark, s * TX, 1.26, JEEP.frontZ + 0.05);
      V.bx(b, 0.4, 0.06, 1.3, bodyDark, s * (TX - 0.05), 1.24, JEEP.rearZ);
    });
    V.bx(b, 2.3, 0.18, 0.2, dark, 0, 0.5, 2.6);
    V.bx(b, 2.1, 0.16, 0.18, dark, 0, 0.5, -2.06);
    var spare = new T.Mesh(V.U.cyl(14), tyreM);
    spare.scale.set(0.5, 0.28, 0.5); spare.rotation.x = Math.PI / 2;
    spare.position.set(0, 1.0, -2.2); b.add(spare);
    var spareHub = new T.Mesh(V.U.cyl(6), V.color(0xD8D4C8));
    spareHub.scale.set(0.26, 0.3, 0.26); spareHub.rotation.x = Math.PI / 2;
    spareHub.position.set(0, 1.0, -2.2); b.add(spareHub);

    /* ---- fold-up windscreen ---- */
    if (!jeepGlassM) jeepGlassM = new T.MeshLambertMaterial({ color: 0xBFDDE3, transparent: true, opacity: 0.32,
                                                             side: T.DoubleSide, depthWrite: false });
    [-1, 1].forEach(function (s) { V.bx(b, 0.07, 0.86, 0.07, dark, s * 0.9, 1.62, 1.12); });
    V.bx(b, 1.87, 0.07, 0.07, dark, 0, 2.05, 1.12);
    V.panel(b, 1.74, 0.78, jeepGlassM, 0, 1.62, 1.12);

    /* ---- seats: two up front, a bench behind ---- */
    [-1, 1].forEach(function (s) {
      var sx = s * JEEP.driverX;
      V.bx(b, 0.72, 0.16, 0.66, seatM, sx, JEEP.seatTop - 0.08, -0.1);
      V.bx(b, 0.6, JEEP.seatTop - 0.16 - JEEP.floor, 0.5, seatDark, sx, (JEEP.seatTop - 0.16 + JEEP.floor) / 2, -0.1);
      V.bx(b, 0.72, 0.72, 0.14, seatM, sx, JEEP.seatTop + 0.35, -0.48);
    });
    V.bx(b, 1.7, 0.16, 0.6, seatM, 0, JEEP.seatTop - 0.08, -1.35);
    V.bx(b, 1.7, 0.6, 0.12, seatM, 0, JEEP.seatTop + 0.3, -1.72);

    /* ---- roll bar ---- */
    [-1, 1].forEach(function (s) { V.cy(b, 0.05, 0.05, 1.25, dark, s * 0.9, 1.76, -0.88, 8); });
    V.bx(b, 1.9, 0.1, 0.1, dark, 0, 2.38, -0.88);

    /* ---- steering wheel on its column, in front of the driver ---- */
    var dx = JEEP.driverX, wy = JEEP.wheel[0], wz = JEEP.wheel[1];
    var col = V.cy(b, 0.035, 0.035, 0.44, dark, dx, (wy + 1.12) / 2, (wz + 0.92) / 2, 6);
    col.rotation.x = -0.83;
    var wheelHolder = new T.Group();
    wheelHolder.position.set(dx, wy, wz);
    wheelHolder.rotation.x = -0.9;
    var rim = new T.Mesh(V.U.torus(), dark);
    rim.scale.setScalar(0.24); wheelHolder.add(rim);
    V.bx(wheelHolder, 0.46, 0.04, 0.03, dark, 0, 0, 0);
    b.add(wheelHolder);

    outer.userData.wheels = wheels;
    outer.userData.steer = steer;
    outer.userData.steeringWheel = rim;
    /* what a driver needs to sit in it, in the jeep's own frame */
    outer.userData.drive = { seatTop: JEEP.seatTop, wheel: JEEP.wheel };
    return outer;
  }

  /* Each jeep station sits near a cycle station, on open ground whose
     whole pad is clear of buildings, trees, roads and place markers, and
     far enough from the cycle rack that the two prompts never overlap. */
  var jeepStations = [];
  function padClear(x, z) {
    for (var ix = -1; ix <= 1; ix += 0.5) {
      for (var iz = -1; iz <= 1; iz += 1) {
        var px = x + ix * 11.5, pz = z + iz * 5.5;
        if (V.blockedAt(px, pz, 1) || (V.nearRoad && V.nearRoad(px, pz, 1))) return false;
      }
    }
    /* place markers are not solid, but a pad parked over an entrance sign would be */
    return !(V.PLACES || []).some(function (p) { return Math.hypot(p.x - x, p.z - z) < 18; }) &&
           !CYCLE_STATIONS.some(function (c) { return Math.hypot(c.x - x, c.z - z) < 24; }) &&
           !jeepStations.some(function (j) { return Math.hypot(j.x - x, j.z - z) < 40; });
  }
  function placeJeepStations() {
    CYCLE_STATIONS.forEach(function (c) {
      /* the chosen spot, if it is still clear; otherwise the nearest clear one */
      if (c.jeep && padClear(c.jeep.x, c.jeep.z)) {
        jeepStations.push({ x: c.jeep.x, z: c.jeep.z, name: c.name });
        return;
      }
      for (var rad = 26; rad <= 80; rad += 6) {
        for (var k = 0; k < 16; k++) {
          var a = (k / 16) * Math.PI * 2;
          var x = Math.round(c.x + Math.cos(a) * rad), z = Math.round(c.z + Math.sin(a) * rad);
          if (padClear(x, z)) { jeepStations.push({ x: x, z: z, name: c.name }); return; }
        }
      }
    });
  }

  function buildJeepStation(station) {
    var x = station.x, z = station.z, root = V.getRoot();
    /* a low paved pad with painted bays, like the cycle rack's platform */
    V.bx(root, 23, 0.12, 11, V.color(0x6F7C72), x, 0.06, z);
    var paint = V.color(0xEDE6D2);
    for (var i = 0; i <= 3; i++) V.bx(root, 0.14, 0.02, 7.2, paint, x - 10.5 + i * 7, 0.13, z + 0.6);
    V.bx(root, 21.1, 0.02, 0.14, paint, x, 0.13, z - 3.0);
    for (var j = -1; j <= 1; j++) {
      var jeep = makeJeep(JEEP_COLOURS[(j + 1 + jeepStations.indexOf(station)) % JEEP_COLOURS.length]);
      /* centre each jeep in its bay: the model's origin is the driver's seat */
      jeep.position.set(x + j * 7 + JEEP.driverX, 0.12, z + 0.8);
      root.add(jeep);
    }
    [-1, 1].forEach(function (s) { V.cy(root, 0.09, 0.09, 3.9, V.color(0x53584F), x + s * 3.8, 1.95, z - 5.2, 6); });
    V.panel(root, 8, 1.5,
      new T.MeshBasicMaterial({ map: V.signTex("JEEP STATION", station.name || "take a jeep · drive the long roads"),
                                side: T.DoubleSide }),
      x, 3.2, z - 5.2, 0);
  }

  var jeepDriver = null, jeepMesh = null, parkedJeeps = [];
  var jeepMoving = false;

  function nearestJeepStation(x, z, radius) {
    var best = null, bestDistance = radius == null ? 12 : radius;
    jeepStations.forEach(function (s) {
      var d = Math.hypot(x - s.x, z - s.z);
      if (d <= bestDistance) { best = s; bestDistance = d; }
    });
    return best;
  }
  function mountJeep(player, jeep) {
    jeepMesh = jeep;
    jeepMesh.position.set(0, 0, 0);
    jeepMesh.rotation.set(0, 0, 0);
    player.add(jeepMesh);
    jeepDriver = player;
  }
  function toggleJeep(player) {
    if (!player || cycleRider) return false;
    var station = nearestJeepStation(player.position.x, player.position.z);
    if (jeepDriver) {
      if (!station) return false;
      if (jeepMesh && jeepMesh.parent) jeepMesh.parent.remove(jeepMesh);
      jeepMesh = null; jeepDriver = null;
      return true;
    }
    if (!station) return false;
    mountJeep(player, makeJeep(JEEP_COLOURS[Math.floor(Math.random() * JEEP_COLOURS.length)]));
    return true;
  }
  function parkJeep(player) {
    if (!jeepDriver || !jeepMesh || !player) return false;
    if (jeepMesh.parent) jeepMesh.parent.remove(jeepMesh);
    jeepMesh.position.set(player.position.x, 0, player.position.z);
    jeepMesh.rotation.set(0, player.rotation.y, 0);
    jeepMesh.userData.steer.forEach(function (s) { s.rotation.y = 0; });
    V.getRoot().add(jeepMesh);
    parkedJeeps.push(jeepMesh);
    jeepMesh = null; jeepDriver = null;
    return true;
  }
  function nearestParkedJeep(x, z, radius) {
    var best = null, bestDistance = radius == null ? 6 : radius;
    parkedJeeps.forEach(function (j) {
      var d = Math.hypot(x - j.position.x, z - j.position.z);
      if (d <= bestDistance) { best = j; bestDistance = d; }
    });
    return best;
  }
  function takeParkedJeep(player) {
    if (!player || cycleRider || jeepDriver) return false;
    var jeep = nearestParkedJeep(player.position.x, player.position.z);
    if (!jeep) return false;
    parkedJeeps.splice(parkedJeeps.indexOf(jeep), 1);
    jeep.parent.remove(jeep);
    /* climb in where it stands, facing the way it was parked */
    player.position.x = jeep.position.x; player.position.z = jeep.position.z;
    player.rotation.y = jeep.rotation.y;
    mountJeep(player, jeep);
    return true;
  }
  /* wheels roll and the front pair steer, the same way for anybody's jeep */
  function animateJeep(jeep, dt, moving, rate) {
    var roll = moving ? dt * 14 : 0;
    var wh = jeep.userData.wheels || [];
    for (var i = 0; i < wh.length; i++) wh[i].rotation.x += roll;
    var want = Math.max(-0.45, Math.min(0.45, (rate || 0) * 0.25));
    (jeep.userData.steer || []).forEach(function (s) { s.rotation.y += (want - s.rotation.y) * Math.min(1, dt * 8); });
    if (jeep.userData.steeringWheel) jeep.userData.steeringWheel.rotation.z = -jeep.userData.steer[0].rotation.y * 2.2;
  }
  function updateJeep(dt) {
    if (!jeepDriver || !jeepMesh) return;
    var heading = jeepDriver.rotation.y;
    var last = jeepMesh.userData.lastHeading == null ? heading : jeepMesh.userData.lastHeading;
    var turn = ((heading - last + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    jeepMesh.userData.lastHeading = heading;
    animateJeep(jeepMesh, dt, jeepMoving, dt > 0 ? turn / dt : 0);
  }

  function makeTrain(livery) {
    var g = new T.Group();
    var body = V.color(livery), roof = V.color(0x8A9695), glass = V.litGlass(0x9FCAD2);
    function car(zOff, nose) {
      V.bx(g, 3.4, 3.4, 19, body, 0, 2.6, zOff);
      V.bx(g, 3.5, 0.6, 19.2, roof, 0, 4.5, zOff);
      V.bx(g, 3.6, 0.7, 19.2, V.color(0x39423E), 0, 0.9, zOff);
      for (var w = 0; w < 6; w++) {
        V.bx(g, 3.46, 1.3, 2.0, glass, 0, 3.1, zOff - 7.4 + w * 2.96);
      }
      if (nose) {
        V.bx(g, 3.0, 2.4, 2.2, body, 0, 2.3, zOff + 10.2);
        V.bx(g, 2.6, 1.2, 0.2, glass, 0, 3.2, zOff + 11.3);
        V.bx(g, 0.7, 0.4, 0.14, V.litLamp(0xE8E2D2, 0xFFF4D0), -0.9, 1.6, zOff + 11.35);
        V.bx(g, 0.7, 0.4, 0.14, V.litLamp(0xE8E2D2, 0xFFF4D0), 0.9, 1.6, zOff + 11.35);
      }
      [-6, 6].forEach(function (bz) {
        [-1.4, 1.4].forEach(function (bx) {
          var wh = V.cy(g, 0.62, 0.62, 0.35, V.color(0x2A2A28), bx, 0.62, zOff + bz, 8);
          wh.rotation.z = Math.PI / 2;
        });
      });
    }
    car(0, true); car(-20.5, false); car(-41, false);
    return g;
  }

  function makePlane(kind) {
    var g = new T.Group();
    var body = V.color(0xF2F0E6), wing = V.color(0xDCD8CC), tail = V.color(0x2E6A62);
    V.cy(g, 1.6, 1.6, 22, body, 0, 0, 0, 12).rotation.x = Math.PI / 2;
    V.cn(g, 1.6, 3.4, body, 0, 0, 12.6, 12).rotation.x = Math.PI / 2;
    V.bx(g, 26, 0.5, 4.2, wing, 0, -0.3, 0);
    V.bx(g, 10, 0.4, 2.6, wing, 0, 0.4, -9.4);
    V.bx(g, 0.5, 5.2, 3.4, tail, 0, 2.6, -10.2);
    if (kind !== "light") {
      V.cy(g, 1.1, 1.1, 3.6, V.color(0x8A9695), -7, -1.4, 1, 10).rotation.x = Math.PI / 2;
      V.cy(g, 1.1, 1.1, 3.6, V.color(0x8A9695), 7, -1.4, 1, 10).rotation.x = Math.PI / 2;
    }
    /* navigation lights */
    V.sp(g, 0.45, V.litLamp(0xE8E2D2, 0xFF4A3A), -13, -0.3, 0, 6);
    V.sp(g, 0.45, V.litLamp(0xE8E2D2, 0x4AFF7A), 13, -0.3, 0, 6);
    return g;
  }

  /* ------------------------------------------------- fleet and services */
  function buildFleet() {
    var roads = V.ROADS || [];
    function road(id) { for (var i = 0; i < roads.length; i++) if (roads[i].id === id) return roads[i]; return null; }

    var ring = road("ring");
    var routes = [];
    if (ring) {
      routes.push({ id:"ring-cw",  route: makeRoute(offsetLine(ring.pts, 4.4), true), speed: 15 });
      routes.push({ id:"ring-ccw", route: makeRoute(offsetLine(ring.pts.slice().reverse(), 4.4), true), speed: 13 });
    }
    ["north", "east", "west", "south", "crossN", "crossE", "crossW"].forEach(function (id) {
      var r = road(id);
      if (r) routes.push({ id: id, route: lollipop(r.pts, 4.2), speed: 12 + Math.random() * 5 });
    });

    /* cars: spread along every route, each with a fixed offset so the
       pattern is the same for everyone who loads the page */
    var seed = 0;
    routes.forEach(function (r, ri) {
      var n = r.route.len > 1200 ? 5 : (r.route.len > 600 ? 3 : 2);
      for (var i = 0; i < n; i++) {
        seed++;
        var colour = CAR_COLOURS[seed % CAR_COLOURS.length];
        var mesh = makeCar(colour, seed % 5 === 0 ? "van" : "car");
        group.add(mesh);
        vehicles.push({
          g: mesh, route: r.route, speed: r.speed * (0.85 + ((seed * 37) % 30) / 100),
          s: (r.route.len / n) * i + (seed * 13) % 40,
          brake: 0
        });
      }
    });

    /* buses: the ring service, calling at the interchange */
    if (ring) {
      var busRoute = makeRoute(offsetLine(ring.pts, 6.6), true);
      var stops = [0, 0.25, 0.5, 0.75].map(function (f) { return busRoute.len * f; });
      for (var b = 0; b < 3; b++) {
        var bm = makeBus(); group.add(bm);
        vehicles.push({
          g: bm, route: busRoute, speed: 11, bus: true, stops: stops,
          s: (busRoute.len / 3) * b, brake: 0, wait: 0, lastStop: -1
        });
      }
    }
  }

  /* Trains: a timetable expressed as a list of runs and dwells, so the
     position at any instant is a pure function of the clock. */
  var SERVICES = [];
  function buildServices() {
    var rail = V.RAIL, stations = V.STATIONS || [];
    if (!rail) return;
    var stops = stations.map(function (s) { return s.x; }).sort(function (a, b) { return a - b; });

    function timetable(from, to, stopList, speed, dwell, gap) {
      var legs = [], t = 0, at = from;
      stopList.concat([to]).forEach(function (x, i) {
        var dist = Math.abs(x - at);
        var dur = dist / speed + 6;           /* + acceleration allowance */
        legs.push({ t0: t, t1: t + dur, x0: at, x1: x });
        t += dur; at = x;
        if (i < stopList.length) { legs.push({ t0: t, t1: t + dwell, x0: x, x1: x, stop: true }); t += dwell; }
      });
      legs.push({ t0: t, t1: t + gap, x0: to, x1: to, hidden: true });
      return { legs: legs, period: t + gap };
    }

    var east = timetable(-980, 980, stops, 32, 14, 26);
    var west = timetable(980, -980, stops.slice().reverse(), 32, 14, 34);

    var a = makeTrain(0x2E6A62), b = makeTrain(0x8C4A3C);
    a.rotation.y = Math.PI / 2; b.rotation.y = -Math.PI / 2;
    group.add(a); group.add(b);
    trains.push({ g: a, z: rail.a.z, table: east, phase: 0, dir: 1 });
    trains.push({ g: b, z: rail.b.z, table: west, phase: west.period * 0.42, dir: -1 });
    SERVICES = [east, west];
  }

  /* smoothstep, so trains and buses ease in and out of their stops */
  function ease(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }

  function trainAt(tr, now) {
    var tt = tr.table;
    var t = ((now + tr.phase) % tt.period + tt.period) % tt.period;
    for (var i = 0; i < tt.legs.length; i++) {
      var L = tt.legs[i];
      if (t >= L.t0 && t < L.t1) {
        if (L.hidden) return null;
        var f = (t - L.t0) / (L.t1 - L.t0);
        return { x: L.x0 + (L.x1 - L.x0) * ease(f), stopped: !!L.stop };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ flights */
  var FLIGHT_PATHS = [
    { from: [-1100, -700, 230], to: [1100, 500, 260], kind: "jet",   dur: 46 },
    { from: [1150, 600, 300],  to: [-1150, -500, 250], kind: "jet",   dur: 52 },
    { from: [-900, 900, 150],  to: [900, -900, 190],  kind: "light", dur: 62 },
    { from: [200, -1200, 210], to: [-300, 1200, 240], kind: "jet",   dur: 55 }
  ];
  var SLOT = 38;                 /* one departure every 38 seconds */

  function buildFlights() {
    FLIGHT_PATHS.forEach(function (p) {
      var m = makePlane(p.kind);
      m.visible = false;
      group.add(m);
      planes.push({ g: m, path: p, trail: null });
    });
    /* a thin contrail behind the jets */
    planes.forEach(function (pl) {
      if (pl.path.kind === "light") return;
      var m = new T.Mesh(V.U.plane(), V.flat(0xFFFFFF, 0.22));
      m.rotation.x = -Math.PI / 2;
      pl.trail = m; pl.trail.visible = false;
      group.add(m);
    });
  }

  /* ------------------------------------------------------------- build */
  function build() {
    group = new T.Group();
    V.getRoot().add(group);
    buildFleet();
    buildServices();
    buildFlights();
    CYCLE_STATIONS.forEach(buildCycleStation);
    placeJeepStations();
    jeepStations.forEach(buildJeepStation);
    ready = true;
  }

  function toggleCycle(player) {
    if (!player) return false;
    var station = nearestCycleStation(player.position.x, player.position.z);
    if (cycleRider) {
      if (!station || Math.hypot(player.position.x - station.x, player.position.z - station.z) > 8) return false;
      if (cycleMesh && cycleMesh.parent) cycleMesh.parent.remove(cycleMesh);
      cycleRider = null;
      return true;
    }
    if (!station || jeepDriver) return false;
    mountCycle(player, makeCycle());
    return true;
  }
  function mountCycle(player, bike) {
    cycleMesh = bike;
    cycleMesh.position.set(0, 0.05, 0);
    cycleMesh.rotation.set(0, 0, 0);
    player.add(cycleMesh);
    cycleRider = player;
  }

  function parkCycle(player) {
    if (!cycleRider || !cycleMesh || !player) return false;
    if (cycleMesh.parent) cycleMesh.parent.remove(cycleMesh);
    cycleMesh.position.set(player.position.x, CYCLE.mountY, player.position.z);
    cycleMesh.rotation.set(0, player.rotation.y, 0.12);
    if (cycleMesh.userData.fork) cycleMesh.userData.fork.rotation.y = 0;
    V.getRoot().add(cycleMesh);
    parkedCycles.push(cycleMesh);
    cycleMesh = null;
    cycleRider = null;
    return true;
  }

  function parkedCycleAt(x, z) {
    return parkedCycles.some(function (bike) {
      return Math.hypot(x - bike.position.x, z - bike.position.z) <= 7;
    });
  }

  function takeParkedCycle(player) {
    if (!player || jeepDriver) return false;
    var bike = nearestParkedCycle(player.position.x, player.position.z, 7);
    if (!bike) return false;
    parkedCycles.splice(parkedCycles.indexOf(bike), 1);
    bike.parent.remove(bike);
    mountCycle(player, bike);
    return true;
  }

  /* Get on a cycle or a jeep wherever you are standing — the Notice Board's
     "Ride to Event" sends one out from the stations rather than making you
     walk to them. Already on the other kind: it is parked here first, so it
     waits where you left it like any other parked vehicle. */
  function boardVehicle(player, kind) {
    if (!player) return false;
    if (kind === "jeep") {
      if (jeepDriver) return true;
      if (cycleRider) parkCycle(player);
      mountJeep(player, makeJeep(JEEP_COLOURS[Math.floor(Math.random() * JEEP_COLOURS.length)]));
      return true;
    }
    if (cycleRider) return true;
    if (jeepDriver) parkJeep(player);
    mountCycle(player, makeCycle());
    return true;
  }

  function nearestCycleStation(x, z) {
    var best = null, bestDistance = Infinity;
    CYCLE_STATIONS.forEach(function (station) {
      var distance = Math.hypot(x - station.x, z - station.z);
      if (distance < bestDistance) { best = station; bestDistance = distance; }
    });
    return bestDistance <= 10 ? best : null;
  }

  function nearestParkedCycle(x, z, radius) {
    var best = null, bestDistance = radius == null ? Infinity : radius;
    parkedCycles.forEach(function (bike) {
      var distance = Math.hypot(x - bike.position.x, z - bike.position.z);
      if (distance <= bestDistance) { best = bike; bestDistance = distance; }
    });
    return best;
  }

  function takeParkedCycleForNpc(x, z, radius) {
    var bike = nearestParkedCycle(x, z, radius == null ? 6 : radius);
    if (!bike) return null;
    parkedCycles.splice(parkedCycles.indexOf(bike), 1);
    if (bike.parent) bike.parent.remove(bike);
    return bike;
  }

  /* ------------------------------------------------------ route finding
   * For a ride that drives itself. The roads and footpaths are cut into
   * steps of about ROUTE_STEP metres and joined wherever two of them meet;
   * the graph is built the first time anybody asks and kept. A journey is
   * a short hop from where you are onto the network, along it, and a short
   * hop off it to the door. Hops across open ground cost extra, so the
   * roads win whenever they go anywhere near the right way, and nothing is
   * ever joined by a straight line that passes through a building. */
  var ROUTE_STEP = 18, ROUTE_JOIN = 13, OFFROAD = 1.8, LANE = 3.4;
  var DIRECT_MAX = 160;       /* further than this, a straight line is not a route */
  var BRIDGE_MAX = 110;       /* how far a dead end may cross open ground to the next line */
  var graph = null;

  function lineClear(ax, az, bx, bz, pad) {
    var n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3));
    for (var i = 1; i < n; i++) {
      var t = i / n;
      if (V.blockedAt(ax + (bx - ax) * t, az + (bz - az) * t, pad)) return false;
    }
    return true;
  }

  function buildGraph() {
    var nodes = [], adj = [];
    function link(a, b) {
      var w = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
      adj[a].push([b, w]); adj[b].push([a, w]);
    }
    var ends = [];              /* the first and last node of every unbroken piece */
    var piece = 0;
    function addLine(pts, closed, line, road) {
      /* a finely drawn curve needs no more points than a straight road */
      var thin = [pts[0]];
      for (var q = 1; q < pts.length; q++) {
        var t0 = thin[thin.length - 1];
        if (q === pts.length - 1 || Math.hypot(pts[q][0] - t0[0], pts[q][1] - t0[1]) >= ROUTE_STEP) thin.push(pts[q]);
      }
      pts = thin;
      if (closed) pts.push(pts[0]);
      var prev = -1, first = -1, start = -1;
      function cut() { if (start >= 0) ends.push(start, prev); start = -1; piece++; }
      for (var s = 0; s < pts.length - 1; s++) {
        var a = pts[s], b = pts[s + 1];
        var n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / ROUTE_STEP));
        /* the last step of a closed line is its first point again */
        var upto = s === pts.length - 2 && !closed ? n : n - 1;
        for (var k = 0; k <= upto; k++) {
          var x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n;
          if (V.blockedAt(x, z, 1.2)) { cut(); prev = -1; continue; }
          nodes.push({ x: x, z: z, line: line, piece: piece, road: road }); adj.push([]);
          var id = nodes.length - 1;
          if (first < 0) first = id;
          if (prev >= 0 && lineClear(nodes[prev].x, nodes[prev].z, x, z, 1.0)) link(prev, id);
          else { cut(); }
          if (start < 0) start = id;
          prev = id;
        }
      }
      if (closed && prev >= 0 && first >= 0 && prev !== first &&
          lineClear(nodes[prev].x, nodes[prev].z, nodes[first].x, nodes[first].z, 1.0)) link(prev, first);
      else cut();
    }
    var line = 0;
    (V.ROADS || []).forEach(function (r) { addLine(r.pts, !!r.closed, line++, true); });
    (V.PATHS || []).forEach(function (p) { addLine(p.pts, false, line++, false); });
    if (V.lanePts && V.lanePts.length > 1) addLine(V.lanePts, false, line++, false);   /* the old village's lane */
    /* junctions: wherever two lines pass within a few metres of each other */
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        if (nodes[i].line === nodes[j].line) continue;
        if (Math.abs(nodes[i].x - nodes[j].x) > ROUTE_JOIN || Math.abs(nodes[i].z - nodes[j].z) > ROUTE_JOIN) continue;
        if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z) < ROUTE_JOIN) link(i, j);
      }
    }
    /* Dead ends — a footpath that stops at the edge of the old village, a
       road broken by a tree — carry on across open ground to the nearest
       other line, at the off-road price, so the network is all one piece. */
    ends.forEach(function (e) {
      var ex = nodes[e].x, ez = nodes[e].z;
      var near = [];
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].piece === nodes[e].piece) continue;
        var d = Math.hypot(nodes[k].x - ex, nodes[k].z - ez);
        if (d > 0 && d < BRIDGE_MAX) near.push([k, d]);
      }
      near.sort(function (a, b) { return a[1] - b[1]; });
      var made = 0;
      for (var n = 0; n < near.length && n < 16 && made < 2; n++) {
        var o = nodes[near[n][0]];
        if (!lineClear(ex, ez, o.x, o.z, 1.0)) continue;
        adj[e].push([near[n][0], near[n][1] * OFFROAD]); adj[near[n][0]].push([e, near[n][1] * OFFROAD]);
        made++;
      }
    });
    return { nodes: nodes, adj: adj };
  }

  /* Ways onto the network: the nearest point you can reach in a straight
     line on each of the few nearest roads or paths — not just the nearest
     few points, which would all be on the same one. */
  function onRamps(x, z) {
    var nodes = graph.nodes;
    var near = nodes.map(function (n, i) { return [i, Math.hypot(n.x - x, n.z - z)]; })
      .sort(function (a, b) { return a[1] - b[1]; });
    var got = [], seen = {}, tried = 0;
    for (var k = 0; k < near.length && got.length < 6 && tried < 60; k++) {
      var n = nodes[near[k][0]];
      if (seen[n.piece]) continue;
      tried++;
      if (!lineClear(x, z, n.x, n.z, 1.0)) continue;
      seen[n.piece] = 1;
      got.push(near[k]);
    }
    /* standing somewhere awkward: take the nearest anyway, and let the
       ordinary sliding-along-walls movement find the way round */
    return got.length ? got : near.slice(0, 2);
  }

  /* A list of { x, z } waypoints from here to there, ending exactly there. */
  function planRoute(fx, fz, tx, tz) {
    if (!graph) graph = buildGraph();
    var nodes = graph.nodes, N = nodes.length, S = N, G = N + 1;
    var direct = Math.hypot(tx - fx, tz - fz);
    if (!N || direct < 30) return [{ x: tx, z: tz }];

    var dist = new Float64Array(N + 2).fill(Infinity), prev = new Int32Array(N + 2).fill(-1);
    var done = new Uint8Array(N + 2);
    var toGoal = {};
    onRamps(tx, tz).forEach(function (c) { toGoal[c[0]] = c[1] * OFFROAD; });
    dist[S] = 0;
    /* straight there, if nothing is in the way */
    if (direct < DIRECT_MAX && lineClear(fx, fz, tx, tz, 1.0)) { dist[G] = direct * OFFROAD; prev[G] = S; }
    onRamps(fx, fz).forEach(function (c) { dist[c[0]] = c[1] * OFFROAD; prev[c[0]] = S; });
    done[S] = 1;

    /* a few hundred nodes: a plain scan beats keeping a heap */
    for (;;) {
      var u = -1, best = Infinity;
      for (var i = 0; i <= G; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === G) break;
      done[u] = 1;
      var edges = graph.adj[u];
      for (var e = 0; e < edges.length; e++) {
        var v = edges[e][0], d = best + edges[e][1];
        if (d < dist[v]) { dist[v] = d; prev[v] = u; }
      }
      if (toGoal[u] != null && best + toGoal[u] < dist[G]) { dist[G] = best + toGoal[u]; prev[G] = u; }
    }
    if (prev[G] < 0) return [{ x: tx, z: tz }];

    var chain = [];
    for (var at = prev[G]; at !== S && at >= 0; at = prev[at]) chain.unshift(at);
    /* keep to the right-hand lane on the carriageways, as the traffic does */
    var out = chain.map(function (id, k) {
      var n = nodes[id];
      if (!n.road) return { x: n.x, z: n.z };
      var a = nodes[chain[Math.max(0, k - 1)]], b = nodes[chain[Math.min(chain.length - 1, k + 1)]];
      var dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      if (!len) return { x: n.x, z: n.z };
      return { x: n.x - (dz / len) * LANE, z: n.z + (dx / len) * LANE };
    });
    out.push({ x: tx, z: tz });
    return out;
  }

  /* ------------------------------------------------------------ update */
  var acc = 0;
  function update(dt, playerPos) {
    if (!ready) return;
    if (playerPos) { playerRef.x = playerPos.x; playerRef.z = playerPos.z; }
    updateJeep(dt);
    if (cycleRider && cycleMesh) {
      /* Wheels and cranks are geared to each other rather than to the clock,
         so the bike never looks as if it is freewheeling uphill. */
      var roll = cycleMoving ? dt * 12.5 : 0;
      cycleMotion += roll;
      var wh = cycleMesh.userData.wheels || [];
      for (var wi = 0; wi < wh.length; wi++) wh[wi].rotation.x -= roll;
      if (cycleMesh.userData.pedals) cycleMesh.userData.pedals.rotation.x = -cycleMotion * 0.42;
      if (cycleMesh.userData.sprocket) cycleMesh.userData.sprocket.rotation.x = -cycleMotion;

      /* Steering and lean: the rider's turn rate drives both, the way it
         does on a real bicycle. */
      var heading = cycleRider.rotation.y;
      var turn = ((heading - (cycleMesh.userData.lastHeading == null ? heading : cycleMesh.userData.lastHeading)
                   + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      cycleMesh.userData.lastHeading = heading;
      var rate = dt > 0 ? turn / dt : 0;
      var lean = Math.max(-0.42, Math.min(0.42, rate * (cycleMoving ? 0.16 : 0.04)));
      cycleMesh.rotation.z += (lean - cycleMesh.rotation.z) * Math.min(1, dt * 6);
      if (cycleMesh.userData.fork) {
        var steer = Math.max(-0.5, Math.min(0.5, rate * 0.22));
        var f = cycleMesh.userData.fork;
        f.rotation.y += (steer - f.rotation.y) * Math.min(1, dt * 9);
      }
      /* a little of the road coming up through the frame */
      cycleMesh.position.y = 0.05 + (cycleMoving ? Math.sin(cycleMotion * 0.9) * 0.012 : 0);
    }
    var now = clockNow();

    /* --- road traffic --- */
    for (var i = 0; i < vehicles.length; i++) {
      var v = vehicles[i];
      var want = v.speed;

      /* dwell at bus stops */
      if (v.bus) {
        if (v.wait > 0) { v.wait -= dt; want = 0; }
        else {
          for (var k = 0; k < v.stops.length; k++) {
            var ds = v.stops[k] - v.s;
            if (ds > 0 && ds < 2.2 && v.lastStop !== k) { v.wait = 6; v.lastStop = k; want = 0; break; }
          }
        }
      }
      /* give way to anyone standing in the road ahead */
      var look = v.route.at(v.s + 13);
      var dx = playerRef.x - look.x, dz = playerRef.z - look.z;
      if (dx * dx + dz * dz < 90) want = 0;

      v.brake += (want - v.brake) * Math.min(1, dt * 1.8);
      v.s += v.brake * dt;
      var p = v.route.at(v.s);
      v.g.position.set(p.x, 0, p.z);
      v.g.rotation.y = p.a;
      /* skip the matrix work for anything far behind the camera */
      v.g.visible = Math.abs(p.x - playerRef.x) + Math.abs(p.z - playerRef.z) < 620;
    }

    /* --- trains --- */
    for (var t = 0; t < trains.length; t++) {
      var tr = trains[t];
      var at = trainAt(tr, now);
      if (!at) { tr.g.visible = false; continue; }
      tr.g.visible = Math.abs(at.x - playerRef.x) + Math.abs(tr.z - playerRef.z) < 900;
      tr.g.position.set(at.x, 0, tr.z);
      if (tr.arrived !== at.stopped) {
        tr.arrived = at.stopped;
        if (at.stopped && V.onTrainStop) V.onTrainStop(at.x, tr.z);
      }
    }

    /* --- aircraft --- */
    for (var f = 0; f < planes.length; f++) {
      var pl = planes[f], path = pl.path;
      /* each path departs on its own stagger of the shared slot clock */
      var offset = f * (SLOT / planes.length) * 2.4;
      var cycle = SLOT * planes.length;
      var local = ((now - offset) % cycle + cycle) % cycle;
      if (local > path.dur) {
        pl.g.visible = false;
        if (pl.trail) pl.trail.visible = false;
        continue;
      }
      var q = local / path.dur;
      var x = path.from[0] + (path.to[0] - path.from[0]) * q;
      var z = path.from[1] + (path.to[1] - path.from[1]) * q;
      var y = path.from[2] + (path.to[2] - path.from[2]) * q;
      pl.g.visible = true;
      pl.g.position.set(x, y, z);
      pl.g.rotation.y = Math.atan2(path.to[0] - path.from[0], path.to[1] - path.from[1]);
      pl.g.rotation.z = Math.sin(now * 0.4 + f) * 0.04;
      if (pl.trail) {
        var back = Math.min(q, 0.22) * 900;
        pl.trail.visible = q > 0.04;
        pl.trail.position.set(x - Math.sin(pl.g.rotation.y) * back / 2, y - 2,
                              z - Math.cos(pl.g.rotation.y) * back / 2);
        pl.trail.scale.set(3.4, back, 1);
        pl.trail.rotation.z = -pl.g.rotation.y;
      }
    }
  }

  /* --------------------------------------------------------------- API */
  /* Next departures from a station, for the board in the concourse and for
     the station panel. Pure arithmetic on the same timetable the trains use. */
  function departures(stationX, limit) {
    var out = [], now = clockNow();
    trains.forEach(function (tr, i) {
      var tt = tr.table;
      for (var n = 0; n < 3; n++) {
        for (var L = 0; L < tt.legs.length; L++) {
          var leg = tt.legs[L];
          if (!leg.stop || Math.abs(leg.x0 - stationX) > 1) continue;
          var base = Math.floor((now + tr.phase) / tt.period) + n;
          var at = base * tt.period + leg.t0 - tr.phase;
          if (at < now - 4) continue;
          out.push({ inSec: Math.max(0, at - now), dir: tr.dir > 0 ? "eastbound" : "westbound" });
        }
      }
    });
    out.sort(function (a, b) { return a.inSec - b.inSec; });
    return out.slice(0, limit || 4);
  }

  window.QVTransport = {
    build: build, update: update, departures: departures,
    cycleStation: function () { return CYCLE_STATIONS[0]; },
    cycleStations: function () { return CYCLE_STATIONS.slice(); },
    isCycling: function () { return !!cycleRider; },
    makeCycleVisual: makeCycle,
    setCycleMoving: function (moving) { cycleMoving = !!moving; },
    toggleCycle: toggleCycle,
    parkCycle: parkCycle,
    parkedCycleAt: parkedCycleAt,
    takeParkedCycle: takeParkedCycle,
    takeParkedCycleForNpc: takeParkedCycleForNpc,
    jeepStations: function () { return jeepStations.slice(); },
    isDriving: function () { return !!jeepDriver; },
    makeJeepVisual: makeJeep,
    animateJeep: animateJeep,
    setJeepMoving: function (moving) { jeepMoving = !!moving; },
    toggleJeep: toggleJeep,
    parkJeep: parkJeep,
    parkedJeepAt: function (x, z) { return !!nearestParkedJeep(x, z); },
    takeParkedJeep: takeParkedJeep,
    boardVehicle: boardVehicle,
    planRoute: planRoute,
    clockNow: clockNow,
    counts: function () { return { vehicles: vehicles.length, trains: trains.length, planes: planes.length }; }
  };
})();
