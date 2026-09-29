/* Quantum Village — the research campus.
 *
 * Everything outside the old village: the ring road and the streets off it,
 * the university quarter to the north, the research park east, the
 * residential quarter and park west, and the station quarter south.
 *
 * Two phases:
 *   plan()   declares roads, rails and districts as plain data. Runs before
 *            anything is built, so other modules can keep clear of the roads.
 *   build()  puts the geometry in the scene.
 *
 * To add a building, add a row to BUILDINGS. To add a room, add a row to
 * ROOMS. Nothing else needs to change.
 */
(function () {
  "use strict";
  var T = window.THREE;
  var V = window.QV;
  var C = null;                       /* palette, resolved at build time */

  /* ====================================================== road network */
  function circlePts(cx, cz, r, n) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    return pts;
  }

  var RING_R = 360;

  var ROADS = [
    { id:"ring",   name:"Bohr Ring",        width:17, closed:true, pts: circlePts(0, 0, RING_R, 72) },
    { id:"north",  name:"Curie Way",        width:15, pts: [[0,-352],[0,-736]] },
    { id:"crossN", name:"Planck Crescent",  width:14, pts: [[-420,-470],[420,-470]] },
    { id:"crossN2",name:"Bohr Walk",        width:13, pts: [[-300,-700],[140,-700]] },
    { id:"east",   name:"Feynman Boulevard",width:15, pts: [[352,0],[830,0]] },
    { id:"crossE", name:"Rutherford Row",   width:14, pts: [[620,-270],[620,310]] },
    { id:"west",   name:"Noether Avenue",   width:15, pts: [[-352,0],[-812,0]] },
    { id:"crossW", name:"Meitner Lane",     width:14, pts: [[-600,-300],[-600,330]] },
    { id:"south",  name:"Station Road",     width:15, pts: [[0,352],[0,566]] },
    { id:"bus",    name:"Interchange Approach", width:13, pts: [[0,462],[196,462]] }
  ];

  /* Footpaths — pedestrian only, and drawn lighter. */
  var PATHS = [
    { pts: [[0,-352],[0,-300],[8,-240],[26,-190],[44,-120]] },       /* ring → old village north */
    { pts: [[352,0],[300,6],[240,10],[170,6],[120,0]] },             /* ring → old village east */
    { pts: [[-352,0],[-300,6],[-240,14],[-170,10],[-120,4]] },       /* ring → old village west */
    { pts: [[0,352],[0,300],[-10,240],[-24,170],[-30,110]] },        /* ring → old village south */
    { pts: [[-150,-432],[-150,-470]] },                              /* library → Planck Crescent */
    { pts: [[-120,-517],[-120,-470]] },
    { pts: [[120,-520],[120,-470]] },
    { pts: [[104,-530],[8,-530]] },
    { pts: [[104,-595],[8,-595]] },
    { pts: [[104,-660],[8,-660]] },
    { pts: [[140,-700],[180,-690],[230,-684]] },                     /* Bohr Walk → Grand Poster Hall entrance */
    { pts: [[-265,-580],[-8,-580]] },                                /* lecture halls */
    { pts: [[265,-580],[8,-580]] },
    { pts: [[0,-736],[0,-758]] },
    { pts: [[-350,-690],[-300,-690],[-300,-700]] },
    { pts: [[470,-98],[470,-8]] },                                   /* institute → boulevard */
    { pts: [[740,-95],[740,-8]] },
    { pts: [[470,111],[470,8]] },
    { pts: [[740,129],[740,8]] },
    { pts: [[-470,-105],[-470,-8]] },
    { pts: [[-450,158],[-450,8]] },
    { pts: [[-600,140],[-680,180],[-720,220]] },                     /* lane → the park */
    { pts: [[0,609],[0,632]] },                                      /* station → platform */
    { pts: [[-560,603],[-560,632]] },
    { pts: [[-560,581],[-560,470],[-300,462],[-4,462]] },            /* halt → interchange */
    { pts: [[196,462],[300,420],[330,360]] },                        /* interchange → the field */
    { pts: [[-600,-300],[-640,-330],[-680,-358]] },                  /* Meitner Lane → Seminar Hall α */
    { pts: [[620,310],[652,344],[680,377]] }                         /* Rutherford Row → Seminar Hall β */
  ];

  /* Rail: two tracks running east–west behind the station. */
  var RAIL = {
    a: { id:"east", z: 648, from: -900, to: 900 },
    b: { id:"west", z: 674, from: -900, to: 900 }
  };
  var STATIONS = [
    { id:"central", name:"Quantum Village Central", x: 0,    platformZ: 630, halfLen: 130 },
    { id:"westfield", name:"Westfield Halt",        x: -560, platformZ: 630, halfLen: 86 }
  ];

  /* ------------------------------------------------------- road lookup */
  function distToSeg(px, pz, ax, az, bx, bz) {
    var vx = bx - ax, vz = bz - az;
    var len2 = vx * vx + vz * vz;
    var t = len2 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
  }
  /* Is this point on (or beside) a carriageway? Used to keep scenery off
     the road, and to slow traffic near a pedestrian. */
  V.nearRoad = function (x, z, margin) {
    margin = margin || 0;
    for (var i = 0; i < ROADS.length; i++) {
      var r = ROADS[i], pts = r.pts, half = r.width / 2 + margin;
      /* cheap reject on the ring */
      if (r.closed) {
        var rad = Math.hypot(x, z);
        if (Math.abs(rad - RING_R) < half) return r;
        continue;
      }
      for (var j = 0; j < pts.length - 1; j++) {
        if (distToSeg(x, z, pts[j][0], pts[j][1], pts[j+1][0], pts[j+1][1]) < half) return r;
      }
    }
    return null;
  };

  /* ------------------------------------------------------------ zones */
  var ZONES = [
    { name:"Noether Park",        sub:"Lawns, pond and bandstand",     cx:-720, cz:220,  r:170 },
    { name:"North Campus",        sub:"University quarter",            box:[-460,-780, 460,-380] },
    { name:"Research Park",       sub:"Institutes and laboratories",   box:[390,-330, 860,330] },
    { name:"Residential Quarter", sub:"Where the village lives",       box:[-820,-330, -400,120] },
    { name:"Station Quarter",     sub:"Trains, buses and the field",   box:[-700,370, 460,760] }
  ];
  V.zoneAt = function (x, z) {
    for (var i = 0; i < ZONES.length; i++) {
      var zo = ZONES[i];
      if (zo.r != null) { if (Math.hypot(x - zo.cx, z - zo.cz) < zo.r) return zo; }
      else if (x > zo.box[0] && x < zo.box[2] && z > zo.box[1] && z < zo.box[3]) return zo;
    }
    return null;
  };

  /* ================================================== building catalogue
   * kind drives what pressing E does, and what the map icon looks like. */
  var BUILDINGS = [
    /* ---- north campus ---- */
    { id:"library", name:"Dirac Library", kind:"library", sub:"Every shelf, every archive",
      x:-150, z:-410, ry:0, w:80, d:44, h:15, roofStyle:"gable", wall:0xEADBBE, roof:0x7C8B8A,
      doors:[{side:"s",at:0,width:9},{side:"n",at:0,width:7}], papers:8, sign:"Dirac Library" },
    { id:"cafe-noether", name:"Café Noether", kind:"cafe", sub:"Coffee, chalk and argument",
      x:150, z:-410, ry:0, w:34, d:26, h:9, roofStyle:"gable", wall:0xF0DFC0, roof:0xCBA86A,
      doors:[{side:"s",at:0,width:7}], papers:2, sign:"Café Noether" },
    { id:"uni-main", name:"Quantum Village University", kind:"university", sub:"Faculty of Physical Sciences",
      x:0, z:-760, ry:0, w:110, d:44, h:17, roofStyle:"hip", wall:0xF2E8D4, roof:0xB4603F,
      doors:[{side:"s",at:0,width:12}], papers:3, sign:"The University", portico:true },
    { id:"offices", name:"Faculty Offices", kind:"offices", sub:"Doors open, mostly",
      x:-380, z:-690, ry:0, w:62, d:28, h:11, roofStyle:"flat", wall:0xD6DFC6, roof:0x8A9695,
      doors:[{side:"e",at:0,width:7}], papers:3, sign:"Faculty Offices" },
    { id:"lecture-a", name:"Lecture Hall Alpha", kind:"lecture", sub:"Tiered seats, long blackboard",
      x:-290, z:-580, ry:0, w:50, d:40, h:14, roofStyle:"vault", wall:0xEADBBE, roof:0x7C8B8A,
      doors:[{side:"e",at:0,width:8}], papers:1, sign:"Lecture Hall α" },
    { id:"lecture-b", name:"Lecture Hall Beta", kind:"lecture", sub:"Tiered seats, long blackboard",
      x:290, z:-580, ry:0, w:50, d:40, h:14, roofStyle:"vault", wall:0xEADBBE, roof:0x7C8B8A,
      doors:[{side:"w",at:0,width:8}], papers:1, sign:"Lecture Hall β" },
    /* Set back from the crossroads on purpose: x:0 sits on the north-south
       spine and z:-470 on the east-west road, so a hall there had traffic
       driving straight through it. This spot is 67m clear of any road and
       still a short walk from the lecture halls. */
    { id:"poster-hall", name:"The Poster Hall", kind:"poster", sub:"Posters, benches and room to stand",
      x:-200, z:-560, ry:0, w:88, d:46, h:15, roofStyle:"vault", wall:0xF2E8D4, roof:0x7C8B8A,
      doors:[{side:"s",at:0,width:12}], papers:2, sign:"The Poster Hall" },
    { id:"poster-hall-2", name:"The Grand Poster Hall", kind:"poster2", sub:"Fifty poster boards, three aisles",
      x:230, z:-720, ry:0, w:120, d:72, h:16, roofStyle:"vault", wall:0xF2E8D4, roof:0x8A9695,
      doors:[{side:"s",at:0,width:14}], papers:3, sign:"Grand Poster Hall" },
    { id:"disc-1", name:"Discussion Room One", kind:"discussion", sub:"Round table, five chairs",
      x:120, z:-530, ry:0, w:24, d:20, h:9, roofStyle:"hip", wall:0xF0DFC0, roof:0xC9714C,
      doors:[{side:"w",at:0,width:6}], sign:"Discussion 1" },
    { id:"disc-2", name:"Discussion Room Two", kind:"discussion", sub:"Round table, five chairs",
      x:120, z:-595, ry:0, w:24, d:20, h:9, roofStyle:"hip", wall:0xF0DFC0, roof:0xB4603F,
      doors:[{side:"w",at:0,width:6}], sign:"Discussion 2" },
    { id:"disc-3", name:"Discussion Room Three", kind:"discussion", sub:"Round table, five chairs",
      x:120, z:-660, ry:0, w:24, d:20, h:9, roofStyle:"hip", wall:0xF0DFC0, roof:0x7C8B8A,
      doors:[{side:"w",at:0,width:6}], sign:"Discussion 3" },

    /* ---- research park ---- */
    { id:"inst-particle", name:"Institute for Particle Physics", kind:"institute", sub:"hep-ph, hep-ex, and the arguments between",
      x:470, z:-120, ry:0, w:80, d:44, h:16, roofStyle:"flat", wall:0xF2E8D4, roof:0x8A9695,
      doors:[{side:"s",at:0,width:10}], papers:4, sign:"Particle Physics", topic:"pheno" },
    { id:"lab-detector", name:"Detector Hall", kind:"lab", sub:"Low background, high hopes",
      x:740, z:-120, ry:0, w:70, d:50, h:20, roofStyle:"vault", wall:0xD6DFC6, roof:0xB9C2C2,
      doors:[{side:"s",at:0,width:10}], papers:3, sign:"Detector Hall", topic:"dm" },
    { id:"lab-quantum", name:"Quantum Optics Laboratory", kind:"lab", sub:"Benches, cryostats, very little talking",
      x:470, z:130, ry:0, w:64, d:38, h:13, roofStyle:"flat", wall:0xEADBBE, roof:0x7C8B8A,
      doors:[{side:"n",at:0,width:9}], papers:3, sign:"Quantum Optics", topic:"qft" },
    { id:"inst-astro", name:"Astrophysics Institute", kind:"institute", sub:"The sky as a beam line",
      x:740, z:150, ry:0, w:60, d:42, h:15, roofStyle:"dome", wall:0xF2E8D4, roof:0xB9C2C2,
      doors:[{side:"n",at:0,width:9}], papers:3, sign:"Astrophysics", topic:"astro" },

    /* ---- residential quarter and park ---- */
    { id:"common-room", name:"Fellows' Common Room", kind:"common", sub:"Tea at four, whether or not you want it",
      x:-470, z:-120, ry:0, w:42, d:30, h:10, roofStyle:"gable", wall:0xF0DFC0, roof:0xCBA86A,
      doors:[{side:"e",at:0,width:7}], papers:2, sign:"Common Room" },
    { id:"cafe-planck", name:"Café Planck", kind:"cafe", sub:"Open late, argues later",
      x:-450, z:170, ry:0, w:32, d:24, h:9, roofStyle:"gable", wall:0xF4EBD8, roof:0xC9714C,
      doors:[{side:"n",at:0,width:7}], papers:2, sign:"Café Planck" },

    /* ---- station quarter ---- */
    { id:"station", name:"Quantum Village Central", kind:"station", sub:"Trains east and west",
      x:0, z:592, ry:0, w:86, d:34, h:14, roofStyle:"flat", wall:0xF2E8D4, roof:0xB9C2C2,
      doors:[{side:"s",at:0,width:12},{side:"n",at:0,width:12}], papers:1, sign:"Central Station" },
    { id:"halt", name:"Westfield Halt", kind:"station", sub:"Two benches and a timetable",
      x:-560, z:592, ry:0, w:34, d:22, h:10, roofStyle:"flat", wall:0xEADBBE, roof:0xB9C2C2,
      doors:[{side:"s",at:0,width:7},{side:"n",at:0,width:7}], sign:"Westfield Halt" },
    { id:"pavilion", name:"Field Pavilion", kind:"common", sub:"Chalk, benches, open air",
      x:330, z:300, ry:0, w:34, d:24, h:9, roofStyle:"gable", wall:0xF0DFC0, roof:0xCBA86A,
      doors:[{side:"w",at:0,width:8},{side:"e",at:0,width:8}], sign:"Field Pavilion" },

    /* ---- the seminar halls, out on the edge of the village ----
     *
     * Deliberately not on the campus. A hall for fifty needs a footprint no
     * gap between the lecture halls could take, and a seminar that fills it
     * empties every corridor it is next to. So they sit past the last street
     * on either side — north-west beyond the residences, south-east beyond
     * the research park — each with its own footpath in from the nearest
     * lane, and nothing around them to be quiet for.
     *
     * `hall: true` is what makes them halls rather than seminar rooms: same
     * kind, so the seat, speaker, activity and map machinery is unchanged,
     * but a different layout — fifty tiered chairs all facing forty metres
     * of slate that doubles as the slide screen. */
    { id:"seminar-hall-a", name:"Seminar Hall Alpha", kind:"seminar", hall:true,
      sub:"Fifty seats, one very large blackboard",
      x:-680, z:-390, ry:0, w:66, d:50, h:20, roofStyle:"vault", wall:0xF2E8D4, roof:0x7C8B8A,
      doors:[{side:"s",at:0,width:12}], papers:0, sign:"Seminar Hall α" },
    { id:"seminar-hall-b", name:"Seminar Hall Beta", kind:"seminar", hall:true,
      sub:"Fifty seats, one very large blackboard",
      x:680, z:410, ry:0, w:66, d:50, h:20, roofStyle:"vault", wall:0xEADBBE, roof:0x8A9695,
      doors:[{side:"n",at:0,width:12}], papers:0, sign:"Seminar Hall β" }
  ];

  /* ============================================================ rooms
   * Seat and stage positions are generated from the building footprint, so
   * a new room only needs a row in BUILDINGS with the right kind. */
  V.ROOMS = V.ROOMS || [];
  V.PAPER_SPOTS = V.PAPER_SPOTS || [];

  var built = {};
  V.buildingById = function (id) { return built[id]; };

  /* ------------------------------------------------------------- plan */
  var planned = false;
  function plan() {
    if (planned) return;
    planned = true;
    V.ROADS = ROADS;
    V.PATHS = PATHS;
    V.RAIL = RAIL;
    V.STATIONS = STATIONS;
    V.RING_R = RING_R;
  }

  /* ====================================================== build helpers */
  var ribbon = function (pts, width, y, material, closed, parent) {
    return V.ribbon(pts, width, y, material, closed, parent);
  };

  /* Evenly spaced points along a polyline, with the local heading. */
  function walkLine(pts, spacing, closed, cb) {
    var list = closed ? pts.concat([pts[0]]) : pts;
    var carry = 0;
    for (var i = 0; i < list.length - 1; i++) {
      var a = list[i], b = list[i + 1];
      var dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      var ang = Math.atan2(dx, dz);
      for (var t = carry; t < len; t += spacing) {
        cb(a[0] + dx * (t / len), a[1] + dz * (t / len), ang, i);
      }
      carry = (carry - len) % spacing;
      if (carry < 0) carry += spacing;
    }
  }

  /* ---------------------------------------------------------- scenery */
  var props;           /* the world's shared instanced-prop batch */

  /* Add a batched instance in a building's local frame. */
  function localAdd(st, geo, mat, lx, y, lz, sx, sy, sz, ry, rz, rx) {
    var cos = Math.cos(st.ry), sin = Math.sin(st.ry);
    props.add(geo, mat, st.x + lx * cos + lz * sin, y, st.z - lx * sin + lz * cos,
      sx, sy, sz, (ry || 0) + st.ry, rz, rx);
  }

  /* Nothing decorative may grow inside a building.
   *
   * This used to be a hard-coded rectangle around the Grand Poster Hall,
   * which is how a tree came to be standing in the middle of The Poster
   * Hall with its trunk across the doorway. Testing the footprint of every
   * building instead fixes that one and the next one. */
  function insideAnyBuilding(x, z, pad) {
    pad = pad || 0;
    for (var i = 0; i < BUILDINGS.length; i++) {
      var b = BUILDINGS[i];
      var ox = x - b.x, oz = z - b.z;
      var cos = Math.cos(b.ry || 0), sin = Math.sin(b.ry || 0);
      var lx = ox * cos - oz * sin, lz = ox * sin + oz * cos;
      if (Math.abs(lx) < b.w / 2 + pad && Math.abs(lz) < b.d / 2 + pad) return true;
    }
    return false;
  }

  function plantTree(x, z, scale, kind) {
    if (insideAnyBuilding(x, z, 2.5)) return;
    scale = scale || 1;
    var trunk = V.color(C.trunk);
    if (kind === "conifer") {
      props.add(V.U.cyl(7), trunk, x, 1.8 * scale, z, 0.4 * scale, 3.6 * scale, 0.4 * scale);
      for (var c = 0; c < 3; c++) {
        props.add(V.U.cone(9), V.color(c % 2 ? C.leafDark : C.leaf),
          x, (4.6 + c * 2.6) * scale, z, (3.4 - c * 0.8) * scale, 4.4 * scale, (3.4 - c * 0.8) * scale);
      }
      V.blockCircle(x, z, 1.5 * scale);
    } else if (kind === "poplar") {
      props.add(V.U.cyl(7), trunk, x, 4 * scale, z, 0.36 * scale, 8 * scale, 0.36 * scale);
      props.add(V.U.sph(8), V.color(C.leafDark), x, 10 * scale, z, 2.2 * scale, 6.2 * scale, 2.2 * scale);
      V.blockCircle(x, z, 1.2 * scale);
    } else {
      props.add(V.U.cyl(8), trunk, x, 2.4 * scale, z, 0.55 * scale, 4.8 * scale, 0.55 * scale);
      props.add(V.U.sph(9), V.color(C.leaf), x, 7.2 * scale, z, 3.6 * scale);
      props.add(V.U.sph(8), V.color(C.leafDark), x + 1.9 * scale, 6.0 * scale, z + 0.9 * scale, 2.5 * scale);
      props.add(V.U.sph(8), V.color(C.leafLight), x - 1.7 * scale, 6.5 * scale, z - 1.1 * scale, 2.2 * scale);
      V.blockCircle(x, z, 1.5 * scale);
    }
  }
  function plantBush(x, z, s) {
    if (insideAnyBuilding(x, z, 2.5)) return;
    s = s || 1;
    props.add(V.U.sph(7), V.color(C.leafDark), x, 1.1 * s, z, 1.5 * s);
    props.add(V.U.sph(6), V.color(C.leaf), x + 1.1 * s, 0.9 * s, z + 0.4 * s, 1.1 * s);
  }
  var FLOWER = [0xE86F8A, 0xE8C45A, 0xF2F0E4, 0xB98FE0, 0xE89A5A];
  function flowerBed(x, z, w, d, n) {
    props.add(V.U.plane(), V.color(0x6F5A3E), x, 0.06, z, w, d, 1, 0, 0, -Math.PI / 2);   /* soil */
    for (var i = 0; i < n; i++) {
      var fx = x + (Math.random() - 0.5) * w, fz = z + (Math.random() - 0.5) * d;
      props.add(V.U.cyl(5), V.color(0x5C8A58), fx, 0.5, fz, 0.07, 1.0, 0.07);
      props.add(V.U.sph(6), V.color(FLOWER[i % FLOWER.length]), fx, 1.05, fz, 0.32);
    }
  }
  function grassTufts(x, z, r, n) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.283, rr = Math.random() * r;
      props.add(V.U.cone(4), V.color(i % 3 ? 0x7E9A5E : 0x93AE67),
        x + Math.cos(a) * rr, 0.42, z + Math.sin(a) * rr, 0.36, 0.9, 0.36, Math.random() * 3);
    }
  }
  function bench(x, z, ry) {
    var wood = V.color(C.wood), dark = V.color(C.woodDark);
    var cos = Math.cos(ry), sin = Math.sin(ry);
    props.add(V.U.box(), wood, x, 0.8, z, 3.4, 0.22, 1.0, ry);
    props.add(V.U.box(), wood, x - 0.42 * sin, 1.24, z - 0.42 * cos, 3.4, 0.7, 0.16, ry);
    props.add(V.U.box(), dark, x + 1.3 * cos, 0.4, z - 1.3 * sin, 0.22, 0.8, 0.8, ry);
    props.add(V.U.box(), dark, x - 1.3 * cos, 0.4, z + 1.3 * sin, 0.22, 0.8, 0.8, ry);
    V.blockCircle(x, z, 1.4);
  }
  function streetLight(x, z, ry) {
    if (insideAnyBuilding(x, z, 2.5)) return;
    props.add(V.U.cyl(7), V.color(0x53584F), x, 4.2, z, 0.19, 8.4, 0.19);
    props.add(V.U.box(), V.color(0x53584F), x + Math.sin(ry) * 1.1, 8.3, z + Math.cos(ry) * 1.1, 2.4, 0.22, 0.22, ry);
    /* the lamp itself is a shared emissive material so dusk lights them all */
    var head = V.bx(V.root, 1.0, 0.5, 0.9, LAMP_M, x + Math.sin(ry) * 2.1, 8.0, z + Math.cos(ry) * 2.1, ry);
    head.matrixAutoUpdate = false; head.updateMatrix();
    V.blockCircle(x, z, 0.7);
  }
  function fenceRun(x1, z1, x2, z2, colour) {
    var dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
    var n = Math.max(1, Math.round(len / 3.6)), ang = Math.atan2(dx, dz);
    var m = V.color(colour == null ? C.woodDark : colour);
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      props.add(V.U.cyl(6), m, x1 + dx * t, 1.05, z1 + dz * t, 0.13, 2.1, 0.13);
    }
    props.add(V.U.box(), V.color(colour == null ? C.wood : colour), (x1 + x2) / 2, 0.78, (z1 + z2) / 2, 0.1, 0.16, len, ang);
    props.add(V.U.box(), V.color(colour == null ? C.wood : colour), (x1 + x2) / 2, 1.42, (z1 + z2) / 2, 0.1, 0.16, len, ang);
  }
  function hedgeRun(x1, z1, x2, z2) {
    var dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
    var ang = Math.atan2(dx, dz);
    props.add(V.U.box(), V.color(0x4E7A48), (x1 + x2) / 2, 0.9, (z1 + z2) / 2, 1.8, 1.8, len, ang);
    V.blockBox((x1 + x2) / 2, (z1 + z2) / 2, 0.9, len / 2, ang);
  }

  var LAMP_M = null;

  /* ------------------------------------------------------------- signs */
  function signPost(x, z, ry, title, sub, w) {
    V.signBoard(x, z, ry, title, sub, w || 8);
    V.blockCircle(x, z, 1.2);
  }
  function directionPost(x, z, blades) {
    V.cy(V.root, 0.2, 0.2, 9, V.color(0x53584F), x, 4.5, z, 8);
    blades.forEach(function (b, i) {
      var tex = V.bladeTex(b.label, b.side);
      var m = new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide });
      var pl = V.panel(V.root, 7.2, 1.63, m,
        x + (b.side === "left" ? -3.9 : 3.9) * Math.cos(b.ry), 8.2 - i * 2.0,
        z - (b.side === "left" ? -3.9 : 3.9) * Math.sin(b.ry), b.ry);
      pl.matrixAutoUpdate = false; pl.updateMatrix();
    });
    V.blockCircle(x, z, 0.9);
  }
  /* A university-style notice board with a procedural physics poster. */
  function noticeBoard(x, z, ry, kind, seed) {
    var g = new T.Group();
    V.cy(g, 0.14, 0.14, 4.2, V.color(C.woodDark), -1.5, 2.1, 0, 6);
    V.cy(g, 0.14, 0.14, 4.2, V.color(C.woodDark), 1.5, 2.1, 0, 6);
    V.bx(g, 3.9, 4.6, 0.2, V.color(0x2F3A34), 0, 4.2, 0);
    var m = new T.MeshBasicMaterial({ map: V.posterTex(kind, seed), side: T.DoubleSide });
    V.panel(g, 3.3, 4.1, m, 0, 4.2, 0.14);
    g.position.set(x, 0, z); g.rotation.y = ry;
    V.root.add(g);
    V.blockCircle(x, z, 1.2);
    return g;
  }

  /* =================================================== interior fittings */
  /* Chairs are instanced, and deliberately not solid: nobody should ever be
     wedged behind a chair, and you sit by pressing E, not by shoving. */
  /* `y0` lifts the whole chair, for a raked hall where the row behind
     stands half a metre above the row in front of it. */
  function chair(st, lx, lz, ry, y0) {
    var wood = V.color(C.wood), dark = V.color(C.woodDark);
    var cos = Math.cos(ry), sin = Math.sin(ry);
    y0 = y0 || 0;
    localAdd(st, V.U.box(), wood, lx, y0 + 1.0, lz, 1.3, 0.18, 1.3, ry);
    localAdd(st, V.U.box(), wood, lx - sin * 0.56, y0 + 1.6, lz - cos * 0.56, 1.3, 1.25, 0.16, ry);
    [-0.5, 0.5].forEach(function (ox) {
      [-0.5, 0.5].forEach(function (oz) {
        localAdd(st, V.U.cyl(5), dark,
          lx + ox * cos + oz * sin, y0 + 0.5, lz - ox * sin + oz * cos, 0.09, 1.0, 0.09);
      });
    });
  }
  function table(parent, lx, lz, w, d, ry, st) {
    var g = new T.Group();
    V.bx(g, w, 0.22, d, V.color(C.wood), 0, 1.5, 0);
    V.bx(g, w - 1.2, 0.5, d - 1.2, V.color(C.woodDark), 0, 1.2, 0);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c) {
      V.cy(g, 0.16, 0.16, 1.4, V.color(C.woodDark), c[0] * (w / 2 - 0.9), 0.7, c[1] * (d / 2 - 0.9), 6);
    });
    g.position.set(lx, 0, lz); g.rotation.y = ry;
    parent.add(g);
    var wp = st.at(lx, lz);
    V.blockBox(wp.x, wp.z, w / 2, d / 2, st.ry + ry);
    return g;
  }
  function roundTable(parent, lx, lz, r, st) {
    var g = new T.Group();
    V.cy(g, r, r, 0.22, V.color(C.wood), 0, 1.5, 0, 18);
    V.cy(g, 0.4, 0.55, 1.4, V.color(C.woodDark), 0, 0.7, 0, 10);
    V.cy(g, 1.2, 1.2, 0.18, V.color(C.woodDark), 0, 0.1, 0, 12);
    g.position.set(lx, 0, lz); parent.add(g);
    var wp = st.at(lx, lz);
    V.blockCircle(wp.x, wp.z, r + 0.1);
    return g;
  }
  /* A blackboard with chalk on it. Given a structure and an id it becomes a
     board people can write on; the scrawl it starts with stays until the
     first person picks up the chalk. */
  function blackboard(parent, lx, lz, ry, w, h, st, id, name) {
    var g = new T.Group();
    V.bx(g, w + 0.6, h + 0.6, 0.25, V.color(C.woodDark), 0, h / 2 + 1.6, 0);
    var face = V.bx(g, w, h, 0.1, V.color(0x24302B), 0, h / 2 + 1.6, 0.16);
    /* chalk marks: a scrawled equation and a diagram */
    var seed = V.posterTex(Math.random() < 0.5 ? "feynman" : "equation", (lx * 31 + lz) | 0);
    var wp = st ? st.at(lx, lz) : null;
    var surface = (window.QVBoard && id) ? QVBoard.register({
      id: id, name: name || "the board", parent: g,
      w: w - 0.8, h: h - 0.7, ox: 0, oy: h / 2 + 1.6, oz: 0.24,
      wx: wp ? wp.x : null, wz: wp ? wp.z : null, seed: seed
    }) : null;
    if (!surface) {
      var chalk = new T.MeshBasicMaterial({ map: seed, transparent: true, opacity: 0.55, side: T.DoubleSide });
      V.panel(g, Math.min(w - 1, h * 1.2), h - 0.8, chalk, 0, h / 2 + 1.6, 0.24);
    }
    V.bx(g, w, 0.22, 0.5, V.color(C.wood), 0, 1.5, 0.3);
    g.position.set(lx, 0, lz); g.rotation.y = ry;
    parent.add(g);
    return { g: g, face: face, board: surface };
  }
  function shelfRun(parent, lx, lz, len, ry, st) {
    var cos = Math.cos(ry), sin = Math.sin(ry);
    function put(geo, mat, ox, y, oz, sx, sy, sz) {
      localAdd(st, geo, mat, lx + ox * cos + oz * sin, y, lz - ox * sin + oz * cos, sx, sy, sz, ry);
    }
    put(V.U.box(), V.color(C.woodDark), 0, 2.6, 0, len, 5.2, 1.4);
    var hues = [0x8C4A3C, 0x3E6A62, 0x8A7A3C, 0x4A5A7A, 0x6A4A6A];
    for (var s = 0; s < 4; s++) {
      for (var b = 0; b < Math.floor(len / 0.62); b++) {
        if (Math.random() < 0.14) continue;
        put(V.U.box(), V.color(hues[(s + b) % hues.length]),
          -len / 2 + 0.36 + b * 0.62, 1.2 + s * 1.2, 0.18, 0.4, 0.9 + Math.random() * 0.5, 1.0);
      }
    }
    var wp = st.at(lx, lz);
    V.blockBox(wp.x, wp.z, len / 2, 0.8, st.ry + ry);
  }
  function labBench(parent, lx, lz, w, ry, st) {
    var g = new T.Group();
    V.bx(g, w, 0.3, 2.4, V.color(0xD8DCD4), 0, 1.5, 0);
    V.bx(g, w - 0.6, 1.2, 2.0, V.color(0xB9C2C2), 0, 0.8, 0);
    for (var i = 0; i < Math.max(1, Math.round(w / 4)); i++) {
      var ox = -w / 2 + 2 + i * 4;
      V.bx(g, 1.1, 1.3, 1.1, V.color(0x8FA0A4), ox, 2.3, 0);
      V.cy(g, 0.28, 0.28, 1.8, V.color(0xB9C2C2), ox + 1.2, 2.5, 0.4, 8);
      V.bx(g, 0.9, 0.6, 0.12, V.litGlass(0x6FD0C4), ox, 2.5, 0.58);
    }
    g.position.set(lx, 0, lz); g.rotation.y = ry;
    parent.add(g);
    var wp = st.at(lx, lz);
    V.blockBox(wp.x, wp.z, w / 2, 1.3, st.ry + ry);
    return g;
  }
  function plant(parent, lx, lz) {
    var g = new T.Group();
    V.cy(g, 0.7, 0.55, 1.1, V.color(0xB07050), 0, 0.55, 0, 9);
    V.sp(g, 1.3, V.color(C.leaf), 0, 1.9, 0, 8);
    V.sp(g, 0.9, V.color(C.leafDark), 0.6, 2.5, 0.3, 7);
    g.position.set(lx, 0, lz); parent.add(g);
  }
  /* A desk with a lit screen — offices and control rooms. */
  function desk(parent, lx, lz, ry, st) {
    var g = new T.Group();
    V.bx(g, 3.4, 0.2, 1.8, V.color(C.wood), 0, 1.4, 0);
    V.bx(g, 0.2, 1.3, 1.6, V.color(C.woodDark), -1.5, 0.7, 0);
    V.bx(g, 0.2, 1.3, 1.6, V.color(C.woodDark), 1.5, 0.7, 0);
    V.bx(g, 1.6, 1.0, 0.1, V.litGlass(0x7FB8C8), 0, 2.1, -0.5);
    V.bx(g, 0.9, 0.06, 0.5, V.color(0xE8E2D2), 0, 1.53, 0.4);
    g.position.set(lx, 0, lz); g.rotation.y = ry;
    parent.add(g);
    var wp = st.at(lx, lz);
    V.blockBox(wp.x, wp.z, 1.7, 0.9, st.ry + ry);
    chair(st, lx + Math.sin(ry) * 1.9, lz + Math.cos(ry) * 1.9, ry + Math.PI);
  }

  /* ------------------------------------------------- interactive papers */
  function paperSpot(x, z, ry, where) {
    V.PAPER_SPOTS.push({ x: x, z: z, ry: ry, where: where });
  }

  /* The wall opposite the main door, in local coordinates. Anything solid
     and wide — a reception desk, a café counter — belongs against this wall,
     never across the way in. */
  function backWall(b, inset) {
    var side = (b.doors && b.doors[0] && b.doors[0].side) || "s";
    inset = inset || 3;
    if (side === "s") return { lx: 0, lz: -b.d / 2 + inset, ry: 0, along: "x", len: b.w };
    if (side === "n") return { lx: 0, lz: b.d / 2 - inset, ry: Math.PI, along: "x", len: b.w };
    if (side === "e") return { lx: -b.w / 2 + inset, lz: 0, ry: Math.PI / 2, along: "z", len: b.d };
    return { lx: b.w / 2 - inset, lz: 0, ry: -Math.PI / 2, along: "z", len: b.d };
  }

  /* ======================================================== room fitting
   * Fills a finished structure with the furniture its kind implies and
   * registers seats, a stage and paper spots. */
  /* ------------------------------------------------------- room character
   *
   * fitRoom lays out the furniture a room needs to *work* — the seats a
   * claim can be made on, the stage, the board. This decides what it looks
   * like, and it has to differ from room to room: three identical seminar
   * rooms in a row are three rooms nobody can tell apart, and "which one am
   * I in?" is exactly what a room ought to answer by itself.
   *
   * Everything here is deterministic in the building id, so a room looks the
   * same to everybody and the same on every reload, and every piece is a
   * scaled unit primitive sharing the cached materials. */
  var THEMES = [
    { floor:0xC8B08A, rug:0x7C3B33, wood:0x8A5F3A, accent:0x2E6E62, name:"oak"    },
    { floor:0xBFC6B4, rug:0x2F5D62, wood:0x6E4B30, accent:0x9A5A2E, name:"sage"   },
    { floor:0xD6C4A4, rug:0x4A4370, wood:0x9C7448, accent:0xC08A3A, name:"amber"  },
    { floor:0xB9BDC2, rug:0x3B5A44, wood:0x5E4630, accent:0x4A6FA8, name:"slate"  },
    { floor:0xD9CDAF, rug:0x8A4A5A, wood:0x7A5836, accent:0x6A8A4A, name:"linen"  },
    { floor:0xC2B49C, rug:0x35545E, wood:0x86613E, accent:0xB05A3C, name:"clay"   }
  ];

  /* A small stable hash, so "seminar-2" always lands on the same theme. */
  function idHash(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function themeOf(b) { return THEMES[idHash(b.id) % THEMES.length]; }
  V.themeOf = themeOf;

  function rug(g, st, lx, lz, w, d, colour) {
    V.slab(g, w, d, V.color(colour), lx, 0.38, lz);
    V.slab(g, w - 1.4, d - 1.4, V.color(new T.Color(colour).multiplyScalar(1.22).getHex()),
           lx, 0.39, lz);
  }

  function bookcase(g, st, lx, lz, len, ry, woodC) {
    var wood = V.color(woodC), spines = [0x8A3B33, 0x2E5A66, 0xC08A3A, 0x4A6FA8, 0x5A8A4A];
    var cos = Math.cos(ry), sin = Math.sin(ry);
    function put(ox, y, oz, sx, sy, sz, mat) {
      V.bx(g, sx, sy, sz, mat, lx + ox * cos + oz * sin, y, lz - ox * sin + oz * cos, ry);
    }
    put(0, 1.9, 0, len, 3.8, 0.5, wood);                    /* carcass */
    /* Books go on as four blocks a shelf rather than forty spines. At this
       distance the eye reads bands of colour either way, and sixteen boxes
       a case is the difference between a bookcase and a frame-rate. */
    for (var shelf = 0; shelf < 4; shelf++) {
      put(0, 0.7 + shelf * 0.9, 0.16, len - 0.3, 0.08, 0.5, wood);
      var blocks = 4, run = (len - 0.8) / blocks;
      for (var bk = 0; bk < blocks; bk++) {
        put(-len / 2 + 0.4 + run * (bk + 0.5), 1.05 + shelf * 0.9, 0.18,
            run - 0.12, 0.62, 0.34, V.color(spines[(bk + shelf) % spines.length]));
      }
    }
    var wp = st.at(lx, lz);
    V.blockBox(wp.x, wp.z, len / 2, 0.4, st.ry + ry);
  }

  /* Built facing +Z in its own group, then turned to face into the room —
     otherwise a clock on an east wall is a disc seen edge-on. */
  function wallClock(g, lx, ly, lz, ry) {
    var c = new T.Group();
    c.position.set(lx, ly, lz);
    c.rotation.y = ry;
    g.add(c);
    V.cy(c, 0.68, 0.68, 0.08, V.color(0x3A2E24), 0, 0, -0.04, 14).rotation.x = Math.PI / 2;
    V.cy(c, 0.62, 0.62, 0.12, V.color(0xF2EDE0), 0, 0, 0, 14).rotation.x = Math.PI / 2;
    V.bx(c, 0.05, 0.36, 0.04, V.color(0x2A2118), 0, 0.14, 0.09);
    V.bx(c, 0.26, 0.05, 0.04, V.color(0x2A2118), 0.11, 0, 0.09);
  }

  function pendant(g, lx, ly, lz, shade) {
    V.cy(g, 0.02, 0.02, 1.2, V.color(0x3A3A36), lx, ly + 0.6, lz, 5);
    var cone = new T.Mesh(V.U.cone(12), V.color(shade));
    cone.scale.set(0.8, 0.7, 0.8);
    cone.rotation.x = Math.PI;              /* a shade opens downwards */
    cone.position.set(lx, ly - 0.2, lz);
    g.add(cone);
    V.sp(g, 0.16, V.litLamp(0xF6EAC8, 0xFFDFA4), lx, ly - 0.42, lz, 8);
  }

  function sideTable(g, st, lx, lz, woodC, accent) {
    V.cy(g, 0.7, 0.7, 0.14, V.color(woodC), lx, 1.5, lz, 12);
    V.cy(g, 0.12, 0.16, 1.45, V.color(woodC), lx, 0.73, lz, 8);
    V.cy(g, 0.5, 0.5, 0.07, V.color(0x3A2E24), lx, 0.05, lz, 10);
    /* a pot of coffee and two cups: the true infrastructure of research */
    V.cy(g, 0.20, 0.24, 0.42, V.color(0xC9CDC8), lx - 0.18, 1.78, lz, 10);
    V.cy(g, 0.10, 0.10, 0.16, V.color(accent), lx + 0.22, 1.65, lz + 0.14, 8);
    V.cy(g, 0.10, 0.10, 0.16, V.color(accent), lx + 0.20, 1.65, lz - 0.18, 8);
    var wp = st.at(lx, lz);
    V.blockCircle(wp.x, wp.z, 0.9);
  }

  function framed(g, lx, ly, lz, ry, kind, seed, w, h) {
    V.bx(g, w + 0.28, h + 0.28, 0.14, V.color(0x4A3421), lx, ly, lz, ry);
    V.panel(g, w, h, new T.MeshBasicMaterial({ map: V.posterTex(kind, seed), side: T.DoubleSide }),
            lx + Math.sin(ry) * 0.1, ly, lz + Math.cos(ry) * 0.1, ry);
  }

  /* The one entry point. Called at the end of fitRoom for every building. */
  function dressRoom(st, b) {
    var g = st.group;
    var th = themeOf(b);
    var h = idHash(b.id);
    var hw = b.w / 2, hd = b.d / 2;
    var doorSide = (b.doors[0] || {}).side || "s";

    /* ---- a rug, sized and placed for the kind of room it is ---- */
    if ((b.kind === "seminar" && !b.hall) || b.kind === "discussion" || b.kind === "common" ||
        b.kind === "offices" || b.kind === "cafe") {
      rug(g, st, 0, 0, Math.min(b.w - 7, 16), Math.min(b.d - 7, 13), th.rug);
    }

    /* ---- pendant lighting in the accent colour, over the working area ---- */
    if (b.h < 13 && b.kind !== "station") {
      var lamps = b.w > 40 ? 3 : (b.w > 26 ? 2 : 1);
      for (var li = 0; li < lamps; li++) {
        var lx = lamps === 1 ? 0 : -b.w * 0.24 + li * (b.w * 0.48 / (lamps - 1));
        pendant(g, lx, b.h - 1.5, 0, th.accent);
      }
    }

    /* ---- something on the walls that is not the same in two rooms ---- */
    var artKinds = ["feynman", "spectrum", "sky", "detector", "equation"];
    var free = { s: doorSide !== "s", n: doorSide !== "n", e: doorSide !== "e", w: doorSide !== "w" };
    var placed = 0;
    ["n", "s", "e", "w"].forEach(function (side, si) {
      if (!free[side] || placed >= 3) return;
      /* keep clear of the blackboard wall, wherever fitRoom put it */
      if (b.hall) { if (side === "n" || side === "s") return; }
      else if ((b.kind === "seminar" || b.kind === "lecture") && (side === "e" || side === "w")) return;
      if (b.kind === "discussion" && side === "n") return;
      if ((b.kind === "poster" || b.kind === "poster2") && (side === "n" || side === "s")) return;
      var kind = artKinds[(h + si) % artKinds.length];
      var ly = Math.min(b.h * 0.55, 5.2);
      if (side === "n") framed(g, (h % 7) - 3, ly, -hd + 0.5, 0, kind, h + si, 2.6, 3.2);
      else if (side === "s") framed(g, (h % 5) - 2, ly, hd - 0.5, Math.PI, kind, h + si, 2.6, 3.2);
      else if (side === "e") framed(g, hw - 0.5, ly, (h % 5) - 2, -Math.PI / 2, kind, h + si, 2.6, 3.2);
      else framed(g, -hw + 0.5, ly, (h % 7) - 3, Math.PI / 2, kind, h + si, 2.6, 3.2);
      placed++;
    });

    /* ---- a clock, on whichever wall the door is in, where people look ---- */
    if (b.h >= 8 && b.kind !== "poster2") {
      var cy2 = Math.min(b.h - 1.6, 6.4);
      if (doorSide === "s") wallClock(g, hw - 3.2, cy2, hd - 0.42, Math.PI);
      else if (doorSide === "n") wallClock(g, hw - 3.2, cy2, -hd + 0.42, 0);
      else if (doorSide === "e") wallClock(g, hw - 0.42, cy2, hd - 3.2, -Math.PI / 2);
      else wallClock(g, -hw + 0.42, cy2, hd - 3.2, Math.PI / 2);
    }

    /* ---- the furnishing that gives each kind its own character ---- */
    if (b.kind === "seminar" && b.hall) {
      /* A hall is furnished by what fifty people need and nothing else:
         water and glasses at the back where they come in, and a pair of
         plants at the front flanking the slate. No bookcase — the wall it
         would stand against is the one everybody is looking at. */
      var backZ = ((b.doors[0] || {}).side === "n") ? -1 : 1;
      sideTable(g, st, -hw + 3.6, backZ * (hd - 3.6), th.wood, th.accent);
      sideTable(g, st, hw - 3.6, backZ * (hd - 3.6), th.wood, th.accent);
      plant(g, -hw + 3.0, -backZ * (hd - 3.0));
      plant(g, hw - 3.0, -backZ * (hd - 3.0));

    } else if (b.kind === "seminar") {
      /* every seminar room gets books, on the wall the door is in */
      var bl = Math.min(b.d - 8, 11);
      if (doorSide === "e") bookcase(g, st, -1.5, -hd + 0.6, bl, 0, th.wood);
      else bookcase(g, st, 1.5, hd - 0.6, bl, Math.PI, th.wood);
      sideTable(g, st, hw - 2.6, hd - 2.6, th.wood, th.accent);

    } else if (b.kind === "discussion") {
      /* a small room: an armchair corner and a pinboard rather than shelves */
      sideTable(g, st, -hw + 2.6, hd - 2.6, th.wood, th.accent);
      V.bx(g, 1.5, 1.0, 1.5, V.color(th.rug), hw - 2.8, 0.88, hd - 2.8);
      V.bx(g, 1.5, 1.3, 0.3, V.color(th.rug), hw - 2.8, 1.6, hd - 2.1);
      V.bx(g, 5.2, 3.2, 0.16, V.color(0x8A7048), -hw + 0.55, 4.4, 0, -Math.PI / 2);

    } else if (b.kind === "lecture") {
      var dirS = doorSide === "e" ? -1 : 1;
      /* a wall of water jugs and a bin by the door, because lectures are long */
      V.cy(g, 0.5, 0.5, 2.6, V.color(0xB9C2C2), -dirS * (hw - 3), 1.3, hd - 3, 10);

    } else if (b.kind === "library") {
      /* reading lamps down the central table, and a card catalogue */
      for (var lt = 0; lt < 4; lt++) {
        var lz2 = 1 + lt * 3.4;
        V.cy(g, 0.1, 0.14, 0.9, V.color(0x3A3A36), 0, 2.85, lz2, 8);
        V.sp(g, 0.28, V.litLamp(0x2E5A66, 0xFFE2AE), 0, 3.45, lz2, 8);
      }
      bookcase(g, st, -hw + 6, -hd + 0.7, 14, 0, th.wood);
      bookcase(g, st, hw - 6, -hd + 0.7, 14, 0, th.wood);

    } else if (b.kind === "cafe") {
      /* a counter is already there; this is the rest of a café */
      V.bx(g, 1.4, 1.6, 0.9, V.color(0x6E7370), -hw + 3, 3.4, -hd + 1.2);   /* machine */
      V.bx(g, 2.6, 0.12, 0.7, V.color(th.wood), hw - 2.2, 3.0, -hd + 1.1);  /* shelf */
      for (var cj = 0; cj < 4; cj++) {
        V.cy(g, 0.16, 0.16, 0.34, V.color(0xF2EDE0), hw - 3.2 + cj * 0.6, 3.25, -hd + 1.1, 8);
      }
      V.bx(g, 0.9, 1.2, 0.9, V.color(th.accent), hw - 2.4, 0.95, hd - 2.4);  /* plant pot */

    } else if (b.kind === "offices") {
      /* every office door gets a name card and a pinboard over the desk */
      var cells2 = Math.max(2, Math.floor(b.w / 16));
      for (var o2 = 0; o2 < cells2; o2++) {
        var ox2 = -hw + (o2 + 0.5) * (b.w / cells2);
        V.bx(g, 3.6, 2.4, 0.14, V.color(0x8A7048), ox2, 5.0, -hd + 0.55);
        V.bx(g, 0.4, 1.1, 0.4, V.color(0x3F7A42), ox2 + 2.4, 3.2, -hd + 2.2);
      }

    } else if (b.kind === "lab") {
      /* gas bottles, a fume hood and a whiteboard of half-erased algebra */
      [-1, 1].forEach(function (sg) {
        V.cy(g, 0.36, 0.36, 3.2, V.color(sg > 0 ? 0x9A5A2E : 0x2E6E62), -hw + 3, 1.6, sg * 5, 10);
      });
      V.bx(g, 5.0, 4.4, 2.0, V.color(0xC9CDC8), hw - 4, 2.2, -hd + 2.4);
      V.bx(g, 4.4, 3.0, 0.2, V.litGlass(0xBFE0DC), hw - 4, 3.0, -hd + 1.35);
      V.bx(g, 8.0, 3.4, 0.14, V.color(0xF4F1E6), 0, 5.0, -hd + 0.52);

    } else if (b.kind === "common") {
      /* the Fellows' room: a fireplace, armchairs and a newspaper rack */
      V.bx(g, 4.4, 3.4, 1.0, V.color(0xB8ADA0), 0, 1.7, -hd + 0.8);
      V.bx(g, 2.4, 1.8, 0.4, V.color(0x2A2118), 0, 0.9, -hd + 1.25);
      V.bx(g, 5.2, 0.3, 1.3, V.color(th.wood), 0, 3.5, -hd + 0.9);
      [-1, 1].forEach(function (sg2) {
        V.bx(g, 1.7, 1.0, 1.7, V.color(th.rug), sg2 * 4.4, 0.9, -hd + 4.4);
        V.bx(g, 1.7, 1.4, 0.35, V.color(th.rug), sg2 * 4.4, 1.7, -hd + 5.2);
      });

    } else if (b.kind === "university" || b.kind === "institute") {
      /* a lobby wants a departure-board-sized notice and something planted */
      V.bx(g, 9.0, 4.0, 0.2, V.color(0x1B2320), 0, 6.4, -hd + 0.5);
      V.panel(g, 8.4, 3.4, new T.MeshBasicMaterial({
        map: V.signTex(b.name, b.sub || "welcome"), side: T.DoubleSide
      }), 0, 6.4, -hd + 0.65, 0);
      [-1, 1].forEach(function (sg3) {
        V.cy(g, 0.8, 0.9, 1.1, V.color(th.accent), sg3 * (hw - 6), 0.55, hd - 6, 10);
        V.sp(g, 1.5, V.color(0x3F7A42), sg3 * (hw - 6), 2.2, hd - 6, 8);
      });

    } else if (b.kind === "poster" || b.kind === "poster2") {
      /* Refreshments: the other half of a poster session. Against the east
         wall rather than by the door, where it was the first thing anybody
         walked into on the way in. */
      var rx2 = hw - 4;
      V.bx(g, 1.6, 0.16, 6.0, V.color(0xF2EDE0), rx2, 2.3, 0);
      V.bx(g, 1.6, 2.2, 6.0, V.color(th.rug), rx2, 1.15, 0);
      for (var gl = 0; gl < 7; gl++) {
        V.cy(g, 0.11, 0.09, 0.26, V.color(0xCFE0DC), rx2, 2.52, -2.4 + gl * 0.8, 7);
      }
      var tp = st.at(rx2, 0);
      V.blockBox(tp.x, tp.z, 0.9, 3.0, st.ry);

    } else if (b.kind === "station") {
      /* a coffee kiosk and a departures clock; stations are all waiting */
      V.bx(g, 4.6, 2.8, 2.2, V.color(th.wood), -hw + 6, 1.4, hd - 3);
      V.bx(g, 5.0, 0.3, 2.6, V.color(th.accent), -hw + 6, 2.95, hd - 3);
      var kp = st.at(-hw + 6, hd - 3);
      V.blockBox(kp.x, kp.z, 2.4, 1.2, st.ry);
    }
  }

  function fitRoom(st, b) {
    var g = st.group;
    var room = null;
    var seats = [], stage = null, board = null;

    if (b.kind === "seminar" && b.hall) {
      /* ------------------------------------------------ a hall for fifty
       *
       * One thing decides this room, and it is the slate: forty metres of
       * it across the wall opposite the door, four storeys of hall above it
       * so it can be fourteen metres tall. Everything else exists to be
       * pointed at it — five tiers rising half a metre a row so nobody
       * reads it past the head in front, ten chairs a tier all turned the
       * same way, and an aisle up the middle from the door to the dais.
       * Five tens is fifty, which is the number the hall is for. */
      var thH = themeOf(b);
      var dirH = ((b.doors[0] || {}).side === "n") ? 1 : -1;   /* which way the board wall lies */
      var hwH = b.w / 2, hdH = b.d / 2;
      var zBoard = dirH * (hdH - 0.9);

      board = blackboard(g, 0, zBoard, dirH < 0 ? 0 : Math.PI, 40, 14, st, b.id, b.name);

      /* a dais, so a presenter stands above the front row rather than in it */
      var zDais = zBoard - dirH * 5.4;
      V.bx(g, b.w - 14, 0.8, 8.6, V.color(thH.wood), 0, 0.4, zDais);
      V.bx(g, b.w - 14, 0.34, 0.5, V.color(C.woodDark), 0, 0.86, zDais - dirH * 4.3);

      /* The lectern goes off to one side. In front of the slate it would be
         a lectern-shaped hole in every slide that went up behind it. */
      var lecX = -hwH + 11;
      V.bx(g, 2.4, 0.3, 1.5, V.color(C.wood), lecX, 3.35, zDais);
      V.bx(g, 1.6, 2.6, 1.1, V.color(C.woodDark), lecX, 2.1, zDais);
      var lecW = st.at(lecX, zDais);
      V.blockBox(lecW.x, lecW.z, 1.2, 0.8, st.ry);

      /* Fifty chairs. Every one of them takes the same `seatRy`, which is
         what "all the chairs face the board" means in code. */
      var colX = [-26, -21, -16, -11, -6, 6, 11, 16, 21, 26];
      var seatRy = dirH > 0 ? 0 : Math.PI;
      for (var tr = 0; tr < 5; tr++) {
        var rowZ = zBoard - dirH * (15 + tr * 6.2);
        var rise = tr * 0.55;
        if (rise > 0) {
          /* the step the row stands on, and a nosing on its front edge */
          V.bx(g, b.w - 5, rise, 6.2, V.color(0xC9BFA6), 0, rise / 2, rowZ);
          V.bx(g, b.w - 5, 0.14, 0.34, V.color(C.woodDark), 0, rise, rowZ + dirH * 3.1);
        }
        for (var cx2 = 0; cx2 < colX.length; cx2++) {
          seats.push(seatAt(g, st, colX[cx2], rowZ, seatRy, rise, rise));
        }
      }

      stage = st.at(5.5, zDais);
      stage.ry = st.ry + (dirH > 0 ? 0 : Math.PI);

      /* The slate is also the screen. Telling the slide system about the
         hall here means a hall only ever has to be declared once, in
         BUILDINGS, for both the chairs and the projector to exist. */
      if (window.QVSlides) {
        QVSlides.registerHall({ id: b.id, name: b.name, board: b.id, x: b.x, z: b.z });
      }

      /* papers by the door, where people come in, not up on the dais */
      var paA = st.at(-20, -dirH * (hdH - 5));
      paperSpot(paA.x, paA.z, st.ry, b.id);
      var paB = st.at(20, -dirH * (hdH - 5));
      paperSpot(paB.x, paB.z, st.ry, b.id);

    } else if (b.kind === "seminar") {
      /* a long table down the middle, chairs either side, board on the
         wall opposite the door */
      var doorSide = b.doors[0].side;
      var boardLx = doorSide === "e" ? -b.w / 2 + 0.9 : b.w / 2 - 0.9;
      var boardRy = doorSide === "e" ? Math.PI / 2 : -Math.PI / 2;
      board = blackboard(g, boardLx, 0, boardRy, 14, 5.2, st, b.id, b.name);
      table(g, 1.5 * (doorSide === "e" ? 1 : -1), 0, 10, 5, Math.PI / 2, st);
      var tx = 1.5 * (doorSide === "e" ? 1 : -1);
      for (var i = 0; i < 4; i++) {
        var lz = -5.6 + i * 3.7;
        seats.push(seatAt(g, st, tx - 4.4, lz, Math.PI / 2));
        seats.push(seatAt(g, st, tx + 4.4, lz, -Math.PI / 2));
      }
      stage = st.at(boardLx + (doorSide === "e" ? 4.2 : -4.2), 0);
      stage.ry = st.ry + boardRy + Math.PI;
      plant(g, b.w / 2 - 2.4, -b.d / 2 + 2.4);
      noticeInside(g, b, -b.w / 2 + 1.2, b.d / 2 - 4);
      var ps = st.at(tx, 6.2); paperSpot(ps.x, ps.z, st.ry, b.id);

    } else if (b.kind === "discussion") {
      roundTable(g, 0, 0, 3.0, st);
      for (var k = 0; k < 5; k++) {
        var a = (k / 5) * Math.PI * 2 + 0.6;
        seats.push(seatAt(g, st, Math.sin(a) * 5.0, Math.cos(a) * 5.0, a + Math.PI));
      }
      board = blackboard(g, 0, -b.d / 2 + 0.9, 0, 9, 4.2, st, b.id, b.name);
      plant(g, b.w / 2 - 2.2, b.d / 2 - 2.2);
      stage = st.at(0, -b.d / 2 + 4.2); stage.ry = st.ry;

    } else if (b.kind === "poster") {
      /* A hall you hold a poster session in: boards down both long walls,
         benches through the middle so a crowd can sit while somebody talks
         at a board, and plenty of floor left to stand about on. */
      var cols = 6;
      var span = b.w - 16;
      for (var pi = 0; pi < cols; pi++) {
        var lx2 = -span / 2 + (span / (cols - 1)) * pi;
        [-1, 1].forEach(function (sideZ, si) {
          var lz2 = sideZ * (b.d / 2 - 0.9);
          var ry2 = sideZ > 0 ? Math.PI : 0;
          var wp2 = st.at(lx2, lz2);
          var pid = b.id + "-" + (si ? "s" : "n") + (pi + 1);
          /* the board it hangs on */
          V.bx(g, 11, 7.6, 0.4, V.color(C.woodDark), lx2, 5.0, lz2 - sideZ * 0.3, ry2);
          var made = window.QVPosters && QVPosters.register({
            id: pid, name: "poster board " + (pi + 1) + (si ? " (south wall)" : " (north wall)"),
            parent: g, w: 10.2, h: 6.9, ox: lx2, oy: 5.0, oz: lz2 - sideZ * 0.62, ry: ry2,
            wx: wp2.x, wz: wp2.z, hallId: b.id, num: si * cols + pi + 1
          });
          if (!made) V.bx(g, 10.2, 6.9, 0.1, V.color(0xE7E0CE), lx2, 5.0, lz2 - sideZ * 0.62, ry2);
        });
      }
      /* two rows of benches back to back down the spine */
      for (var bi = 0; bi < 8; bi++) {
        var bx2 = -b.w / 2 + 12 + bi * ((b.w - 24) / 7);
        seats.push(seatAt(g, st, bx2, -3.0, 0));
        seats.push(seatAt(g, st, bx2, 3.0, Math.PI));
      }
      board = blackboard(g, -b.w / 2 + 0.9, 0, Math.PI / 2, 12, 5.0, st, b.id, b.name);
      stage = st.at(-b.w / 2 + 5.4, 0); stage.ry = st.ry + Math.PI / 2 + Math.PI;
      plant(g, b.w / 2 - 3, -b.d / 2 + 3);
      plant(g, b.w / 2 - 3, b.d / 2 - 3);
      noticeInside(g, b, b.w / 2 - 1.2, 0);

      /* The winner is a freestanding outdoor display, beyond the south door. */
      /* Offset it to the outside-right of the entrance, well clear of the path. */
      var winnerPos = st.at(17, b.d / 2 + 12.0);
      var standMat = V.color(C.woodDark);
      [-4.7, 4.7].forEach(function (sx) {
        V.cy(V.root, 0.18, 0.18, 5.0, standMat, winnerPos.x + sx, 2.5, winnerPos.z, 8);
      });
      V.bx(V.root, 13.0, 0.28, 0.35, standMat, winnerPos.x, 8.55, winnerPos.z);
      V.panel(V.root, 12.4, 1.1,
        new T.MeshBasicMaterial({ map: V.signTex("BEST POSTER", "most liked research") , side: T.DoubleSide }),
        winnerPos.x, 9.4, winnerPos.z - 0.2, 0);
      window.QVPosters && QVPosters.register({
        id: b.id + "-winner", name: "BEST POSTER", parent: V.root,
        w: 12, h: 7, ox: winnerPos.x, oy: 4.8, oz: winnerPos.z, ry: 0,
        wx: winnerPos.x, wz: winnerPos.z + 2.5, displayOnly: true, hallId: b.id
      });
      V.blockBox(winnerPos.x, winnerPos.z, 6.5, 0.4, 0);

    } else if (b.kind === "poster2") {
      /* The Grand Poster Hall — 50 poster boards in a large exhibition space.
         Layout: 10 boards on each long wall (north / south), plus 3 double-sided
         aisles through the interior (Aisle A, B, C) with 5 stands per side
         = 10 per aisle = 30 aisle boards. 20 + 30 = 50 total. */

      /* ---- 20 wall boards (10 per long wall, 5 west of door and 5 east of door) ---- */
      var wallXs = [-50, -40.5, -31, -21.5, -12, 12, 21.5, 31, 40.5, 50];
      for (var pwi = 0; pwi < wallXs.length; pwi++) {
        var wlx = wallXs[pwi];
        [-1, 1].forEach(function (sideZ, si) {
          var wlz = sideZ * (b.d / 2 - 0.9);
          var wry = sideZ > 0 ? Math.PI : 0;
          var wwp = st.at(wlx, wlz - sideZ * 2.2);
          var wpid = b.id + "-w" + (si ? "s" : "n") + (pwi + 1);
          V.bx(g, 8.8, 7.0, 0.4, V.color(C.woodDark), wlx, 5.0, wlz - sideZ * 0.3, wry);
          var wmade = window.QVPosters && QVPosters.register({
            id: wpid, name: "Wall board " + (pwi + 1) + (si ? " (south wall)" : " (north wall)"),
            parent: g, w: 8.2, h: 6.4, ox: wlx, oy: 5.0, oz: wlz - sideZ * 0.62, ry: wry,
            wx: wwp.x, wz: wwp.z, hallId: b.id, num: si * wallXs.length + pwi + 1
          });
          if (!wmade) V.bx(g, 8.2, 6.4, 0.1, V.color(0xE7E0CE), wlx, 5.0, wlz - sideZ * 0.62, wry);
        });
      }

      /* ---- 30 aisle boards (3 aisles × 5 double-sided easel stands) ---- */
      var aisles = 3;
      var aisleStands = 5;
      var aisleZones = [-b.d / 4, 0, b.d / 4];     /* Aisle A (z=-18), B (z=0), C (z=+18) */
      var aisleNames = ["A", "B", "C"];
      /* No stand on the centre line: that is the lane in from the south
         door, and a double-sided easel parked across it made the hall
         genuinely hard to walk into. Still five stands an aisle, so the
         hall still carries its fifty boards. */
      var aisleXs = [-46, -27, -12, 12, 27];
      for (var ai = 0; ai < aisles; ai++) {
        var aisleZ = aisleZones[ai];
        for (var asi = 0; asi < aisleStands; asi++) {
          var alx = aisleXs[asi];

          /* Each stand is a sturdy free-standing double-sided exhibition easel/partition */
          /* Two vertical posts with stabilizer feet on the floor */
          [-4.0, 4.0].forEach(function (legX) {
            V.bx(g, 0.36, 7.6, 0.44, V.color(C.woodDark), alx + legX, 3.8, aisleZ);
            V.bx(g, 0.6, 0.22, 1.8, V.color(C.woodDark), alx + legX, 0.11, aisleZ);
          });
          /* Top and bottom frame crossbars */
          V.bx(g, 8.6, 0.34, 0.44, V.color(C.woodDark), alx, 7.45, aisleZ);
          V.bx(g, 8.6, 0.24, 0.44, V.color(C.woodDark), alx, 0.95, aisleZ);
          /* Solid dark backing board for both poster faces */
          V.bx(g, 8.0, 6.4, 0.32, V.color(C.woodDark), alx, 4.2, aisleZ);

          /* Collision box so players walk around the easel */
          var cwp = st.at(alx, aisleZ);
          V.blockBox(cwp.x, cwp.z, 4.3, 0.5, st.ry);

          /* Double-sided posters: one facing South (+Z), one facing North (-Z) */
          [-1, 1].forEach(function (face, fi) {
            var apid = b.id + "-" + aisleNames[ai] + (asi + 1) + (fi ? "b" : "f");
            var aFaceZ = aisleZ + face * 0.18;
            /* Three.js PlaneGeometry normal is local +Z.
               When face = 1 (South face), ry = 0 points normal in +Z (South toward viewer).
               When face = -1 (North face), ry = Math.PI points normal in -Z (North toward viewer). */
            var aRy = face > 0 ? 0 : Math.PI;
            var awp = st.at(alx, aisleZ + face * 2.2);
            var standName = "Aisle " + aisleNames[ai] + " stand " + (asi + 1) + (face > 0 ? " (south face)" : " (north face)");
            var amade = window.QVPosters && QVPosters.register({
              id: apid, name: standName,
              parent: g, w: 7.6, h: 5.8, ox: alx, oy: 4.2, oz: aFaceZ, ry: aRy,
              wx: awp.x, wz: awp.z, hallId: b.id,
              num: 2 * wallXs.length + ai * aisleStands * 2 + asi * 2 + fi + 1
            });
            if (!amade) V.bx(g, 7.6, 5.8, 0.08, V.color(0xE7E0CE), alx, 4.2, aFaceZ, aRy);
          });
        }
      }

      /* ---- benches between the aisles ---- */
      for (var bbi = 0; bbi < 6; bbi++) {
        var bbx = -b.w / 2 + 18 + bbi * ((b.w - 36) / 5);
        seats.push(seatAt(g, st, bbx, -b.d / 8, 0));
        seats.push(seatAt(g, st, bbx, b.d / 8, Math.PI));
      }

      /* ---- blackboard on the west wall ---- */
      board = blackboard(g, -b.w / 2 + 0.9, 0, Math.PI / 2, 14, 5.0, st, b.id, b.name);
      stage = st.at(-b.w / 2 + 5.4, 0); stage.ry = st.ry + Math.PI / 2 + Math.PI;
      noticeInside(g, b, b.w / 2 - 1.2, 0);

      /* ---- outdoor BEST POSTER display for Grand Poster Hall ---- */
      var winnerPos2 = st.at(20, b.d / 2 + 14.0);
      var standMat2 = V.color(C.woodDark);
      [-4.7, 4.7].forEach(function (sx) {
        V.cy(V.root, 0.18, 0.18, 5.0, standMat2, winnerPos2.x + sx, 2.5, winnerPos2.z, 8);
      });
      V.bx(V.root, 13.0, 0.28, 0.35, standMat2, winnerPos2.x, 8.55, winnerPos2.z);
      V.panel(V.root, 12.4, 1.1,
        new T.MeshBasicMaterial({ map: V.signTex("BEST POSTER", "most liked research"), side: T.DoubleSide }),
        winnerPos2.x, 9.4, winnerPos2.z - 0.2, 0);
      window.QVPosters && QVPosters.register({
        id: b.id + "-winner", name: "BEST POSTER", parent: V.root,
        w: 12, h: 7, ox: winnerPos2.x, oy: 4.8, oz: winnerPos2.z, ry: 0,
        wx: winnerPos2.x, wz: winnerPos2.z + 2.5, displayOnly: true, hallId: b.id
      });
      V.blockBox(winnerPos2.x, winnerPos2.z, 6.5, 0.4, 0);

    } else if (b.kind === "lecture") {
      var side = b.doors[0].side;                 /* e or w */
      var dir = side === "e" ? -1 : 1;            /* board on the far wall */
      board = blackboard(g, dir * (b.w / 2 - 0.9), 0, dir > 0 ? -Math.PI / 2 : Math.PI / 2, 22, 6, st, b.id, b.name);
      /* lectern */
      V.bx(g, 1.8, 0.3, 1.2, V.color(C.wood), dir * (b.w / 2 - 5), 2.6, 3.2);
      V.bx(g, 1.2, 2.4, 0.9, V.color(C.woodDark), dir * (b.w / 2 - 5), 1.3, 3.2);
      /* three tiered rows of benches, low enough to walk over */
      for (var r = 0; r < 3; r++) {
        var lx = dir * (b.w / 2 - 12 - r * 8);
        V.bx(g, 5.4, 0.9 + r * 0.7, b.d - 8, V.color(0xC9BFA6), lx, (0.9 + r * 0.7) / 2, 0);
        V.bx(g, 1.2, 0.22, b.d - 9, V.color(C.wood), lx - dir * 1.4, 1.5 + r * 0.7, 0);
        for (var s = 0; s < 4; s++) {
          var lz2 = -(b.d - 12) / 2 + s * ((b.d - 12) / 3);
          seats.push(seatAt(g, st, lx + dir * 1.0, lz2, dir > 0 ? -Math.PI / 2 : Math.PI / 2, 1.0 + r * 0.7));
        }
      }
      stage = st.at(dir * (b.w / 2 - 5), -3.5); stage.ry = st.ry + (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      noticeInside(g, b, 0, -b.d / 2 + 1.1);
      var lp = st.at(dir * (b.w / 2 - 6), 6); paperSpot(lp.x, lp.z, st.ry, b.id);

    } else if (b.kind === "library") {
      /* short stacks either side of a central aisle, with room to walk
         between every pair of rows */
      /* stacks pushed out to leave room for the reading table and its chairs */
      for (var sh = 0; sh < 4; sh++) {
        var zz = -b.d / 2 + 8 + sh * 8.5;
        shelfRun(g, -b.w / 2 + 20, zz, 16, 0, st);
        shelfRun(g, b.w / 2 - 20, zz, 16, 0, st);
      }
      /* The reading table used to sit dead on the centre line, which is
         also the line you walk in along. It is now off to one side, with
         the aisle from the door left clear all the way to the back. */
      table(g, 6.5, 5, 5, 14, 0, st);
      for (var lt = 0; lt < 4; lt++) {
        seats.push(seatAt(g, st, 2.1, lt * 3.4, Math.PI / 2));
        seats.push(seatAt(g, st, 10.9, lt * 3.4, -Math.PI / 2));
      }
      plant(g, -b.w / 2 + 4, b.d / 2 - 4);
      plant(g, b.w / 2 - 4, b.d / 2 - 4);
      noticeInside(g, b, -20, -b.d / 2 + 1.1);
      noticeInside(g, b, 20, -b.d / 2 + 1.1);

    } else if (b.kind === "lab") {
      /* The front bench runs the width of the room, and on a lab whose door
         is in that wall it ran straight across the entrance. Two benches
         with a gangway between them, which is how a real bench room is laid
         out anyway. */
      var frontLen = (b.w - 18) / 2 - 7;
      var frontOff = 7 + frontLen / 2;
      labBench(g, -frontOff, -b.d / 2 + 7, frontLen, 0, st);
      labBench(g, frontOff, -b.d / 2 + 7, frontLen, 0, st);
      labBench(g, 0, 0, b.w - 24, 0, st);
      labBench(g, -b.w / 2 + 8, b.d / 2 - 9, 12, Math.PI / 2, st);
      /* a cryostat and a rack of electronics */
      V.cy(g, 2.2, 2.6, 7, V.color(0xB9C2C2), b.w / 2 - 9, 3.5, b.d / 2 - 8, 14);
      V.bx(g, 3.2, 6, 2, V.color(0x39423E), b.w / 2 - 15, 3, b.d / 2 - 8);
      for (var rk = 0; rk < 5; rk++) {
        V.bx(g, 2.6, 0.5, 0.1, V.litGlass(0x6FD0C4), b.w / 2 - 15, 1.2 + rk * 1.1, b.d / 2 - 6.95);
      }
      var cw = st.at(b.w / 2 - 9, b.d / 2 - 8); V.blockCircle(cw.x, cw.z, 2.8);
      var rw = st.at(b.w / 2 - 15, b.d / 2 - 8); V.blockCircle(rw.x, rw.z, 2.0);
      noticeInside(g, b, -b.w / 2 + 8, -b.d / 2 + 1.1, "detector");
      for (var ls = 0; ls < 2; ls++) seats.push(seatAt(g, st, -b.w / 2 + 12 + ls * 6, b.d / 2 - 5, 0));

    } else if (b.kind === "cafe" || b.kind === "common") {
      for (var ct = 0; ct < 4; ct++) {
        var cx = -b.w / 2 + 7 + (ct % 2) * (b.w - 14);
        var cz = -b.d / 2 + 7 + Math.floor(ct / 2) * (b.d - 14);
        roundTable(g, cx, cz, 1.9, st);
        for (var cs = 0; cs < 3; cs++) {
          var ca = (cs / 3) * Math.PI * 2;
          seats.push(seatAt(g, st, cx + Math.sin(ca) * 3.2, cz + Math.cos(ca) * 3.2, ca + Math.PI));
        }
      }
      /* the counter goes against the wall opposite the door, never across it */
      var bw = backWall(b, 2.6);
      var clen = Math.min(bw.len - 10, bw.len * 0.6);
      V.bx(g, clen, 2.4, 1.6, V.color(C.woodDark), bw.lx, 1.2, bw.lz, bw.ry);
      V.bx(g, clen, 0.24, 2.0, V.color(C.wood), bw.lx, 2.5, bw.lz, bw.ry);
      var cwp = st.at(bw.lx, bw.lz);
      V.blockBox(cwp.x, cwp.z, clen / 2, 1.0, st.ry + bw.ry);
      plant(g, b.w / 2 - 2.4, b.d / 2 - 2.4);
      noticeInside(g, b, -b.w / 2 + 3, -b.d / 2 + 1.1, "spectrum");

    } else if (b.kind === "offices") {
      var cells = Math.max(2, Math.floor(b.w / 16));
      for (var o = 0; o < cells; o++) {
        var ox = -b.w / 2 + (o + 0.5) * (b.w / cells);
        desk(g, ox, -b.d / 2 + 5, 0, st);
        shelfRun(g, ox, b.d / 2 - 2.2, 8, 0, st);
        seats.push(seatAt(g, st, ox, b.d / 2 - 6, Math.PI));
      }
      noticeInside(g, b, 0, -b.d / 2 + 1.1, "equation");

    } else if (b.kind === "university" || b.kind === "institute") {
      /* an open lobby: reception against the back wall, boards, seating */
      var rw = backWall(b, 5);
      V.bx(g, 12, 2.4, 2.4, V.color(C.woodDark), rw.lx, 1.2, rw.lz, rw.ry);
      V.bx(g, 13, 0.26, 3.0, V.color(C.wood), rw.lx, 2.5, rw.lz, rw.ry);
      var rp = st.at(rw.lx, rw.lz);
      V.blockBox(rp.x, rp.z, 6.5, 1.5, st.ry + rw.ry);
      for (var q = 0; q < 4; q++) {
        var qx = -b.w / 2 + 10 + q * ((b.w - 20) / 3);
        noticeInside(g, b, qx, -b.d / 2 + 1.1, ["feynman", "spectrum", "sky", "detector"][q]);
      }
      for (var bt = 0; bt < 2; bt++) {
        var bx2 = -b.w / 2 + 14 + bt * (b.w - 28);
        roundTable(g, bx2, b.d / 2 - 9, 2.1, st);
        for (var bs = 0; bs < 4; bs++) {
          var ba = (bs / 4) * Math.PI * 2;
          seats.push(seatAt(g, st, bx2 + Math.sin(ba) * 3.4, b.d / 2 - 9 + Math.cos(ba) * 3.4, ba + Math.PI));
        }
      }
      plant(g, -b.w / 2 + 4, b.d / 2 - 4);
      plant(g, b.w / 2 - 4, b.d / 2 - 4);

    } else if (b.kind === "station") {
      /* concourse: benches, a departure board, a ticket window */
      for (var sb = 0; sb < 2; sb++) {
        var sbx = -b.w / 2 + 12 + sb * (b.w - 24);
        V.bx(g, 6, 0.24, 1.4, V.color(C.wood), sbx, 1.1, 0);
        V.bx(g, 6, 0.9, 0.16, V.color(C.wood), sbx, 1.6, -0.6);
        seats.push(seatAt(g, st, sbx - 1.6, 0, Math.PI));
        seats.push(seatAt(g, st, sbx + 1.6, 0, Math.PI));
      }
      departureBoard(g, 0, -b.d / 2 + 1.3, 0, b.id);
      if (b.w > 50) {
        V.bx(g, 8, 3.2, 1.2, V.color(C.woodDark), b.w / 2 - 12, 1.6, -b.d / 2 + 2.2);
        var tp = st.at(b.w / 2 - 12, -b.d / 2 + 2.2);
        V.blockBox(tp.x, tp.z, 4, 0.6, st.ry);
      }
    }

    if (seats.length || stage) {
      room = {
        id: b.id, name: b.name, kind: b.kind,
        x: b.x, z: b.z, ry: b.ry || 0, hw: b.w / 2, hd: b.d / 2,
        seats: seats, stage: stage,
        board: board ? st.at(0, 0) : null
      };
      if (b.kind === "seminar" || b.kind === "lecture" || b.kind === "discussion" ||
          b.kind === "poster" || b.kind === "poster2") V.ROOMS.push(room);
    }
    /* and the character on top of the layout */
    try { dressRoom(st, b); }
    catch (e) { console.warn("[campus] could not dress " + b.id + ":", e && e.message); }

    /* paper icons on the furniture */
    for (var pi = 0; pi < (b.papers || 0); pi++) {
      var lx3 = -b.w / 2 + 6 + (pi % 4) * ((b.w - 12) / 3);
      var lz3 = b.d / 2 - 5 - Math.floor(pi / 4) * 6;
      var wp3 = st.at(lx3, lz3);
      paperSpot(wp3.x, wp3.z, st.ry, b.id);
    }
    return room;
  }

  function seatAt(g, st, lx, lz, ry, yOff, floorY) {
    chair(st, lx, lz, ry, floorY || 0);
    var w = st.at(lx, lz);
    return V.addSeat({ x: w.x, z: w.z, ry: st.ry + ry, y: yOff || 0, room: st.roomId });
  }
  function noticeInside(g, b, lx, lz, kind) {
    var k = kind || ["feynman", "equation", "spectrum", "sky", "detector"][Math.floor(Math.random() * 5)];
    var m = new T.MeshBasicMaterial({ map: V.posterTex(k, (lx * 7 + lz * 13) | 0), side: T.DoubleSide });
    V.panel(g, 3.0, 3.9, m, lx, 4.4, lz + 0.14);
  }
  function departureBoard(g, lx, lz, ry, id) {
    V.bx(g, 14, 3.4, 0.3, V.color(0x1B2320), lx, 6.4, lz);
    var m = new T.MeshBasicMaterial({ color: 0x2A3A34 });
    V.panel(g, 13.2, 2.8, m, lx, 6.4, lz + 0.18);
    for (var r = 0; r < 4; r++) {
      V.bx(g, 12, 0.12, 0.06, V.litLamp(0x3A4A44, 0xE8B04B), lx, 7.4 - r * 0.7, lz + 0.22);
    }
  }

  /* ============================================================== build */
  function build() {
    C = V.C;
    plan();
    props = V.props;                 /* shared with village.js, flushed by it */
    LAMP_M = V.litLamp(0x4A4438, 0xFFC46B);

    buildRoads();
    buildRail();
    buildBuildings();
    buildPark();
    buildResidences();
    buildResearchExtras();
    buildStationQuarter();
    buildScenery();
    buildWayfinding();
    props = null;
  }

  /* ------------------------------------------------------------- roads */
  function buildRoads() {
    var tar = V.color(0x6E6E68);
    var kerb = V.color(0xC7C2B4);
    var dash = V.flat(0xE8E2CE, 0.85);
    var pave = V.color(0xCDB68A);

    ROADS.forEach(function (r) {
      ribbon(r.pts.slice(), r.width, 0.06, tar, r.closed);
      ribbon(r.pts.slice(), r.width + 3.4, 0.045, kerb, r.closed);
      /* centre line */
      walkLine(r.pts, 9, r.closed, function (x, z, ang) {
        props.add(V.U.plane(), dash, x, 0.075, z, 0.5, 4.2, 1, 0, -ang, -Math.PI / 2);
      });
      /* pavements either side, as a slightly wider pale ribbon under the road */
      if (!r.closed) {
        walkLine(r.pts, 46, false, function (x, z, ang) {
          streetLight(x + Math.cos(ang) * (r.width / 2 + 3.6), z - Math.sin(ang) * (r.width / 2 + 3.6), ang + Math.PI / 2);
        });
      } else {
        walkLine(r.pts, 64, true, function (x, z, ang) {
          streetLight(x * (1 + (r.width / 2 + 3.6) / RING_R), z * (1 + (r.width / 2 + 3.6) / RING_R), Math.atan2(x, z));
        });
      }
    });

    /* roundabouts where the spurs leave the ring */
    [[0, -RING_R], [RING_R, 0], [0, RING_R], [-RING_R, 0]].forEach(function (p, i) {
      V.ci(V.root, 26, tar, p[0], 0.065, p[1], 28);
      V.ci(V.root, 11, V.color(0x8FA968), p[0], 0.09, p[1], 22);
      plantTree(p[0], p[1], 1.0, "conifer");
      crossing(p[0] + (i % 2 ? 0 : 34), p[1] + (i % 2 ? 34 : 0), i % 2 ? Math.PI / 2 : 0, 16);
    });

    /* pedestrian crossings on the straight roads */
    crossing(0, -420, 0, 15); crossing(0, -640, 0, 15);
    crossing(-200, -470, Math.PI / 2, 14); crossing(200, -470, Math.PI / 2, 14);
    crossing(470, 0, Math.PI / 2, 15); crossing(740, 0, Math.PI / 2, 15);
    crossing(-470, 0, Math.PI / 2, 15); crossing(-600, 120, 0, 14);
    crossing(0, 470, Math.PI / 2, 15); crossing(0, 530, Math.PI / 2, 15);

    /* footpaths */
    PATHS.forEach(function (p) { ribbon(p.pts.slice(), 6.2, 0.05, pave, false); });
  }

  function crossing(x, z, ry, width) {
    var m = V.flat(0xF2EEDC, 0.92);
    for (var i = -3; i <= 3; i++) {
      var ox = Math.cos(ry) * i * 1.9, oz = -Math.sin(ry) * i * 1.9;
      V.slab(V.root, 1.1, width, m, x + ox, 0.085, z + oz, ry);
    }
  }

  /* -------------------------------------------------------------- rail */
  function buildRail() {
    var ballast = V.color(0x9C948A);
    var sleeper = V.color(0x6B5A48);
    var steel = V.color(0xA8B0B2);

    [RAIL.a, RAIL.b].forEach(function (tr) {
      V.slab(V.root, tr.to - tr.from, 11, ballast, (tr.from + tr.to) / 2, 0.05, tr.z, 0);
      for (var x = tr.from; x < tr.to; x += 3.4) {
        props.add(V.U.box(), sleeper, x, 0.22, tr.z, 0.8, 0.3, 8.4);
      }
      [-2.4, 2.4].forEach(function (off) {
        var rail = V.bx(V.root, tr.to - tr.from, 0.34, 0.34, steel, (tr.from + tr.to) / 2, 0.5, tr.z + off);
        rail.matrixAutoUpdate = false; rail.updateMatrix();
      });
    });

    /* platforms, canopies and a footbridge at each station */
    STATIONS.forEach(function (s) {
      var pz = s.platformZ, len = s.halfLen * 2;
      V.bx(V.root, len, 1.1, 14, V.color(0xC7C2B4), s.x, 0.55, pz);
      V.slab(V.root, len - 2, 12, V.color(0xB8B2A2), s.x, 1.12, pz);
      /* yellow safety line */
      V.slab(V.root, len - 2, 0.7, V.flat(0xE8B04B, 0.9), s.x, 1.14, pz + 5.2);
      /* canopy on posts */
      for (var i = -2; i <= 2; i++) {
        V.cy(V.root, 0.22, 0.22, 6, V.color(0x53584F), s.x + i * (len / 6), 3, pz - 4.5, 8);
        V.blockCircle(s.x + i * (len / 6), pz - 4.5, 0.6);
      }
      V.bx(V.root, len * 0.8, 0.4, 13, V.color(0xB9C2C2), s.x, 6.2, pz - 1);
      /* benches and a name board */
      bench(s.x - 20, pz - 2, Math.PI);
      bench(s.x + 20, pz - 2, Math.PI);
      var nb = new T.MeshBasicMaterial({ map: V.signTex(s.name, "platform 1"), side: T.DoubleSide });
      V.panel(V.root, 11, 3.4, nb, s.x, 4.4, pz - 4.2, Math.PI);
      V.panel(V.root, 11, 3.4, nb, s.x, 4.4, pz - 4.1, 0);
      /* a fence along the far side of the running lines */
      for (var fx = s.x - s.halfLen; fx < s.x + s.halfLen; fx += 40) {
        fenceRun(fx, RAIL.b.z + 12, fx + 38, RAIL.b.z + 12, 0x8A9695);
      }
    });
  }

  /* --------------------------------------------------------- buildings */
  function buildBuildings() {
    BUILDINGS.forEach(function (b) {
      var st = V.structure({
        id: b.id, name: b.name, kind: b.kind,
        x: b.x, z: b.z, ry: b.ry || 0, w: b.w, d: b.d, h: b.h,
        wall: b.wall, roof: b.roof, roofStyle: b.roofStyle,
        doors: b.doors, inside: true,
        floor: b.floor != null ? b.floor : themeOf(b).floor,
        doorColor: b.doorColor,
        windows: b.windows !== false
      });
      st.roomId = b.id;
      built[b.id] = { def: b, st: st };

      /* portico for the grandest buildings */
      if (b.portico) {
        for (var i = 0; i < 6; i++) {
          var px = -b.w * 0.3 + i * (b.w * 0.12);
          V.cy(st.group, 1.0, 1.1, b.h * 0.82, V.color(0xCFC7B4), px, b.h * 0.41, b.d / 2 + 5, 12);
          var wp = st.at(px, b.d / 2 + 5);
          V.blockCircle(wp.x, wp.z, 1.2);
        }
        V.bx(st.group, b.w * 0.76, 1.2, 12, V.color(b.roof), 0, b.h * 0.9, b.d / 2 + 4);
        V.bx(st.group, b.w * 0.78, 0.4, 12.6, V.color(0xCFC7B4), 0, 0.2, b.d / 2 + 4);
      }

      /* the sign goes outside the main door */
      var dr = b.doors[0];
      var out = signOffset(b, dr, 13);
      signPost(out.x, out.z, st.ry + out.ry, b.sign || b.name, b.sub, b.w > 60 ? 11 : 8.4);

      /* a paved apron at the door, so the way in always reads as a way in */
      var ap = signOffset(b, dr, 6.5);
      V.slab(V.root, 12, 12, V.color(C.path), ap.x, 0.055, ap.z, st.ry);

      /* Everything fitRoom and dressRoom add goes into one group, so the
         whole interior can be switched off in a single boolean once you are
         far enough away for it to be a smudge. The shell stays, because the
         building itself still has to be there. */
      var shellCount = st.group.children.length;
      fitRoom(st, b);
      var contents = new T.Group();
      var extra = st.group.children.slice(shellCount);
      for (var ci = 0; ci < extra.length; ci++) {
        st.group.remove(extra[ci]);
        contents.add(extra[ci]);
      }
      st.group.add(contents);
      st.contents = contents;
      V.addLod({ g: contents, x: b.x, z: b.z, r: Math.max(170, b.w + b.d + 90) });

      /* a place entry drives the map, the minimap and the E key */
      V.PLACES.push({
        id: b.id, name: b.name, kind: b.kind, x: ap.x, z: ap.z, r: 9,
        sub: b.sub, tag: KIND_TAG[b.kind] || "Building", topic: b.topic || null,
        walkin: true, building: b.id
      });
    });
  }
  var KIND_TAG = {
    library:"Library", cafe:"Café", university:"University", offices:"Offices",
    lecture:"Lecture hall", seminar:"Seminar room", discussion:"Discussion room",
    institute:"Institute", lab:"Laboratory", station:"Station", common:"Common room"
  };
  /* A point `dist` metres outside a given door, and the facing for a sign. */
  function signOffset(b, dr, dist) {
    var lx = 0, lz = 0, ry = 0;
    if (dr.side === "s") { lx = dr.at || 0; lz = b.d / 2 + dist; ry = 0; }
    else if (dr.side === "n") { lx = dr.at || 0; lz = -b.d / 2 - dist; ry = Math.PI; }
    else if (dr.side === "e") { lx = b.w / 2 + dist; lz = dr.at || 0; ry = Math.PI / 2; }
    else { lx = -b.w / 2 - dist; lz = dr.at || 0; ry = -Math.PI / 2; }
    var cos = Math.cos(b.ry || 0), sin = Math.sin(b.ry || 0);
    return { x: b.x + lx * cos + lz * sin, z: b.z - lx * sin + lz * cos, ry: ry };
  }

  /* ------------------------------------------------------------- park */
  function buildPark() {
    var cx = -720, cz = 220;
    V.ci(V.root, 150, V.color(0xB6CC88), cx, 0.035, cz, 40);
    /* pond with a shallow margin */
    V.ci(V.root, 52, V.color(C.water), cx - 20, 0.05, cz + 20, 32);
    V.ci(V.root, 34, V.color(C.waterDeep), cx - 20, 0.06, cz + 20, 26);
    V.blockCircle(cx - 20, cz + 20, 48);
    /* fountain in the middle of the pond */
    V.cy(V.root, 4, 4.6, 1.6, V.color(C.stone), cx - 20, 0.8, cz + 20, 16);
    V.cy(V.root, 0.5, 0.7, 5, V.color(C.stone), cx - 20, 3, cz + 20, 10);
    V.sp(V.root, 1.6, V.flat(0xCFEFF0, 0.55), cx - 20, 6.2, cz + 20, 10);

    /* bandstand */
    var bs = new T.Group();
    V.cy(bs, 8, 8.4, 1.2, V.color(C.stone), 0, 0.6, 0, 16);
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2;
      V.cy(bs, 0.26, 0.26, 6, V.color(C.cream), Math.cos(a) * 7, 4.2, Math.sin(a) * 7, 8);
    }
    V.cn(bs, 9.4, 3.4, V.color(C.roofSlate), 0, 9, 0, 10);
    bs.position.set(cx + 60, 0, cz - 50); V.root.add(bs);
    V.blockCircle(cx + 60, cz - 50, 8.6);

    /* trees, beds, benches and a fence around the edge */
    for (var t = 0; t < 46; t++) {
      var a2 = Math.random() * 6.283, r2 = 60 + Math.random() * 82;
      var tx = cx + Math.cos(a2) * r2, tz = cz + Math.sin(a2) * r2;
      if (V.blockedAt(tx, tz, 6) || V.nearRoad(tx, tz, 10)) continue;
      plantTree(tx, tz, 0.85 + Math.random() * 0.7, t % 5 === 0 ? "poplar" : (t % 3 ? "round" : "conifer"));
    }
    for (var b2 = 0; b2 < 8; b2++) {
      var ab = (b2 / 8) * 6.283;
      bench(cx + Math.cos(ab) * 42, cz + Math.sin(ab) * 42, -ab + Math.PI / 2);
    }
    for (var f = 0; f < 6; f++) flowerBed(cx + 40 + f * 12, cz + 70, 9, 5, 16);
    grassTufts(cx, cz, 140, 90);
    signPost(cx + 20, cz - 120, 0, "Noether Park", "lawns · pond · bandstand", 9);
  }

  /* -------------------------------------------------------- residences */
  function buildResidences() {
    var HOUSES = [
      [-680,-60,0.2], [-746,-60,-0.1], [-680,-130,0.35], [-746,-130,0.1],
      [-680,-200,-0.2], [-746,-200,0.25], [-470,-210,0.1], [-534,-210,-0.15],
      [-470,-278,0.3], [-534,-278,0], [-680,80,0.15], [-746,80,-0.25],
      [-680,150,0.1], [-746,150,0.3]
    ];
    HOUSES.forEach(function (h, i) {
      var st = V.structure({
        x: h[0], z: h[1], ry: h[2], w: 17 + (i % 3) * 3, d: 14, h: 7.5,
        wall: [0xF2E8D4, 0xEADBBE, 0xD6DFC6, 0xF0DFC0][i % 4],
        roof: [0xC9714C, 0xB4603F, 0xCBA86A][i % 3],
        roofStyle: i % 4 === 0 ? "hip" : "gable",
        doors: [{ side: "s", at: 0, width: 4.4 }],
        inside: true, floor: 0xC9B48E, thick: 0.8, h2: 0
      });
      /* a chimney and a garden */
      V.bx(st.group, 1.4, 3.4, 1.4, V.color(C.stone), 5, 9.2, -3);
      fenceRun(h[0] - 11, h[1] + 12, h[0] + 11, h[1] + 12);
      plantBush(h[0] - 8, h[1] + 9, 0.9);
      plantBush(h[0] + 8, h[1] + 9, 1.1);
      flowerBed(h[0], h[1] + 10, 7, 2.4, 9);
      if (i % 3 === 0) plantTree(h[0] + 14, h[1] + 6, 1.0);
    });
    signPost(-600, -160, Math.PI / 2, "Residential Quarter", "fellows and families", 9);
  }

  /* -------------------------------------------- research park extras */
  function buildResearchExtras() {
    /* the storage ring: a marked circle with service huts, walkable */
    var rx = 700, rz = -330, rr = 78;
    var ringMat = V.color(0xBFC6C0);
    for (var i = 0; i < 72; i++) {
      var a = (i / 72) * 6.283;
      props.add(V.U.box(), ringMat, rx + Math.cos(a) * rr, 0.9, rz + Math.sin(a) * rr, 2.6, 1.6, 7.4, -a);
    }
    for (var h = 0; h < 4; h++) {
      var ah = (h / 4) * 6.283 + 0.4;
      var hx = rx + Math.cos(ah) * rr, hz = rz + Math.sin(ah) * rr;
      V.bx(V.root, 7, 5, 7, V.color(0xD6DFC6), hx, 2.5, hz, -ah);
      V.bx(V.root, 8, 0.6, 8, V.color(0x8A9695), hx, 5.3, hz, -ah);
      V.blockCircle(hx, hz, 5);
    }
    signPost(rx, rz + rr + 16, 0, "Storage Ring", "1.2 GeV · beam off", 9);
    V.PLACES.push({ id:"storage-ring", name:"The Storage Ring", kind:"open", x:rx, z:rz + rr + 20, r:10,
                    sub:"Open research area", tag:"Open research", topic:"coll" });

    /* telescope dome beside the astrophysics institute */
    var tx = 830, tz = 210;
    V.cy(V.root, 9, 9.6, 9, V.color(C.wall), tx, 4.5, tz, 20);
    var dome = new T.Mesh(V.U.dome(20), V.color(C.metal));
    dome.scale.set(9.2, 7, 9.2); dome.position.set(tx, 9, tz); V.root.add(dome);
    V.bx(V.root, 2.2, 9, 0.5, V.color(0x2A3A3A), tx, 13, tz + 9.1);
    V.blockCircle(tx, tz, 10);
    signPost(tx, tz - 16, Math.PI, "The Dome", "seeing 0.9 arcsec", 8);

    /* a big detector sculpture outside the detector hall */
    var dx = 740, dz = -60;
    V.cy(V.root, 6, 6, 3, V.color(0xB9C2C2), dx, 1.6, dz, 16);
    for (var s = 0; s < 8; s++) {
      var as = (s / 8) * 6.283;
      V.bx(V.root, 1.4, 5, 1.4, V.color(0x8FA0A4), dx + Math.cos(as) * 4.6, 5.5, dz + Math.sin(as) * 4.6, -as);
    }
    V.blockCircle(dx, dz, 7);
    noticeBoard(690, -60, -0.4, "detector", 7);
    noticeBoard(520, -60, 0.4, "feynman", 3);
    noticeBoard(520, 90, 0.2, "spectrum", 11);
    noticeBoard(690, 110, -0.2, "sky", 5);

    signPost(500, -8, Math.PI / 2, "Research Park", "institutes and laboratories", 10);
  }

  /* ------------------------------------------------- station quarter */
  function buildStationQuarter() {
    /* bus interchange: an open canopy on pillars, with bays and shelters */
    var bx = 120, bz = 462;
    V.slab(V.root, 150, 60, V.color(0x7C7C74), bx, 0.055, bz);
    for (var i = -3; i <= 3; i++) {
      V.cy(V.root, 0.5, 0.5, 8, V.color(0x53584F), bx + i * 22, 4, bz - 16, 8);
      V.cy(V.root, 0.5, 0.5, 8, V.color(0x53584F), bx + i * 22, 4, bz + 16, 8);
      V.blockCircle(bx + i * 22, bz - 16, 0.9);
      V.blockCircle(bx + i * 22, bz + 16, 0.9);
    }
    V.bx(V.root, 154, 0.8, 40, V.color(0xB9C2C2), bx, 8.4, bz);
    for (var b = 0; b < 4; b++) {
      var sx = bx - 60 + b * 40;
      V.bx(V.root, 8, 0.3, 1.4, V.color(C.wood), sx, 1.1, bz + 6);
      V.bx(V.root, 8, 1.0, 0.16, V.color(C.wood), sx, 1.7, bz + 5.4);
      var m = new T.MeshBasicMaterial({ map: V.signTex("Bay " + (b + 1), "ring road service"), side: T.DoubleSide });
      V.panel(V.root, 5, 1.56, m, sx, 4.4, bz + 3.4, 0);
    }
    signPost(bx - 76, bz - 26, 0, "Bus Interchange", "ring road services", 9);
    V.PLACES.push({ id:"interchange", name:"Bus Interchange", kind:"transport", x:bx - 70, z:bz + 26, r:10,
                    sub:"Ring road services", tag:"Transport" });

    /* the open research field: lawn, chalk wall, picnic tables */
    var fx = 330, fz = 380;
    V.slab(V.root, 220, 150, V.color(0xB6CC88), fx, 0.04, fz);
    for (var p = 0; p < 5; p++) {
      var px = fx - 80 + p * 40;
      V.bx(V.root, 6, 0.24, 3.2, V.color(C.wood), px, 1.5, fz + 40);
      V.bx(V.root, 6, 1.3, 0.5, V.color(C.woodDark), px, 0.7, fz + 40);
      V.blockBox(px, fz + 40, 3, 1.6, 0);
    }
    /* a long outdoor blackboard */
    V.bx(V.root, 40, 6, 0.8, V.color(C.woodDark), fx, 3.2, fz - 60);
    V.bx(V.root, 38, 5, 0.3, V.color(0x24302B), fx, 3.3, fz - 59.5);
    /* Two writable stretches of it. Outdoors, so anyone may write. */
    [{ id: "field-w", name: "the field board, west end", ox: fx - 12, w: 10, seed: "equation", sd: 2 },
     { id: "field-e", name: "the field board, east end", ox: fx + 8, w: 8, seed: "feynman", sd: 4 }
    ].forEach(function (s2) {
      var seed = V.posterTex(s2.seed, s2.sd);
      var made = window.QVBoard && QVBoard.register({
        id: s2.id, name: s2.name, parent: V.root, w: s2.w, h: 4.4,
        ox: s2.ox, oy: 3.4, oz: fz - 59.2, wx: s2.ox, wz: fz - 59.2, seed: seed
      });
      if (!made) {
        var m = new T.MeshBasicMaterial({ map: seed, transparent: true, opacity: 0.5, side: T.DoubleSide });
        V.panel(V.root, s2.w, 4.4, m, s2.ox, 3.4, fz - 59.2);
      }
    });
    V.blockBox(fx, fz - 60, 20, 0.6, 0);
    signPost(fx - 60, fz - 50, 0, "Open Research Field", "chalk provided", 9);
    V.PLACES.push({ id:"field", name:"Open Research Field", kind:"open", x:fx - 40, z:fz - 40, r:12,
                    sub:"Chalk provided", tag:"Open research" });
    grassTufts(fx, fz, 100, 70);

    /* a level crossing where Station Road meets the line — decorative,
       the road stops short of the track */
    V.bx(V.root, 1.0, 5, 1.0, V.color(0xE8E2CE), -10, 2.5, 606);
    V.bx(V.root, 1.0, 5, 1.0, V.color(0xE8E2CE), 10, 2.5, 606);

    /* ============================================================ outdoor blackboards
     * Permanent chalk surfaces placed at prominent locations throughout the
     * village.  Each one is built like the field boards — wooden stanchions,
     * dark slate, collision block — and registered with QVBoard.register()
     * so it automatically inherits the live Firebase sync (boards/{id}/{uid}),
     * MathJax LaTeX rendering, pinned-picture support, and onDisconnect
     * cleanup already in place. */
    var outdoorBoards = [
      /* 1. Far North Outskirts — pine meadow beyond the university */
      { id: "board-outskirt-north", name: "North Meadow Outskirts board",
        x: -20, z: -810, w: 20, h: 7.2, ry: 0 },
      /* 2. Northeast Outskirts — overlooking the northern ridge and woodland */
      { id: "board-outskirt-northeast", name: "Northeast Ridge Outskirts board",
        x: 520, z: -600, w: 18, h: 6.8, ry: -Math.PI / 4 },
      /* 3. Far East Outskirts — boundary clearing beyond Feynman Boulevard */
      { id: "board-outskirt-east", name: "Far East Boundary board",
        x: 840, z: 25, w: 20, h: 7.2, ry: -Math.PI / 2 },
      /* 4. Southeast Outskirts — open pasture south of the railway line */
      { id: "board-outskirt-southeast", name: "Southeast Pasture Outskirts board",
        x: 460, z: 700, w: 18, h: 6.4, ry: -3 * Math.PI / 4 },
      /* 5. Far South Outskirts — deep pine belt south of the tracks */
      { id: "board-outskirt-south", name: "South Woods Outskirts board",
        x: 0, z: 750, w: 20, h: 7.2, ry: Math.PI },
      /* 6. Southwest Outskirts — outer meadow beyond Westfield Halt */
      { id: "board-outskirt-southwest", name: "Southwest Meadow Outskirts board",
        x: -520, z: 700, w: 18, h: 6.4, ry: 3 * Math.PI / 4 },
      /* 7. Far West Outskirts — horizon clearing beyond Noether Avenue */
      { id: "board-outskirt-west", name: "Far West Boundary board",
        x: -835, z: 30, w: 20, h: 7.2, ry: Math.PI / 2 },
      /* 8. Northwest Outskirts — quiet wildwood meadow */
      { id: "board-outskirt-northwest", name: "Northwest Wildwood Outskirts board",
        x: -520, z: -600, w: 18, h: 6.4, ry: Math.PI / 4 }
    ];

    outdoorBoards.forEach(function (ob) {
      var sinR = Math.sin(ob.ry || 0), cosR = Math.cos(ob.ry || 0);
      var boardDepth = 0.5;

      /* Wooden stanchions — offset along the board's local X axis.
         Local X in world space: (cosR, 0, -sinR). */
      var postW = 0.36, postD = 0.36, postH = ob.h + 1.4;
      var halfW = ob.w / 2 - 0.3;
      [-1, 1].forEach(function (side) {
        var px = ob.x + cosR * side * halfW;
        var pz = ob.z - sinR * side * halfW;
        V.bx(V.root, postW, postH, postD, V.color(C.woodDark), px, postH / 2, pz, ob.ry);
      });

      /* Cross beam at the top */
      V.bx(V.root, ob.w + 0.4, 0.3, 0.36, V.color(C.woodDark),
        ob.x, ob.h + 1.0, ob.z, ob.ry);

      /* Dark slate backing */
      V.bx(V.root, ob.w, ob.h, boardDepth, V.color(C.woodDark),
        ob.x, ob.h / 2 + 0.8, ob.z, ob.ry);

      /* The green-black writing surface — pushed forward along the
         board's local +Z axis (the front face of the board).
         Local +Z in world space: (+sinR, 0, +cosR). */
      var slateOff = boardDepth / 2 + 0.08;
      var slateOx = ob.x + sinR * slateOff;
      var slateOz = ob.z + cosR * slateOff;
      V.bx(V.root, ob.w - 0.6, ob.h - 0.4, 0.12, V.color(0x24302B),
        slateOx, ob.h / 2 + 0.8, slateOz, ob.ry);

      /* Writable surface, registered with QVBoard.
         Three.js PlaneGeometry has its front-face normal pointing along +Z.
         By placing the panel on the +Z side (+sinR, +cosR) with rotation ob.ry,
         the front face faces outward directly toward viewers approaching the board. */
      var seed = V.posterTex(
        Math.random() < 0.5 ? "equation" : "feynman",
        (ob.x * 7 + ob.z * 13) | 0
      );
      var writeOff = boardDepth / 2 + 0.2;
      var writeOx = ob.x + sinR * writeOff;
      var writeOz = ob.z + cosR * writeOff;
      var made = window.QVBoard && QVBoard.register({
        id: ob.id, name: ob.name, parent: V.root,
        w: ob.w - 1.0, h: ob.h - 0.8,
        ox: writeOx, oy: ob.h / 2 + 0.8, oz: writeOz, ry: ob.ry,
        wx: ob.x + sinR * (writeOff + 1.8), wz: ob.z + cosR * (writeOff + 1.8), seed: seed
      });
      if (!made) {
        var m = new T.MeshBasicMaterial({
          map: seed, transparent: true, opacity: 0.5, side: T.DoubleSide
        });
        V.panel(V.root, ob.w - 1.0, ob.h - 0.8, m,
          writeOx, ob.h / 2 + 0.8, writeOz, ob.ry);
      }

      /* Collision block so people walk around it */
      V.blockBox(ob.x, ob.z, ob.w / 2, boardDepth, ob.ry || 0);

      /* Register on the map and places index */
      V.PLACES.push({
        id: ob.id,
        name: ob.name,
        kind: "board",
        x: ob.x,
        z: ob.z,
        r: 14,
        sub: "Outdoor chalkboard & equations",
        tag: "Outskirts blackboard",
        walkin: false
      });
    });
  }

  /* --------------------------------------------------------- scenery */
  function buildScenery() {
    /* avenue trees along every straight road */
    ROADS.forEach(function (r) {
      if (r.closed) return;
      walkLine(r.pts, 26, false, function (x, z, ang) {
        [1, -1].forEach(function (side) {
          var tx = x + Math.cos(ang) * side * (r.width / 2 + 7.5);
          var tz = z - Math.sin(ang) * side * (r.width / 2 + 7.5);
          if (V.blockedAt(tx, tz, 4)) return;
          plantTree(tx, tz, 0.9 + Math.random() * 0.4, Math.random() < 0.3 ? "poplar" : "round");
        });
      });
    });
    /* a belt of woodland out towards the world edge */
    for (var i = 0; i < 420; i++) {
      var a = Math.random() * 6.283, r = 430 + Math.random() * 430;
      var x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.hypot(x, z) > V.WORLD_R - 20) continue;
      if (V.blockedAt(x, z, 8) || V.nearRoad(x, z, 14) || insideAnyBuilding(x, z, 8)) continue;
      if (Math.abs(z - RAIL.a.z) < 26 || Math.abs(z - RAIL.b.z) < 26) continue;
      plantTree(x, z, 0.8 + Math.random() * 0.9,
        ["round", "round", "conifer", "poplar"][i % 4]);
      if (i % 4 === 0) plantBush(x + 6, z + 4, 0.8 + Math.random() * 0.5);
      if (i % 9 === 0) grassTufts(x, z, 9, 5);
    }
    /* hedgerows marking the field boundaries out east */
    for (var f = 0; f < 5; f++) {
      var hz = 120 + f * 46;
      if (V.blockedAt(520, hz, 6)) continue;
      hedgeRun(500, hz, 640, hz);
    }
    /* flower beds and benches around the campus lawns */
    [[-150,-370],[150,-370],[0,-700],[-290,-530],[290,-530]].forEach(function (p, i) {
      flowerBed(p[0], p[1], 14, 5, 22);
      bench(p[0] - 10, p[1] - 4, i % 2 ? 0.6 : -0.6);
      bench(p[0] + 10, p[1] - 4, i % 2 ? -0.6 : 0.6);
    });
    /* the campus lawns themselves */
    V.ci(V.root, 120, V.color(0xB6CC88), 0, 0.03, -560, 30);
    V.ci(V.root, 70, V.color(0xB6CC88), 560, 0.03, -60, 24);
  }

  /* ------------------------------------------------------- wayfinding */
  function buildWayfinding() {
    directionPost(26, -390, [
      { label:"University", side:"left", ry:0 },
      { label:"Library", side:"left", ry:0 },
      { label:"Old Village", side:"right", ry:0 }
    ]);
    directionPost(390, 26, [
      { label:"Research Park", side:"left", ry:Math.PI / 2 },
      { label:"Detector Hall", side:"left", ry:Math.PI / 2 },
      { label:"Seminar Hall \u03b2", side:"right", ry:Math.PI / 2 },
      { label:"Old Village", side:"right", ry:Math.PI / 2 }
    ]);
    directionPost(-390, 26, [
      { label:"Residences", side:"left", ry:-Math.PI / 2 },
      { label:"Seminar Hall \u03b1", side:"left", ry:-Math.PI / 2 },
      { label:"Noether Park", side:"left", ry:-Math.PI / 2 },
      { label:"Café Planck", side:"right", ry:-Math.PI / 2 }
    ]);
    directionPost(26, 390, [
      { label:"Central Station", side:"left", ry:Math.PI },
      { label:"Interchange", side:"left", ry:Math.PI },
      { label:"Open Field", side:"right", ry:Math.PI }
    ]);
    directionPost(-20, -466, [
      { label:"Lecture Halls", side:"left", ry:0 },
      { label:"Discussion Rooms", side:"right", ry:0 }
    ]);
    /* a village map board at each gateway */
    [[34, -360], [-34, 360], [360, -34], [-360, 34]].forEach(function (p, i) {
      noticeBoard(p[0], p[1], Math.atan2(-p[0], -p[1]), ["sky", "feynman", "detector", "spectrum"][i], i + 2);
    });
  }

  window.QVCampus = { plan: plan, build: build, ROADS: ROADS, BUILDINGS: BUILDINGS, STATIONS: STATIONS, RAIL: RAIL };
})();
