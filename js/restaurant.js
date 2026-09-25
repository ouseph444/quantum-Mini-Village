/* Quantum Village — The Grand Refectory restaurant.
 *
 * A clean, charming village store/café with an orderly queue system.
 * Staff (Rowan & Madame Bernadette) call the player's name when it is their turn.
 * Strict FIFO queuing order.
 * Served food remains visible on tables/counter for exactly 50 seconds, then disappears.
 */
(function () {
  "use strict";
  var V = window.QV;
  var T = window.THREE;

  /* ---------------------------------------------------------------- api */
  var api = {};
  window.QVRestaurant = api;

  api.hooks = {}; /* { addPoints, toast, getPoints, displayName, onPlayerAtFront } */

  /* ---------------------------------------------------------------- data */
  var MENU = [
    { id:"tea",      emoji:"🍵", name:"Tea",                   desc:"Freshly brewed, served with a biscuit",       cost:5  },
    { id:"coffee",   emoji:"☕", name:"Filter Coffee",          desc:"A proper pot, not the instant kind",          cost:8  },
    { id:"croissant",emoji:"🥐", name:"Croissant",              desc:"Buttery, still warm from the kitchen",        cost:10 },
    { id:"cake",     emoji:"🍰", name:"Cake Slice",             desc:"Cardamom cake with fresh cream",              cost:12 },
    { id:"salad",    emoji:"🥗", name:"Garden Salad",           desc:"With roasted chickpeas & lemon dressing",     cost:15 },
    { id:"dal",      emoji:"🍲", name:"Dal & Rice",             desc:"Slow-cooked all morning, rich & comforting",   cost:18 },
    { id:"flatbread",emoji:"🫓", name:"Flatbread Special",      desc:"Charred, topped with labneh and za'atar",     cost:22 },
    { id:"platter",  emoji:"🥩", name:"Physicist's Platter",    desc:"The full hearty spread — you've earned it",   cost:30 }
  ];
  api.MENU = MENU;

  /* Serving counter position facing front */
  var COUNTER_X = 80;
  var COUNTER_Z = 63.6;

  /* Strict queue slots leading up to Rowan at the counter */
  var QUEUE_SLOTS = [
    { x: 80, z: 65.2 }, /* slot 0: right at counter facing Rowan */
    { x: 80, z: 67.2 }, /* slot 1 */
    { x: 80, z: 69.2 }, /* slot 2 */
    { x: 80, z: 71.2 }, /* slot 3 */
    { x: 80, z: 73.2 }  /* slot 4: queue entrance */
  ];
  api.QUEUE_SLOTS = QUEUE_SLOTS;

  /* Spaced seating spots matching the 3 cozy tables in village.js */
  var TABLE_SPOTS = [
    { x: 69.4, z: 68, tx: 71, tz: 68, r: Math.PI / 2 },
    { x: 72.6, z: 68, tx: 71, tz: 68, r: -Math.PI / 2 },
    { x: 87.4, z: 68, tx: 89, tz: 68, r: Math.PI / 2 },
    { x: 90.6, z: 68, tx: 89, tz: 68, r: -Math.PI / 2 },
    { x: 86.4, z: 74, tx: 88, tz: 74, r: Math.PI / 2 },
    { x: 89.6, z: 74, tx: 88, tz: 74, r: -Math.PI / 2 }
  ];

  /* Walking routes. The queue lane is roped off between x 78.4 and 81.6
     from the counter to z 73, so people step out of it sideways at the
     counter end and join it from the open end, and they come at a chair
     from the aisle side of its table rather than through the table top. */
  var LANE_X = 80, LANE_EXIT_Z = 64.3, LANE_ENTRY_Z = 75.6;
  function sideX(x) { return x < LANE_X ? 76.8 : 83.2; }
  function inLane(x, z) { return Math.abs(x - LANE_X) < 1.3 && z > 64.6 && z < 76.2; }
  function seatApproach(seat) { return { x: seat.x, z: seat.tz - 2.4 }; }
  /* open patio ground either side of the lane, clear of tables and planters */
  var WANDER = [
    { x: 75, z: 70 }, { x: 75, z: 76 }, { x: 67, z: 73 }, { x: 76, z: 66 },
    { x: 85, z: 77 }, { x: 84, z: 70 }, { x: 93, z: 71 }, { x: 84, z: 66 }
  ];
  function wanderSpot(fromX) {
    var left = fromX < LANE_X;
    var pool = WANDER.filter(function (w) { return (w.x < LANE_X) === left; });
    return pool[Math.floor(Math.random() * pool.length)];
  }

  var SCHOLAR_NAMES = [
    { name: "Dr. Chandra", role: "Theoretical Fellow", emoji: "👨‍🏫" },
    { name: "Maya", role: "Graduate Scholar", emoji: "👩‍🎓" },
    { name: "Prof. Thorne", role: "Astrophysics Chair", emoji: "👨‍🔬" },
    { name: "Elena", role: "Visiting Researcher", emoji: "👩‍💻" },
    { name: "Kiran", role: "Postdoctoral Fellow", emoji: "🧑‍🏫" },
    { name: "Arthur", role: "Village Archivist", emoji: "🧔" }
  ];

  /* ---------------------------------------------------- queue state */
  var queue = [];            /* array of "player" | "npc-N" strings */
  var playerInQueue = false;
  var playerAtFront = false;
  var queueTick = 0;
  var ADVANCE_INTERVAL = 7;  /* seconds per customer served */

  var NPC_COUNT = 6;
  var npcs = [];
  var rowan = null;  /* Server / Barista NPC */
  var owner = null;  /* Madame Bernadette (Owner NPC) */
  var sceneRoot = null;

  /* 50-second food tracker: dishes on tables/counter that disappear after 50s */
  var servedDishes = []; /* array of { mesh, timeLeft, ownerNpc } */
  var lastServed = null;
  var pendingOrder = null;
  var heldFood = null;
  var PREP_SECONDS = 40;
  var HOLD_SECONDS = 30;

  /* ---------------------------------------------------- 3D Dish Helper */
  /* Dishes are modelled small and scaled up, so they read at chibi scale
     on a table top from the normal camera distance. */
  var FOOD_SCALE = 1.8;
  function createFoodDish() {
    var g = new T.Group();
    /* Ceramic plate */
    var plateMat = new T.MeshLambertMaterial({ color: 0xF7F4EE });
    var plate = new T.Mesh(new T.CylinderGeometry(0.36, 0.32, 0.05, 12), plateMat);
    g.add(plate);

    /* Ceramic cup with coffee/tea */
    var mugMat = new T.MeshLambertMaterial({ color: 0x3E5E4E });
    var mug = new T.Mesh(new T.CylinderGeometry(0.10, 0.08, 0.18, 8), mugMat);
    mug.position.set(-0.14, 0.10, 0.10);
    g.add(mug);

    /* Food: golden baked pastry / warm meal */
    var foodMat = new T.MeshLambertMaterial({ color: 0xC87828 });
    var food = new T.Mesh(new T.CylinderGeometry(0.18, 0.14, 0.12, 10), foodMat);
    food.position.set(0.12, 0.08, -0.06);
    g.add(food);

    /* Little steam puff */
    var steamMat = new T.MeshLambertMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.55 });
    var steam = new T.Mesh(new T.SphereGeometry(0.06, 6, 4), steamMat);
    steam.position.set(-0.14, 0.26, 0.10);
    g.add(steam);

    g.userData = { steam: steam };
    g.scale.setScalar(FOOD_SCALE);
    return g;
  }

  /* ---------------------------------------------------- build 3-D scene */
  api.build = function (root) {
    if (!T || !V) return;
    sceneRoot = root;
    buildQueueLane(root);
    buildServer(root);
    buildOwner(root);
    buildNPCs(root);
  };

  /* Rowan — Dedicated Order Taker / Barista behind the counter */
  function buildServer(root) {
    var look = { skin: 2, hair: 3, shirt: 0, trouser: 1 };
    var g = V.makePerson(look), P = V.PERSON;

    /* Dark green apron */
    var apronM = new T.MeshLambertMaterial({ color: 0x1E3B2E });
    /* a front half-shell, so it wraps the round torso instead of boxing it */
    apronM.side = T.DoubleSide;
    var apron = new T.Mesh(new T.CylinderGeometry(1, 1.12, 1, 14, 1, true, -1.25, 2.5), apronM);
    apron.scale.set(0.39, 0.72, 0.31);
    apron.position.set(0, 1.12, 0);
    g.add(apron);

    /* Golden name badge */
    var badge = new T.Mesh(new T.BoxGeometry(0.20, 0.10, 0.05), new T.MeshLambertMaterial({ color: 0xD8B040 }));
    badge.position.set(-0.16, P.chestY + 0.08, P.chestZ + 0.03);
    g.add(badge);

    /* Barista cap */
    var capM = new T.MeshLambertMaterial({ color: 0x1E3B2E });
    var cap = new T.Mesh(new T.CylinderGeometry(0.50, 0.54, 0.18, 14), capM);
    cap.position.set(0, P.headTop - 0.06, -0.04);
    g.add(cap);

    /* Directly behind counter facing south (+z) */
    g.position.set(COUNTER_X, 0, 61.8);
    g.rotation.y = 0;
    root.add(g);

    rowan = {
      g: g,
      name: "Rowan",
      role: "Host & Barista",
      bubble: "Next in line, please! ☕",
      t: 0
    };
    api.server = rowan;
    V.refectoryServer = rowan;
  }

  /* Madame Bernadette — Cafe Owner & Executive Chef */
  function buildOwner(root) {
    var look = { skin: 1, hair: 4, shirt: 2, trouser: 0 };
    var g = V.makePerson(look), P = V.PERSON;

    /* Tall Chef's Toque */
    var toqueM = new T.MeshLambertMaterial({ color: 0xFDFBF7 });
    var toque = new T.Mesh(new T.CylinderGeometry(0.48, 0.44, 0.52, 12), toqueM);
    toque.position.set(0, P.headTop + 0.16, -0.02);
    g.add(toque);
    var puff = new T.Mesh(new T.SphereGeometry(0.50, 10, 8), toqueM);
    puff.position.set(0, P.headTop + 0.44, -0.02);
    puff.scale.set(1, 0.45, 1);
    g.add(puff);

    /* Double-breasted chef coat golden buttons */
    var btnM = new T.MeshLambertMaterial({ color: 0xD8A83A });
    [-0.12, 0.12].forEach(function (bx) {
      [P.chestY - 0.18, P.chestY - 0.02, P.chestY + 0.14].forEach(function (by) {
        var btn = new T.Mesh(new T.CylinderGeometry(0.04, 0.04, 0.05, 6), btnM);
        btn.rotation.x = Math.PI / 2;
        btn.position.set(bx, by, P.chestZ - 0.01);
        g.add(btn);
      });
    });

    /* Red culinary scarf */
    var scarf = new T.Mesh(new T.BoxGeometry(0.30, 0.12, 0.12), new T.MeshLambertMaterial({ color: 0xA82424 }));
    scarf.position.set(0, P.neckY, 0.20);
    g.add(scarf);

    /* Spectacles */
    var glassFrame = new T.Mesh(new T.BoxGeometry(0.50, 0.06, 0.04), btnM);
    glassFrame.position.set(0, P.headY - 0.02, 0.48);
    g.add(glassFrame);

    g.position.set(74, 0, 68);
    root.add(g);

    owner = {
      g: g,
      name: "Madame Bernadette",
      role: "Cafe Owner & Chef",
      bubble: "Welcome to The Grand Refectory! 🍲",
      tx: 74,
      tz: 68,
      t: 0,
      idleLeft: 6,
      waypoints: [
        { x: 74, z: 68, b: "Eat well, think well! 🍲" },
        { x: 86, z: 68, b: "Cardamom cake fresh out of the oven! 🍰" },
        { x: 85, z: 74, b: "Rowan has the filter coffee brewing! ☕" },
        { x: 75, z: 72, b: "Discussions & posters earn you points for food! ✨" }
      ],
      wayIdx: 0,
      isOwner: true
    };
    api.owner = owner;
    V.refectoryOwner = owner;
  }

  /* Brass bollards with plush velvet ropes creating the queue lane */
  function buildQueueLane(root) {
    var posts = [
      [78.4, 65.2], [78.4, 67.8], [78.4, 70.4], [78.4, 73.0],
      [81.6, 65.2], [81.6, 67.8], [81.6, 70.4], [81.6, 73.0]
    ];
    var postMat = new T.MeshLambertMaterial({ color: 0x987232 });
    var capMat  = new T.MeshLambertMaterial({ color: 0xE8B84B });
    var ropeMat = new T.MeshLambertMaterial({ color: 0x881E2E, transparent: true, opacity: 0.92 });

    posts.forEach(function (p) {
      var post = new T.Group();
      var base = new T.Mesh(new T.CylinderGeometry(0.24, 0.28, 0.10, 10), postMat);
      base.position.y = 0.05; post.add(base);
      var pole = new T.Mesh(new T.CylinderGeometry(0.07, 0.08, 1.8, 8), postMat);
      pole.position.y = 0.95; post.add(pole);
      var cap = new T.Mesh(new T.SphereGeometry(0.14, 8, 6), capMat);
      cap.position.y = 1.9; post.add(cap);
      post.position.set(p[0], 0, p[1]);
      root.add(post);
    });

    function rope(x1, z1, x2, z2) {
      var dx = x2 - x1, dz = z2 - z1;
      var len = Math.hypot(dx, dz);
      var ang = Math.atan2(dx, dz);
      var r = new T.Mesh(new T.CylinderGeometry(0.035, 0.035, len, 6), ropeMat);
      r.rotation.x = Math.PI / 2;
      r.rotation.z = -ang;
      r.position.set((x1 + x2) / 2, 1.48, (z1 + z2) / 2);
      root.add(r);
    }
    rope(posts[0][0], posts[0][1], posts[1][0], posts[1][1]);
    rope(posts[1][0], posts[1][1], posts[2][0], posts[2][1]);
    rope(posts[2][0], posts[2][1], posts[3][0], posts[3][1]);
    rope(posts[4][0], posts[4][1], posts[5][0], posts[5][1]);
    rope(posts[5][0], posts[5][1], posts[6][0], posts[6][1]);
    rope(posts[6][0], posts[6][1], posts[7][0], posts[7][1]);

    /* Small brass queue sign next to queue entrance */
    var signPole = new T.Mesh(new T.CylinderGeometry(0.04, 0.04, 1.6, 6), postMat);
    signPole.position.set(82.6, 0.8, 73.2);
    root.add(signPole);
    var signPlate = new T.Mesh(
      new T.PlaneGeometry(1.3, 0.45),
      new T.MeshBasicMaterial({ map: V.signTex("ORDER QUEUE", "enter here ➜"), side: T.DoubleSide })
    );
    signPlate.position.set(82.6, 1.62, 73.2);
    root.add(signPlate);
  }

  /* Build customer NPCs who follow queue order strictly */
  function buildNPCs(root) {
    npcs = [];
    for (var i = 0; i < NPC_COUNT; i++) {
      var look = V.randomLook(i * 137 + 43);
      var g = V.makePerson(look);
      var meta = SCHOLAR_NAMES[i % SCHOLAR_NAMES.length];

      /* Food tray mesh (carried while walking to table) */
      var tray = new T.Group();
      var trayWood = new T.Mesh(new T.BoxGeometry(0.65, 0.05, 0.45), new T.MeshLambertMaterial({ color: 0x6E4A28 }));
      tray.add(trayWood);
      var cup = new T.Mesh(new T.CylinderGeometry(0.08, 0.06, 0.16, 8), new T.MeshLambertMaterial({ color: 0xF5F0E6 }));
      cup.position.set(-0.16, 0.1, 0); tray.add(cup);
      var snack = new T.Mesh(new T.BoxGeometry(0.18, 0.08, 0.18), new T.MeshLambertMaterial({ color: 0xD48830 }));
      snack.position.set(0.14, 0.07, 0); tray.add(snack);
      tray.position.set(0, V.PERSON.handY + 0.14, 0.5);
      tray.scale.setScalar(1.5);
      tray.visible = false;
      g.add(tray);

      var startState = "eating";
      var seat = TABLE_SPOTS[i % TABLE_SPOTS.length];
      var sx = seat.x, sz = seat.z;
      var qp = -1;

      /* First 3 start in queue slots strictly */
      if (i < 3) {
        startState = "in-queue";
        qp = i;
        sx = QUEUE_SLOTS[i].x;
        sz = QUEUE_SLOTS[i].z;
        g.rotation.y = Math.PI; /* Face north towards Rowan */
      } else {
        g.rotation.y = seat.r;
      }

      g.position.set(sx, 0, sz);
      root.add(g);

      npcs.push({
        id: "npc-" + i,
        name: meta.name,
        role: meta.role,
        emoji: meta.emoji,
        g: g,
        tray: tray,
        tableDish: null,
        state: startState,
        tx: sx,
        tz: sz,
        t: Math.random() * 10,
        seatIdx: i % TABLE_SPOTS.length,
        idleLeft: 10 + Math.random() * 10,
        queuePos: qp,
        path: []
      });
      /* the rest are already part-way through a meal, so the room is alive
         from the first frame instead of waiting on the queue */
      if (startState === "eating") sitDown(npcs[npcs.length - 1], 8 + Math.random() * 30);
    }
    V.restaurantNPCs = npcs;

    /* Prime queue state with the initial 3 NPCs in strict FIFO order */
    queue = ["npc-0", "npc-1", "npc-2"];
  }

  /* ---------------------------------------------------- movement helpers */
  /* Walk a list of points in order; the last one is where they stop. */
  function route(n, pts) {
    n.path = pts.slice(1);
    n.tx = pts[0].x; n.tz = pts[0].z;
  }
  /* setPose folds or unfolds the legs; only call it on a change */
  function setPose(n, pose) {
    if (n.g.userData.pose !== pose) V.setPose(n.g, pose);
  }
  function freeSeat(n) {
    var free = [];
    TABLE_SPOTS.forEach(function (s, i) {
      var taken = npcs.some(function (m) {
        return m !== n && m.seatIdx === i && (m.state === "eating" || m.state === "walking-to-table");
      });
      if (!taken) free.push(i);
    });
    return free.length ? free[Math.floor(Math.random() * free.length)] : -1;
  }
  /* Sit at the NPC's seat and put the meal on the table for `secs`. */
  function sitDown(n, secs) {
    var seat = TABLE_SPOTS[n.seatIdx % TABLE_SPOTS.length];
    n.state = "eating";
    n.tray.visible = false;
    n.g.position.x = seat.x; n.g.position.z = seat.z;
    n.g.rotation.y = seat.r;
    setPose(n, "sit");
    /* these chairs are 0.04 lower than the campus ones setPose assumes */
    n.g.userData.yOffset -= 0.04;
    if (sceneRoot) {
      var tableDish = createFoodDish();
      tableDish.position.set(seat.tx, 1.9, seat.tz);
      sceneRoot.add(tableDish);
      n.tableDish = tableDish;
      servedDishes.push({ mesh: tableDish, timeLeft: secs, ownerNpc: n });
    }
    n.idleLeft = secs;
  }

  /* ---------------------------------------------------- queue logic */
  api.playerJoin = function () {
    if (playerInQueue) return false;
    playerInQueue = true;
    playerAtFront = false;
    /* Strict order: Player joins at the tail */
    queue.push("player");
    syncNPCQueuePositions();
    return true;
  };

  api.playerLeave = function () {
    playerInQueue = false;
    playerAtFront = false;
    var i = queue.indexOf("player");
    if (i >= 0) queue.splice(i, 1);
    syncNPCQueuePositions();
  };

  api.playerPosition = function () {
    if (!playerInQueue) return -1;
    return queue.indexOf("player"); /* 0 = at counter */
  };

  api.isPlayerAtFront = function () { return playerAtFront; };
  api.isPlayerInQueue = function () { return playerInQueue; };

  /* Sync target positions for customer NPCs strictly matching their slot */
  function syncNPCQueuePositions() {
    npcs.forEach(function (n) {
      var pos = queue.indexOf(n.id);
      if (pos >= 0) {
        n.state = "in-queue";
        n.queuePos = pos;
        setPose(n, "stand");
        var slot = QUEUE_SLOTS[Math.min(pos, QUEUE_SLOTS.length - 1)];
        var gp = n.g.position;
        /* already in the lane: step up; otherwise walk round to its open end */
        if (inLane(gp.x, gp.z)) route(n, [slot]);
        else route(n, [{ x: sideX(gp.x), z: LANE_ENTRY_Z }, { x: LANE_X, z: LANE_ENTRY_Z }, slot]);
        n.tray.visible = false;
      }
    });
  }

  /* Fill queue strictly from back when short */
  function refillQueue() {
    if (queue.length >= 4) return;
    for (var i = 0; i < npcs.length; i++) {
      var n = npcs[i];
      if (queue.indexOf(n.id) === -1 && n.state === "stroll") {
        queue.push(n.id);
        syncNPCQueuePositions();
        break;
      }
    }
  }

  /* Advance queue strictly one-by-one: Front customer gets served */
  function advanceQueue() {
    if (!queue.length) return;
    var front = queue.shift();

    if (front === "player") {
      playerInQueue = false;
      playerAtFront = false;
    } else {
      /* Front NPC served in proper order! */
      var frontNpc = npcs.filter(function (n) { return n.id === front; })[0];
      if (frontNpc) {
        frontNpc.queuePos = -1;
        frontNpc.tray.visible = true;
        var sIdx = freeSeat(frontNpc);
        var exitX = sIdx >= 0 ? sideX(TABLE_SPOTS[sIdx].x) : sideX(Math.random() < 0.5 ? 0 : 999);
        var out = { x: exitX, z: LANE_EXIT_Z };
        if (sIdx >= 0) {
          /* out of the lane at the counter end, round to the chair, sit */
          frontNpc.state = "walking-to-table";
          frontNpc.seatIdx = sIdx;
          var seat = TABLE_SPOTS[sIdx];
          route(frontNpc, [out, seatApproach(seat), { x: seat.x, z: seat.z }]);
        } else {
          /* every chair taken: take it away and eat standing on the patio */
          frontNpc.state = "stroll";
          frontNpc.idleLeft = 14 + Math.random() * 10;
          route(frontNpc, [out, wanderSpot(exitX)]);
        }
      }
    }

    /* Check if player has now reached the front */
    if (playerInQueue && queue.length > 0 && queue[0] === "player") {
      playerAtFront = true;
      notifyPlayerTurn();
    } else if (playerInQueue && queue.length === 0) {
      playerAtFront = true;
      notifyPlayerTurn();
    }

    /* All remaining customers in line take a step forward into their new slot */
    syncNPCQueuePositions();
    refillQueue();
  }

  /* Staff explicitly calls player's name when it is their turn */
  function notifyPlayerTurn() {
    var pName = (api.hooks.displayName && api.hooks.displayName()) || "Resident";
    if (rowan) {
      rowan.bubble = "☕ " + pName + ", your turn! Step right up!";
    }
    if (owner) {
      owner.bubble = "✨ " + pName + " is up at the counter! Enjoy your meal, darling!";
    }
    if (api.hooks.onPlayerAtFront) {
      api.hooks.onPlayerAtFront(pName);
    }
  }

  function notifyFoodReady() {
    var pName = (api.hooks.displayName && api.hooks.displayName()) || "Resident";
    if (rowan) rowan.bubble = "☕ " + pName + ", your order is ready! Walk to the counter and press C.";
    if (owner) owner.bubble = "✨ " + pName + ", your food is waiting at the counter!";
    if (api.hooks.onFoodReady) api.hooks.onFoodReady(pName, pendingOrder.item.name);
  }

  /* Buy an item: deduct points, serve food visible for 50s */
  api.buyItem = function (itemId) {
    var item = MENU.filter(function (m) { return m.id === itemId; })[0];
    if (!item) return false;
    if (pendingOrder || heldFood) return false;
    if (!api.hooks.getPoints) return false;
    var pts = api.hooks.getPoints();
    if (pts < item.cost) return false;
    api.hooks.addPoints(-item.cost);

    /* Player departs queue */
    api.playerLeave();

    /* Rowan starts a real 50-second preparation period. */
    var pName = (api.hooks.displayName && api.hooks.displayName()) || "Resident";
    pendingOrder = { item: item, name: pName, prepLeft: PREP_SECONDS, ready: false, dish: null };
    lastServed = { name: pName, item: item.name, emoji: item.emoji, at: Date.now(), state: "preparing", seconds: PREP_SECONDS };
    if (rowan) {
      rowan.bubble = "I am preparing your " + item.name + ", " + pName + ". It will take 50 seconds.";
      setTimeout(function () {
        if (rowan && !pendingOrder) rowan.bubble = "Next in line, please! ☕";
      }, 5000);
    }

    /* Toast */
    if (api.hooks.toast) {
      api.hooks.toast(item.emoji + " <b>" + item.name + "</b> — Rowan is preparing it for 50 seconds. <span class=\"pts\">−" + item.cost + "</span>");
    }
    return true;
  };
  api.lastServed = function () { return lastServed; };
  api.collectFood = function () {
    if (!pendingOrder || !pendingOrder.ready) return false;
    var pp = api.hooks.getPlayerPosition && api.hooks.getPlayerPosition();
    if (!pp || Math.hypot(pp.x - COUNTER_X, pp.z - COUNTER_Z) > 4.5) {
      if (api.hooks.toast) api.hooks.toast("Walk to Rowan at the counter first, then press <b>C</b>.");
      return false;
    }
    var playerObject = api.hooks.getPlayerObject && api.hooks.getPlayerObject();
    if (!playerObject || !sceneRoot) return false;
    if (pendingOrder.dish && pendingOrder.dish.parent) pendingOrder.dish.parent.remove(pendingOrder.dish);
    var held = createFoodDish();
    held.position.set(0.3, 1.06, 0.62);
    playerObject.add(held);
    heldFood = { mesh: held, timeLeft: HOLD_SECONDS };
    lastServed.state = "collected";
    lastServed.at = Date.now();
    if (rowan) rowan.bubble = "Enjoy your " + pendingOrder.item.name + ", " + pendingOrder.name + "! Come back soon. ☕✨";
    if (api.hooks.toast) api.hooks.toast(pendingOrder.item.emoji + " <b>Food collected!</b> Rowan handed your " + pendingOrder.item.name + " to you. It stays with you for 30 seconds.");
    pendingOrder = null;
    return true;
  };

  /* Get array of { id, name, emoji, role, isPlayer, pos } currently in the queue */
  api.getQueueLineup = function () {
    var out = [];
    queue.forEach(function (id, idx) {
      if (id === "player") {
        out.push({ id: "player", name: (api.hooks.displayName ? api.hooks.displayName() : "You"), emoji: "⭐", isPlayer: true, pos: idx });
      } else {
        var n = npcs.filter(function (npc) { return npc.id === id; })[0];
        if (n) {
          out.push({ id: n.id, name: n.name, emoji: n.emoji, role: n.role, isPlayer: false, pos: idx });
        }
      }
    });
    return out;
  };

  /* ---------------------------------------------------- NPC animation */
  function updateNPCs(dt, playerPos) {
    npcs.forEach(function (n) {
      n.t += dt;
      var dx = n.tx - n.g.position.x;
      var dz = n.tz - n.g.position.z;
      var d = Math.hypot(dx, dz);
      /* reached a waypoint with more to go: head for the next one */
      if (d <= 0.35 && n.path && n.path.length) {
        var next = n.path.shift();
        n.tx = next.x; n.tz = next.z;
        dx = n.tx - n.g.position.x; dz = n.tz - n.g.position.z;
        d = Math.hypot(dx, dz);
      }
      var moving = d > 0.35;

      if (moving) {
        setPose(n, "stand");
        var sp = Math.min(d, 2.4 * dt);
        n.g.position.x += (dx / d) * sp;
        n.g.position.z += (dz / d) * sp;
        var want = Math.atan2(dx, dz);
        var diff = ((want - n.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        n.g.rotation.y += diff * Math.min(1, dt * 8);
        V.animatePerson(n.g, true, n.t, 0.9);
      } else if (n.state === "in-queue") {
        /* in line: face Rowan */
        var faceCounter = Math.PI;
        var fDiff = ((faceCounter - n.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        n.g.rotation.y += fDiff * Math.min(1, dt * 6);
        V.animatePerson(n.g, false, n.t, 1);
      } else if (n.state === "walking-to-table") {
        /* at the chair: sit, and the meal goes on the table for 50 seconds */
        sitDown(n, 50.0);
      } else if (n.state === "eating") {
        V.animatePerson(n.g, false, n.t, 0.5);
        n.idleLeft -= dt;
        if (n.idleLeft <= 0) {
          /* finished: up from the chair, back out to the aisle, off for a wander */
          var seat = TABLE_SPOTS[n.seatIdx % TABLE_SPOTS.length];
          n.state = "stroll";
          setPose(n, "stand");
          route(n, [seatApproach(seat), wanderSpot(seat.x)]);
          n.idleLeft = 6 + Math.random() * 8;
        }
      } else if (n.state === "stroll") {
        V.animatePerson(n.g, false, n.t, 0.8);
        n.idleLeft -= dt;
        if (n.idleLeft <= 0) {
          if (queue.length < 4 && queue.indexOf(n.id) === -1) {
            queue.push(n.id);
            syncNPCQueuePositions();
          } else {
            /* the queue is full: mill about the patio a little longer */
            route(n, [wanderSpot(n.g.position.x)]);
            n.idleLeft = 5 + Math.random() * 7;
          }
        }
      }

      /* Cull distant NPCs */
      if (playerPos) {
        var far = Math.abs(n.g.position.x - playerPos.x) + Math.abs(n.g.position.z - playerPos.z);
        n.g.visible = far < 380;
      }
    });

    /* Rowan barista animation & dialogue updates */
    if (rowan && rowan.g) {
      rowan.t += dt;
      /* Rowan works the counter — espresso machine, till, pastry case — and
         comes back to the till whenever the player is served or food is up */
      var needTill = queue[0] === "player" || (pendingOrder && pendingOrder.ready);
      rowan.idleLeft = (rowan.idleLeft == null ? 4 : rowan.idleLeft) - dt;
      if (needTill) rowan.tx = COUNTER_X;
      else if (rowan.idleLeft <= 0) {
        rowan.tx = [COUNTER_X - 2.2, COUNTER_X, COUNTER_X + 2.1][Math.floor(Math.random() * 3)];
        rowan.idleLeft = 4 + Math.random() * 5;
      }
      var rdx = (rowan.tx == null ? COUNTER_X : rowan.tx) - rowan.g.position.x;
      if (Math.abs(rdx) > 0.1) {
        rowan.g.position.x += Math.sign(rdx) * Math.min(Math.abs(rdx), 1.3 * dt);
        rowan.g.rotation.y += ((rdx > 0 ? Math.PI / 2 : -Math.PI / 2) - rowan.g.rotation.y) * Math.min(1, dt * 8);
        V.animatePerson(rowan.g, true, rowan.t, 0.6);
      } else {
        rowan.g.rotation.y += (0 - rowan.g.rotation.y) * Math.min(1, dt * 6);   /* face the customers */
        V.animatePerson(rowan.g, false, rowan.t * 0.7, 0.6);
      }

      if (queue.length > 0) {
        if (queue[0] === "player") {
          var pName = (api.hooks.displayName && api.hooks.displayName()) || "Resident";
          rowan.bubble = "☕ " + pName + ", what can I get for you today?";
          /* Wave right arm */
          var rig = rowan.g.userData.rig;
          if (rig && rig.rArm) rig.rArm.rotation.x = -1.1 + Math.sin(rowan.t * 3) * 0.25;
        } else {
          var frontCustomer = npcs.filter(function (n) { return n.id === queue[0]; })[0];
          rowan.bubble = frontCustomer ? ("One hot order coming up for " + frontCustomer.name.split(" ")[0] + "! ✨") : "Next in line, please! ☕";
        }
      } else {
        rowan.bubble = "Next in line, please! ☕";
      }
    }

    /* Madame Bernadette (Cafe Owner) strolls veranda & greets scholars */
    if (owner && owner.g) {
      owner.t += dt;
      var odx = owner.tx - owner.g.position.x;
      var odz = owner.tz - owner.g.position.z;
      var od = Math.hypot(odx, odz);
      var oMoving = od > 0.4;

      if (oMoving) {
        var osp = 1.6 * dt;
        owner.g.position.x += (odx / od) * osp;
        owner.g.position.z += (odz / od) * osp;
        var owant = Math.atan2(odx, odz);
        var odiff = ((owant - owner.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        owner.g.rotation.y += odiff * Math.min(1, dt * 6);
        V.animatePerson(owner.g, true, owner.t, 0.7);
      } else {
        V.animatePerson(owner.g, false, owner.t * 0.7, 0.6);
        owner.idleLeft -= dt;
        if (owner.idleLeft <= 0) {
          owner.wayIdx = (owner.wayIdx + 1) % owner.waypoints.length;
          var wp = owner.waypoints[owner.wayIdx];
          owner.tx = wp.x;
          owner.tz = wp.z;
          owner.bubble = wp.b;
          owner.idleLeft = 9 + Math.random() * 8;
        }
      }

      if (playerPos) {
        var ofar = Math.abs(owner.g.position.x - playerPos.x) + Math.abs(owner.g.position.z - playerPos.z);
        owner.g.visible = ofar < 380;
      }
    }
  }

  /* ---------------------------------------------------- update */
  api.update = function (dt, playerPos) {
    if (pendingOrder && !pendingOrder.ready) {
      pendingOrder.prepLeft -= dt;
      if (lastServed) lastServed.seconds = Math.max(0, Math.ceil(pendingOrder.prepLeft));
      if (pendingOrder.prepLeft <= 0) {
        pendingOrder.ready = true;
        lastServed.state = "ready";
        lastServed.seconds = 0;
        if (sceneRoot) {
          var readyDish = createFoodDish();
          readyDish.position.set(COUNTER_X + 1.2, 1.26, COUNTER_Z);
          sceneRoot.add(readyDish);
          pendingOrder.dish = readyDish;
        }
        notifyFoodReady();
      }
    }
    if (heldFood) {
      heldFood.timeLeft -= dt;
      if (heldFood.timeLeft <= 0) {
        if (heldFood.mesh.parent) heldFood.mesh.parent.remove(heldFood.mesh);
        heldFood = null;
        lastServed = null;
      }
    }
    /* Advance queue strictly */
    queueTick += dt;
    if (queueTick >= ADVANCE_INTERVAL) {
      queueTick = 0;
      advanceQueue();
      refillQueue();
    }
    if (npcs.length) updateNPCs(dt, playerPos);

    /* Update served dishes: count down 50 seconds, then remove food */
    for (var dIdx = servedDishes.length - 1; dIdx >= 0; dIdx--) {
      var sd = servedDishes[dIdx];
      sd.timeLeft -= dt;
      if (sd.serving) {
        sd.progress = Math.min(1, sd.progress + dt / 1.2);
        var eased = 1 - Math.pow(1 - sd.progress, 3);
        sd.mesh.position.x = sd.from.x + (sd.to.x - sd.from.x) * eased;
        sd.mesh.position.y = sd.from.y + (sd.to.y - sd.from.y) * eased;
        sd.mesh.position.z = sd.from.z + (sd.to.z - sd.from.z) * eased;
        if (sd.progress >= 1) sd.serving = 0;
      }
      if (sd.mesh.userData && sd.mesh.userData.steam) {
        sd.mesh.userData.steam.position.y = 0.26 + Math.sin(sd.timeLeft * 3.5) * 0.03;
      }
      if (sd.timeLeft <= 0) {
        /* Exactly 50s reached — make food disappear! */
        if (sd.mesh.parent) sd.mesh.parent.remove(sd.mesh);
        if (sd.ownerNpc) sd.ownerNpc.tableDish = null;
        servedDishes.splice(dIdx, 1);
      }
    }
  };

  /* ---------------------------------------------------- init */
  api.init = function (h) {
    api.hooks = h || {};
  };

  api.queue = queue;

})();
