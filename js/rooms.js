/* Quantum Village — seminar and discussion rooms.
 *
 * A room is any interior with registered seats. Seminar rooms, lecture halls
 * and discussion rooms also have a stage in front of the board, which is what
 * "speak" means: your avatar leaves the table, walks to the blackboard and
 * becomes the focus of the room while everybody else stays seated.
 *
 * Seats and the speaking slot are claimed through QVNet, which uses a
 * transaction, so two people cannot take the same chair. Both are released
 * on disconnect, and the state travels in the ordinary presence payload —
 * no extra writes.
 */
(function () {
  "use strict";
  var V = window.QV;
  /* Resolved on use, not at load: the order of the script tags should not be
     able to break this file. */
  function net() { return window.QVNet; }

  var api = {};
  var hooks = {};                /* set by app.js: walkTo, player, toast */
  var state = {
    roomId: null,                /* the interior we are standing in */
    seat: null,                  /* the seat object we hold */
    seatIndex: -1,               /* its position in the room's seat list */
    speaking: false,
    goal: null                   /* a scripted walk in progress */
  };
  var occupancy = {};            /* roomId -> { seats:{n:uid}, speaker:uid } */
  var watching = {};             /* roomId -> unsubscribe */
  var roomById = {};
  var seatsByRoom = {};

  api.init = function (h) {
    hooks = h || {};
    (V.ROOMS || []).forEach(function (r) { roomById[r.id] = r; });
    (V.seats || []).forEach(function (s) {
      (seatsByRoom[s.room] = seatsByRoom[s.room] || []).push(s);
    });
    /* seat numbers are per room and stable, because they come from build order */
    Object.keys(seatsByRoom).forEach(function (rid) {
      seatsByRoom[rid].forEach(function (s, i) { s.n = i; });
    });
  };

  api.roomOf = function (id) { return roomById[id] || null; };
  api.seatsOf = function (id) { return seatsByRoom[id] || []; };
  api.state = function () { return state; };
  api.occupancyOf = function (id) { return occupancy[id] || { seats: {}, speaker: null }; };
  /* true while the avatar is not under the player's control */
  api.locked = function () { return !!state.seat || !!state.goal; };
  api.isSeated = function () { return !!state.seat; };
  api.isSpeaking = function () { return state.speaking; };

  /* ------------------------------------------------------ room presence */
  function watch(roomId) {
    if (!roomId || watching[roomId]) return;
    try {
      watching[roomId] = net().watchRoom(roomId, function (st) {
        occupancy[roomId] = st || { seats: {}, speaker: null };
        if (hooks.onRoomState) hooks.onRoomState(roomId, occupancy[roomId]);
      });
    } catch (e) { console.warn("[village] room watch failed:", e && e.message); }
  }
  function unwatchAll(except) {
    Object.keys(watching).forEach(function (id) {
      if (id === except) return;
      try { watching[id](); } catch (e) {}
      delete watching[id];
    });
  }

  /* Which room is the player standing in? Derived from the interior they
     are inside, so there is no separate trigger volume to get out of sync.
     Asked directly rather than read from the cached value, so this does not
     depend on V.update having already run this frame. */
  function currentRoomId(pos) {
    var inside = pos ? V.insideOf(pos.x, pos.z) : V.currentInterior();
    return inside ? inside.id : null;
  }

  /* ------------------------------------------------------------- seating */
  api.nearestSeat = function (x, z, maxDist) {
    var rid = state.roomId;
    if (!rid) return null;
    var list = seatsByRoom[rid] || [];
    var occ = occupancy[rid] || { seats: {} };
    var best = null, bd = maxDist == null ? 3.6 : maxDist;
    var me = myId();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var taken = occ.seats[s.n];
      if (taken && taken !== me) continue;
      var d = Math.hypot(x - s.x, z - s.z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  };
  function myId() {
    var N = net();
    var u = N && N.user && N.user();
    return u ? u.uid : (window.QVLocalId || "guest");
  }

  api.sit = function (seat) {
    if (state.seat) return Promise.resolve(false);
    var rid = state.roomId;
    seat = seat || api.nearestSeat(hooks.player().position.x, hooks.player().position.z);
    if (!seat || !rid) return Promise.resolve(false);
    return net().claimSeat(rid, seat.n).then(function (got) {
      if (!got) { if (hooks.toast) hooks.toast("Someone got there first."); return false; }
      state.seat = seat; state.seatIndex = seat.n;
      var p = hooks.player();
      p.position.x = seat.x; p.position.z = seat.z;
      p.rotation.y = seat.ry;
      V.setPose(p, "sit");
      /* tiered lecture benches sit higher than the floor */
      if (seat.y) p.userData.yOffset = (p.userData.yOffset || 0) + seat.y;
      if (hooks.onChange) hooks.onChange();
      return true;
    });
  };

  api.stand = function () {
    if (!state.seat) return Promise.resolve(false);
    var rid = state.roomId, seat = state.seat;
    state.seat = null; state.seatIndex = -1;
    var p = hooks.player();
    V.setPose(p, "stand");
    /* step clear of the chair so pressing E again does not re-seat you */
    var out = V.clearSpot(seat.x + Math.sin(seat.ry) * 2.2, seat.z + Math.cos(seat.ry) * 2.2, 1.1);
    p.position.x = out.x; p.position.z = out.z;
    if (hooks.onChange) hooks.onChange();
    return net().releaseSeat(rid, seat.n).then(function () { return true; });
  };

  /* ------------------------------------------------------------ speaking */
  api.canSpeak = function () {
    var r = roomById[state.roomId];
    if (!r || !r.stage) return false;
    var occ = occupancy[state.roomId] || {};
    return !occ.speaker || occ.speaker === myId();
  };

  api.speak = function () {
    var r = roomById[state.roomId];
    if (!r || !r.stage || state.speaking) return Promise.resolve(false);
    var rid = state.roomId;
    var fromSeat = state.seat;
    return net().claimSpeaker(rid).then(function (got) {
      if (!got) { if (hooks.toast) hooks.toast("Someone else has the board."); return false; }
      state.speaking = true;
      state.returnTo = fromSeat || null;
      /* leave the table first, then walk to the board */
      var release = fromSeat ? net().releaseSeat(rid, fromSeat.n) : Promise.resolve();
      state.seat = null; state.seatIndex = -1;
      V.setPose(hooks.player(), "stand");
      walkScripted(r.stage.x, r.stage.z, r.stage.ry, function () {
        V.setPose(hooks.player(), "speak");
        if (hooks.onChange) hooks.onChange();
      });
      /* Taking the board is the start of something: tell the village what
         and where, so people can come if they want to. */
      if (hooks.onSpeakStart) hooks.onSpeakStart(r);
      if (hooks.onChange) hooks.onChange();
      return release.then(function () { return true; });
    });
  };

  api.stopSpeaking = function () {
    if (!state.speaking) return Promise.resolve(false);
    var rid = state.roomId, back = state.returnTo;
    state.speaking = false; state.returnTo = null;
    V.setPose(hooks.player(), "stand");
    if (hooks.onSpeakEnd) hooks.onSpeakEnd(rid);
    if (hooks.onChange) hooks.onChange();
    return net().releaseSpeaker(rid).then(function () {
      if (back) {
        walkScripted(back.x, back.z, back.ry, function () {
          api.sit(back);
        });
      }
      return true;
    });
  };

  /* A short automatic walk. The player keeps the camera; only the feet are
     on rails, and pressing a movement key cancels it. */
  function walkScripted(x, z, ry, done) {
    state.goal = { x: x, z: z, ry: ry, done: done, t: 0 };
    if (hooks.walkTo) hooks.walkTo(x, z);
  }
  api.cancelScripted = function () {
    if (!state.goal) return;
    var g = state.goal; state.goal = null;
    if (g.done) g.done();
  };

  /* -------------------------------------------------------------- update */
  api.update = function (dt, playerPos) {
    var rid = currentRoomId(playerPos);

    if (rid !== state.roomId) {
      /* leaving a room gives up whatever was held in it */
      if (state.seat || state.speaking) api.leave();
      state.roomId = rid;
      if (rid) { watch(rid); }
      unwatchAll(rid);
      if (hooks.onChange) hooks.onChange();
    }

    if (state.goal) {
      state.goal.t += dt;
      var d = Math.hypot(playerPos.x - state.goal.x, playerPos.z - state.goal.z);
      if (d < 1.4 || state.goal.t > 12) {
        var g = state.goal; state.goal = null;
        var p = hooks.player();
        p.rotation.y = g.ry == null ? p.rotation.y : g.ry;
        if (g.done) g.done();
      }
    }

    /* held a seat but wandered off it somehow: let it go */
    if (state.seat && playerPos) {
      var away = Math.hypot(playerPos.x - state.seat.x, playerPos.z - state.seat.z);
      if (away > 2.4) api.stand();
    }
  };

  /* Give up everything in the current room. */
  api.leave = function () {
    var rid = state.roomId;
    var p = hooks.player && hooks.player();
    if (p) V.setPose(p, "stand");
    var jobs = [];
    if (state.seat) { jobs.push(net().releaseSeat(rid, state.seat.n)); state.seat = null; state.seatIndex = -1; }
    if (state.speaking) { jobs.push(net().releaseSpeaker(rid)); state.speaking = false; }
    state.returnTo = null; state.goal = null;
    if (hooks.onChange) hooks.onChange();
    return Promise.all(jobs).catch(function () {});
  };

  /* ---------------------------------------------------- what to show/say */
  /* The prompt for whatever the player could do here, or null. */
  api.prompt = function (x, z) {
    if (state.goal) return { key: "", label: "Walking to the board…", act: null };
    if (state.speaking) return { key: "E", label: "Finish speaking", act: "stop-speaking" };
    if (state.seat) {
      var r = roomById[state.roomId];
      if (r && r.stage && api.canSpeak()) return { key: "E", label: "Speak at the board", act: "speak", alt: { key: "Q", label: "Stand up", act: "stand" } };
      return { key: "E", label: "Stand up", act: "stand" };
    }
    if (!state.roomId) return null;
    var seat = api.nearestSeat(x, z);
    if (seat) return { key: "E", label: "Sit down", act: "sit", seat: seat };
    var room = roomById[state.roomId];
    if (room && room.stage && api.canSpeak()) {
      var d = Math.hypot(x - room.stage.x, z - room.stage.z);
      if (d < 5) return { key: "E", label: "Speak at the board", act: "speak" };
    }
    return null;
  };

  api.act = function (what, arg) {
    if (what === "sit") return api.sit(arg);
    if (what === "stand") return api.stand();
    if (what === "speak") return api.speak();
    if (what === "stop-speaking") return api.stopSpeaking();
    return Promise.resolve(false);
  };

  /* How many people are in this room right now, from presence. */
  api.peopleIn = function (roomId, peers) {
    var out = [];
    Object.keys(peers || {}).forEach(function (k) {
      if (peers[k].room === roomId) out.push(peers[k]);
    });
    return out;
  };

  window.QVRooms = api;
})();
