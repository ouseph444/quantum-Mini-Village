/* Quantum Village — residents, movement, research layer. */
(function () {
  "use strict";
  var V = window.QV, T = window.THREE, Net = window.QVNet;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }

  /* ============================================================ resident */
  var LS = "qv.resident.v1";
  var me = {
    id:"", name:"", title:"", orcid:"", inst:"", country:"",
    look:null, shelf:[], points:0, visited:{}, seen:0, joined:0
  };
  try { var raw = localStorage.getItem(LS); if (raw) me = Object.assign(me, JSON.parse(raw)); } catch (e) {}
  if (!me.id) me.id = "v" + Math.random().toString(36).slice(2, 10);
  if (!me.look) me.look = V.randomLook();
  else me.look = V.normalizeLook(me.look);
  if (!me.joined) me.joined = Date.now();
  window.QVLocalId = me.id;
  function saveMe() { try { localStorage.setItem(LS, JSON.stringify(me)); } catch (e) {} }

  /* ========================================================== who you are
     A resident is a physicist, so the village asks for the things a
     physicist is actually known by: how they are addressed, where they
     work, and — if they have one — the ORCID iD that identifies them on
     every paper they have ever written. */
  var TITLES = ["Dr", "Prof", "Mr", "Mrs", "Ms"];
  var COUNTRIES = ("Argentina,Australia,Austria,Bangladesh,Belgium,Brazil,Bulgaria,Canada,Chile,China,Colombia,Croatia," +
    "Czechia,Denmark,Egypt,Estonia,Ethiopia,Finland,France,Germany,Ghana,Greece,Hungary,Iceland,India,Indonesia,Iran," +
    "Ireland,Israel,Italy,Japan,Jordan,Kazakhstan,Kenya,Latvia,Lebanon,Lithuania,Luxembourg,Malaysia,Mexico,Morocco," +
    "Netherlands,New Zealand,Nigeria,Norway,Pakistan,Peru,Philippines,Poland,Portugal,Qatar,Romania,Russia,Saudi Arabia," +
    "Serbia,Singapore,Slovakia,Slovenia,South Africa,South Korea,Spain,Sri Lanka,Sweden,Switzerland,Taiwan,Thailand," +
    "Tunisia,Turkey,Ukraine,United Arab Emirates,United Kingdom,United States,Uruguay,Vietnam").split(",");

  /* ORCID iDs are sixteen digits in groups of four; the last one is a
     MOD 11-2 check character, which is why a typo can be caught here
     rather than by a puzzled colleague later. */
  function orcidDigits(v) { return String(v || "").toUpperCase().replace(/[^0-9X]/g, "").slice(0, 16); }
  function fmtOrcid(v) {
    var d = orcidDigits(v), out = [];
    for (var i = 0; i < d.length; i += 4) out.push(d.slice(i, i + 4));
    return out.join("-");
  }
  function orcidOk(v) {
    var d = orcidDigits(v);
    if (d.length !== 16 || /X/.test(d.slice(0, 15))) return false;
    var total = 0;
    for (var i = 0; i < 15; i++) total = (total + +d[i]) * 2;
    var check = (12 - (total % 11)) % 11;
    return (check === 10 ? "X" : String(check)) === d[15];
  }
  function orcidUrl(v) { return "https://orcid.org/" + fmtOrcid(v); }

  /* The name on the lane, with the title in front of it when there is one. */
  function displayName(who) {
    var w = who || me, n = (w.name || "").trim() || "Resident";
    return ((w.title || "") + " " + n).trim().slice(0, 32);
  }
  /* "Prof · CERN · Switzerland" — whichever parts of it exist. */
  function affiliation(who) {
    var w = who || me;
    return [w.inst, w.country].filter(Boolean).join(" · ");
  }

  /* Hyphens appear as you type, and the iD is judged only once you have
     typed all sixteen digits — nobody wants to be told they are wrong
     while still halfway through. */
  function wireOrcidField(input, hint) {
    var say = function () {
      var raw = orcidDigits(input.value);
      input.classList.remove("bad", "good");
      if (!raw.length) { hint.textContent = HINT_ORCID; hint.className = "hint"; return; }
      if (raw.length < 16) { hint.textContent = "Keep going — " + raw.length + " of 16."; hint.className = "hint"; return; }
      var ok = orcidOk(raw);
      input.classList.add(ok ? "good" : "bad");
      hint.textContent = ok ? "Checks out." : "That iD fails its check digit — look for a transposed pair.";
      hint.className = "hint " + (ok ? "ok" : "no");
    };
    input.addEventListener("input", function () {
      var end = input.selectionStart === input.value.length;
      input.value = fmtOrcid(input.value);
      if (end) try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
      say();
    });
    say();
  }
  var HINT_ORCID = "Sixteen digits, as printed on your ORCID record. We check it before you walk in.";

  /* Reads one of the two identity forms into the resident, refusing only
     an ORCID iD that is present and wrong. Everything but the name is
     optional, so a visitor with no affiliation still gets in. */
  function applyIdentity(f, hint) {
    var orcid = orcidDigits(f.orcid.value);
    if (orcid.length && !orcidOk(orcid)) {
      f.orcid.classList.add("bad");
      if (hint) { hint.textContent = "That ORCID iD is not valid. Clear it, or correct it, to carry on."; hint.className = "hint no"; }
      f.orcid.focus();
      return false;
    }
    me.name = f.name.value.trim().slice(0, 22) || "Resident";
    me.title = TITLES.indexOf(f.title.value) >= 0 ? f.title.value : "";
    me.orcid = orcid.length ? fmtOrcid(orcid) : "";
    me.inst = f.inst.value.trim().slice(0, 90);
    me.country = f.country.value.trim().slice(0, 56);
    saveMe();
    publishResident();
    return true;
  }

  /* The card other residents can look up, kept beside the live presence. */
  function publishResident() {
    Net.docSet("residents/" + (me.uid || me.id), {
      name:me.name, title:me.title, orcid:me.orcid, inst:me.inst, country:me.country,
      look:V.normalizeLook(me.look), at:Date.now()
    }).catch(function () {});
  }

  /* ============================================================== papers */
  var TOPICS = window.QC_TOPICS, PAPERS = window.QC_PAPERS, CANON = window.QC_CANON;
  var topicById = {};
  TOPICS.forEach(function (t) { topicById[t.id] = t; });

  function arxivWhen(id) {
    var m = /^(\d{2})(\d{2})\./.exec(id);
    if (!m) return { label:"earlier", key:0 };
    var names = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var y = 2000 + +m[1], mo = +m[2];
    return { label:(names[mo] || "") + " " + y, key:y * 12 + mo };
  }
  /* Links are derived from the identifier — no URL is ever entered by hand. */
  function absUrl(id) { return "https://arxiv.org/abs/" + id; }
  function pdfUrl(id) { return "https://arxiv.org/pdf/" + id; }
  function findUrl(q) { return "https://arxiv.org/search/?searchtype=all&query=" + encodeURIComponent(q); }

  PAPERS.forEach(function (p) {
    var w = arxivWhen(p.i);
    p.when = w.label; p.key = w.key;
    p.url = absUrl(p.i); p.pdf = pdfUrl(p.i);
    var t = topicById[p.t] || {};
    p.tname = t.name || p.t; p.arch = t.arch || "";
    p.hue = "#" + (V.TOPIC_HUES[p.t] || 0x4FA8B8).toString(16).padStart(6, "0");
    p.search = (p.n + " " + p.tname + " " + (t.kw || []).join(" ")).toLowerCase();
  });
  PAPERS.sort(function (a, b) { return b.key - a.key; });
  CANON.forEach(function (c) {
    var t = topicById[c.t] || {};
    c.url = findUrl(c.n + " " + c.a);
    c.tname = t.name || c.t;
    c.hue = "#" + (V.TOPIC_HUES[c.t] || 0x7C93C8).toString(16).padStart(6, "0");
    c.search = (c.n + " " + c.a + " " + c.tname).toLowerCase();
  });
  var newestKey = PAPERS.length ? PAPERS[0].key : 0;

  /* ============================================================== world */
  /* The page opens at 2× zoom: half the old default follow distance of 23.
     The wheel and the +/− buttons still range over the same 9–110. */
  var player, target = null, targetMark, camYaw = 0, camPitch = 0.46, camDist = 23 / 2;
  var camMode = "follow";
  var keys = {}, peers = {}, tagLayer, nearPlace = null, started = false;
  var walkT = 0, ray = new T.Raycaster(), ndc = new T.Vector2();
  var groundPlane = new T.Plane(new T.Vector3(0, 1, 0), 0);

  function start() {
    V.init($("#scene"));
    player = V.makePerson(me.look);
    var s = V.clearSpot(8, 34, 1.4);
    player.position.set(s.x, 0, s.z);
    V.getScene().add(player);

    /* destination marker */
    targetMark = new T.Group();
    var ring = new T.Mesh(new T.TorusGeometry(1.2, 0.12, 6, 24),
      new T.MeshBasicMaterial({ color: 0x1E4A44 }));
    ring.rotation.x = -Math.PI / 2; targetMark.add(ring);
    var dot = new T.Mesh(new T.CircleGeometry(0.9, 18),
      new T.MeshBasicMaterial({ color: 0xE8B04B, transparent:true, opacity:0.55 }));
    dot.rotation.x = -Math.PI / 2; dot.position.y = 0.01; targetMark.add(dot);
    targetMark.position.y = 0.07; targetMark.visible = false;
    V.getScene().add(targetMark);

    /* Paper markers stay in and around the old village and the campus core,
       not scattered over nine hundred metres of woodland. */
    scatterTokens(16);
    tagLayer = $("#tags");

    /* ---- the systems that sit on top of the world ---- */
    if (window.QVInteract) {
      QVInteract.wire({ onSourceAct: function (pick) {
        if (!pick || !pick.act) return;
        if (pick.act === "write-board" && window.QVBoard) { QVBoard.open(pick.board); return; }
        if (pick.act === "pin-poster" && window.QVPosters) { QVPosters.openPin(pick.poster); return; }
        if (pick.act === "view-poster" && window.QVPosters) { QVPosters.openView(pick.poster); return; }
        if (pick.act === "like-poster" && window.QVPosters) { QVPosters.like(pick.poster); return; }
        if (pick.act === "collect-food" && window.QVRestaurant) { QVRestaurant.collectFood(); return; }
        if (pick.act === "cycle" && window.QVTransport) {
          if (QVTransport.toggleCycle(player)) {
            toast(QVTransport.isCycling() ? "Cycle unlocked. Ride to any location." : "Cycle returned to the station.");
          }
          return;
        }
        if (pick.act === "park-cycle" && window.QVTransport) {
          if (QVTransport.parkCycle(player)) toast("Cycle parked outside " + esc(pick.place || "the facility") + ".");
          return;
        }
        if (pick.act === "take-parked-cycle" && window.QVTransport) {
          if (QVTransport.takeParkedCycle(player)) toast("Cycle collected. Ride to another location.");
          return;
        }
        if (pick.act === "jeep" && window.QVTransport) {
          if (QVTransport.toggleJeep(player)) {
            toast(QVTransport.isDriving() ? "Jeep unlocked. Drive to any location." : "Jeep returned to the station.");
          }
          return;
        }
        if (pick.act === "park-jeep" && window.QVTransport) {
          if (QVTransport.parkJeep(player)) toast("Jeep parked outside " + esc(pick.place || "the facility") + ".");
          return;
        }
        if (pick.act === "take-parked-jeep" && window.QVTransport) {
          if (QVTransport.takeParkedJeep(player)) toast("Jeep collected. Drive to another location.");
          return;
        }
        if (window.QVRooms) QVRooms.act(pick.act, pick.seat);
      } });
      registerPlaces();
    }
    if (window.QVPosters) {
      QVPosters.init({
        name: displayName,
        toast: toast,
        /* `key` is what the likes are filed under: the stand, or for a
           registered poster its registration, so a like follows the poster */
        like: function (key, done) {
          Net.likePoster(key).then(function (ok) {
            if (done) done(ok);
            if (!ok) toast("<b>That like did not go through</b> — check your connection.");
          });
        },
        unlike: function (key, done) {
          Net.clearMyPosterLike(key).then(function (ok) { if (done) done(ok); });
        },
        pinReg: function (id, src, title) { return window.QVEvents ? QVEvents.pinReg(id, src, title) : Promise.reject(new Error("unavailable")); },
        unpinReg: function (id) { return window.QVEvents ? QVEvents.unpinReg(id) : Promise.resolve(); },
        onOpen: function () { QVInteract.setEnabled(false); },
        onClose: function () { QVInteract.setEnabled(true); },
        uid: myUidNow,
        holder: function (id) { return holderOf("posters", id); },
        claim: function (id) { return claimSurface("posters", id); },
        release: function (id) { if (Net.releaseSurface) Net.releaseSurface("posters", id); },
        competition: function (hallId) { return activeCompetition(hallId); },
        report: function (o) { openReport(o); }
      });
      /* Award points for pinning a poster */
      QVPosters.onPin = (function (_orig) {
        return function (id, src, title, by) {
          if (_orig) try { _orig(id, src, title, by); } catch (e) {}
          if (src) {
            me.points += 20; saveMe(); setScore();
            Net.addScore(20, displayName()).catch(function () {});
            toast("\uD83D\uDCCC Poster pinned \u2014 your work is on the wall <span class=\"pts\">+20</span>");
            announceActivity("poster", title, QVPosters.get(id));
            objective();
          }
        };
      })(QVPosters.onPin);
      QVInteract.source(function (x, z) { return QVPosters.prompt(x, z); });
    }
    if (window.QVBoard) {
      QVBoard.init({
        name: displayName,
        toast: toast,
        position: function () { return player.position; },
        onOpen: function () { QVInteract.setEnabled(false); },
        onClose: function () { QVInteract.setEnabled(true); },
        uid: myUidNow,
        holder: function (id) { return holderOf("boards", id); },
        holds: function (id) { return Net.holdsSurface ? Net.holdsSurface("boards", id) : true; },
        claim: function (id) { return claimSurface("boards", id); }
      });
      /* B, and the button beside the map that stands in for it on a phone. */
      var readBtn = $("#read-btn");
      if (readBtn) {
        readBtn.addEventListener("click", function (e) {
          e.preventDefault();
          openNearestBoard();
        });
      }
      /* Award points for writing on a blackboard */
      QVBoard.onWrite = (function (_orig) {
        return function (id, src, by, pic) {
          if (_orig) try { _orig(id, src, by, pic); } catch (e) {}
          var wiping = !String(src || "").trim() && !pic;
          if (!wiping) {
            me.points += 15; saveMe(); setScore();
            Net.addScore(15, displayName()).catch(function () {});
            toast("Chalked up on <b>the board</b> \u2014 discussion started <span class=\"pts\">+15</span>");
            announceActivity("blackboard", topicFromChalk(src), QVBoard.get(id));
            objective();
          } else if (window.QVActivities) {
            QVActivities.end();
          }
        };
      })(QVBoard.onWrite);
      /* before the room source: at the board, E is for writing */
      QVInteract.source(function (x, z) { return QVBoard.prompt(x, z); });
    }
    if (window.QVRooms) {
      QVRooms.init({
        player: function () { return player; },
        walkTo: function (x, z) { walkTo(x, z); },
        toast: toast,
        onChange: function () { updateRoomHud(); },
        onRoomState: function () { updateRoomHud(); },
        onSpeakStart: function (room) {
          /* what is on the board is the topic; if it is blank, the room's
             own name is the best the village can be told */
          var b = window.QVBoard && QVBoard.get ? QVBoard.get(room.id) : null;
          var topic = topicFromChalk(b && (b.text || b.src || ""));
          var kind = { seminar:"seminar", lecture:"lecture", discussion:"discussion",
                       poster:"poster", poster2:"poster" }[room.kind] || "seminar";
          if (window.QVActivities) QVActivities.start(kind, topic || room.name, room.x, room.z, room.name);
        },
        onSpeakEnd: function () {
          if (window.QVActivities) QVActivities.end();
        }
      });
      QVInteract.source(function (x, z) { return QVRooms.prompt(x, z); });
    }
    if (window.QVSlides) {
      QVSlides.init({
        name: displayName,
        uid: function () { return Net.user() ? Net.user().uid : (window.QVLocalId || "guest"); },
        /* "Which hall am I in" has exactly one answer in this village, and
           rooms.js is where it lives. */
        roomId: function () {
          var st = window.QVRooms ? QVRooms.state() : null;
          return (st && st.roomId) || null;
        },
        toast: toast,
        onOpen: function () { QVInteract.setEnabled(false); },
        onClose: function () { QVInteract.setEnabled(true); },
        /* a hall's slides go up on its blackboard, so they share its claim */
        holder: function (roomId) { return holderOf("boards", roomId); },
        claim: function (roomId) { return claimSurface("boards", roomId); },
        release: function (roomId) { releaseBoardIfIdle(roomId); },
        /* A deck going up is a seminar starting, and the village is told the
           same way it is told about chalk and posters. */
        onPresent: function (roomId, hall, deck) {
          me.points += 15; saveMe(); setScore();
          Net.addScore(15, displayName()).catch(function () {});
          toast("Slides up on <b>" + esc(hall ? hall.name : "the board") + "</b> — " +
                (deck ? deck.pages : 1) + " page" + ((deck && deck.pages === 1) ? "" : "s") +
                " <span class=\"pts\">+15</span>");
          if (window.QVActivities && hall) {
            QVActivities.start("seminar", "Slides in " + hall.name, hall.x, hall.z, hall.name);
          }
          objective();
        },
        /* The deck came down, so the notice on the Live list should go with
           it — unless the same person is still standing at the board, in
           which case the seminar they announced is still happening. */
        onEnd: function () {
          var st = window.QVRooms ? QVRooms.state() : null;
          if (st && st.speaking) return;
          if (window.QVActivities) QVActivities.end();
        }
      });
    }
    if (window.QVArchives) {
      QVArchives.wire();
      QVArchives.build({
        onOpen: function () { QVInteract.setEnabled(false); },
        onClose: function () { QVInteract.setEnabled(true); }
      });
    }

    /* Initialise the restaurant system */
    if (window.QVRestaurant) {
      QVRestaurant.init({
        getPoints: function () { return me.points; },
        addPoints: function (delta) { me.points += delta; saveMe(); setScore(); Net.addScore(delta, displayName()).catch(function () {}); },
        toast: toast,
        displayName: displayName,
        getPlayerPosition: function () { return player.position; },
        getPlayerObject: function () { return player; },
        onPlayerAtFront: function (pName) {
          var who = pName || displayName() || "Resident";
          toast("🔔 <b>" + esc(who) + "!</b> It's your turn at the counter — Rowan is ready for your order!");
          if (currentPanel === "restaurant") openRestaurant({ id: "restaurant", kind: "restaurant" });
        },
        onFoodReady: function (pName, itemName) {
          toast("🔔 <b>" + esc(pName) + "!</b> Your " + esc(itemName) + " is ready. Walk to the counter and press <b>C</b> to collect it.");
          if (currentPanel === "restaurant") openRestaurant({ id: "restaurant", kind: "restaurant" });
        }
      });
      QVInteract.source(function (x, z) {
        var served = QVRestaurant.lastServed && QVRestaurant.lastServed();
        if (!served || served.state !== "ready" || Math.hypot(x - 80, z - 63.6) > 4.5) return null;
        return { id: "restaurant-collect", key: "C", act: "collect-food", label: "Collect " + served.item };
      });
    }
    if (window.QVTransport) {
      QVInteract.source(function (x, z) {
        var jeepStation = (QVTransport.jeepStations ? QVTransport.jeepStations() : []).filter(function (item) {
          return Math.hypot(x - item.x, z - item.z) <= 12;
        })[0];
        /* at the wheel: the only things to do are return or park the jeep */
        if (QVTransport.isDriving && QVTransport.isDriving()) {
          if (jeepStation) return { id: "jeep-station", key: "E", act: "jeep", label: "Return jeep" };
          if (!nearPlace) return null;
          return { id: "park-jeep-" + nearPlace.id, key: "E", act: "park-jeep",
            place: nearPlace.name, label: "Park jeep outside " + nearPlace.name };
        }
        var cycling = QVTransport.isCycling();
        if (!cycling && QVTransport.parkedJeepAt && QVTransport.parkedJeepAt(x, z)) {
          return { id: "parked-jeep", key: "E", act: "take-parked-jeep", label: "Take parked jeep" };
        }
        if (!cycling && QVTransport.parkedCycleAt && QVTransport.parkedCycleAt(x, z)) {
          return { id: "parked-cycle", key: "E", act: "take-parked-cycle", label: "Take parked cycle" };
        }
        var stations = QVTransport.cycleStations ? QVTransport.cycleStations() : [QVTransport.cycleStation()];
        var station = stations.filter(function (item) {
          return Math.hypot(x - item.x, z - item.z) <= 10;
        })[0];
        if (station) {
          return { id: "cycle-station", key: "E", act: "cycle",
            label: cycling ? "Return cycle" : "Take a cycle" };
        }
        if (jeepStation && !cycling) {
          return { id: "jeep-station", key: "E", act: "jeep", label: "Take a jeep" };
        }
        if (!cycling || !nearPlace) return null;
        return { id: "park-cycle-" + nearPlace.id, key: "E", act: "park-cycle",
          place: nearPlace.name, label: "Park cycle outside " + nearPlace.name };
      });
    }

    /* Initialise real-time voice chat */
    if (window.QVVoice) {
      QVVoice.init({
        toast: toast,
        getPosition: function () { return player.position; },
        getDisplayName: function () { return displayName(); },
        getUid: function () { return me.uid || me.id; },
        getPeers: function () { return peers; },
        getNpcs: function () {
          return [].concat(
            V.villagers || [],
            V.walkers || [],
            (V.refectoryServer && V.refectoryServer.g) ? [V.refectoryServer] : [],
            (V.refectoryOwner && V.refectoryOwner.g) ? [V.refectoryOwner] : []
          );
        },
        onSpeakingChange: function (live) {
          /* the mic button and the waveform are driven from voice.js; this
             is only here so the rest of the village can react if it wants */
          if (window.QVAmbient && QVAmbient.setSpeaking) QVAmbient.setSpeaking(live);
        }
      });
      QVVoice.bindHotkey();
    }

    /* Private messages and one-to-one calls, from a resident's card */
    if (window.QVPrivate) {
      QVPrivate.init({
        toast: toast,
        myName: function () { return displayName(); },
        peerName: function (uid) { return peers[uid] ? peers[uid].name : ""; },
        isOnline: function (uid) { return !!peers[uid]; },
        onUnread: function () { if (peerCard.uid) { peerCard.sig = ""; renderPeerCard(); } }
      });
    }

    /* ---- live activities: announcements and the Live Activities panel ---- */
    if (window.QVActivities) {
      QVActivities.init({
        goTo: function (x, z) { ferry(x, z); },
        getName: function () { return displayName(); },
        isMe: function (uid) {
          var u = Net.user();
          return !!(u && uid === u.uid);
        },
        toast: toast
      });
    }

    /* ---- the arrival tour ---- */
    if (window.QVTour) {
      QVTour.init({
        goTo: function (x, z) { ferry(x, z); },
        onStart: function () {
          if (window.QVInteract) QVInteract.setEnabled(false);
          closePanel();
        },
        onEnd: function () {
          if (window.QVInteract) QVInteract.setEnabled(true);
          toast("That is the village. Press <b>M</b> for the map whenever you are lost.");
        }
      });
      if (!QVTour.seen()) setTimeout(function () { QVTour.offer(); }, 1600);
    }

    started = true;
    loop();
  }

  /* Every place in the world becomes something you can act on. Walk-in
     buildings have open doors, so E is for the notices rather than the lock. */
  function registerPlaces() {
    V.PLACES.forEach(function (p) {
      QVInteract.add({
        id: "place-" + p.id, x: p.x, z: p.z, r: p.r + 3, kind: "place",
        label: p.walkin ? ("What's on at " + p.name) : ("Enter " + p.name),
        verb: "enter",
        onUse: function () { enterPlace(p); },
        onNear: function (near) { if (near) visit(p); }
      });
    });
  }
  function visit(p) {
    if (me.visited[p.id]) return;
    me.visited[p.id] = Date.now();
    me.points += 10; saveMe(); setScore();
    Net.addScore(10, displayName()).catch(function () {});
    toast("First visit to <b>" + esc(p.name) + "</b> <span class=\"pts\">+10</span>");
    objective();
  }

  /* ------------------------------------------------- activity announcing
   *
   * Three things in the village count as starting something: chalking a
   * blackboard, taking the speaking slot in a room, and pinning a poster.
   * Each of them lands here, which resolves a topic and a place and hands
   * the pair to QVActivities so everybody else is told.
   *
   * The topic is whatever the person actually wrote — the first line of the
   * chalk, or the poster's title — because "Blackboard discussion on Dark
   * Photons" is worth walking across the village for and "a discussion" is
   * not. */
  function topicFromChalk(src) {
    var line = String(src || "")
      .replace(/\$\$?/g, " ")            /* strip the LaTeX delimiters */
      .split(/\n/)[0]
      .replace(/\s+/g, " ")
      .trim();
    return line.slice(0, 80);
  }

  function announceActivity(kind, topic, spot) {
    if (!window.QVActivities) return;
    var x = (spot && spot.x != null) ? spot.x : player.position.x;
    var z = (spot && spot.z != null) ? spot.z : player.position.z;
    /* a board or frame inside a room names the room; otherwise the nearest
       place does, which is what someone reading the notice has to find */
    var room = null;
    if (spot && spot.hallId) room = placeName(spot.hallId);
    if (!room && window.QVRooms) {
      var st = QVRooms.state();
      if (st && st.roomId) room = placeName(st.roomId);
    }
    QVActivities.start(kind, topic, x, z, room);
  }

  function placeName(id) {
    var p = V.PLACES.filter(function (q) { return q.id === id || q.building === id; })[0];
    return p ? p.name : null;
  }

  /* ---------------------------------------------------- click to walk */
  /* Set up the shared raycaster from a screen point. */
  function pickRay(clientX, clientY) {
    ndc.x = (clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(clientY / window.innerHeight) * 2 + 1;
    ray.setFromCamera(ndc, V.getCamera());
    return true;
  }

  function groundPoint(clientX, clientY) {
    ndc.x = (clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(clientY / window.innerHeight) * 2 + 1;
    ray.setFromCamera(ndc, V.getCamera());
    var hit = new T.Vector3();
    if (!ray.ray.intersectPlane(groundPlane, hit)) return null;
    return hit;
  }

  function walkTo(x, z) {
    var spot = V.clearSpot(x, z, 1.3);
    target = { x:spot.x, z:spot.z };
    targetMark.position.set(spot.x, 0.07, spot.z);
    targetMark.visible = true;
    targetMark.scale.setScalar(0.4);
  }

  var drag = { on:false, x:0, y:0, moved:0, id:null, t:0 };
  function bindExtraUi() {
    var close = $("#acts-close");
    if (close) close.addEventListener("click", function () { QVActivities.closePanel(); });
  }

  function bindInput() {
    var sc = $("#scene");

    sc.addEventListener("pointerdown", function (e) {
      drag.on = true; drag.x = e.clientX; drag.y = e.clientY;
      drag.moved = 0; drag.id = e.pointerId; drag.t = Date.now();
      sc.setPointerCapture(e.pointerId);
    });
    sc.addEventListener("pointermove", function (e) {
      if (!drag.on) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.moved > 6) {
        camYaw -= dx * 0.006;
        camPitch = Math.max(0.16, Math.min(1.25, camPitch + dy * 0.004));
      }
    });
    sc.addEventListener("pointerup", function (e) {
      if (!drag.on) return;
      drag.on = false;
      if (drag.moved < 8 && Date.now() - drag.t < 700) {
        /* a tap on a neighbour opens (or shuts) their card and nothing else;
           a tap anywhere else shuts it and carries on as it always did */
        var pk = peerAt(e.clientX, e.clientY);
        if (pk) { togglePeerCard(pk); return; }
        if (peerCard.uid) closePeerCard();
        /* a tap on a paper icon reads it; anywhere else, walk there */
        if (window.QVInteract && pickRay(e.clientX, e.clientY) && QVInteract.clickAt(ray)) return;
        var p = groundPoint(e.clientX, e.clientY);
        if (p) { walkTo(p.x, p.z); keys = {}; }
      }
    });
    /* hover feedback on the desktop */
    var hoverAcc = 0;
    sc.addEventListener("pointermove", function (e) {
      if (drag.on || !window.QVInteract) return;
      var now = performance.now();
      if (now - hoverAcc < 90) return;
      hoverAcc = now;
      if (pickRay(e.clientX, e.clientY)) QVInteract.hover(ray);
    });
    sc.addEventListener("pointercancel", function () { drag.on = false; });
    sc.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    sc.addEventListener("wheel", function (e) {
      e.preventDefault();
      camDist = Math.max(9, Math.min(110, camDist + e.deltaY * 0.035));
    }, { passive:false });

    window.addEventListener("keydown", function (e) {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      var k = e.key.toLowerCase();
      keys[k] = true;
      if (k === "w" || k === "a" || k === "s" || k === "d" || k.indexOf("arrow") === 0) target = null;
      if (k === "e") {
        /* one key, whatever is nearest: a door, a paper, a chair, the board */
        var did = window.QVInteract && QVInteract.use();
        if (!did && nearPlace) enterPlace(nearPlace);
        e.preventDefault();
      }
      if ((k === "q" || k === "l") && window.QVInteract) { QVInteract.useAlt(); e.preventDefault(); }
      if (k === "c" && window.QVRestaurant) {
        QVRestaurant.collectFood();
        e.preventDefault();
      }
      /* B — read the board. It is deliberately not E: E is "do the thing
         you are standing next to", and you read a board from your chair at
         the back of the room as often as from in front of it. */
      if (k === "b") { openNearestBoard(); e.preventDefault(); }
      /* P — the slides on a seminar hall's blackboard: put a deck up, or
         look at the page the hall is on. */
      if (k === "p" && window.QVSlides) { QVSlides.toggle(); e.preventDefault(); }
      /* The arrow keys walk the avatar, so they only turn a page while the
         slides panel is open and it is your deck. */
      if (window.QVSlides && QVSlides.key && QVSlides.isOpen() && QVSlides.key(k)) {
        e.preventDefault();
        return;
      }
      if (k === "m") togglePanel("map");
      if (k === "j" && window.QVActivities) { QVActivities.togglePanel(); e.preventDefault(); }
      if (k === "escape") {
        if (peerCard.uid) { closePeerCard(); e.preventDefault(); return; }
        var acts = $("#acts");
        if (acts && acts.classList.contains("on")) { QVActivities.closePanel(); e.preventDefault(); return; }
        if (window.QVAdmin && QVAdmin.isOpen && QVAdmin.isOpen()) QVAdmin.close();
        else if (compRequestOpen()) closeCompRequest();
        else if (reportOpen()) closeReport();
        else if (bookingOpen()) closeBooking();
        else if (window.QVEvents && QVEvents.isOpen()) QVEvents.close();
        else if (window.QVEvents && QVEvents.requestOpen()) QVEvents.closeRequest();
        else if (window.QVSlides && QVSlides.isOpen()) QVSlides.close();
        else if (window.QVBoard && QVBoard.isReading && QVBoard.isReading()) QVBoard.closeRead();
        else if (window.QVPosters && QVPosters.isOpen()) QVPosters.close();
        else if (window.QVBoard && QVBoard.isOpen()) QVBoard.close();
        else if (window.QVArchives && QVArchives.isOpen()) QVArchives.close();
        else closePanel();
      }
      /* Enter is "I want to say something", so a folded-away chat opens */
      if (e.key === "Enter") setChatOpen(true, true);
    });
    window.addEventListener("keyup", function (e) { keys[e.key.toLowerCase()] = false; });

    /* touch joystick, for phones */
    var stick = $("#stick"), knob = $("#stick-knob"), on = false, base = { x:0, y:0 };
    stick.addEventListener("pointerdown", function (e) {
      on = true; var r = stick.getBoundingClientRect();
      base.x = r.left + r.width / 2; base.y = r.top + r.height / 2;
      stick.setPointerCapture(e.pointerId); target = null;
    });
    stick.addEventListener("pointermove", function (e) {
      if (!on) return;
      var dx = e.clientX - base.x, dy = e.clientY - base.y;
      var d = Math.min(44, Math.hypot(dx, dy)), a = Math.atan2(dy, dx);
      knob.style.transform = "translate(" + Math.cos(a) * d + "px," + Math.sin(a) * d + "px)";
      stickVec.x = Math.cos(a) * (d / 44); stickVec.y = Math.sin(a) * (d / 44);
    });
    function end() { on = false; knob.style.transform = "translate(0,0)"; stickVec.x = stickVec.y = 0; }
    stick.addEventListener("pointerup", end);
    stick.addEventListener("pointercancel", end);
  }
  var stickVec = { x:0, y:0 };

  /* ----------------------------------------------------- reading a board */
  /* One entry point for B, for the button, and for a tap on the slate. */
  function openNearestBoard() {
    if (!window.QVBoard || !QVBoard.read) return false;
    if (QVBoard.isReading && QVBoard.isReading()) { QVBoard.closeRead(); return true; }
    if (QVBoard.isOpen && QVBoard.isOpen()) return false;
    var opened = QVBoard.read(null, player.position.x, player.position.z);
    if (!opened) toast("No blackboard within reach. Walk into a seminar room or lecture hall and press <b>B</b>.");
    return opened;
  }

  /* Shown only when there is something to read, and marked when there is
     actually chalk on it rather than a blank slate. */
  var lastReadSig = "";
  function updateReadButton() {
    var btn = $("#read-btn");
    if (!btn || !window.QVBoard || !QVBoard.readableAt) return;
    var near = QVBoard.readableAt(player.position.x, player.position.z);
    var sig = near ? near.id + "|" + (near.written ? 1 : 0) : "";
    if (sig === lastReadSig) return;
    lastReadSig = sig;
    btn.hidden = !near;
    btn.classList.toggle("has-content", !!(near && near.written));
    if (near) {
      btn.title = (near.written ? "Read what is on " : "Look at ") + near.name + " (B)";
    }
  }

  /* ------------------------------------------------------------ motion */
  function movePlayer(dt) {
    var driving = !!(window.QVTransport && QVTransport.isDriving && QVTransport.isDriving());
    var speed = driving ? 32 : (window.QVTransport && QVTransport.isCycling && QVTransport.isCycling() ? 22 : 9.5);
    if (ride && !ride.arrived) speed *= RIDE_BOOST;
    /* a jeep is wider than a person, so it keeps further from walls */
    var bodyPad = driving ? 1.6 : 1.15;
    var mx = 0, mz = 0, moving = false;

    /* Sitting hands the avatar over to rooms.js; the camera still works. */
    var seated = window.QVRooms && QVRooms.isSeated();

    var f = 0, s = 0;
    if (keys.w || keys.arrowup) f += 1;
    if (keys.s || keys.arrowdown) f -= 1;
    if (keys.a || keys.arrowleft) s -= 1;
    if (keys.d || keys.arrowright) s += 1;
    f -= stickVec.y; s += stickVec.x;

    if (seated) {
      /* pressing a direction key is how you get up */
      if (f || s) QVRooms.stand();
      f = 0; s = 0; target = null;
    } else if ((f || s) && window.QVRooms && QVRooms.state().goal) {
      QVRooms.cancelScripted();
    }

    if (f || s) {
      var mag = Math.hypot(f, s); if (mag > 1) { f /= mag; s /= mag; }
      var sin = Math.sin(camYaw), cos = Math.cos(camYaw);
      mx = (s * cos - f * sin); mz = (-s * sin - f * cos);
      moving = true;
      target = null; targetMark.visible = false;
    } else if (target) {
      var dx = target.x - player.position.x, dz = target.z - player.position.z;
      var d = Math.hypot(dx, dz);
      if (d < 0.7) { target = null; targetMark.visible = false; }
      else {
        mx = dx / d; mz = dz / d; moving = true;
        if (d < 3) speed *= Math.max(0.35, d / 3);
      }
    }

    if (moving) {
      var nx = player.position.x + mx * speed * dt;
      var nz = player.position.z + mz * speed * dt;
      var before = { x:nx, z:nz };
      var out = V.clearSpot(nx, nz, bodyPad);
      /* if a solid pushed us, slide along it rather than sticking */
      var pushed = Math.hypot(out.x - before.x, out.z - before.z);
      if (pushed > 0.001 && target) {
        var px = out.x - player.position.x, pz = out.z - player.position.z;
        if (Math.hypot(px, pz) < 0.05) {
          var tang = Math.atan2(mx, mz) + Math.PI / 2;
          var alt = V.clearSpot(player.position.x + Math.sin(tang) * speed * dt,
                                player.position.z + Math.cos(tang) * speed * dt, bodyPad);
          out = alt;
        }
      }
      player.position.x = out.x; player.position.z = out.z;
      var want = Math.atan2(mx, mz);
      var diff = ((want - player.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      player.rotation.y += diff * Math.min(1, dt * 11);
      walkT += dt;
    }
    V.animatePerson(player, moving, walkT, 1);
    if (window.QVTransport && QVTransport.setJeepMoving) QVTransport.setJeepMoving(driving && moving);
    var cycling = window.QVTransport && QVTransport.isCycling && QVTransport.isCycling();
    if (cycling) {
      /* the bike rides on the player, and animatePerson poses the rider */
      QVTransport.setCycleMoving(moving);
      if (window.QVAmbient && QVAmbient.setCycling) QVAmbient.setCycling(moving);
    } else {
      if (player.userData.pose === "sit") V.setPose(player, "stand");
      if (window.QVTransport && QVTransport.setCycleMoving) QVTransport.setCycleMoving(false);
      if (window.QVAmbient && QVAmbient.setCycling) QVAmbient.setCycling(false);
    }

    if (targetMark.visible) {
      targetMark.scale.x = targetMark.scale.z = Math.min(1, targetMark.scale.x + dt * 4);
      targetMark.rotation.y += dt * 1.4;
    }

    /* camera */
    var cam = V.getCamera();
    var inside = V.currentInterior();
    var pitch = camMode === "overhead" ? 1.15 : camPitch;
    var dist = camMode === "overhead" ? Math.max(camDist, 56) : camDist;
    if (inside) dist = Math.min(dist, 15);
    /* pull the camera in rather than let it sit inside a wall */
    var clear = dist;
    for (var step = dist; step >= 7; step -= 2) {
      var tx = player.position.x + Math.sin(camYaw) * step * Math.cos(pitch);
      var tz = player.position.z + Math.cos(camYaw) * step * Math.cos(pitch);
      var ty = 2 + Math.sin(pitch) * step;
      /* Indoors the camera has to come right in, or you watch a wall. */
      var blocked = ty < 13 && V.blockedAt(tx, tz, 1.4);
      if (!blocked) { clear = step; break; }
      clear = step;
    }
    var want3 = new T.Vector3(
      player.position.x + Math.sin(camYaw) * clear * Math.cos(pitch),
      Math.max(3.2, 2 + Math.sin(pitch) * clear),
      player.position.z + Math.cos(camYaw) * clear * Math.cos(pitch)
    );
    cam.position.lerp(want3, Math.min(1, dt * 6));
    cam.lookAt(player.position.x, 2.5, player.position.z);
  }

  /* ------------------------------------------------------- collectibles */
  var TOKEN_MIN = 28, TOKEN_MAX = 520;
  function tokenSpot() { return V.freeSpot(TOKEN_MIN, TOKEN_MAX, 4); }
  function scatterTokens(n) {
    var pool = PAPERS.filter(function (p) { return me.shelf.indexOf(p.i) < 0; });
    var picks = [];
    for (var i = 0; i < n && pool.length; i++) {
      var p = pool[Math.floor(Math.random() * pool.length)];
      var spot = tokenSpot();
      picks.push({ x:spot.x, z:spot.z, t:p.t, paper:p });
    }
    V.spawnTokens(picks);
  }
  function checkTokens() {
    var list = V.tokens;
    for (var i = list.length - 1; i >= 0; i--) {
      var tk = list[i];
      var d = Math.hypot(player.position.x - tk.g.position.x, player.position.z - tk.g.position.z);
      if (d < 2.3) collect(tk);
    }
  }
  function collect(tk) {
    var p = tk.data.paper;
    V.removeToken(tk);
    if (me.shelf.indexOf(p.i) < 0) me.shelf.push(p.i);
    me.points += 5;
    saveMe();
    setScore();
    toast('<b>' + esc(p.tname) + "</b> — added to your shelf <span class=\"pts\">+5</span>" +
          '<span class="tsub">' + esc(p.n.slice(0, 74)) + (p.n.length > 74 ? "…" : "") + "</span>");
    Net.addScore(5, displayName()).catch(function () {});
    setTimeout(function () {
      var pool = PAPERS.filter(function (x) { return me.shelf.indexOf(x.i) < 0; });
      if (!pool.length) return;
      var np = pool[Math.floor(Math.random() * pool.length)];
      var spot = tokenSpot();
      V.spawnTokens(V.tokens.map(function (t) { return t.data; }).concat([{ x:spot.x, z:spot.z, t:np.t, paper:np }]));
    }, 900);
    objective();
  }

  /* -------------------------------------------------------- place entry */
  /* The prompt is owned by QVInteract now; this only tracks which place the
     player is standing at, for the Enter button and the place card. */
  function checkPlace() {
    var best = null, bd = 1e9;
    for (var i = 0; i < V.PLACES.length; i++) {
      var p = V.PLACES[i];
      var d = Math.hypot(player.position.x - p.x, player.position.z - p.z);
      if (d < p.r + 3 && d < bd) { bd = d; best = p; }
    }
    nearPlace = best;
  }

  function enterPlace(p) {
    if (!p) return;
    if (p.kind === "library") return openArchive();
    if (p.kind === "institute" || p.kind === "university") return openInstitute(p.uni || p.id, p);
    if (p.kind === "travel") return togglePanel("map");
    if (p.kind === "commons") return openCommons();
    if (p.kind === "cafe" || p.kind === "common") return openCafe(p);
    if (p.kind === "restaurant") return openRestaurant(p);
    if (p.kind === "station" || p.kind === "transport") return openStation(p);
    if (p.kind === "seminar" || p.kind === "discussion" || p.kind === "lecture") return openRoomPanel(p);
    if (p.kind === "board") {
      if (window.QVBoard && QVBoard.open) return QVBoard.open(p.id);
      return openPlaceCard(p);
    }
    if (p.kind === "lab" || p.kind === "offices" || p.kind === "open") return openPlaceCard(p);
    return openPlaceCard(p);
  }

  /* ------------------------------------------------------------- labels */
  /* Name tags.
   *
   * Two jobs with very different costs. Deciding *which* sixteen things
   * deserve a tag, and writing their markup, means walking every peer, every
   * villager and every token and touching innerHTML — far too much to do
   * sixty times a second. Projecting a known tag to a screen position is
   * three multiplies and a transform, and has to happen every frame or the
   * labels swim behind the things they belong to.
   *
   * So the first is throttled and the second is not. */
  var tagItems = [];

  function updateTags() {
    var cam = V.getCamera(), v = new T.Vector3();
    var items = [];
    Object.keys(peers).forEach(function (k) {
      var pr = peers[k];
      items.push({ obj:pr.g, label:pr.name, sub:pr.sub || pr.inst || "resident", cls:"peer", bubble:pr.bubble, uid:k });
    });
    /* Old-village neighbours and campus researchers both carry a name tag
       you can click; they answer the same way. */
    [V.villagers, V.walkers].forEach(function (list) {
      (list || []).forEach(function (n) {
        if (!n.g.visible) return;
        var d = Math.hypot(n.g.position.x - player.position.x, n.g.position.z - player.position.z);
        if (d < 46) items.push({ obj:n.g, label:n.name, sub:n.role, cls:"npc", npc:n, dist:d });
      });
    });
    /* Rowan — Grand Refectory Host & Barista */
    if (V.refectoryServer && V.refectoryServer.g) {
      var srv = V.refectoryServer;
      var d = Math.hypot(srv.g.position.x - player.position.x, srv.g.position.z - player.position.z);
      if (d < 50) {
        items.push({
          obj: srv.g,
          label: srv.name,
          sub: srv.role,
          cls: "npc server",
          bubble: srv.bubble,
          dist: d,
          onclick: function () { enterPlace({ id: "restaurant", kind: "restaurant" }); }
        });
      }
    }
    /* Madame Bernadette — Cafe Owner & Executive Chef */
    if (V.refectoryOwner && V.refectoryOwner.g) {
      var own = V.refectoryOwner;
      var od = Math.hypot(own.g.position.x - player.position.x, own.g.position.z - player.position.z);
      if (od < 50) {
        items.push({
          obj: own.g,
          label: own.name,
          sub: own.role,
          cls: "npc owner",
          yOff: V.PERSON.headTop + 1.0,
          bubble: own.bubble,
          dist: od,
          onclick: function () { openCafeOwner(own); }
        });
      }
    }
    (V.tokens || []).forEach(function (tk) {
      var d = Math.hypot(tk.g.position.x - player.position.x, tk.g.position.z - player.position.z);
      if (d < 46) items.push({ obj:tk.g, label:(topicById[tk.data.t] || {}).name || "", sub:"+5", cls:"token", yOff:1.5, hue:"#" + (V.TOPIC_HUES[tk.data.t] || 0x4FA8B8).toString(16).padStart(6, "0") });
    });
    items.sort(function (a, b) { return (a.dist || 0) - (b.dist || 0); });
    tagItems = items.slice(0, 16);
    if (peerCard.uid) measurePeerCardRoom();

    while (tagLayer.children.length < tagItems.length) {
      var el = document.createElement("div"); el.className = "tag"; tagLayer.appendChild(el);
    }
    for (var i = 0; i < tagLayer.children.length; i++) {
      var node = tagLayer.children[i], it = tagItems[i];
      if (!it) { node.style.display = "none"; node._sig = null; continue; }
      /* Only rewrite the markup when the text has actually changed — a name
         tag that says the same thing does not need a new DOM subtree. */
      var sig = it.cls + "|" + it.label + "|" + it.sub + "|" + (it.bubble || "") + "|" + (it.hue || "");
      if (node._sig !== sig) {
        node._sig = sig;
        node.className = "tag " + it.cls;
        node.innerHTML = (it.bubble ? '<span class="bub">' + esc(it.bubble) + "</span>" : "") +
          '<span class="nm"' + (it.hue ? ' style="--c:' + it.hue + '"' : "") + ">" + esc(it.label) +
          (it.cls === "token" ? ' <b class="num">' + esc(it.sub) + "</b>" : "") + "</span>" +
          (it.cls !== "token" ? '<span class="sb">' + esc(it.sub) + "</span>" : "");
        node.style.pointerEvents = (it.npc || it.onclick || it.uid) ? "auto" : "none";
        if (it.uid && it.uid === peerCard.uid) peerCard.tagOk = false;
      }
      /* how tall their tag is, so an open card can sit just above it —
         measured when the card opens and when the tag's text changes */
      if (it.uid && it.uid === peerCard.uid && !peerCard.tagOk) {
        peerCard.tagOk = true;
        peerCard.tagH = node.offsetHeight || peerCard.tagH;
      }
      node.onclick = it.onclick ? it.onclick
        : it.npc ? (function (n) { return function () { openVillager(n); }; })(it.npc)
        : it.uid ? (function (u) { return function (e) { e.stopPropagation(); togglePeerCard(u); }; })(it.uid) : null;
    }
    positionTags();
  }

  /* Cheap enough to run every frame, and it has to. */
  var tagVec = new T.Vector3();
  function positionTags() {
    if (!tagLayer) return;
    var cam = V.getCamera();
    var W = window.innerWidth, H = window.innerHeight;
    for (var i = 0; i < tagLayer.children.length; i++) {
      var node = tagLayer.children[i], it = tagItems[i];
      if (!it) { if (node.style.display !== "none") node.style.display = "none"; continue; }
      tagVec.set(it.obj.position.x, it.obj.position.y + (it.yOff != null ? it.yOff : V.PERSON.headTop + 0.5),
                 it.obj.position.z).project(cam);
      if (tagVec.z > 1) { node.style.display = "none"; continue; }
      if (node.style.display === "none") node.style.display = "block";
      node.style.transform = "translate(-50%,-100%) translate(" +
        ((tagVec.x * 0.5 + 0.5) * W).toFixed(1) + "px," +
        ((-tagVec.y * 0.5 + 0.5) * H).toFixed(1) + "px)";
    }
    positionPeerCard();
  }

  /* ------------------------------------------------ a neighbour's card */
  /* Click somebody and their card opens over their head, above their name
   * tag, and follows them as they walk. It is live from two places at once:
   * the presence record already streaming in for everybody (where they are,
   * what they are doing), and their residents/<uid> profile, which gets one
   * Firestore listener for exactly as long as the card is open. Nothing is
   * watched for anybody whose card is shut.
   *
   * Clicking them again, clicking somewhere else in the village, Escape or
   * the × closes it; clicking somebody else moves it to them. It closes by
   * itself when they leave, or when you walk out of sight of them. */
  var peerCard = { uid: null, unsub: null, doc: null, docErr: false, sig: "", tagH: 34, w: 240, h: 120,
                   tops: [], railTop: Infinity, railLeft: 0, stickTop: Infinity, stickRight: -Infinity,
                   below: false, off: "" };
  var PEER_CARD_RANGE = 90;

  function peerCardEl() {
    var c = $("#peer-card");
    if (c) return c;
    c = document.createElement("div");
    c.id = "peer-card";
    c.setAttribute("role", "dialog");
    c.setAttribute("aria-label", "Resident profile");
    c.hidden = true;
    /* inside the card, clicks are the card's: they must not walk the avatar
       or turn the camera behind it */
    c.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    c.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest && e.target.closest("[data-pc-close]")) { closePeerCard(); return; }
      var act = e.target.closest && e.target.closest("[data-pc-dm],[data-pc-call]");
      if (act && peerCard.uid && window.QVPrivate) {
        var who = peerCard.uid, nm = peers[who] ? peers[who].name : "";
        closePeerCard();
        if (act.hasAttribute("data-pc-dm")) QVPrivate.openChat(who, nm);
        else QVPrivate.startCall(who, nm);
      }
    });
    document.body.appendChild(c);
    return c;
  }

  function togglePeerCard(uid) {
    if (!uid || !peers[uid]) return;
    if (peerCard.uid === uid) { closePeerCard(); return; }
    openPeerCard(uid);
  }
  function openPeerCard(uid) {
    closePeerCard();
    peerCard.uid = uid;
    peerCard.doc = null; peerCard.docErr = false; peerCard.sig = ""; peerCard.tagOk = false;
    peerCard.below = false; peerCard.off = "";
    measurePeerCardRoom();
    var c = peerCardEl();
    c.classList.remove("below");
    c.hidden = false;
    c.classList.remove("on");
    renderPeerCard();
    positionPeerCard();
    requestAnimationFrame(function () { if (peerCard.uid === uid) c.classList.add("on"); });
    try {
      peerCard.unsub = Net.docWatch("residents/" + uid, function (d) {
        if (peerCard.uid !== uid) return;
        peerCard.doc = d || null; peerCard.docErr = false;
        renderPeerCard();
      }, function () {
        if (peerCard.uid !== uid) return;
        /* refused, or the connection went: the live presence still says who
           they are, so the card stays up on that */
        peerCard.docErr = true;
        renderPeerCard();
      });
    } catch (e) { peerCard.docErr = true; renderPeerCard(); }
  }
  function closePeerCard() {
    if (peerCard.unsub) { try { peerCard.unsub(); } catch (e) {} }
    peerCard.unsub = null; peerCard.uid = null; peerCard.doc = null; peerCard.sig = "";
    var c = $("#peer-card");
    if (c) { c.hidden = true; c.classList.remove("on"); c.innerHTML = ""; }
  }

  function renderPeerCard() {
    var uid = peerCard.uid, pr = uid && peers[uid];
    if (!pr) { closePeerCard(); return; }
    var d = peerCard.doc || {};
    /* the profile first; presence (which already carries the title in the
       name) for anything the profile does not have or could not be read */
    var name = d.name ? displayName({ name: d.name, title: d.title }) : (pr.name || "Resident");
    var inst = d.inst || pr.inst || "", country = d.country || pr.country || "";
    var orcid = d.orcid || pr.orcid || "";
    var doing = pr.act === "speak" ? "Speaking" : pr.act === "sit" ? "Seated" : pr.act === "jeep" ? "Driving" :
                pr.cycling ? "Cycling" : "";
    var where = pr.sub || "";
    var pv = window.QVPrivate, unread = pv ? pv.unread(uid) : false;
    var callWhy = pv ? pv.callBlocked(uid) : "";
    var sig = [name, inst, country, orcid, doing, where, peerCard.docErr ? 1 : 0, peerCard.doc ? 1 : 0,
               unread ? 1 : 0, callWhy].join("|");
    if (sig === peerCard.sig) return;
    peerCard.sig = sig;
    var rows = "";
    if (inst) rows += '<div class="pc-row"><dt>Institution</dt><dd>' + esc(inst) + "</dd></div>";
    if (country) rows += '<div class="pc-row"><dt>Country</dt><dd>' + esc(country) + "</dd></div>";
    if (orcid) rows += '<div class="pc-row"><dt>ORCID</dt><dd><a href="' + esc(orcidUrl(orcid)) +
      '" target="_blank" rel="noopener">' + esc(fmtOrcid(orcid)) + "</a></dd></div>";
    if (where || doing) rows += '<div class="pc-row"><dt>Now</dt><dd>' +
      esc([doing, where].filter(Boolean).join(" · ")) + "</dd></div>";
    var c = peerCardEl();
    c.innerHTML =
      '<div class="pc-head"><span class="eyebrow">Resident</span>' +
        '<button type="button" class="pc-x" data-pc-close aria-label="Close profile">✕</button></div>' +
      '<h4 class="pc-name">' + esc(name) + "</h4>" +
      (rows ? '<dl class="pc-rows">' + rows + "</dl>"
            : '<p class="fine pc-none">No profile details shared yet.</p>') +
      (peerCard.docErr ? '<p class="fine pc-note">Profile could not be loaded — showing what is live.</p>' : "") +
      (pv ? '<div class="pc-actions">' +
        '<button type="button" class="btn small ghost" data-pc-dm>💬 Personal message' +
          (unread ? ' <span class="pc-unread" aria-label="unread">●</span>' : "") + "</button>" +
        '<button type="button" class="btn small ghost' + (callWhy ? " unavailable" : "") + '" data-pc-call' +
          (callWhy ? ' title="' + esc(callWhy) + '"' : "") + ">🎙️ Personal voice chat</button></div>" : "");
    c.setAttribute("aria-label", "Profile of " + name);
    /* measured here, when the content changes, never in the frame loop */
    peerCard.w = c.offsetWidth || 240; peerCard.h = c.offsetHeight || 120;
  }

  /* Every frame, like the tags: over their head and above their name tag,
     held inside the screen. If the space above them is taken by the top of
     the HUD (on a phone the chat box lives up there), the card drops below
     their feet instead of hiding under it. The arrow keeps pointing at
     them when the card is pushed in from a screen edge. */
  var pcVec = new T.Vector3();
  function positionPeerCard() {
    var uid = peerCard.uid;
    if (!uid) return;
    var pr = peers[uid], c = $("#peer-card");
    if (!pr || !c) { closePeerCard(); return; }
    var gx = pr.g.position.x, gy = pr.g.position.y, gz = pr.g.position.z, cam = V.getCamera();
    if (Math.hypot(gx - player.position.x, gz - player.position.z) > PEER_CARD_RANGE) { closePeerCard(); return; }
    pcVec.set(gx, gy + V.PERSON.headTop + 0.5, gz).project(cam);
    if (pcVec.z > 1 || !pr.g.visible) { if (c.style.visibility !== "hidden") c.style.visibility = "hidden"; return; }
    if (c.style.visibility === "hidden") c.style.visibility = "";
    var W = window.innerWidth, H = window.innerHeight;
    var ax = (pcVec.x * 0.5 + 0.5) * W, y = (-pcVec.y * 0.5 + 0.5) * H - peerCard.tagH - 8;
    var hw = (peerCard.w || 240) / 2, ch = peerCard.h || 120;
    /* the lowest thing pinned to the top of the screen that the card,
       where it would go, would run into */
    var ux = Math.max(hw + 8, Math.min(W - hw - 8, ax)), safeTop = 8;
    for (var i = 0; i < peerCard.tops.length; i++) {
      var r = peerCard.tops[i];
      if (r.right > ux - hw && r.left < ux + hw) safeTop = Math.max(safeTop, r.bottom + 6);
    }
    var below = y - ch < safeTop;
    if (below) {
      pcVec.set(gx, gy + 0.05, gz).project(cam);
      y = Math.min(H - ch - 8, (-pcVec.y * 0.5 + 0.5) * H + 12);
    }
    /* and clear of the side rail, wherever the two share a height */
    var bottom = below ? y + ch : y, right = bottom > peerCard.railTop ? peerCard.railLeft - 6 : W - 8;
    var x = Math.max(hw + 8, Math.min(right - hw, ax));
    /* and never over the thumbstick: lift it clear if they would meet */
    if (x - hw < peerCard.stickRight && bottom > peerCard.stickTop - 6) {
      y -= bottom - (peerCard.stickTop - 6);
    }
    if (below !== peerCard.below) { peerCard.below = below; c.classList.toggle("below", below); }
    var off = Math.max(16 - hw, Math.min(hw - 16, ax - x)).toFixed(0);
    if (off !== peerCard.off) { peerCard.off = off; c.style.setProperty("--pc-arrow", off + "px"); }
    c.style.transform = "translate(-50%," + (below ? "0" : "-100%") + ") translate(" +
      x.toFixed(1) + "px," + y.toFixed(1) + "px)";
  }
  /* Where the fixed furniture is: what is pinned to the top of the screen
     (the top bar's buttons and pill, and the chat box where a phone puts
     it), the side rail and the thumbstick. Read at the tag rate, not every
     frame. */
  function measurePeerCardRoom() {
    var side = $("#side"), sr = side && side.getBoundingClientRect();
    peerCard.railTop = sr && sr.height ? sr.top : Infinity;
    peerCard.railLeft = sr && sr.height ? sr.left : window.innerWidth;
    var st = $("#stick"), tr = st && st.offsetParent ? st.getBoundingClientRect() : null;
    peerCard.stickTop = tr && tr.height ? tr.top : Infinity;
    peerCard.stickRight = tr && tr.height ? tr.right + 6 : -Infinity;
    /* painted boxes only: a transparent wrapper (the top bar's right-hand
       stack spans most of the screen) is looked through to what is in it */
    var tops = [];
    (function walk(list, depth) {
      list.forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (!r.height || !r.width || r.top > window.innerHeight * 0.4) return;
        var cs = getComputedStyle(e), clear = cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent";
        if (clear && depth < 3 && e.children.length) walk($$(":scope > *", e), depth + 1);
        else tops.push(r);
      });
    })($$("#topbar > *").concat($$("#chat")), 0);
    peerCard.tops = tops;
  }

  /* The avatar under a click, if it is a neighbour's. */
  function peerAt(clientX, clientY) {
    var objs = [], owner = new Map();
    Object.keys(peers).forEach(function (k) {
      var g = peers[k].g;
      if (g && g.visible) { objs.push(g); owner.set(g, k); }
    });
    if (!objs.length || !pickRay(clientX, clientY)) return null;
    var hits = ray.intersectObjects(objs, true);
    for (var i = 0; i < hits.length; i++) {
      for (var o = hits[i].object; o; o = o.parent) if (owner.has(o)) return owner.get(o);
    }
    /* A figure is mostly thin limbs, and a fingertip is not a pixel: a tap
       that lands between somebody's legs, or just beside them, still means
       them. Their on-screen column from feet to head, a little widened;
       the nearest one wins. */
    var cam = V.getCamera(), best = null, bestD = Infinity;
    objs.forEach(function (g) {
      var foot = pcVec.set(g.position.x, g.position.y + 0.1, g.position.z).project(cam);
      if (foot.z > 1) return;
      var fx = (foot.x * 0.5 + 0.5) * window.innerWidth, fy = (-foot.y * 0.5 + 0.5) * window.innerHeight;
      var head = pcVec.set(g.position.x, g.position.y + V.PERSON.headTop, g.position.z).project(cam);
      var hy = (-head.y * 0.5 + 0.5) * window.innerHeight, tall = fy - hy;
      if (tall < 4) return;
      var half = Math.max(12, tall * 0.26);
      if (clientY < hy - 6 || clientY > fy + 4 || Math.abs(clientX - fx) > half) return;
      var d = cam.position.distanceTo(g.position);
      if (d < bestD) { bestD = d; best = owner.get(g); }
    });
    return best;
  }

  /* --------------------------------------------------------------- loop
   *
   * One requestAnimationFrame, and inside it three tiers of work:
   *
   *   every frame   movement, the world, and where the name tags sit — the
   *                 things that would visibly stutter at anything less
   *   ~10 Hz        which name tags exist, the place card, the HUD, and what
   *                 we tell the network about ourselves
   *   ~4 Hz         the minimap, which is a canvas redraw nobody watches
   *                 closely enough to notice
   *
   * When the tab is in the background the whole thing is skipped: the
   * browser throttles the callback anyway, but skipping means we are not
   * doing physics and Firebase writes in the four frames a minute it does
   * still hand us.
   */
  var hudAcc = 0, miniAcc = 0, tagAcc = 0, netAcc = 0;

  /* A frame budget, not a frame rate.
   *
   * requestAnimationFrame runs at whatever the panel does, and on a 120 Hz
   * laptop or phone that is twice the work — twice the GPU, twice the
   * battery, twice the heat — for a village that does not move fast enough
   * to show it. Sixty is the cap; the 0.8 of a millisecond of slack stops a
   * frame that lands a hair early from being thrown away and turning 60 into
   * a juddering 30. */
  var FRAME_MS = 1000 / 60 - 0.8;
  var lastFrame = 0;

  function loop() {
    requestAnimationFrame(loop);
    if (!started) return;
    if (V.isHidden && V.isHidden()) return;

    var nowMs = performance.now();
    if (nowMs - lastFrame < FRAME_MS) return;
    lastFrame = nowMs;

    var dt = V.delta();
    rideTick(dt);
    movePlayer(dt);
    V.update(dt, player.position);
    if (window.QVRooms) QVRooms.update(dt, player.position);
    updatePeers(dt);
    if (window.QVBubbles) QVBubbles.update(dt, player.position);
    if (window.QVInteract) QVInteract.update(player.position.x, player.position.z);
    if (window.QVArchives) QVArchives.update(dt, player.position, V.getCamera());
    if (window.QVRestaurant) QVRestaurant.update(dt, player.position);
    positionTags();
    V.render();

    tagAcc += dt;
    if (tagAcc > 0.1) {
      tagAcc = 0;
      checkPlace();
      checkTokens();
      updateTags();
      updateReadButton();
      if (window.QVSlides && QVSlides.updateHud) QVSlides.updateHud();
      if (window.QVVoice && QVVoice.update) QVVoice.update();
    }

    netAcc += dt;
    if (netAcc > 0.1) {
      netAcc = 0;
      var rs = window.QVRooms ? QVRooms.state() : null;
      Net.setPresence({
        n: displayName(), l: me.look,
        af: me.inst || "", co: me.country || "", oi: me.orcid || "",
        x: +player.position.x.toFixed(2), z: +player.position.z.toFixed(2),
        r: +player.rotation.y.toFixed(2),
        p: (V.placeAt(player.position.x, player.position.z) || {}).name || "",
        rm: (rs && rs.roomId) || "",
        st: (rs && rs.speaking) ? "speak" : (rs && rs.seat) ? "sit" :
            (window.QVTransport && QVTransport.isDriving && QVTransport.isDriving()) ? "jeep" : "",
        si: rs && rs.seat ? rs.seat.n : -1,
        cy: !!(window.QVTransport && QVTransport.isCycling && QVTransport.isCycling())
      });
    }

    hudAcc += dt;
    if (hudAcc > 0.4) { hudAcc = 0; updateHud(); }
    miniAcc += dt;
    if (miniAcc > 0.25) { miniAcc = 0; drawMini(); }
  }

  /* How high off the floor a given chair stands. Every client builds the
     same room from the same data, so a seat number is enough to agree on
     it — nothing about the tier has to travel. */
  function seatLift(roomId, n) {
    if (!roomId || typeof n !== "number" || n < 0 || !window.QVRooms) return 0;
    var s = QVRooms.seatsOf(roomId)[n];
    return (s && s.y) || 0;
  }

  /* Walk each neighbour towards where they last said they were. Snapping is
     reserved for a jump too big to be a walk — a ferry, or a reconnection. */
  var PEER_SPEED = 10.5;
  function updatePeers(dt) {
    var keys = Object.keys(peers);
    for (var i = 0; i < keys.length; i++) {
      var pr = peers[keys[i]];
      if (pr.tx == null) continue;
      pr.t = (pr.t || 0) + dt;
      if (pr.g.userData.pose && pr.g.userData.pose !== "stand") {
        V.animatePerson(pr.g, false, pr.t, 1);
        continue;
      }
      var dx = pr.tx - pr.g.position.x, dz = pr.tz - pr.g.position.z;
      var d = Math.hypot(dx, dz);
      var moving = d > 0.12;
      if (d > 60) {
        pr.g.position.x = pr.tx; pr.g.position.z = pr.tz;
      } else if (moving) {
        /* keep pace with what they are on, or a driver drags behind */
        var step = Math.min(d, (pr.driving ? 34 : pr.cycling ? 23 : PEER_SPEED) * dt);
        pr.g.position.x += (dx / d) * step;
        pr.g.position.z += (dz / d) * step;
        var want = Math.atan2(dx, dz);
        var diff = ((want - pr.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        pr.g.rotation.y += diff * Math.min(1, dt * 8);
      } else {
        var dr = ((pr.tr - pr.g.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        pr.g.rotation.y += dr * Math.min(1, dt * 6);
      }
      V.animatePerson(pr.g, moving, pr.t, 1);
      if (pr.cycling && pr.cycle) {
        var roll = moving ? dt * 12.5 : 0;
        var wh = pr.cycle.userData.wheels || [];
        for (var wi = 0; wi < wh.length; wi++) wh[wi].rotation.x -= roll;
        if (pr.cycle.userData.pedals) pr.cycle.userData.pedals.rotation.x -= roll * 0.42;
      }
      if (pr.driving && pr.jeep && QVTransport.animateJeep) {
        var jr = pr.jeep.userData.lastR == null ? pr.g.rotation.y : pr.jeep.userData.lastR;
        var jturn = ((pr.g.rotation.y - jr + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        pr.jeep.userData.lastR = pr.g.rotation.y;
        QVTransport.animateJeep(pr.jeep, dt, moving, dt > 0 ? jturn / dt : 0);
      }
      /* far-off neighbours need not be drawn */
      pr.g.visible = Math.abs(pr.g.position.x - player.position.x) +
                     Math.abs(pr.g.position.z - player.position.z) < 460;
    }
  }

  function updateHud() {
    var p = V.placeAt(player.position.x, player.position.z);
    $("#place-name").textContent = p.name;
    $("#place-sub").textContent = p.sub || p.tag || "";
    $("#phase").textContent = V.phaseLabel();
    $("#clock").textContent = V.clockLabel();
    var n = Object.keys(peers).length + 1;
    $("#online").textContent = n + (n === 1 ? " here" : " here");
  }
  function setScore() { $("#score").textContent = me.points; }

  var bootInfo = {};
  function updateBackendPill() {
    var el = $("#backend"); if (!el) return;
    var b = Net.backend();
    if (b === "local") { el.textContent = "Solo build"; el.className = "solo"; return; }
    if (!Net.connected()) { el.textContent = "Reconnecting…"; el.className = "solo"; return; }
    var u = Net.user();
    var slow = Net.liveMode && Net.liveMode() === "firestore";
    var label = b === "firebase"
      ? (u ? (u.anon ? "Live · guest" : "Live · signed in") : "Live · read only")
      : "Live";
    el.textContent = slow ? label + " · slow sync" : label;
    el.title = slow
      ? "No Realtime Database on this project, so presence and chat run on Firestore and update every few seconds."
      : "";
    el.className = "live";
  }

  /* ------------------------------------------------------------ minimap */
  /* The minimap follows the player rather than showing the whole world:
     at nine hundred metres across, a fixed map is unreadable at 128px. */
  var MINI_R = 300;
  function drawMini() {
    var c = $("#mini"); if (!c) return;
    var ctx = c.getContext("2d");
    var W = c.width, H = c.height, R = MINI_R;
    var ox = player.position.x, oz = player.position.z;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 2, 0, 6.283); ctx.clip();
    ctx.fillStyle = "#24544C"; ctx.fillRect(0, 0, W, H);
    function px(x) { return W / 2 + ((x - ox) / R) * (W / 2 - 6); }
    function py(z) { return H / 2 + ((z - oz) / R) * (H / 2 - 6); }

    /* roads, then the railway, then the old lane */
    ctx.strokeStyle = "rgba(210,205,190,.45)"; ctx.lineWidth = 3.4;
    (V.ROADS || []).forEach(function (r) {
      ctx.beginPath();
      var pts = r.closed ? r.pts.concat([r.pts[0]]) : r.pts;
      pts.forEach(function (pt, i) {
        if (i === 0) ctx.moveTo(px(pt[0]), py(pt[1])); else ctx.lineTo(px(pt[0]), py(pt[1]));
      });
      ctx.stroke();
    });
    if (V.RAIL) {
      ctx.strokeStyle = "rgba(120,140,140,.75)"; ctx.lineWidth = 2;
      [V.RAIL.a, V.RAIL.b].forEach(function (tr) {
        ctx.beginPath(); ctx.moveTo(px(tr.from), py(tr.z)); ctx.lineTo(px(tr.to), py(tr.z)); ctx.stroke();
      });
    }
    ctx.strokeStyle = "rgba(232,217,176,.35)"; ctx.lineWidth = 3;
    ctx.beginPath();
    (V.lanePts || []).forEach(function (pt, i) {
      if (i % 4) return;
      if (i === 0) ctx.moveTo(px(pt[0]), py(pt[1])); else ctx.lineTo(px(pt[0]), py(pt[1]));
    });
    ctx.stroke();
    /* ponds */
    ctx.fillStyle = "rgba(143,198,196,.5)";
    [[-118, 84, 46, 34], [-740, 240, 52, 52]].forEach(function (p) {
      ctx.beginPath();
      ctx.ellipse(px(p[0]), py(p[1]), (p[2] / R) * (W / 2), (p[3] / R) * (H / 2), 0, 0, 6.283);
      ctx.fill();
    });
    /* places */
    V.PLACES.forEach(function (pl) {
      if (pl.kind === "board") {
        ctx.fillStyle = "#1E2B26"; ctx.strokeStyle = "#E8B04B"; ctx.lineWidth = 1;
        ctx.fillRect(px(pl.x) - 3, py(pl.z) - 2.5, 6, 5);
        ctx.strokeRect(px(pl.x) - 3, py(pl.z) - 2.5, 6, 5);
      } else {
        ctx.fillStyle = me.visited[pl.id] ? "#E8B04B" : "rgba(244,235,216,.55)";
        ctx.beginPath(); ctx.arc(px(pl.x), py(pl.z), 3, 0, 6.283); ctx.fill();
      }
    });
    /* cycle station */
    if (window.QVTransport && QVTransport.cycleStation) {
      var cs = QVTransport.cycleStation();
      var cx = px(cs.x), cz = py(cs.z);
      ctx.fillStyle = "#E8B04B"; ctx.strokeStyle = "#173A35"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cz, 8, 0, 6.283); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#173A35"; ctx.font = "700 11px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("🚲", cx, cz + 4);
      ctx.font = "700 7px system-ui, sans-serif"; ctx.fillText("CYCLE", cx, cz + 16);
    }
    /* jeep station */
    var js0 = window.QVTransport && QVTransport.jeepStations ? QVTransport.jeepStations()[0] : null;
    if (js0) {
      var jx = px(js0.x), jz = py(js0.z);
      ctx.fillStyle = "#E8B04B"; ctx.strokeStyle = "#173A35"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(jx, jz, 8, 0, 6.283); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#173A35"; ctx.font = "700 11px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("🚙", jx, jz + 4);
      ctx.font = "700 7px system-ui, sans-serif"; ctx.fillText("JEEP", jx, jz + 16);
    }
    /* tokens */
    ctx.fillStyle = "#F2D78A";
    (V.tokens || []).forEach(function (tk) {
      ctx.beginPath(); ctx.arc(px(tk.g.position.x), py(tk.g.position.z), 1.6, 0, 6.283); ctx.fill();
    });
    /* peers */
    ctx.fillStyle = "#9FE0D2";
    Object.keys(peers).forEach(function (k) {
      var pr = peers[k];
      ctx.beginPath(); ctx.arc(px(pr.g.position.x), py(pr.g.position.z), 2.4, 0, 6.283); ctx.fill();
    });
    /* you, always dead centre, with a heading pip */
    ctx.fillStyle = "#F4EBD8"; ctx.strokeStyle = "#1E4A44"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 4.2, 0, 6.283); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = "#F4EBD8"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W / 2, H / 2);
    ctx.lineTo(W / 2 + Math.sin(player.rotation.y) * 10, H / 2 + Math.cos(player.rotation.y) * 10);
    ctx.stroke();
    ctx.restore();
    /* compass */
    ctx.fillStyle = "rgba(244,235,216,.75)";
    ctx.font = "700 9px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("N", W / 2, 11);
  }

  /* ============================================================ networking */
  function wireNet() {
    Net.onPeers(function (list) {

      var seen = {};
      list.forEach(function (p) {
        seen[p.key] = 1;
        var pr = p.presence || {};
        var ent = peers[p.key];
        var remoteLook = pr.l ? V.normalizeLook(pr.l) : null;
        if (!ent) {
          var g = V.makePerson(remoteLook || V.randomLook());
          V.getScene().add(g);
          ent = peers[p.key] = { g:g, uid:p.key, name:pr.n || "Resident", sub:"", bubble:"", t:0,
                                 lookSig:V.lookSignature(remoteLook || g.userData.look) };
        }
        /* Somebody changing into a lab coat should be visible to everybody,
           so rebuild the figure when the look they publish actually changes. */
        var sig = remoteLook ? V.lookSignature(remoteLook) : ent.lookSig;
        if (remoteLook && sig !== ent.lookSig) {
          ent.lookSig = sig;
          var pos = ent.g.position.clone(), rot = ent.g.rotation.y, hadCycle = !!ent.cycle;
          V.getScene().remove(ent.g);
          ent.g = V.makePerson(remoteLook);
          ent.g.position.copy(pos); ent.g.rotation.y = rot;
          V.getScene().add(ent.g);
          if (hadCycle && ent.cycle) { ent.g.add(ent.cycle); }
          if (ent.jeep) { ent.g.add(ent.jeep); }
        }
        ent.name = pr.n || ent.name;
        ent.sub = pr.p || "";
        ent.inst = pr.af || "";
        ent.country = pr.co || "";
        ent.orcid = pr.oi || "";
        ent.room = pr.rm || "";
        ent.act = pr.st || "";
        ent.cycling = !!pr.cy;
        if (ent.cycling && !ent.cycle && window.QVTransport && QVTransport.makeCycleVisual) {
          ent.cycle = QVTransport.makeCycleVisual();
          ent.cycle.position.set(0, 0.05, 0);
          ent.g.add(ent.cycle);
        } else if (!ent.cycling && ent.cycle) {
          ent.g.remove(ent.cycle);
          ent.cycle = null;
        }
        ent.driving = pr.st === "jeep";
        if (ent.driving && !ent.jeep && window.QVTransport && QVTransport.makeJeepVisual) {
          ent.jeep = QVTransport.makeJeepVisual();
          ent.g.add(ent.jeep);
        } else if (!ent.driving && ent.jeep) {
          ent.g.remove(ent.jeep);
          ent.jeep = null;
        }
        if (typeof pr.x === "number") {
          /* Record where they say they are; the render loop walks them
             there. Presence can arrive four times a second or once every
             two and a half, and this looks the same either way. */
          ent.tx = pr.x; ent.tz = pr.z; ent.tr = pr.r || 0;
          if (ent.fresh === undefined) {
            ent.fresh = true;
            ent.g.position.x = pr.x; ent.g.position.z = pr.z; ent.g.rotation.y = ent.tr;
          }
          var pose = pr.st === "sit" ? "sit" : (pr.st === "speak" ? "speak" : "stand");
          if (ent.g.userData.pose !== pose) { V.setPose(ent.g, pose); ent.lift = 0; }
          /* A raked hall puts the back row two metres above the front one.
             setPose only knows about the sitting itself, so the tier is
             added here, from the seat number presence already carries. */
          if (pose === "sit") {
            var lift = seatLift(pr.rm, pr.si);
            if (lift !== (ent.lift || 0)) {
              ent.g.userData.yOffset = (ent.g.userData.yOffset || 0) - (ent.lift || 0) + lift;
              ent.lift = lift;
            }
          }
          /* a seated or speaking neighbour is placed exactly, so nobody
             drifts off their chair */
          if (pose !== "stand") {
            ent.g.position.x = pr.x; ent.g.position.z = pr.z; ent.g.rotation.y = ent.tr;
          }
        }
      });
      Object.keys(peers).forEach(function (k) {
        if (!seen[k]) { V.getScene().remove(peers[k].g); delete peers[k]; }
      });
      /* an open card keeps up with them, and goes when they do */
      if (peerCard.uid) { if (peers[peerCard.uid]) renderPeerCard(); else closePeerCard(); }
      updateHud();
      if (currentPanel === "people") renderPeople(true);
    });

    /* ---- chalk and posters, shared and strictly for the session ----
       Both go into the Realtime Database under the writer's uid with a
       disconnect hook on them, so the village empties itself when people
       leave. Anything that disappears from the tree is wiped locally too,
       which is what somebody else closing their tab looks like from here. */
    var shownBoards = {}, shownPosters = {}, posterLikes = {}, posterLiked = {};
    /* IDs of posters just pinned by this user; like data from Firebase is
       ignored for these for a brief window so a stale like does not appear
       as an auto-like immediately after pinning. */
    var recentlyPinned = {};

    function refreshPosterWinner(hallId) {
      if (!window.QVPosters) return;
      var halls = hallId ? [hallId] : ["poster-hall", "poster-hall-2"];
      halls.forEach(function (hid) {
        var winner = null;
        var posters = QVPosters.all(hid);
        posters.forEach(function (f) {
          if (!f.src) return;
          var likes = f.likes || 0;
          if (likes > 0 && (!winner || likes > winner.likes || (likes === winner.likes && f.id < winner.id))) {
            winner = { id: f.id, src: f.src, title: f.title, by: f.by, likes: likes };
          }
        });
        QVPosters.setWinner(hid, winner);
      });
    }

    /* Each surface shows its holder's document (see "who holds which
       surface"). The raw per-author records are kept so a change of claim
       can re-pick without waiting for the next write. */
    var rawBoards = {}, rawSlides = {}, rawPosters = {};
    var renderBoards = function () {}, renderSlides = function () {}, renderPosters = function () {};

    if (window.QVBoard) {
      var prevBoardWrite = QVBoard.onWrite;
      QVBoard.onWrite = function (id, src, by, pic) {
        if (prevBoardWrite) {
          try { prevBoardWrite(id, src, by, pic); } catch (e) {}
        }
        /* a picture only goes out under our name if the board is ours */
        var holding = Net.holdsSurface ? Net.holdsSurface("boards", id) : true;
        var p = (pic && holding) ? pic : "";
        var empty = !String(src || "").trim() && !p;
        var had = !!myBoardPic[id];
        myBoardPic[id] = !!p;
        Net.putBoard(id, empty ? null
          : { s: String(src || "").slice(0, 1200), p: p, n: by || "", at: Date.now() })
          .then(function () {
            /* took our picture down: the board is free for somebody else */
            if (had && !p && holding) releaseBoardIfIdle(id);
          });
      };
      renderBoards = function () {
        var ids = {};
        Object.keys(rawBoards).forEach(function (id) { ids[id] = 1; });
        Object.keys(shownBoards).forEach(function (id) { ids[id] = 1; });
        Object.keys(ids).forEach(function (id) {
          /* the chalk is whoever wrote last; the picture is the holder's */
          var latest = pickRecord(rawBoards[id], null);
          var holder = holderOf("boards", id);
          var picRec = holder ? pickRecord(rawBoards[id], holder) : latest;
          var pic = (picRec && picRec.v.p) || null;
          if (!latest && !pic) {
            if (!shownBoards[id]) return;
            delete shownBoards[id];
            QVBoard.receive(id, "", "", null);
            return;
          }
          shownBoards[id] = 1;
          QVBoard.receive(id, latest ? latest.v.s || "" : "", latest ? latest.v.n || "" : "", pic);
        });
      };
      Net.watchBoards(function (latest, all) { rawBoards = all || {}; renderBoards(); });
    }
    /* Slides, on exactly the same footing as the chalk: one record per hall
       carrying the page the hall is looking at, written by the presenter and
       read by everybody. A page turn is one write and one read, which is
       what makes "everybody sees the same page" true rather than hopeful. */
    if (window.QVSlides) {
      var shownSlides = {};
      QVSlides.onChange = function (roomId, payload) {
        mySlidesUp[roomId] = !!payload;
        var w = Net.putSlides(roomId, payload || null);
        /* the deck came down: give the board back once the page is gone */
        if (!payload) Promise.resolve(w).then(function () { releaseBoardIfIdle(roomId); });
      };
      renderSlides = function () {
        var ids = {};
        Object.keys(rawSlides).forEach(function (id) { ids[id] = 1; });
        Object.keys(shownSlides).forEach(function (id) { ids[id] = 1; });
        Object.keys(ids).forEach(function (id) {
          var rec = pickRecord(rawSlides[id], holderOf("boards", id));
          if (rec) {
            shownSlides[id] = 1;
            QVSlides.receive(id, rec.v);
          } else if (shownSlides[id]) {
            delete shownSlides[id];
            QVSlides.receive(id, null);
          }
        });
        if (QVSlides.refresh) QVSlides.refresh();
      };
      Net.watchSlides(function (latest, all) { rawSlides = all || {}; renderSlides(); });
    }
    /* Somebody claimed or freed a stand or a board: re-pick what each one
       shows, and let an open slides panel say whether it is free. */
    if (Net.watchSurfaces) {
      Net.watchSurfaces(function (all) {
        surfaces = { posters: (all && all.posters) || {}, boards: (all && all.boards) || {} };
        renderBoards(); renderSlides(); renderPosters();
      });
    }
    if (Net.onClaimLost) {
      Net.onClaimLost(function (kind, id) {
        if (kind === "boards") { myBoardPic[id] = false; mySlidesUp[id] = false; }
        var h = holderOf(kind, id);
        toast("You were offline and <b>" + esc((h && h.n) || "someone else") +
              "</b> has pinned their document where yours was. Yours has been taken down.");
      });
    }
    if (window.QVPosters) {
      var prevPosterPin = QVPosters.onPin;
      QVPosters.onPin = function (id, src, title, by) {
        if (prevPosterPin) {
          try { prevPosterPin(id, src, title, by); } catch (e) {}
        }
        /* Immediately clear likes locally so no stale state bleeds through */
        posterLikes[id] = 0;
        delete posterLiked[id];
        QVPosters.setLikes(id, 0);
        QVPosters.setLiked(id, false);
        /* Mark as recently pinned so that any watchPosterLikes callback that
           fires before the server-side delete completes cannot re-apply a
           stale like for this poster. Cleared after 4 seconds. */
        recentlyPinned[id] = Date.now();
        setTimeout(function () { delete recentlyPinned[id]; }, 4000);
        if (Net.clearMyPosterLike) Net.clearMyPosterLike(id);
        var hid = id.indexOf("poster-hall-2") === 0 ? "poster-hall-2" : "poster-hall";
        refreshPosterWinner(hid);

        var payload = src ? { s: src, t: String(title || "").slice(0, 160),
                              n: by || "", at: Date.now() } : null;
        /* In a hall running a poster competition the stand was claimed for
           the competition (see claimSurface), and the poster goes up as a
           competition poster: it outlives this session and ends when the
           competition does. The rules check every one of these fields. */
        var comp = claimComp[id];
        if (payload && comp && comp.expiresAt > serverNow()) {
          payload.competitionId = comp.competitionId;
          payload.hallId = hallOfFrame(id);
          payload.expiresAt = comp.expiresAt;
        }
        var myRec = rawPosters[id] && rawPosters[id][myUidNow()];
        var wasComp = !!(myRec && myRec.competitionId);
        var w = Promise.resolve(Net.putPoster(id, payload)).catch(function () {
          toast("<b>That poster did not go up.</b> The competition in this hall may have just " +
                "ended — try pinning it again.");
        });
        /* taken down: the poster goes first, then the stand is free. A
           competition claim may be from before a page refresh, so it is
           given back even if this session did not take it. */
        if (!src && Net.releaseSurface) {
          w.then(function () { Net.releaseSurface("posters", id, wasComp); });
        }
        /* The organiser took down a competition poster and none are left
           in the competition: it ends, rather than counting down over an
           empty hall. */
        if (!src && wasComp) {
          var hall = hallOfFrame(id), ac = activeCompetition(hall);
          if (ac && ac.id === myRec.competitionId && ac.organiserId === myUidNow() &&
              !competitionPosterCount(ac.id, id + "/" + myUidNow())) {
            w.then(function () { return Net.endPosterCompetition(ac.id, hall); }).then(function () {
              toast("\uD83C\uDFC6 <b>" + esc(ac.title) + "</b> has ended — its last poster came down. " +
                    "The hall is back to normal presentation mode.");
            }).catch(function () {});
          }
        }
      };
      renderPosters = function () {
        var jobs = [];
        var updatedHalls = {};
        var ids = {};
        Object.keys(rawPosters).forEach(function (id) { ids[id] = 1; });
        Object.keys(shownPosters).forEach(function (id) { ids[id] = 1; });
        var now = serverNow();
        Object.keys(ids).forEach(function (id) {
          var rec = pickRecord(livePosterRecords(id, now), holderOf("posters", id));
          var hid = id.indexOf("poster-hall-2") === 0 ? "poster-hall-2" : "poster-hall";
          if (rec) {
            shownPosters[id] = 1;
            updatedHalls[hid] = true;
            jobs.push(QVPosters.receive(id, rec.v.s || null, rec.v.t || "", rec.v.n || "", rec.u,
              rec.v.competitionId ? { competitionId: rec.v.competitionId, expiresAt: rec.v.expiresAt } : null));
          } else if (shownPosters[id]) {
            delete shownPosters[id];
            updatedHalls[hid] = true;
            jobs.push(QVPosters.receive(id, null, "", "", ""));
          }
        });
        /* stands still held for a competition that is over */
        Object.keys(surfaces.posters || {}).forEach(function (id) {
          var c = surfaces.posters[id];
          if (c && ((typeof c.expiresAt === "number" && c.expiresAt + SWEEP_GRACE <= now) ||
                    (c.competitionId && !competitionLive(c.competitionId, id)))) {
            queueSweep("pins", "pins/posters/" + id);
          }
        });
        Promise.all(jobs).then(function () {
          Object.keys(updatedHalls).forEach(function (hid) {
            refreshPosterWinner(hid);
          });
        });
      };
      /* A competition poster is shown until its expiresAt by the server's
         clock and not a moment longer, whether or not anybody has swept it
         yet. Whatever is past its time is handed to the sweeper. */
      function livePosterRecords(id, now) {
        var byUid = rawPosters[id] || {}, out = {};
        Object.keys(byUid).forEach(function (u) {
          var v = byUid[u];
          if (v && typeof v.expiresAt === "number") {
            if (v.expiresAt + SWEEP_GRACE <= now) queueSweep("posters", "posters/" + id + "/" + u);
            if (v.expiresAt <= now) return;
          }
          /* its competition was ended early */
          if (v && v.competitionId && !competitionLive(v.competitionId, id)) {
            queueSweep("posters", "posters/" + id + "/" + u);
            return;
          }
          out[u] = v;
        });
        return out;
      }
      rerenderPosters = renderPosters;
      /* How many posters are still up in a competition, leaving one out. */
      competitionPosterCount = function (cid, except) {
        var n = 0;
        Object.keys(rawPosters).forEach(function (f) {
          Object.keys(rawPosters[f] || {}).forEach(function (u) {
            var v = rawPosters[f][u];
            if (v && v.competitionId === cid && f + "/" + u !== except) n++;
          });
        });
        return n;
      };
      Net.watchPosters(function (latest, all) { rawPosters = all || {}; renderPosters(); });
      Net.watchPosterLikes(function (counts, mine) {
        posterLikes = counts || {};
        posterLiked = {};
        Object.keys(mine || {}).forEach(function (id) {
          /* Do not mark a just-pinned poster as liked — the Firebase delete
             for the previous like may not have propagated yet. */
          if (!recentlyPinned[id]) posterLiked[id] = true;
        });
        QVPosters.syncLikes(posterLikes, posterLiked);
        refreshPosterWinner("poster-hall");
        refreshPosterWinner("poster-hall-2");
      });
    }
    wireCompetitions();
    wireNotices();
    wireRideHud();
    if (window.QVEvents) {
      QVEvents.init({
        toast: toast,
        uid: myUidNow,
        profile: function () { return { name: fullNameGuess(), inst: me.inst || "" }; },
        onOpen: function () { if (window.QVInteract) QVInteract.setEnabled(false); },
        onClose: function () { if (window.QVInteract) QVInteract.setEnabled(true); },
        goTo: function (x, z) { closePanel(); ferry(x, z); },
        goButtons: goButtons,
        closePanel: closePanel,
        onChange: function () {
          refreshPosterWinner();
          /* not while somebody is typing in the participant search */
          var ae = document.activeElement;
          if (currentPanel === "notices" && !(ae && ae.dataset && ae.dataset.peSearch)) renderNotices(boardDetail);
          if (window.QVAdmin && QVAdmin.eventsChanged) QVAdmin.eventsChanged();
          paintNoticeCount();
          autoOpenBoard();
        }
      });
    }

    Net.onChat(function (m, isMe) {
      var ann = !!m.a;
      /* Anything said out in the village only carries as far as earshot.
         An announcement carries everywhere, and a message with no position
         on it — an older client, say — is let through rather than lost. */
      if (!isMe && !ann && typeof m.x === "number" && typeof m.z === "number") {
        if (Math.hypot(m.x - player.position.x, m.z - player.position.z) > EARSHOT) return;
      }
      addChat(m.n || "Resident", m.m || "", isMe, ann);
      /* An announcement should reach you even with the chat rolled up. */
      if (ann && !isMe) toast("<b>" + esc(m.n || "Someone") + "</b> — " + esc(String(m.m).slice(0, 90)));
      speechBubble(m, isMe);
    });

    /* What was said comes up over the speaker's head, in the world, for
       as long as it takes to read (bubbles.js). One bubble per person: a
       second message replaces the first. Earshot has already been applied
       above, so a bubble shows exactly where the chat line does. */
    function speechBubble(m, isMe) {
      if (!window.QVBubbles || !m.m) return;
      if (isMe) {
        QVBubbles.say("me", function () { return player; }, m.m, { name: "You", ann: !!m.a });
        return;
      }
      var key = m.uid && peers[m.uid] ? m.uid
        : Object.keys(peers).filter(function (k) { return peers[k].name === m.n; })[0];
      if (!key) return;
      QVBubbles.say(key, function () { return peers[key] && peers[key].g; }, m.m, {
        name: m.n || peers[key].name, ann: !!m.a,
        /* clear of their name tag, and of the voice line when it shows */
        clearPx: function () { return peers[key] && peers[key].bubble ? 64 : 42; }
      });
    }

    Net.onEvent(function (kind, d) {
      if (kind === "institute") {
        toast("<b>" + esc(d.name || "An institute") + "</b> has been founded in the village");
        loadInstitutes();
      }
      if (kind === "seminar") toast("Seminar called at <b>" + esc(d.where || "the Lecture Barn") + "</b>");
    });

    Net.onAuth(function (u) {
      if (u) {
        /* an anonymous account has no display name; keep the one on the lane */
        if (u.name && (!me.name || me.name === "Resident")) { me.name = u.name; saveMe(); }
        me.uid = u.uid;
        publishResident();
        /* Administration, once we know who is asking. Whether the icon
           appears is decided by the database, not by this file, and the
           rules decide whether anything it does is allowed. It is also what
           notices if this account has been blocked in the middle of a
           session and says so, rather than letting the village go quiet. */
        if (window.QVAdmin && !adminStarted) {
          adminStarted = true;
          QVAdmin.init({ toast: toast });
        }
      }
      renderAccount();
      updateBackendPill();
    });

    /* A dropped connection is normal on a phone; say so quietly and put it
       back when it returns, rather than letting the village silently stop. */
    Net.onConnection(function (up) {
      var bar = $("#netbar");
      if (!bar) return;
      if (up) {
        bar.classList.remove("on");
      } else if (Net.backend() !== "local") {
        bar.innerHTML = "<b>Offline.</b> The village is still here — your neighbours will " +
          "reappear when the connection does.";
        bar.classList.add("on");
      }
      updateBackendPill();
    });

    Net.collWatch("institutes", function (rows) {
      institutes = rows;
      syncInstitutes();
      if (currentPanel === "institutes") renderInstitutes();
    });
    Net.collWatch("groups", function (rows) {
      groups = rows;
      if (currentPanel === "groups") renderGroups();
    });
    Net.watchScores(function (rows) {
      scores = rows;
      if (currentPanel === "board") renderBoard();
    });
  }

  var institutes = [], groups = [], scores = [];
  var spawned = {};
  function syncInstitutes() {
    institutes.forEach(function (u, i) {
      if (spawned[u.id]) return;
      spawned[u.id] = true;
      V.foundInstitute(u, i, true);
    });
  }
  function loadInstitutes() { /* collWatch already live; kept for event hook */ }

  /* ================================================================ chat */
  /* Village talk is not kept anywhere — the database copy is deleted as soon
     as the people who are here have read it — so the log on screen behaves
     the same way rather than pretending there is a history to scroll. */
  var CHAT_ON_SCREEN = 180000;

  /* The chat folds down to its header. Opening it — from the Chat button,
     the +/– on the right, or Enter — shows the log and the box, clears the
     unread count, and puts the cursor in the box when asked to. */
  var chatUnread = 0;
  function setChatOpen(open, focus) {
    var c = $("#chat");
    if (!c) return;
    c.classList.toggle("min", !open);
    var t = $("#chat-toggle");
    if (t) {
      t.textContent = open ? "\u2013" : "+";
      t.setAttribute("aria-label", open ? "Collapse chat" : "Expand chat");
    }
    var b = $("#chat-open");
    if (b) {
      b.classList.toggle("on", open);
      b.setAttribute("aria-expanded", open ? "true" : "false");
      b.title = open ? "Hide the text chat" : "Open the text chat";
    }
    if (open) {
      chatUnread = 0;
      paintUnread();
      var log = $("#chat-log");
      if (log) log.scrollTop = log.scrollHeight;
      if (focus) { var ci = $("#chat-input"); if (ci) ci.focus(); }
    }
  }
  function paintUnread() {
    var u = $("#chat-unread");
    if (!u) return;
    u.hidden = !chatUnread;
    u.textContent = chatUnread > 9 ? "9+" : String(chatUnread);
    var b = $("#chat-open");
    if (b) b.setAttribute("aria-label", chatUnread
      ? "Open the text chat \u2014 " + chatUnread + " new message" + (chatUnread === 1 ? "" : "s")
      : "Open the text chat");
  }

  function addChat(who, text, isMe, ann) {
    var log = $("#chat-log");
    var folded = $("#chat") && $("#chat").classList.contains("min");
    if (folded && !isMe) { chatUnread++; paintUnread(); }
    var row = document.createElement("div");
    row.className = "cline" + (isMe ? " me" : "") + (ann ? " ann" : "");
    row.innerHTML = (ann ? '<span class="cann">Village</span>' : "") +
      '<span class="cw">' + esc(who) + '</span><span class="cm">' + esc(text) + "</span>";
    log.appendChild(row);
    while (log.children.length > 40) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    setTimeout(function () {
      row.classList.add("gone");
      setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, 700);
    }, CHAT_ON_SCREEN);
  }
  /* ============================================ who holds which surface
   *
   * A poster stand or a blackboard carries one person's document at a
   * time; net.js keeps the claims and the database rules enforce them.
   * This is the village's view of them, handed to posters.js, board.js and
   * slides.js so each can say "in use by Ada" before anybody picks a file,
   * and used below to show the holder's document rather than whichever
   * record happened to be written last. */
  var surfaces = { posters: {}, boards: {} };
  function myUidNow() {
    var u = Net.user && Net.user();
    return u ? u.uid : (window.QVLocalId || "guest");
  }
  function holderOf(kind, id) {
    var c = surfaces[kind] && surfaces[kind][id];
    /* a stand held for a competition that is over is free */
    if (c && typeof c.expiresAt === "number" && c.expiresAt <= serverNow()) return null;
    if (c && c.competitionId && kind === "posters" && !competitionLive(c.competitionId, id)) return null;
    return c && c.u ? c : null;
  }
  /* The competition a stand was claimed for, if any, so the poster that
     follows goes up under the same one. */
  var claimComp = {};
  function claimSurface(kind, id) {
    var comp = null;
    if (kind === "posters") {
      var ac = activeCompetition(hallOfFrame(id));
      if (ac) comp = { competitionId: ac.id, expiresAt: ac.expiresAt };
      claimComp[id] = comp;
    }
    return Net.claimSurface ? Net.claimSurface(kind, id, displayName(), comp)
                            : Promise.resolve({ ok: true });
  }
  /* ================================================ poster competitions
   *
   * A layer over the poster halls, not a second poster system. A hall runs
   * in one of two modes:
   *
   *   normal       posters are the session's, exactly as before: they come
   *                down when their author leaves.
   *   competition  an administrator has approved a request, and for 24
   *                hours from that approval (by the database's clock) every
   *                poster pinned in the hall is a competition poster, which
   *                stays up after its author leaves and ends with the
   *                competition.
   *
   * net.js keeps the records and the rules enforce them; this is the
   * village's view: which mode each hall is in, the card that says so, the
   * request form, and hiding and sweeping what has expired. */
  var POSTER_HALL_NAMES = { "poster-hall": "The Poster Hall", "poster-hall-2": "The Grand Poster Hall" };
  var hallComps = {};          /* hallId -> { id, approvedAt, expiresAt, competition } */
  var compRequests = {};       /* pending requests, id -> record */
  var rerenderPosters = function () {};
  var competitionPosterCount = function () { return 0; };
  var SWEEP_GRACE = 5000;      /* allow for our estimate of the server clock */

  function hallOfFrame(id) { return String(id).indexOf("poster-hall-2") === 0 ? "poster-hall-2" : "poster-hall"; }
  function serverNow() { return Net.serverNow ? Net.serverNow() : Date.now(); }

  function activeCompetition(hallId) {
    var l = hallComps[hallId];
    if (!l || !l.competition || l.competition.status !== "active") return null;
    if (typeof l.expiresAt !== "number" || l.expiresAt <= serverNow()) return null;
    return { id: l.id, hallId: hallId, title: l.competition.title || "Poster competition",
             organiserName: l.competition.organiserName || "", organiserId: l.competition.organiserId || "",
             expiresAt: l.expiresAt };
  }
  /* Is a competition poster's (or stand's) competition still the one its
     hall is running? A competition ended early lets its hall go at once,
     and from that moment its posters are hidden everywhere, whether or not
     anybody has swept them yet. Until the halls have been read — or while
     a hall's competition record is still arriving — the answer is "yes",
     so nothing flickers on a page load. */
  var hallCompsLoaded = false;
  function competitionLive(competitionId, frameId) {
    if (!competitionId || !hallCompsLoaded) return true;
    var l = hallComps[hallOfFrame(frameId)];
    if (l && l.id === competitionId && !l.competition) return true;
    var ac = activeCompetition(hallOfFrame(frameId));
    return !!(ac && ac.id === competitionId);
  }
  /* The request a hall shows as pending: ours if we have one, otherwise the
     oldest. */
  function pendingRequestFor(hallId) {
    var me = myUidNow(), best = null;
    Object.keys(compRequests).forEach(function (id) {
      var r = compRequests[id];
      if (!r || r.hallId !== hallId || r.status !== "pending") return;
      var c = { id: id, title: r.title, mine: r.userId === me, at: r.requestedAt || 0 };
      if (!best || (c.mine && !best.mine) || (c.mine === best.mine && c.at < best.at)) best = c;
    });
    return best;
  }
  function hallMode(hallId) {
    var ac = activeCompetition(hallId);
    if (ac) return "a:" + ac.id;
    var p = pendingRequestFor(hallId);
    return p ? "p:" + p.id + (p.mine ? ":m" : "") : "n";
  }

  /* Tidying up after the end of a competition. What has expired is already
     hidden by the server clock; this only deletes it. Any visitor may, the
     rules allow it once expiresAt has passed, and a short random wait keeps
     a hall full of people from all doing it at the same instant. */
  var sweepQ = { posters: {}, pins: {}, comps: {}, notices: {} }, sweepTimer = null, sweptOnce = {};
  function queueSweep(kind, key, val) {
    if (!Net.sweepExpiredCompetition || !Net.competitionsLive || !Net.competitionsLive()) return;
    if (sweptOnce[kind + ":" + key]) return;
    sweptOnce[kind + ":" + key] = 1;
    sweepQ[kind][key] = val || true;
    if (!sweepTimer) sweepTimer = setTimeout(runSweep, 1500 + Math.random() * 4500);
  }
  function runSweep() {
    sweepTimer = null;
    var q = sweepQ;
    sweepQ = { posters: {}, pins: {}, comps: {}, notices: {} };
    /* events that are over move from Upcoming to Past for everybody */
    Object.keys(q.notices).forEach(function (nid) {
      Net.setNoticeStatus(nid, "archived").catch(function () {});
    });
    var posters = Object.keys(q.posters), pins = Object.keys(q.pins);
    if (posters.length || pins.length) Net.sweepExpiredCompetition({ posters: posters, pins: pins });
    Object.keys(q.comps).forEach(function (id) {
      Net.sweepExpiredCompetition({ id: id, hallId: q.comps[id] });
    });
  }

  var lastModes = {};
  function compChanged() {
    rerenderPosters();
    paintHallCard(true);
    if (window.QVPosters && QVPosters.refreshMode) QVPosters.refreshMode();
    Object.keys(POSTER_HALL_NAMES).forEach(function (h) { lastModes[h] = hallMode(h); });
  }
  /* Once a second: the countdown, and the moment a competition runs out,
     which has to switch the hall back to normal for everybody inside it
     without waiting for anybody to write anything. The end itself is
     decided by expiresAt against the server clock, not by this timer. */
  function compTick() {
    var changed = false;
    Object.keys(POSTER_HALL_NAMES).forEach(function (h) {
      if (hallMode(h) !== lastModes[h]) changed = true;
      var l = hallComps[h];
      if (l && typeof l.expiresAt === "number" && l.expiresAt + SWEEP_GRACE <= serverNow()) {
        queueSweep("comps", l.id, h);
      } else if (l && l.competition && l.competition.status === "active" &&
                 (l.competition.expiresAt == null || l.expiresAt == null) && !sweptOnce["fill:" + l.id]) {
        /* the administrator's tab closed between the two approval writes */
        sweptOnce["fill:" + l.id] = 1;
        if (Net.fillCompetitionExpiry) Net.fillCompetitionExpiry(l.id, h).catch(function () {});
      }
    });
    if (changed) compChanged();
    else paintHallCard(false);
  }

  function wireCompetitions() {
    /* the card's Upload button works in every back end; competitions
       themselves need the Realtime Database */
    var box = $("#hallcomp");
    if (box) box.addEventListener("click", onHallCardClick);
    if (!Net.competitionsLive || !Net.competitionsLive()) return;
    Net.watchHallCompetitions(function (map) { hallComps = map || {}; hallCompsLoaded = true; compChanged(); });
    Net.watchPendingCompetitionRequests(function (map) { compRequests = map || {}; compChanged(); });
    /* Whoever asked hears the answer, wherever they are in the village. */
    var prevMine = null;
    Net.watchMyCompetitionRequests(function (map) {
      map = map || {};
      if (prevMine) {
        Object.keys(map).forEach(function (id) {
          var a = prevMine[id], b = map[id];
          if (!a || !b || a.status !== "pending" || b.status === "pending") return;
          var hall = POSTER_HALL_NAMES[b.hallId] || "the poster hall";
          toast(b.status === "approved"
            ? "🏆 Your poster competition <b>" + esc(b.title) + "</b> was approved. It runs for " +
              "24 hours in <b>" + esc(hall) + "</b>."
            : "Your request for the poster competition <b>" + esc(b.title) + "</b> was not approved.");
        });
      }
      prevMine = map;
      myCompReqs = map;
      if (currentPanel === "notices") renderNotices();
    });
    setInterval(compTick, 1000);
  }

  function fmtLeft(ms) {
    ms = Math.max(0, ms);
    var t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return two(h) + ":" + two(m) + ":" + two(sec);
  }

  /* The card in the room badge while you are in a poster hall. Rebuilt
     only when the hall's mode changes, so a button is never replaced under
     a finger; the countdown alone is updated every second. */
  var hallCardKey = "";
  function paintHallCard(force) {
    var box = $("#hallcomp");
    if (!box) return;
    var st = window.QVRooms ? QVRooms.state() : null;
    var halls = Net.BOOKABLE_HALLS || {};
    var hid = st && st.roomId && (POSTER_HALL_NAMES[st.roomId] || halls[st.roomId]) ? st.roomId : null;
    if (!hid) { box.hidden = true; hallCardKey = ""; return; }
    var isPoster = !!POSTER_HALL_NAMES[hid];
    var ac = isPoster ? activeCompetition(hid) : null;
    var ev = hallEvents(hid);
    var key = hid + "|" + (isPoster ? hallMode(hid) : "s") + "|" + (ac ? ac.title : "") + "|" +
              (ev.now ? ev.now.noticeId : "") + "|" + (ev.next ? ev.next.noticeId + ev.next.status : "");
    if (!force && key === hallCardKey) {
      var left = box.querySelector(".hc-left");
      if (left && ac) left.textContent = fmtLeft(ac.expiresAt - serverNow());
      return;
    }
    hallCardKey = key;
    box.hidden = false;
    box.dataset.hall = hid;
    var live = Net.competitionsLive && Net.competitionsLive();
    var canBook = !!halls[hid] && Net.bookingsLive && Net.bookingsLive();
    var bookBtn = canBook ? '<button class="btn small ghost" type="button" data-hc="book">Book This Hall</button>' : "";
    /* what is on in this hall, from the Notice Board */
    var events = "";
    if (ev.now) {
      events += '<button type="button" class="hc-event" data-hc="event" data-id="' + esc(ev.now.noticeId) + '">' +
        '<span class="hc-tag">On now</span> <b>' + esc(ev.now.topic) + "</b> · until " +
        esc(fmtTime(noticeEnd(ev.now))) + "</button>";
    }
    if (ev.next) {
      events += '<button type="button" class="hc-event" data-hc="event" data-id="' + esc(ev.next.noticeId) + '">' +
        '<span class="hc-tag">Next here</span> <b>' + esc(ev.next.topic) + "</b> · " +
        esc(fmtWhenShort(ev.next.startAt)) + "</button>";
    }
    if (!isPoster) {
      box.className = "hc";
      box.innerHTML = '<span class="hc-mode">' + esc(halls[hid].name) + "</span>" +
        (events || '<span class="hc-line">Nothing booked here yet.</span>') +
        '<div class="hc-acts">' + bookBtn +
        '<button class="btn small ghost" type="button" data-hc="board">Notice Board</button></div>';
      return;
    }
    if (ac) {
      box.className = "hc on-comp";
      box.innerHTML =
        '<span class="hc-mode">\uD83C\uDFC6 Poster Presentation Competition</span>' +
        '<span class="hc-line">Competition: <b>' + esc(ac.title) + "</b></span>" +
        '<span class="hc-line">Time remaining: <b class="hc-left">' + fmtLeft(ac.expiresAt - serverNow()) + "</b></span>" +
        events +
        '<div class="hc-acts"><button class="btn small" type="button" data-hc="upload">Upload Competition Poster</button>' +
        (ac.organiserId && ac.organiserId === myUidNow()
          ? '<button class="btn small ghost danger" type="button" data-hc="endcomp">End competition</button>' : "") +
        bookBtn + "</div>";
      return;
    }
    var p = pendingRequestFor(hid);
    box.className = "hc";
    if (p) {
      box.innerHTML =
        '<span class="hc-mode">Competition Request Pending</span>' +
        '<span class="hc-line">' + (p.mine ? "Your request" : "A request") + " for <b>" + esc(p.title) +
        "</b> is waiting for admin approval.</span>" + events +
        '<div class="hc-acts"><button class="btn small" type="button" data-hc="upload">Upload Poster</button>' +
        (p.mine ? '<button class="btn small ghost" type="button" data-hc="withdraw" data-id="' + esc(p.id) +
                  '">Withdraw request</button>' : "") + bookBtn + "</div>";
      return;
    }
    box.innerHTML =
      '<span class="hc-mode">Normal Presentation Mode</span>' + events +
      '<div class="hc-acts"><button class="btn small" type="button" data-hc="upload">Upload Poster</button>' +
      (live ? '<button class="btn small ghost" type="button" data-hc="request">Request Poster Competition</button>' : "") +
      bookBtn + "</div>";
  }

  /* Clear of everything that shares its corner. On a wide screen the room
     badge sits at the top left (see style.css) and the card goes straight
     under it. On a phone the chat box has the top left and the bottom of the
     screen belongs to the thumbstick and the prompts, so the card goes
     straight under the chat box, following it as it is expanded or folded. */
  var WIDE = "(min-width:821px) and (min-height:561px)";
  function placeHallCard() {
    var box = $("#hallcomp");
    if (!box || box.hidden) return;
    var top = 84;
    if (window.matchMedia && window.matchMedia(WIDE).matches) {
      var rh = $("#roomhud");
      /* offsetTop ignores the badge's slide-in transform */
      if (rh && rh.offsetHeight) top = rh.offsetTop + rh.offsetHeight + 8;
    } else {
      var chat = $("#chat");
      var r = chat ? chat.getBoundingClientRect() : null;
      if (r && r.height) top = Math.round(r.bottom + 8);
    }
    box.style.top = top + "px";
  }
  (function () {
    window.addEventListener("resize", placeHallCard);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(placeHallCard);
      ["#chat", "#roomhud"].forEach(function (sel) { var n = $(sel); if (n) ro.observe(n); });
    }
  })();

  function onHallCardClick(e) {
    var b = e.target.closest ? e.target.closest("button[data-hc]") : null;
    if (!b || b.disabled) return;
    e.preventDefault();
    var hid = $("#hallcomp").dataset.hall;
    var act = b.dataset.hc;
    if (act === "upload") {
      if (!window.QVPosters || QVPosters.isOpen()) return;
      var id = QVPosters.freeFrame(hid, player.position.x, player.position.z);
      if (!id) { toast("Every poster stand in <b>" + esc(POSTER_HALL_NAMES[hid]) + "</b> is taken right now."); return; }
      QVPosters.openPin(id);
    } else if (act === "request") {
      openCompRequest(hid);
    } else if (act === "endcomp") {
      var ac = activeCompetition(hid);
      if (!ac || !window.confirm("End \u201C" + ac.title + "\u201D now?\n\nThe timer stops, every competition " +
                                 "poster in this hall comes down, and the hall goes back to normal mode.")) return;
      b.disabled = true;
      Net.endPosterCompetition(ac.id, hid).then(function () {
        toast("\uD83C\uDFC6 <b>" + esc(ac.title) + "</b> has ended.");
      }).catch(function () {
        b.disabled = false;
        toast("<b>That did not go through</b> — the database refused it.");
      });
    } else if (act === "book") {
      openBooking(hid);
    } else if (act === "board") {
      renderNotices();
    } else if (act === "event") {
      renderNotices(b.dataset.id);
    } else if (act === "withdraw") {
      b.disabled = true;
      Net.withdrawPosterCompetitionRequest(b.dataset.id)
        .then(function () { toast("Competition request withdrawn."); })
        .catch(function () { b.disabled = false; toast("<b>That did not go through</b> — the request may already have been decided."); });
    }
  }

  /* ---- asking for a competition ---- */
  function compRequestOpen() { var o = $("#comp-req"); return !!(o && !o.hidden); }
  function closeCompRequest() {
    var o = $("#comp-req");
    if (!o || o.hidden) return;
    o.hidden = true;
    if (window.QVInteract) QVInteract.setEnabled(true);
  }
  function openCompRequest(hid) {
    var o = $("#comp-req");
    if (!o || compRequestOpen()) return;
    if (activeCompetition(hid)) { toast("A competition is already running here."); return; }
    var p = pendingRequestFor(hid);
    if (p) { toast("A competition request for this hall is already waiting for approval."); return; }
    $("#cr-hall").textContent = POSTER_HALL_NAMES[hid];
    $("#cr-title").value = "";
    $("#cr-desc").value = "";
    $("#cr-when").value = "";
    $("#cr-name").value = fullNameGuess();
    $("#cr-inst").value = me.inst || "";
    $("#cr-pos").value = "";
    var err = $("#cr-err"); err.hidden = true; err.textContent = "";
    o.hidden = false;
    if (window.QVInteract) QVInteract.setEnabled(false);
    setTimeout(function () { try { $("#cr-title").focus(); } catch (e2) {} }, 30);
    var go = $("#cr-go");
    $("#cr-cancel").onclick = closeCompRequest;
    o.onclick = function (e) { if (e.target === o) closeCompRequest(); };
    $("#cr-form").onsubmit = function (e) {
      e.preventDefault();
      var title = $("#cr-title").value.trim();
      if (!title) { err.textContent = "Give the competition a title."; err.hidden = false; return; }
      if (!$("#cr-name").value.trim()) { err.textContent = "Say who is organising it — it goes on the Notice Board."; err.hidden = false; return; }
      var when = $("#cr-when").value ? new Date($("#cr-when").value).getTime() : null;
      go.disabled = true;
      Net.requestPosterCompetition({
        hallId: hid, title: title, description: $("#cr-desc").value,
        preferredStart: (when && isFinite(when)) ? when : null, userName: displayName(),
        fullName: $("#cr-name").value, institution: $("#cr-inst").value, position: $("#cr-pos").value
      }).then(function () {
        closeCompRequest();
        toast("Competition requested for <b>" + esc(POSTER_HALL_NAMES[hid]) +
              "</b>. It starts when an administrator approves it.");
      }).catch(function (x) {
        err.textContent = "The request did not go through" + (x && x.message ? " — " + x.message : ".");
        err.hidden = false;
      }).then(function () { go.disabled = false; });
    };
  }

  /* ================================= hall bookings and the notice board
   *
   * Anybody may ask to book a seminar or poster hall; an administrator
   * approves or rejects. Approval takes the hall's quarter hours (so two
   * overlapping bookings cannot both be approved) and puts the event on
   * the Village Notice Board, which is the one place the whole village
   * finds out what is on. An approved poster competition goes on the board
   * the same way. Nothing a resident writes goes on the board directly —
   * the rules allow only an administrator's approval to create a notice.
   *
   * Every time is absolute, so each visitor sees the event in their own
   * time zone; "upcoming" and "past" are judged by the server's clock. */
  var notices = {}, myBookings = {}, myCompReqs = {};
  var boardTime = "upcoming", boardType = "all", boardDetail = null;
  var BOARD_TYPES = [["all", "All"], ["seminar", "Seminars"], ["poster_presentation", "Poster Presentations"],
    ["poster_competition", "Poster Competitions"], ["workshop", "Workshops"],
    ["research_discussion", "Research Discussions"], ["other", "Other"]];
  var BOARD_TIMES = [["upcoming", "Upcoming"], ["today", "Today"], ["week", "This Week"],
    ["past", "Past"], ["mine", "My requests"]];
  var REQ_STATUS = { pending: "Pending", approved: "Approved", rejected: "Not approved", cancelled: "Cancelled" };

  function typeLabel(t) { return (Net.EVENT_TYPES || {})[t] || "Event"; }
  function typeGroup(t) {
    return ["seminar", "poster_presentation", "poster_competition", "workshop",
            "research_discussion"].indexOf(t) >= 0 ? t : "other";
  }
  /* a poster competition's notice has no end until it is filled in, and
     its end is always 24 hours after it started */
  function noticeEnd(n) {
    return typeof n.endAt === "number" ? n.endAt : (n.startAt || 0) + (Net.COMPETITION_MS || 86400000);
  }
  function noticePast(n, now) { return n.status === "archived" || noticeEnd(n) <= now; }
  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "long", year: "numeric" });
  }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function fmtWhenShort(ms) {
    var d = new Date(ms), today = new Date(serverNow());
    return (d.toDateString() === today.toDateString() ? "today"
      : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })) + ", " + fmtTime(ms);
  }
  function fmtRange(n) {
    var st = n.startAt, en = noticeEnd(n);
    return fmtTime(st) + " – " +
      (new Date(st).toDateString() === new Date(en).toDateString() ? fmtTime(en) : fmtDate(en) + ", " + fmtTime(en));
  }
  function fullNameGuess() {
    return ((me.title ? me.title + " " : "") + (me.name || displayName())).trim().slice(0, 80);
  }
  function hallName(id) { return ((Net.BOOKABLE_HALLS || {})[id] || {}).name || POSTER_HALL_NAMES[id] || id; }
  function myTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
  }

  /* What is on in a hall now, and next. */
  function hallEvents(hid) {
    var now = serverNow(), cur = null, next = null;
    Object.keys(notices).forEach(function (k) {
      var n = notices[k];
      if (!n || n.hallId !== hid || n.status !== "active" || noticeEnd(n) <= now) return;
      if (n.startAt <= now) { if (!cur || n.startAt < cur.startAt) cur = n; }
      else if (!next || n.startAt < next.startAt) next = n;
    });
    return { now: cur, next: next };
  }

  function wireNotices() {
    var btn = $("#notices-btn");
    if (btn) btn.addEventListener("click", function (e) { e.preventDefault(); togglePanel("notices"); });
    var sb = $("#sheet-body");
    if (sb) sb.addEventListener("click", onBoardClick);
    if (sb) sb.addEventListener("input", function (e) {
      if (currentPanel === "notices" && window.QVEvents) QVEvents.onBoardInput(e.target);
    });
    if (!Net.bookingsLive || !Net.bookingsLive()) {
      /* no hall bookings on this project, but poster sessions may still be */
      nbDataIn = true;
      setTimeout(autoOpenBoard, 1800);
      setInterval(function () { paintNoticeCount(); autoOpenBoard(); }, 15000);
      return;
    }
    var first = true;
    Net.watchNotices(function (map) {
      map = map || {};
      if (!first) {
        Object.keys(map).forEach(function (k) {
          var n = map[k];
          if (!notices[k] && n && n.status === "active" && noticeEnd(n) > serverNow()) {
            toast("📌 New on the <b>Notice Board</b>: " + esc(typeLabel(n.eventType)) + " — <b>" +
                  esc(n.topic) + "</b>, " + esc(fmtWhenShort(n.startAt)) + ", " + esc(n.hallName || hallName(n.hallId)));
          }
        });
      }
      first = false;
      notices = map;
      /* a competition notice whose end the administrator's tab never wrote */
      Object.keys(map).forEach(function (k) {
        var n = map[k];
        if (n && n.competitionId && typeof n.endAt !== "number" && !sweptOnce["nfill:" + k] && Net.fillCompetitionExpiry) {
          sweptOnce["nfill:" + k] = 1;
          Net.fillCompetitionExpiry(n.competitionId, n.hallId).catch(function () {});
        }
      });
      paintNoticeCount();
      paintHallCard(true);
      if (currentPanel === "notices") renderNotices(boardDetail);
      noticeTick();
      /* the first snapshot is what was on the board when they arrived; give
         the village a moment to appear before the board slides in */
      if (!nbDataIn) { nbDataIn = true; setTimeout(autoOpenBoard, 1800); }
      else autoOpenBoard();
    });
    var prevB = null;
    Net.watchMyBookings(function (map) {
      map = map || {};
      if (prevB) {
        Object.keys(map).forEach(function (id) {
          var a = prevB[id], b = map[id];
          if (!a || !b || a.status === b.status) return;
          if (b.status === "approved") {
            toast("📅 Your booking of <b>" + esc(hallName(b.hallId)) + "</b> for <b>" + esc(b.topic) +
                  "</b> was approved. It is on the Notice Board.");
          } else if (b.status === "rejected") {
            toast("Your booking request for <b>" + esc(b.topic) + "</b> was not approved.");
          } else if (b.status === "cancelled") {
            toast("Your booking for <b>" + esc(b.topic) + "</b> was cancelled by an administrator.");
          }
        });
      }
      prevB = map;
      myBookings = map;
      if (currentPanel === "notices" && boardTime === "mine") renderNotices();
    });
    setInterval(noticeTick, 15000);
  }
  /* Events that are over go from Upcoming to Past for everybody: whoever
     notices first archives them (the rules allow that once they have
     ended, and nothing else). */
  function noticeTick() {
    var now = serverNow();
    Object.keys(notices).forEach(function (k) {
      var n = notices[k];
      if (n && n.status === "active" && noticeEnd(n) + SWEEP_GRACE <= now) queueSweep("notices", k);
    });
    paintNoticeCount();
    autoOpenBoard();
  }
  /* What on the board is still to come or on right now: approved notices
     that have not ended, and poster sessions that are neither over nor
     cancelled. Keyed the way the board itself keys them, so "have I seen
     this one" survives a re-render. */
  function boardActivity() {
    var now = serverNow(), week = now + 7 * 86400000, out = { ids: [], week: 0, onNow: false };
    Object.keys(notices).forEach(function (k) {
      var x = notices[k];
      if (!x || !x.topic || x.status !== "active" || noticeEnd(x) <= now) return;
      out.ids.push(k);
      if (x.startAt < week) out.week++;
      if (x.startAt <= now) out.onNow = true;
    });
    var PE = window.QVEvents && QVEvents.live() ? QVEvents : null;
    if (PE) PE.list("upcoming").forEach(function (eid) {
      var ev = PE.events()[eid];
      if (!ev || ev.status === "cancelled") return;
      out.ids.push("pe:" + eid);
      if (ev.startAt < week) out.week++;
      if (ev.startAt <= now) out.onNow = true;
    });
    return out;
  }

  /* Which of those this resident has already had in front of them, this
     session. sessionStorage, so a new visit starts fresh; a Map in memory
     when the browser will not keep it (private mode, blocked storage). */
  var NB_SEEN = "qv.nb.seen.v1", nbSeenMem = null;
  function nbSeen() {
    if (nbSeenMem) return nbSeenMem;
    nbSeenMem = {};
    try { (JSON.parse(sessionStorage.getItem(NB_SEEN) || "[]") || []).forEach(function (k) { nbSeenMem[k] = 1; }); }
    catch (e) {}
    return nbSeenMem;
  }
  function markBoardSeen() {
    var seen = nbSeen();
    boardActivity().ids.forEach(function (k) { seen[k] = 1; });
    try { sessionStorage.setItem(NB_SEEN, JSON.stringify(Object.keys(seen).slice(-400))); } catch (e) {}
    paintNoticeCount();
  }

  /* The rail button carries how many events are on in the coming week, and
     an animated outline for as long as anything is upcoming or on now. */
  function paintNoticeCount() {
    var c = $("#notices-count"), b = $("#notices-btn");
    if (!c || !b) return;
    var a = boardActivity(), seen = nbSeen();
    var fresh = a.ids.some(function (k) { return !seen[k]; });
    c.textContent = a.week ? String(a.week) : "";
    b.classList.toggle("has-live", a.ids.length > 0);
    b.classList.toggle("on-now", a.onNow);
    b.classList.toggle("nb-new", fresh);
    b.setAttribute("aria-label", "Notices" + (a.ids.length
      ? " — " + a.ids.length + (a.onNow ? " upcoming or on now" : " upcoming") + (fresh ? ", new since you last looked" : "")
      : ""));
  }

  /* Open the board by itself when there is something on it the resident
     has not seen. Never over the sign-in wall, the welcome card, the tour,
     another panel or a form, and never while they are typing — it waits
     for the next tick instead. Closing it marks what was on it as seen,
     so it only comes back for something genuinely new. */
  var nbDataIn = false;
  function autoOpenBoard() {
    if (!entered || !started || !nbDataIn || currentPanel) return;
    var a = boardActivity(), seen = nbSeen();
    if (!a.ids.some(function (k) { return !seen[k]; })) return;
    var blocked = ["#gate", "#welcome", "#booking", "#comp-req", "#report", "#poster-view", "#poster-pin",
                   "#board-read", "#paper-modal", "#pe-reg", "#pereq"].some(function (s) {
      var o = $(s); return o && !o.hidden;
    });
    var ae = document.activeElement;
    if (blocked || (ae && /input|textarea|select/i.test(ae.tagName)) ||
        (window.QVTour && QVTour.isRunning && QVTour.isRunning()) ||
        (window.QVBoard && QVBoard.isOpen && QVBoard.isOpen()) ||
        (window.QVSlides && QVSlides.isOpen && QVSlides.isOpen()) ||
        (window.QVAdmin && QVAdmin.isOpen && QVAdmin.isOpen())) return;
    boardTime = "upcoming"; boardType = "all";
    renderNotices();
  }

  function boardList() {
    var now = serverNow(), d = new Date(now);
    var dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), dayEnd = dayStart + 86400000;
    var week = now + 7 * 86400000;
    return Object.keys(notices).map(function (k) { return notices[k]; }).filter(function (n) {
      if (!n || !n.topic) return false;
      if (boardType !== "all" && typeGroup(n.eventType) !== boardType) return false;
      var past = noticePast(n, now), end = noticeEnd(n);
      if (boardTime === "past") return past && n.status !== "cancelled";
      if (past) return false;
      if (boardTime === "today") return n.startAt < dayEnd && end > dayStart;
      if (boardTime === "week") return n.startAt < week;
      return true;
    }).sort(function (a, b) {
      return boardTime === "past" ? b.startAt - a.startAt : a.startAt - b.startAt;
    });
  }

  function noticeHeadline(n, now) {
    if (n.status === "cancelled") return "Cancelled · " + typeLabel(n.eventType);
    if (noticePast(n, now)) return "Past " + typeLabel(n.eventType);
    if (n.startAt <= now) return "On now · " + typeLabel(n.eventType);
    return "Upcoming " + typeLabel(n.eventType);
  }

  function renderNotices(detailId) {
    if (currentPanel !== "notices") openPanel("notices", "Village Notice Board", "Approved academic events");
    var PE = window.QVEvents && QVEvents.live() ? QVEvents : null;
    if (detailId && PE && detailId.indexOf("pe:") === 0 && PE.events()[detailId.slice(3)]) {
      boardDetail = detailId;
      body().innerHTML = PE.detailHtml(detailId.slice(3));
      return;
    }
    boardDetail = (detailId && notices[detailId]) ? detailId : null;
    if (boardDetail) { renderNoticeDetail(notices[boardDetail]); return; }
    var live = Net.bookingsLive && Net.bookingsLive();
    var now = serverNow();
    var html = '<div class="nb-bar">' +
      '<div class="nb-seg" role="tablist">' + BOARD_TIMES.map(function (t) {
        return '<button type="button" role="tab" data-nbtime="' + t[0] + '"' +
          (t[0] === boardTime ? ' class="on" aria-selected="true"' : "") + ">" + t[1] + "</button>";
      }).join("") + "</div>" +
      (live ? '<span class="nb-bar-acts">' + (window.QVEvents ? QVEvents.boardButton() : "") +
        '<button type="button" class="btn small" data-nb="book">Book a hall</button></span>' : "") + "</div>";
    if (boardTime === "mine") {
      body().innerHTML = html + renderMyRequests();
      return;
    }
    html += '<div class="nb-types">' + BOARD_TYPES.map(function (t) {
      return '<button type="button" data-nbtype="' + t[0] + '"' + (t[0] === boardType ? ' class="on"' : "") +
        ">" + t[1] + "</button>";
    }).join("") + "</div>";
    var list = boardList();
    /* poster sessions residents can register for, above the other notices */
    var pe = PE && (boardType === "all" || boardType === "poster_presentation" ||
                    boardType === "poster_competition") ? PE.list(boardTime).filter(function (eid) {
      return boardType !== "poster_competition" || PE.events()[eid].allowComp;
    }) : [];
    if (pe.length) {
      html += '<h5 class="pe-hh">Poster sessions · registration</h5><div class="nb-list">' +
        pe.map(PE.cardHtml).join("") + "</div>" + (list.length ? '<h5 class="pe-hh">Events</h5>' : "");
    }
    if (!live) {
      html += '<p class="fine">The Notice Board needs the live village.</p>';
    } else if (!list.length && pe.length) {
      /* the poster sessions above are all there is */
    } else if (!list.length) {
      html += '<p class="fine nb-empty">' + (boardTime === "past" ? "No past events here yet."
        : "Nothing on the board here yet. Organise something: stand in a seminar or poster hall and press " +
          "<b>Book This Hall</b>, or use <b>Book a hall</b> above.") + "</p>";
    } else {
      html += '<div class="nb-list">' + list.map(function (n) {
        var abs = String(n.abstract || "");
        return '<article class="nb-card t-' + esc(typeGroup(n.eventType)) + (n.status === "cancelled" ? " cancelled" : "") + '">' +
          '<span class="nb-kind">' + esc(noticeHeadline(n, now)) + "</span>" +
          "<h4>" + esc(n.topic) + "</h4>" +
          '<p class="nb-who"><b>' + esc(n.name) + "</b>" +
            (n.institution || n.position ? "<br>" + esc([n.institution, n.position].filter(Boolean).join(" · ")) : "") + "</p>" +
          (abs ? '<p class="nb-abs">' + esc(abs.length > 220 ? abs.slice(0, 217).trim() + "…" : abs) + "</p>" : "") +
          '<p class="nb-when"><span>' + esc(fmtDate(n.startAt)) + "</span><span>" + esc(fmtRange(n)) + "</span><span>" +
            esc(n.hallName || hallName(n.hallId)) + "</span></p>" +
          '<div class="nb-acts">' +
            '<button type="button" class="btn small ghost" data-nbview="' + esc(n.noticeId) + '">View Event</button>' +
            (n.status === "cancelled" ? "" : goButtons(n.hallId)) +
          "</div></article>";
      }).join("") + "</div>";
    }
    body().innerHTML = html;
  }

  function renderNoticeDetail(n) {
    var now = serverNow();
    var tz = myTz();
    var theirs = n.tz && tz && n.tz !== tz && n.date && n.startTime
      ? '<dd class="fine">Organiser\'s time: ' + esc(n.date) + ", " + esc(n.startTime) + "–" + esc(n.endTime) +
        " (" + esc(n.tz) + ")</dd>" : "";
    body().innerHTML =
      '<button type="button" class="btn small ghost nb-back" data-nb="back">← All notices</button>' +
      '<article class="nb-detail t-' + esc(typeGroup(n.eventType)) + (n.status === "cancelled" ? " cancelled" : "") + '">' +
        '<span class="nb-kind">' + esc(noticeHeadline(n, now)) + "</span>" +
        "<h3>" + esc(n.topic) + "</h3>" +
        "<dl>" +
          "<dt>" + (n.eventType === "poster_competition" ? "Organised by" : "Presented by") + "</dt><dd>" + esc(n.name) + "</dd>" +
          (n.institution ? "<dt>Institution</dt><dd>" + esc(n.institution) + "</dd>" : "") +
          (n.position ? "<dt>Position</dt><dd>" + esc(n.position) + "</dd>" : "") +
          "<dt>Date</dt><dd>" + esc(fmtDate(n.startAt)) + "</dd>" +
          "<dt>Time</dt><dd>" + esc(fmtRange(n)) + (tz ? ' <span class="fine">(your time)</span>' : "") + "</dd>" + theirs +
          "<dt>Location</dt><dd>" + esc(n.hallName || hallName(n.hallId)) + "</dd>" +
        "</dl>" +
        (n.abstract ? '<h5>Abstract</h5><p class="nb-fullabs">' + esc(n.abstract) + "</p>" : "") +
        '<div class="nb-acts"><button type="button" class="btn small" data-nbgo="' + esc(n.hallId) + '">Take me to ' +
          esc(n.hallName || hallName(n.hallId)) + "</button>" +
          (n.status !== "cancelled" && eventPlace(n.hallId) ? '<button type="button" class="btn small ghost" data-nbride="' +
            esc(n.hallId) + '" aria-expanded="false">Ride to Event</button>' : "") + "</div>" +
      "</article>";
    $("#sheet-body").scrollTop = 0;
  }

  function renderMyRequests() {
    var rows = [];
    Object.keys(myBookings).forEach(function (id) {
      var b = myBookings[id];
      rows.push({ at: b.createdAt || 0, html:
        '<article class="nb-req st-' + esc(b.status) + '"><span class="nb-kind">Hall booking · ' +
          esc(typeLabel(b.eventType)) + '</span><span class="nb-st">' + esc(REQ_STATUS[b.status] || b.status) + "</span>" +
        "<h4>" + esc(b.topic) + "</h4>" +
        '<p class="nb-when"><span>' + esc(hallName(b.hallId)) + "</span><span>" + esc(fmtDate(b.startAt)) + "</span><span>" +
          esc(fmtTime(b.startAt) + " – " + fmtTime(b.endAt)) + "</span></p>" +
        (b.status === "pending" ? '<button type="button" class="btn small ghost" data-nbwithdraw="' + esc(id) +
          '">Withdraw request</button>' : "") +
        (b.status === "approved" ? '<button type="button" class="btn small ghost" data-nbview="b-' + esc(id) +
          '">View on the board</button>' : "") + "</article>" });
    });
    Object.keys(myCompReqs).forEach(function (id) {
      var r = myCompReqs[id];
      rows.push({ at: r.requestedAt || 0, html:
        '<article class="nb-req st-' + esc(r.status) + '"><span class="nb-kind">Poster competition</span>' +
        '<span class="nb-st">' + esc(REQ_STATUS[r.status] || r.status) + "</span>" +
        "<h4>" + esc(r.title) + "</h4>" +
        '<p class="nb-when"><span>' + esc(hallName(r.hallId)) + "</span>" +
          (r.status === "approved" && r.approvedAt ? "<span>" + esc(fmtWhenShort(r.approvedAt)) + " for 24 hours</span>" : "") + "</p>" +
        "</article>" });
    });
    if (window.QVEvents && QVEvents.myRequests) rows = rows.concat(QVEvents.myRequests());
    rows.sort(function (a, b) { return b.at - a.at; });
    return rows.length ? '<div class="nb-list">' + rows.map(function (r) { return r.html; }).join("") + "</div>"
      : '<p class="fine nb-empty">You have not asked to book anything yet.</p>';
  }

  function onBoardClick(e) {
    if (currentPanel !== "notices") return;
    var t = e.target.closest ? e.target.closest("button") : null;
    if (!t) return;
    if (t.dataset.pe && window.QVEvents &&
        QVEvents.onBoardClick(t, function (eid) { renderNotices("pe:" + eid); })) return;
    if (t.dataset.nbtime) { boardTime = t.dataset.nbtime; renderNotices(); return; }
    if (t.dataset.nbtype) { boardType = t.dataset.nbtype; renderNotices(); return; }
    if (t.dataset.nbview) { renderNotices(t.dataset.nbview); return; }
    if (t.dataset.nbto) { takeMeThere(t.dataset.nbto); return; }
    if (t.dataset.nbride) { toggleRideChooser(t); return; }
    if (t.dataset.nbrideby) { startRide(t.dataset.hall, t.dataset.nbrideby); return; }
    if (t.dataset.nbridex) {
      var chooser = t.closest(".nb-ride"), card = chooser && chooser.parentNode;
      var rb = card && card.querySelector("[data-nbride]");
      if (rb) rb.setAttribute("aria-expanded", "false");
      if (chooser) chooser.remove();
      return;
    }
    if (t.dataset.nb === "back") { renderNotices(); return; }
    if (t.dataset.nb === "book") {
      var st = window.QVRooms ? QVRooms.state() : null;
      openBooking(st && st.roomId);
      return;
    }
    if (t.dataset.nbgo) {
      var pl = V.PLACES.filter(function (p) { return (p.building || p.id) === t.dataset.nbgo; })[0];
      if (pl) ferry(pl.x, pl.z);
      return;
    }
    if (t.dataset.nbwithdraw) {
      t.disabled = true;
      Net.withdrawHallBooking(t.dataset.nbwithdraw)
        .then(function () { toast("Booking request withdrawn."); })
        .catch(function () { t.disabled = false; toast("<b>That did not go through</b> — it may already have been decided."); });
    }
  }

  /* ---- asking to book a hall ---- */
  function bookingOpen() { var o = $("#booking"); return !!(o && !o.hidden); }
  function closeBooking() {
    var o = $("#booking");
    if (!o || o.hidden) return;
    o.hidden = true;
    if (window.QVInteract) QVInteract.setEnabled(true);
  }
  /* A refusal from the database is either the thirty-second limit or, far
     more often on a fresh install, security rules that are older than this
     page. Say which, rather than blaming the connection. */
  function refusalText(e, what) {
    var denied = e && /permission|denied/i.test(String(e.code || "") + " " + String(e.message || ""));
    if (!denied) return what + " did not go through — check your connection and try again.";
    return what + " was refused by the database. If you sent one in the last thirty seconds, wait a " +
      "moment and try again. Otherwise the database's security rules are out of date: the village " +
      "administrator needs to publish database.rules.json (Firebase console → Realtime Database → Rules).";
  }
  function localMs(date, time) {
    var d = String(date || "").split("-").map(Number), t = String(time || "").split(":").map(Number);
    if (d.length !== 3 || t.length < 2 || d.some(isNaN) || t.some(isNaN)) return NaN;
    return new Date(d[0], d[1] - 1, d[2], t[0], t[1]).getTime();
  }
  /* The start and end of what the form currently says, or null. An end at
     or before the start is the next day — "23:00 to 00:00" ends at
     midnight, "22:00 to 01:00" runs overnight — and the twelve-hour limit
     still applies. */
  function bookingSpan(date, start, end) {
    var a = localMs(date, start), z = localMs(date, end);
    if (isNaN(a) || isNaN(z)) return null;
    if (z <= a) z = localMs(ymd(localMs(date, "12:00") + 86400000), end);
    return { startAt: a, endAt: z };
  }
  function bookingClash(hallId, startAt, endAt) {
    return Object.keys(notices).map(function (k) { return notices[k]; }).filter(function (n) {
      return n && n.hallId === hallId && n.status !== "cancelled" && n.startAt < endAt && noticeEnd(n) > startAt;
    })[0] || null;
  }
  function ymd(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  /* Approved events already in that hall on that day, so the organiser can
     pick a free time before asking rather than be turned down after. */
  function paintAvailability() {
    var hall = $("#bk-hall").value, date = $("#bk-date").value, box = $("#bk-avail");
    if (!hall || !date) { box.textContent = "Pick a hall and a date to see what is already booked."; return; }
    var from = localMs(date, "00:00"), to = from + 86400000;
    var taken = Object.keys(notices).map(function (k) { return notices[k]; }).filter(function (n) {
      return n && n.hallId === hall && n.status !== "cancelled" && n.startAt < to && noticeEnd(n) > from;
    }).sort(function (a, b) { return a.startAt - b.startAt; });
    var html = taken.length
      ? "<b>Already booked that day:</b> " + taken.map(function (n) {
          return esc(fmtTime(n.startAt) + "–" + fmtTime(noticeEnd(n))) + " (" + esc(n.topic) + ")";
        }).join(", ")
      : "No approved events in " + esc(hallName(hall)) + " that day.";
    /* and, once a time is chosen, whether it is free */
    var span = bookingSpan(date, $("#bk-start").value, $("#bk-end").value);
    box.classList.remove("bad", "good");
    if (span) {
      var c = bookingClash(hall, span.startAt, span.endAt);
      var over = new Date(span.endAt).toDateString() !== new Date(span.startAt).toDateString();
      if (c) {
        html += '<br><b class="bk-no">\u2716 ' + esc(fmtTime(span.startAt) + "–" + fmtTime(span.endAt)) +
          " clashes with \u201C" + esc(c.topic) + "\u201D.</b>";
        box.classList.add("bad");
      } else if (span.endAt - span.startAt > Net.BOOKING_MAX_MS) {
        html += '<br><b class="bk-no">\u2716 That is longer than twelve hours.</b>';
        box.classList.add("bad");
      } else {
        html += '<br><b class="bk-ok">\u2714 ' + esc(fmtTime(span.startAt) + "–" + fmtTime(span.endAt)) +
          (over ? " (ends the next day)" : "") + " is free.</b>";
        box.classList.add("good");
      }
    }
    box.innerHTML = html;
  }
  function openBooking(hid) {
    var ov = $("#booking");
    if (!ov || bookingOpen()) return;
    if (!Net.bookingsLive || !Net.bookingsLive()) { toast("Booking a hall needs the live village."); return; }
    var halls = Net.BOOKABLE_HALLS;
    if (!halls[hid]) hid = Object.keys(halls)[0];
    $("#bk-hall").innerHTML = Object.keys(halls).map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(halls[id].name) + "</option>";
    }).join("");
    $("#bk-hall").value = hid;
    $("#bk-type").innerHTML = Object.keys(Net.EVENT_TYPES).filter(function (t) { return t !== "poster_competition"; })
      .map(function (t) { return '<option value="' + t + '">' + esc(Net.EVENT_TYPES[t]) + "</option>"; }).join("");
    $("#bk-type").value = halls[hid].type === "poster" ? "poster_presentation" : "seminar";
    $("#bk-name").value = fullNameGuess();
    $("#bk-inst").value = me.inst || "";
    ["#bk-pos", "#bk-topic", "#bk-abs", "#bk-extra"].forEach(function (s) { $(s).value = ""; });
    /* every quarter hour of the day, labelled the way this visitor's clock
       reads (2:15 PM, or 14:15) */
    var times = "";
    for (var q = 0; q < 96; q++) {
      var hh = ("0" + Math.floor(q / 4)).slice(-2), mm = ("0" + (q % 4) * 15).slice(-2);
      times += '<option value="' + hh + ":" + mm + '">' +
        esc(new Date(2000, 0, 1, +hh, +mm).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) + "</option>";
    }
    $("#bk-start").innerHTML = '<option value="">Choose…</option>' + times;
    $("#bk-end").innerHTML = '<option value="">Choose…</option>' + times;
    ["#bk-hall", "#bk-type", "#bk-name", "#bk-inst", "#bk-pos", "#bk-topic", "#bk-abs", "#bk-date", "#bk-start", "#bk-end"]
      .forEach(function (sel) { $(sel).classList.remove("bad"); });
    $("#bk-date").min = ymd(serverNow());
    $("#bk-date").value = "";
    var tz = myTz();
    $("#bk-tz").textContent = tz ? "Times are in your time zone (" + tz + "); everybody else sees them in theirs." : "";
    var err = $("#bk-err"); err.hidden = true; err.textContent = ""; err.classList.remove("ok");
    var go = $("#bk-go"); go.disabled = false;
    paintAvailability();
    $("#bk-hall").onchange = function () {
      var h = halls[$("#bk-hall").value];
      if (h && $("#bk-type").value === (h.type === "poster" ? "seminar" : "poster_presentation")) {
        $("#bk-type").value = h.type === "poster" ? "poster_presentation" : "seminar";
      }
      paintAvailability();
    };
    $("#bk-date").onchange = paintAvailability;
    /* fixing the field a message was about takes the message away */
    function clearSay() { err.hidden = true; err.textContent = ""; }
    $("#bk-start").onchange = function () {
      $("#bk-start").classList.remove("bad"); clearSay();
      var v = $("#bk-start").value;
      if (v && !$("#bk-end").value) {
        var m = (+v.slice(0, 2) * 60 + +v.slice(3) + 60) % 1440;
        $("#bk-end").value = ("0" + Math.floor(m / 60)).slice(-2) + ":" + ("0" + m % 60).slice(-2);
      }
      paintAvailability();
    };
    $("#bk-end").onchange = function () { $("#bk-end").classList.remove("bad"); clearSay(); paintAvailability(); };
    ["#bk-name", "#bk-inst", "#bk-pos", "#bk-topic", "#bk-abs", "#bk-date"].forEach(function (sel) {
      $(sel).oninput = function () {
        if ($(sel).classList.contains("bad")) { $(sel).classList.remove("bad"); clearSay(); }
        if (sel === "#bk-date") paintAvailability();
      };
    });
    ov.hidden = false;
    if (window.QVInteract) QVInteract.setEnabled(false);
    setTimeout(function () { try { $("#bk-topic").focus(); } catch (e2) {} }, 30);
    $("#bk-cancel").onclick = closeBooking;
    ov.onclick = function (e) { if (e.target === ov) closeBooking(); };
    $("#bk-form").onsubmit = function (e) {
      e.preventDefault();
      /* the message, and the field it is about: outlined, focused, and the
         message scrolled into view so it cannot be missed */
      function say(m, sel) {
        err.textContent = m; err.hidden = false; err.classList.remove("ok");
        if (sel) { var fld = $(sel); fld.classList.add("bad"); try { fld.focus(); } catch (e2) {} }
        try { err.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e3) {}
      }
      function val(s) { return cleanReportText($(s).value).replace(/[ \t]+/g, " "); }
      var f = { hallId: $("#bk-hall").value, eventType: $("#bk-type").value, name: val("#bk-name"),
                institution: val("#bk-inst"), position: val("#bk-pos"), topic: val("#bk-topic"),
                abstract: val("#bk-abs"), extra: val("#bk-extra"),
                date: $("#bk-date").value, startTime: $("#bk-start").value, endTime: $("#bk-end").value, tz: tz };
      if (!f.name) return say("Fill in your full name — it goes on the Notice Board.", "#bk-name");
      if (!f.institution) return say("Fill in your institution or organisation.", "#bk-inst");
      if (!f.position) return say("Fill in your position or role.", "#bk-pos");
      if (!f.topic) return say("Give the event a title or topic.", "#bk-topic");
      if (!f.abstract) return say("Add a short abstract.", "#bk-abs");
      if (f.abstract.length > 1500) return say("The abstract is " + f.abstract.length + " characters; please keep it under 1500.", "#bk-abs");
      if (f.extra.length > 1000) return say("The additional information is over 1000 characters; please shorten it.", "#bk-extra");
      /* A date box shows day, month and year separately; with one of them
         still empty it looks filled in and reports nothing at all. */
      var dateBox = $("#bk-date");
      if (dateBox.validity && dateBox.validity.badInput) {
        return say("The date is not complete — check the day, month and year, or pick it from the calendar.", "#bk-date");
      }
      if (!f.date) return say("Choose the date.", "#bk-date");
      /* a browser with no date picker hands over whatever was typed */
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(f.date)) return say("Enter the date as YYYY-MM-DD, e.g. 2026-10-08.", "#bk-date");
      if (!f.startTime) return say("Choose a start time.", "#bk-start");
      if (!f.endTime) return say("Choose an end time.", "#bk-end");
      var span = bookingSpan(f.date, f.startTime, f.endTime);
      var Q = Net.BOOKING_SLOT_MS;
      if (!span) return say("That date could not be read — pick it from the calendar.", "#bk-date");
      f.startAt = span.startAt;
      f.endAt = span.endAt;
      if (f.startAt % Q || f.endAt % Q) return say("Start and end on the hour or a quarter past, half past or a quarter to.");
      if (f.endAt === f.startAt) return say("The end time has to be after the start time.");
      if (f.endAt - f.startAt > Net.BOOKING_MAX_MS) return say("A booking can be at most twelve hours.", "#bk-end");
      if (f.startAt <= serverNow() + 60000) return say("That time has already passed — choose a time in the future.", "#bk-start");
      var clash = bookingClash(f.hallId, f.startAt, f.endAt);
      if (clash) return say("That overlaps “" + clash.topic + "” (" + fmtTime(clash.startAt) + "–" +
                            fmtTime(noticeEnd(clash)) + "), which is already booked. Choose another time or hall.", "#bk-start");
      go.disabled = true;
      err.hidden = true;
      Net.requestHallBooking(f).then(function () {
        closeBooking();
        toast("Booking request sent for <b>" + esc(hallName(f.hallId)) + "</b>. It goes on the Notice Board " +
              "once an administrator approves it.");
      }).catch(function (x) {
        go.disabled = false;
        say(refusalText(x, "The booking request"));
      });
    };
  }

  /* ================================================ report / feedback
   *
   * One form, reachable from the flag in the top rail wherever you are,
   * and from "Report" on any poster. It files a record under reports/ in
   * the Realtime Database — a different branch, and a different kind of
   * thing, from village talk: talk is deleted once it has been read, a
   * report is kept until an administrator deletes it. Only administrators
   * can read reports; they review them under Administration → Reports. */
  var reportSubject = "";
  var REPORT_MIN = 5;
  function reportOpen() { var o = $("#report"); return !!(o && !o.hidden); }
  function closeReport() {
    var o = $("#report");
    if (!o || o.hidden) return;
    o.hidden = true;
    if (window.QVInteract) QVInteract.setEnabled(true);
  }
  /* Where the resident is standing: the room if they are indoors,
     otherwise the place the place card is showing. */
  function currentLocation() {
    var st = window.QVRooms ? QVRooms.state() : null;
    if (st && st.roomId) {
      var pl = V.PLACES.filter(function (p) { return (p.building || p.id) === st.roomId; })[0];
      if (pl && pl.name) return pl.name;
    }
    var n = $("#place-name");
    return n ? n.textContent.replace(/\s+/g, " ").trim() : "";
  }
  /* Control characters out (tabs and line breaks stay), line endings made
     one kind. Nothing else is changed: the message is kept exactly as
     written, and is only ever shown as text, never as HTML. */
  function cleanReportText(t) {
    return String(t || "").replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  }
  function paintReportCount() {
    var n = cleanReportText($("#rp-msg").value).length, max = Net.REPORT_MAX || 5000;
    var c = $("#rp-count");
    c.textContent = n + " / " + max;
    c.classList.toggle("no", n > max);
  }
  function openReport(o) {
    o = o || {};
    var ov = $("#report");
    if (!ov || reportOpen()) return;
    if (window.QVPosters && QVPosters.isOpen()) QVPosters.close();
    $("#rp-type").value = o.reportType || "";
    reportSubject = o.subject || "";
    var subj = $("#rp-subject");
    subj.hidden = !reportSubject;
    subj.textContent = reportSubject ? "About: " + reportSubject : "";
    $("#rp-msg").value = "";
    $("#rp-where").value = (o.location || currentLocation()).slice(0, 80);
    var err = $("#rp-err"); err.hidden = true; err.textContent = ""; err.classList.remove("ok");
    var go = $("#rp-go"); go.disabled = false;
    paintReportCount();
    ov.hidden = false;
    if (window.QVInteract) QVInteract.setEnabled(false);
    setTimeout(function () { try { $(o.reportType ? "#rp-msg" : "#rp-type").focus(); } catch (e2) {} }, 30);

    $("#rp-msg").oninput = paintReportCount;
    $("#rp-cancel").onclick = closeReport;
    ov.onclick = function (e) { if (e.target === ov) closeReport(); };
    $("#rp-form").onsubmit = function (e) {
      e.preventDefault();
      function say(m) { err.textContent = m; err.hidden = false; }
      var type = $("#rp-type").value;
      var msg = cleanReportText($("#rp-msg").value);
      var max = Net.REPORT_MAX || 5000;
      if (!type) return say("Choose what kind of report this is.");
      if (msg.length < REPORT_MIN) return say("Tell us a little more — a sentence is enough.");
      /* refused, never cut short: the whole message is what gets kept */
      if (msg.length > max) return say("That is " + msg.length + " characters; the limit is " + max +
                                       ". Please shorten it, or send it as two reports.");
      if (!Net.reportsLive || !Net.reportsLive()) return say("Reports need the live village — sign in and try again.");
      go.disabled = true;
      err.hidden = true;
      Net.submitReport({
        reportType: type, message: msg, userName: displayName(),
        location: cleanReportText($("#rp-where").value).replace(/\s+/g, " ").slice(0, 80),
        subject: reportSubject,
        userAgent: navigator.userAgent,
        viewport: window.innerWidth + "x" + window.innerHeight
      }).then(function () {
        closeReport();
        toast("<b>Report submitted successfully.</b><br>Thank you for helping improve Quantum Village.");
      }).catch(function (x) {
        go.disabled = false;
        say(refusalText(x, "The report"));
      });
    };
  }
  (function () {
    var b = $("#report-btn");
    if (b) b.addEventListener("click", function (e) { e.preventDefault(); openReport(); });
  })();

  /* A blackboard is held for a pinned picture and for a slide deck alike,
     so it is only given back once neither of ours is up on it. */
  var myBoardPic = {}, mySlidesUp = {};
  function releaseBoardIfIdle(id) {
    if (myBoardPic[id] || mySlidesUp[id]) return;
    if (Net.releaseSurface) Net.releaseSurface("boards", id);
  }
  /* The record to show on a surface: the holder's if somebody holds it,
     otherwise (no claim, or rules not yet deployed) whoever wrote last. */
  function pickRecord(byUid, holder) {
    byUid = byUid || {};
    if (holder) return byUid[holder.u] ? { v: byUid[holder.u], u: holder.u } : null;
    var best = null, bu = "";
    Object.keys(byUid).forEach(function (u) {
      var v = byUid[u];
      if (v && (!best || (v.at || 0) > (best.at || 0))) { best = v; bu = u; }
    });
    return best ? { v: best, u: bu } : null;
  }

  /* How far a voice carries. The village is 900 across and a building is
     forty or fifty, so this is roughly "the same courtyard or room". */
  var EARSHOT = 70;
  var announcing = false;

  function say(text, ann) {
    var msg = { n: displayName(), m: text.slice(0, 300) };
    if (ann) msg.a = true;
    else { msg.x = player.position.x; msg.z = player.position.z; }
    Net.sendChat(msg);
    if (!Net.isLive()) addChat(displayName(), text, true, !!ann);
  }
  function sendChat() {
    var el = $("#chat-input"), v = el.value.trim();
    if (!v) return;
    el.value = "";
    say(v, announcing);
  }
  function setAnnouncing(on) {
    announcing = !!on;
    var b = $("#chat-mode");
    if (b) {
      b.textContent = announcing ? "Village" : "Nearby";
      b.classList.toggle("on", announcing);
      b.title = announcing ? "Everyone in the village will hear this"
                           : "Only people near you will hear this";
    }
    var i = $("#chat-input");
    if (i) i.placeholder = announcing ? "Announce to the whole village…" : "Say something…";
  }

  /* ============================================================== panels */
  var adminStarted = false;
  var currentPanel = null;
  function openPanel(id, title, eyebrow) {
    if (currentPanel === "notices" && id !== "notices") markBoardSeen();
    currentPanel = id;
    /* The Notice Board sits in the bottom-right corner, beside the rail,
       without the scrim, so the village stays walkable while it is up.
       Every other panel is the centred sheet it always was. */
    var dock = id === "notices";
    if (dock) fitDock();
    $("#sheet").classList.toggle("dock", dock);
    $("#sheet").classList.add("open");
    $("#sheet-title").textContent = title;
    $("#sheet-eyebrow").textContent = eyebrow || "";
    $("#sheet-body").scrollTop = 0;
    $$("#icons button").forEach(function (b) { b.classList.toggle("on", b.dataset.panel === id); });
  }
  /* How far the docked board has to stand off the right edge to clear the
     side rail, which changes width with the screen. */
  function fitDock() {
    var side = $("#side");
    if (side) document.documentElement.style.setProperty("--rail-w", side.offsetWidth + "px");
  }
  window.addEventListener("resize", function () { if (currentPanel === "notices") fitDock(); });
  function closePanel() {
    if (currentPanel === "notices") markBoardSeen();
    currentPanel = null;
    $("#sheet").classList.remove("open");
    $$("#icons button").forEach(function (b) { b.classList.remove("on"); });
    if (threadUnsub) { threadUnsub(); threadUnsub = null; }
    if (depTimer) { clearInterval(depTimer); depTimer = null; }
  }
  function togglePanel(id) {
    if (currentPanel === id) { closePanel(); return; }
    ({ map:renderMap, archive:openArchive, institutes:renderInstitutes,
       people:function () { renderPeople(true); }, groups:renderGroups,
       board:renderBoard, profile:renderProfile, help:renderHelp,
       notices:function () { renderNotices(); } }[id] || function () {})();
  }
  function body() { return $("#sheet-body"); }

  /* -------------------------------------------------------------- cards */
  function paperCard(p) {
    var saved = me.shelf.indexOf(p.i) >= 0;
    return '<article class="rec" data-id="' + esc(p.i) + '">' +
      '<div class="rec-top"><span class="tag-pill" style="--c:' + p.hue + '">' + esc(p.tname) + "</span>" +
      '<span class="mono">' + esc(p.i) + '</span><span class="mono when">' + esc(p.when) + "</span></div>" +
      "<h4>" + esc(p.n) + "</h4>" +
      '<div class="rec-act">' +
      '<button class="btn small abs" data-id="' + esc(p.i) + '">Abstract</button>' +
      '<a class="btn small ghost" href="' + p.url + '" target="_blank" rel="noopener">arXiv</a>' +
      '<a class="btn small ghost" href="' + p.pdf + '" target="_blank" rel="noopener">PDF</a>' +
      '<button class="btn small ghost keep' + (saved ? " on" : "") + '" data-id="' + esc(p.i) + '">' +
      (saved ? "On your shelf" : "Keep") + "</button>" +
      '<button class="btn small ghost talk" data-id="' + esc(p.i) + '">Discuss</button>' +
      '</div><div class="absbox" hidden></div></article>';
  }
  function canonCard(c) {
    return '<article class="rec canon">' +
      '<div class="rec-top"><span class="tag-pill" style="--c:' + c.hue + '">' + esc(c.tname) + "</span>" +
      '<span class="mono when">' + c.y + "</span></div>" +
      "<h4>" + esc(c.n) + "</h4><p class=\"byline\">" + esc(c.a) + "</p>" +
      '<div class="rec-act"><a class="btn small ghost" href="' + c.url + '" target="_blank" rel="noopener">Find on arXiv</a></div></article>';
  }
  function bindCards(scope) {
    $$(scope + " .abs").forEach(function (b) {
      b.addEventListener("click", function () { showAbstract(b.dataset.id, b.closest(".rec")); });
    });
    $$(scope + " .keep").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.id, i = me.shelf.indexOf(id);
        if (i >= 0) { me.shelf.splice(i, 1); b.classList.remove("on"); b.textContent = "Keep"; }
        else { me.shelf.push(id); b.classList.add("on"); b.textContent = "On your shelf"; }
        saveMe();
      });
    });
    $$(scope + " .talk").forEach(function (b) {
      b.addEventListener("click", function () { openThread(b.dataset.id); });
    });
  }

  /* The real abstract lives on arXiv; the page has no server of its own,
     so we link straight to it and, where Claude is available, offer a short
     read of the title beside it — labelled for what it is. */
  function showAbstract(id, node) {
    var p = PAPERS.filter(function (x) { return x.i === id; })[0];
    if (!p) return;
    var box = node.querySelector(".absbox");
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    var link = '<a class="btn small" href="' + p.url + '" target="_blank" rel="noopener">Read the abstract on arXiv</a>';
    if (!Net.ask) {
      box.innerHTML = '<div class="rec-act">' + link + "</div>" +
        '<p class="fine">arXiv holds the abstract itself — this page has no back end of its own to mirror it.</p>';
      return;
    }
    box.innerHTML = '<p class="fine">Reading the title…</p>';
    Net.ask("You are a colleague in a village reading group. In 45 words or fewer, say what a paper titled \"" +
      p.n + "\" (arXiv " + p.i + ", " + p.tname + ", " + p.when + ") is most likely about and why the topic matters. " +
      "Do not invent results, numbers, authors or quotations, and do not claim to have read it. Plain prose, no preamble.",
      { modelTier:"quick", cache:true })
      .then(function (r) {
        box.innerHTML = '<p class="said">' + esc(r.text) + "</p><div class=\"rec-act\">" + link + "</div>" +
          '<p class="fine">A read of the title, not the arXiv abstract.</p>';
      })
      .catch(function () {
        box.innerHTML = '<div class="rec-act">' + link + "</div>" +
          '<p class="fine">arXiv holds the abstract itself.</p>';
      });
  }

  /* ------------------------------------------------------------ archive */
  var q = "", topicFilter = "all", shelfMode = "recent";
  function openArchive() {
    openPanel("archive", "The Archive", "Village library · " + PAPERS.length + " records");
    body().innerHTML =
      '<div class="tools"><input id="q" class="field" placeholder="Search titles, topics, keywords…" value="' + esc(q) + '" autocomplete="off">' +
      '<div class="seg">' +
      ['recent','canon','shelf'].map(function (m) {
        return '<button data-m="' + m + '" class="' + (shelfMode === m ? "on" : "") + '">' +
          (m === "recent" ? "Recent" : m === "canon" ? "Foundational" : "Your shelf (" + me.shelf.length + ")") + "</button>";
      }).join("") + "</div></div>" +
      '<div class="chiprow">' +
      '<button class="chip' + (topicFilter === "all" ? " on" : "") + '" data-t="all">All</button>' +
      TOPICS.map(function (t) {
        return '<button class="chip' + (topicFilter === t.id ? " on" : "") + '" data-t="' + t.id +
          '" style="--c:#' + (V.TOPIC_HUES[t.id] || 0x4FA8B8).toString(16).padStart(6, "0") + '">' + esc(t.name) + "</button>";
      }).join("") + "</div>" +
      '<div id="results"></div>';
    $("#q").addEventListener("input", function (e) { q = e.target.value; drawResults(); });
    $$("#sheet-body .chip").forEach(function (b) {
      b.addEventListener("click", function () { topicFilter = b.dataset.t; openArchive(); });
    });
    $$("#sheet-body .seg button").forEach(function (b) {
      b.addEventListener("click", function () { shelfMode = b.dataset.m; openArchive(); });
    });
    drawResults();
    me.seen = newestKey; saveMe(); updateBell();
  }
  function drawResults() {
    var query = q.trim().toLowerCase(), out = "";
    if (shelfMode === "canon") {
      var list = CANON.filter(function (c) {
        return (topicFilter === "all" || c.t === topicFilter) && (!query || c.search.indexOf(query) >= 0);
      });
      out = '<p class="fine">Canon, by author and year. Each link runs a live arXiv search rather than asserting an identifier.</p>' +
        (list.length ? list.map(canonCard).join("") : '<p class="fine">Nothing on that shelf.</p>');
    } else {
      var src = shelfMode === "shelf"
        ? PAPERS.filter(function (p) { return me.shelf.indexOf(p.i) >= 0; })
        : PAPERS;
      var res = src.filter(function (p) {
        return (topicFilter === "all" || p.t === topicFilter) && (!query || p.search.indexOf(query) >= 0);
      });
      out = res.length ? res.map(paperCard).join("")
        : '<p class="fine">' + (shelfMode === "shelf"
            ? "Your shelf is empty. Walk over the paper markers in the village, or press Keep on any record."
            : "No records match.") + "</p>";
    }
    $("#results").innerHTML = out;
    bindCards("#results");
  }

  /* --------------------------------------------------------- institutes */
  var BUILTIN = [
    { id:"lit", name:"Institute House", topic:"qft", founder:"the village", motto:"From the action, everything follows.", built:true },
    { id:"php", name:"Phenomenology Hall", topic:"pheno", founder:"the village", motto:"A prediction is a promise made to a detector.", built:true },
    /* the standing campus institutes — walk into these */
    { id:"inst-particle", name:"Institute for Particle Physics", topic:"pheno", founder:"the university",
      motto:"Every model owes the detector a number.", built:true },
    { id:"inst-astro", name:"Astrophysics Institute", topic:"astro", founder:"the university",
      motto:"The sky is the only beam line we did not have to build.", built:true },
    { id:"uni-main", name:"Quantum Village University", topic:"qft", founder:"the village",
      motto:"Faculty of Physical Sciences, founded on an argument.", built:true }
  ];
  function matchPapers(name, topicId, limit) {
    var words = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(function (w) { return w.length > 2; });
    var t = topicById[topicId], kws = t ? t.kw : [];
    var scored = PAPERS.map(function (p) {
      var s = 0;
      if (p.t === topicId) s += 6;
      words.forEach(function (w) { if (p.search.indexOf(w) >= 0) s += 3; });
      kws.forEach(function (k) { if (p.search.indexOf(k) >= 0) s += 1; });
      return { p:p, s:s };
    }).filter(function (x) { return x.s > 0; });
    scored.sort(function (a, b) { return b.s - a.s || b.p.key - a.p.key; });
    return scored.slice(0, limit || 40).map(function (x) { return x.p; });
  }
  var FIRST = ["Ada","Ilse","Rohan","Tobias","Yuki","Amara","Dmitri","Solveig","Nour","Kwame","Beatriz","Jian","Farah","Anders","Priya"];
  var LAST = ["Okonjo","Vandermeer","Castellanos","Nakashima","Berglund","Haddadi","Oyelaran","Ferreira","Novak","Lindholm","Bhattacharya","Moreau","Sandoval","Eriksen","Quan"];
  function facultyFor(uni) {
    var seed = 0; for (var i = 0; i < String(uni.id).length; i++) seed += uni.id.charCodeAt(i);
    var t = topicById[uni.topic] || TOPICS[0];
    var ranks = ["Professor of " + t.name, "Reader in " + t.name, "Senior lecturer, " + t.name];
    return [0, 1, 2].map(function (k) {
      return { name:"Prof. " + FIRST[(seed + k * 5) % FIRST.length] + " " + LAST[(seed * 3 + k * 7) % LAST.length],
               rank:ranks[k], topic:uni.topic };
    });
  }

  function renderInstitutes() {
    openPanel("institutes", "Institutes", "Found one and it is built on the lane");
    var all = BUILTIN.concat(institutes);
    body().innerHTML =
      '<form id="found" class="form">' +
      '<h4>Found an institute</h4>' +
      '<label>Name<input id="u-name" class="field" placeholder="Dark Photon" maxlength="26" required autocomplete="off"></label>' +
      '<label>Research focus<select id="u-topic" class="field">' +
      TOPICS.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + "</option>"; }).join("") +
      "</select></label>" +
      '<label>Motto<input id="u-motto" class="field" placeholder="optional" maxlength="64" autocomplete="off"></label>' +
      '<button class="btn">Break ground</button>' +
      '<p class="fine">A hall goes up on a free plot, stocked with the matching records, departments, rooms and faculty. Everyone in the village sees it.</p>' +
      "</form>" +
      all.map(function (u) {
        var t = topicById[u.topic] || {};
        var n = matchPapers(u.name, u.topic, 400).length;
        return '<article class="inst" data-u="' + esc(u.id) + '" style="--c:#' +
          (V.TOPIC_HUES[u.topic] || 0x4FB89A).toString(16).padStart(6, "0") + '">' +
          "<h4>" + esc(u.name) + "</h4>" +
          '<p class="motto">' + esc(u.motto || t.blurb || "") + "</p>" +
          '<p class="fine">' + esc(t.name || "") + " · " + n + " records · founded by " + esc(u.founder || "a resident") + "</p>" +
          '<button class="btn small">Enter</button></article>';
      }).join("");
    $("#found").addEventListener("submit", function (e) { e.preventDefault(); foundInstitute(); });
    $$("#sheet-body .inst").forEach(function (card) {
      card.addEventListener("click", function () {
        var u = all.filter(function (x) { return x.id === card.dataset.u; })[0];
        if (u) openInstitute(u.id);
      });
    });
  }
  function foundInstitute() {
    var name = $("#u-name").value.trim();
    if (!name) return;
    var topic = $("#u-topic").value, t = topicById[topic];
    var uni = {
      id: "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: name, topic: topic, topicName: t.name,
      motto: $("#u-motto").value.trim() || t.blurb,
      founder: displayName(), by: me.uid || me.id, at: Date.now()
    };
    Net.docSet("institutes/" + uni.id, uni).catch(function () {
      institutes.push(uni); syncInstitutes();
    });
    Net.broadcast("institute", { name:uni.name, by:me.uid || me.id });
    me.points += 25; saveMe(); setScore();
    Net.addScore(25, displayName()).catch(function () {});
    toast("<b>" + esc(uni.name) + "</b> is breaking ground <span class=\"pts\">+25</span>");
    objective();
    setTimeout(function () { openInstitute(uni.id); }, 500);
  }

  function openInstitute(id, place) {
    var all = BUILTIN.concat(institutes);
    var uni = all.filter(function (x) { return x.id === id; })[0];
    if (!uni && place) {
      /* an institute that exists in the world but not in the register */
      uni = { id: place.id, name: place.name, topic: place.topic || "pheno",
              founder: "the village", motto: place.sub || "" };
    }
    if (!uni) { renderInstitutes(); return; }
    var t = topicById[uni.topic] || TOPICS[0];
    var papers = matchPapers(uni.name, uni.topic, 40);
    var fac = facultyFor(uni);
    openPanel("inst", uni.name, t.name);
    body().innerHTML =
      '<p class="motto lead">' + esc(uni.motto || t.blurb) + "</p>" +
      '<div class="tabs" id="itabs">' +
      '<button class="on" data-c="feed">Reading room</button><button data-c="dep">Departments</button>' +
      '<button data-c="fac">Faculty</button><button data-c="room">Rooms</button><button data-c="grp">Groups</button>' +
      '</div><div id="ibody"></div>';
    function ib() { return $("#ibody"); }

    var views = {
      feed: function () {
        var byMonth = {};
        papers.forEach(function (p) { (byMonth[p.when] = byMonth[p.when] || []).push(p); });
        var months = Object.keys(byMonth).sort(function (a, b) { return byMonth[b][0].key - byMonth[a][0].key; });
        ib().innerHTML = '<p class="fine">Records matching <b>' + esc(uni.name) +
          '</b>, newest first. Every link is derived from the arXiv identifier.</p>' +
          months.map(function (m) {
            return '<h5 class="sep">' + esc(m) + "</h5>" + byMonth[m].map(paperCard).join("");
          }).join("");
        bindCards("#ibody");
      },
      dep: function () {
        var counts = {};
        papers.forEach(function (p) { counts[p.t] = (counts[p.t] || 0) + 1; });
        var others = Object.keys(counts).filter(function (k) { return k !== uni.topic; })
          .sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 3);
        var deps = [{ n:"Department of " + t.name, c:counts[uni.topic] || 0 }]
          .concat(others.map(function (k) { return { n:"Joint programme with " + topicById[k].name, c:counts[k] }; }))
          .concat([{ n:"Computation & Numerics", c:0 }, { n:"Instrument Liaison", c:0 }]);
        ib().innerHTML = deps.map(function (d) {
          return '<div class="row"><h5>' + esc(d.n) + "</h5><p class=\"fine\">" +
            (d.c ? d.c + " records on the shelves" : "Support unit") + "</p></div>";
        }).join("");
      },
      fac: function () {
        ib().innerHTML = fac.map(function (f, i) {
          return '<div class="row person"><h5>' + esc(f.name) + "</h5><p class=\"fine\">" + esc(f.rank) + "</p>" +
            '<button class="btn small ask" data-i="' + i + '">Ask a question</button><div class="answer" hidden></div></div>';
        }).join("") + (Net.ask ? "" : '<p class="fine">Faculty answer when Claude is available in this build.</p>');
        $$("#ibody .ask").forEach(function (b) {
          b.addEventListener("click", function () {
            askFaculty(fac[+b.dataset.i], uni, papers, b.parentNode.querySelector(".answer"));
          });
        });
      },
      room: function () {
        var slots = ["09:30 · journal club", "11:00 · seminar", "14:00 · working session", "16:30 · open discussion"];
        ib().innerHTML = slots.map(function (s, i) {
          var p = papers[i % Math.max(1, papers.length)];
          return '<div class="row"><h5>' + esc(s) + "</h5><p class=\"fine\">" + esc(p ? p.n : t.name + " — open floor") + "</p>" +
            (p ? '<button class="btn small talk" data-id="' + esc(p.i) + '">Open the room</button>' : "") + "</div>";
        }).join("") + '<button class="btn small ghost" id="call">Call a seminar</button>';
        bindCards("#ibody");
        $("#call").addEventListener("click", function () {
          Net.broadcast("seminar", { where:uni.name, by:me.uid || me.id });
          me.points += 10; saveMe(); setScore(); Net.addScore(10, displayName()).catch(function () {});
          toast("Seminar called at <b>" + esc(uni.name) + "</b> <span class=\"pts\">+10</span>");
          objective();
        });
      },
      grp: function () {
        var mine = groups.filter(function (g) { return g.inst === uni.id; });
        ib().innerHTML =
          '<form id="mkg" class="form"><label>Start a research group' +
          '<input id="g-name" class="field" placeholder="e.g. kinetic mixing working group" maxlength="48" required autocomplete="off"></label>' +
          '<button class="btn">Create</button></form>' +
          (mine.length ? mine.map(groupCard).join("") : '<p class="fine">No groups here yet.</p>');
        $("#mkg").addEventListener("submit", function (e) {
          e.preventDefault(); createGroup($("#g-name").value.trim(), uni.id, uni.topic);
        });
        bindGroups("#ibody");
      }
    };
    $$("#itabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        $$("#itabs button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on"); views[b.dataset.c]();
      });
    });
    views.feed();
  }

  function askFaculty(f, uni, papers, box) {
    if (!Net.ask) { box.hidden = false; box.innerHTML = '<p class="fine">Claude is not available in this build.</p>'; return; }
    ask("Ask " + f.name, "", function (question) {
      if (!question) return;
      box.hidden = false;
      box.innerHTML = '<p class="fine">Thinking…</p>';
      var list = papers.slice(0, 12).map(function (p) { return p.i + " — " + p.n; }).join("\n");
      Net.ask("You are " + f.name + ", " + f.rank + " at " + uni.name +
        " in Quantum Village, a small settlement of working theorists. A visitor asks: \"" + question + "\"\n\n" +
        "Answer as a physicist to a peer: precise, technical where it helps, 110 words or fewer, no preamble. " +
        "You may recommend reading ONLY from this list, by identifier, and only where genuinely relevant:\n" + list +
        "\nNever invent an arXiv identifier, author, result or number. If it is outside your field, say so.",
        { modelTier:"default" })
        .then(function (r) {
          box.innerHTML = '<p class="said">' + esc(r.text) + "</p>";
          me.points += 5; saveMe(); setScore(); objective();
        })
        .catch(function (e) {
          box.innerHTML = '<p class="fine">' + (e && e.code === "rate_limited" ? "Too many questions at once — try shortly." : "No answer right now.") + "</p>";
        });
    });
  }

  /* ---------------------------------------------------------- villagers */
  function openVillager(n) {
    var t = topicById[n.topic] || {};
    openPanel("npc", n.name, n.role + (t.name ? " · " + t.name : ""));
    body().innerHTML =
      '<p class="motto lead">' + esc(t.blurb || "Keeps the village running.") + "</p>" +
      '<div class="rec-act"><button class="btn small" id="npc-ask">Ask something</button>' +
      (t.id ? '<button class="btn small ghost" id="npc-rec">Point me at a paper</button>' : "") + "</div>" +
      '<div id="npc-answer" class="answer"></div>';
    $("#npc-ask").addEventListener("click", function () {
      var box = $("#npc-answer");
      if (!Net.ask) { box.innerHTML = '<p class="fine">Villagers speak when Claude is available in this build. The Archive works either way.</p>'; return; }
      ask("Ask " + n.name, "What should I understand about " + (t.name || "this village") + " first?", function (question) {
        if (!question) return;
        box.innerHTML = '<p class="fine">Thinking…</p>';
        Net.ask("You are " + n.name + ", a " + n.role + " in Quantum Village, usually found near " + ((n.home && n.home.name) || "the campus") +
          ". Your field is " + (t.name || "village life") + ". Someone asks: \"" + question + "\"\n" +
          "Answer in 80 words or fewer, in character, technically accurate, with no invented citations, numbers or results.",
          { modelTier:"quick" })
          .then(function (r) { box.innerHTML = '<p class="said">' + esc(r.text) + "</p>";
            me.points += 5; saveMe(); setScore(); objective(); })
          .catch(function () { box.innerHTML = '<p class="fine">No answer right now.</p>'; });
      });
    });
    if ($("#npc-rec")) $("#npc-rec").addEventListener("click", function () {
      var ps = matchPapers((topicById[n.topic] || {}).name || "", n.topic, 6);
      $("#npc-answer").innerHTML = "<h5>" + esc(n.name) + " points at the shelf</h5>" + ps.map(paperCard).join("");
      bindCards("#npc-answer");
    });
  }

  /* ------------------------------------------------------------- places */
  function openPlaceCard(p) {
    openPanel("place", p.name, p.tag || p.kind);
    var ps = p.topic ? matchPapers((topicById[p.topic] || {}).name || "", p.topic, 8) : [];
    body().innerHTML = '<p class="motto lead">' + esc(p.sub || "") + "</p>" +
      (ps.length ? "<h5 class=\"sep\">On the table here</h5>" + ps.map(paperCard).join("")
                 : '<p class="fine">Nothing on the table just now.</p>');
    bindCards("#sheet-body");
  }
  function openCommons() {
    openPanel("place", "The Commons", "Village green");
    var recent = PAPERS.slice(0, 6);
    body().innerHTML =
      '<p class="motto lead">The noticeboard under the big tree. Everything in the village starts here.</p>' +
      '<div class="grid2">' +
      '<button class="tile" data-go="archive"><b>The Archive</b><span>' + PAPERS.length + " records</span></button>" +
      '<button class="tile" data-go="institutes"><b>Institutes</b><span>' + (BUILTIN.length + institutes.length) + " standing</span></button>" +
      '<button class="tile" data-go="board"><b>Leaderboard</b><span>Village standings</span></button>' +
      '<button class="tile" data-go="map"><b>Map</b><span>' + V.PLACES.length + " places</span></button>" +
      "</div>" +
      '<h5 class="sep">Newest on the board</h5>' + recent.map(paperCard).join("");
    bindCards("#sheet-body");
    $$("#sheet-body .tile").forEach(function (b) {
      b.addEventListener("click", function () { togglePanel(b.dataset.go); });
    });
  }
  function openCafe(p) {
    openPanel("place", p.name, "Café");
    body().innerHTML =
      '<p class="motto lead">' + esc(p.sub) + "</p>" +
      '<p class="fine">A voice carries about as far as the room you are standing in. Use <b>Village</b> beside the chat box when everyone should hear it.</p>' +
      '<div id="cafe-log" class="cafelog"></div>' +
      '<form id="cafe-form" class="composer"><input id="cafe-input" class="field" placeholder="Say something to the village…" maxlength="300" autocomplete="off"><button class="btn small">Send</button></form>';
    $("#cafe-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("#cafe-input").value.trim(); if (!v) return;
      $("#cafe-input").value = "";
      say(v, false);
    });
    var log = $("#cafe-log");
    log.innerHTML = $("#chat-log").innerHTML || '<p class="fine">Nothing said yet today.</p>';
  }

  /* ---------------------------------------------------- cafe owner */
  function openCafeOwner(own) {
    openPanel("owner", own.name, "Proprietor & Master Chef · The Grand Refectory");
    var pts = me.points;
    body().innerHTML =
      '<div class="owner-hero-card">' +
      '<div class="owner-avatar-wrap">' +
      '<div class="owner-avatar">👩‍🍳</div>' +
      '<span class="owner-badge">Owner</span>' +
      '</div>' +
      '<div class="owner-hero-body">' +
      '<b class="owner-name">' + esc(own.name) + '</b>' +
      '<span class="owner-sub">Founder of The Grand Refectory</span>' +
      '<p class="owner-bio">“I founded this refectory so that none of our brilliant researchers would have to contemplate the cosmos on an empty stomach. A well-fed mind is a sharp mind!”</p>' +
      '</div>' +
      '</div>' +

      '<div class="owner-points-advice">' +
      '<h5>💡 How to earn points for food</h5>' +
      '<p class="fine">“The village community values your scholarship! Earn points to spend at our counter anytime:”</p>' +
      '<ul>' +
      '<li><b>+15 pts</b> writing a problem or discussion on any blackboard</li>' +
      '<li><b>+20 pts</b> pinning a research poster to the wall</li>' +
      '<li><b>+10 pts</b> exploring new institutes and places</li>' +
      '<li><b>+5 pts</b> walking over paper markers in the village</li>' +
      '</ul>' +
      '<p class="fine">Your current wallet: <b style="color:var(--gold)">' + pts + ' pts</b></p>' +
      '</div>' +

      '<div class="owner-recs">' +
      '<h5>Today\'s specials recommended by Madame Bernadette</h5>' +
      '<div class="owner-rec-chips">' +
      '<span class="rec-chip">🍲 Slow-cooked Dal & Rice (18 pts)</span>' +
      '<span class="rec-chip">🥩 The Physicist\'s Platter (30 pts)</span>' +
      '<span class="rec-chip">🍰 Cardamom Cake with Cream (12 pts)</span>' +
      '</div>' +
      '</div>' +

      '<div class="rec-act" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn" id="owner-go-restaurant">Join Queue & Order Food</button>' +
      '<button class="btn ghost" id="owner-ask">Ask Bernadette</button>' +
      '</div>' +
      '<div id="owner-answer" class="answer" style="margin-top:12px"></div>';

    $("#owner-go-restaurant").addEventListener("click", function () {
      openRestaurant({ id: "restaurant", kind: "restaurant" });
    });

    $("#owner-ask").addEventListener("click", function () {
      var box = $("#owner-answer");
      if (!Net.ask) {
        box.innerHTML = '<p class="fine">Madame Bernadette: “Rowan brews the coffee, I mind the kitchen, and the universe provides the curiosity!”</p>';
        return;
      }
      ask("Ask Madame Bernadette", "What is the secret to good food and deep physics?", function (question) {
        if (!question) return;
        box.innerHTML = '<p class="fine">Thinking…</p>';
        Net.ask("You are Madame Bernadette, the beloved, warm and spirited master chef and owner of The Grand Refectory cafe in Quantum Village. You speak passionately about food, scholarly life, and nurturing physicists. Someone asks: \"" + question + "\"\n" +
          "Answer in 70 words or fewer, in character, warm, wise, and witty.", { modelTier:"quick" })
          .then(function (r) {
            box.innerHTML = '<p class="said">' + esc(r.text) + '</p>';
            me.points += 5; saveMe(); setScore(); objective();
          })
          .catch(function () {
            box.innerHTML = '<p class="said">“Patience, butter, and a hint of cardamom! Now go enjoy your meal, darling.”</p>';
          });
      });
    });
  }

  /* -------------------------------------------------------- restaurant */
  var restaurantQueueTimer = null;

  function openRestaurant(p) {
    if (restaurantQueueTimer) { clearInterval(restaurantQueueTimer); restaurantQueueTimer = null; }
    openPanel("restaurant", "The Grand Refectory", "Food · Queue · Good company");

    function renderRestaurantPanel() {
      var R = window.QVRestaurant;
      var inQ = R && R.isPlayerInQueue();
      var pos = R ? R.playerPosition() : -1;
      var atFront = R && R.isPlayerAtFront();
      var pts = me.points;

      var quote = "Welcome to The Grand Refectory! Join the queue lane to order, or relax at any veranda table.";
      if (atFront || pos === 0) {
        quote = "Welcome to the counter! It's your turn — what can I get started for you today? Everything is freshly made.";
      } else if (inQ) {
        quote = "We're moving along nicely! You're number " + (pos + 1) + " in line. Feel free to browse our specials while we prepare the orders ahead.";
      }
      var hostBanner =
        '<div class="rest-host-card">' +
        '<div class="rest-host-avatar-wrap">' +
        '<div class="rest-host-avatar">☕</div>' +
        '<span class="rest-host-badge">Order Taker</span>' +
        '</div>' +
        '<div class="rest-host-body">' +
        '<div class="rest-host-title"><b>Rowan</b> <span>Head Barista & Village Host</span></div>' +
        '<div class="rest-host-speech">“' + quote + '”</div>' +
        '</div>' +
        '</div>';

      var served = R && R.lastServed ? R.lastServed() : null;
      var servedBanner = served
        ? '<div class="rest-served"><span class="rest-served-dish">' + served.emoji + '</span>' +
          '<div><b>' + (served.state === "preparing" ? "Rowan is preparing " : (served.state === "ready" ? "Your order is ready, " : "Food collected by ")) + esc(served.name) + '</b><span>' +
          (served.state === "preparing" ? esc(served.item) + ' will be ready in ' + served.seconds + ' seconds.' : (served.state === "ready" ? esc(served.item) + ' is waiting at the counter. Walk there and press C.' : esc(served.item) + ' stays with you for 30 seconds.')) +
          '</span></div></div>'
        : '';

      var lineup = R && R.getQueueLineup ? R.getQueueLineup() : [];
      var lineupSection = '';
      if (lineup.length) {
        lineupSection =
          '<div class="rest-lineup-box">' +
          '<div class="rest-lineup-head"><span class="lineup-pulse"></span><b>Live Counter Queue:</b> ' +
          (inQ ? ('You are #' + (pos + 1) + ' of ' + lineup.length) : (lineup.length + ' waiting in line')) +
          '</div>' +
          '<div class="rest-lineup-chips">' +
          lineup.map(function (c) {
            return '<div class="lineup-chip' + (c.isPlayer ? ' is-you' : '') + '">' +
              '<span class="chip-avatar">' + c.emoji + '</span>' +
              '<div class="chip-text"><b class="chip-name">' + esc(c.name) + '</b>' +
              '<span class="chip-role">' + (c.isPlayer ? 'YOU' : esc(c.role || 'Scholar')) + '</span></div>' +
              '</div>';
          }).join('<span class="chip-arrow">➜</span>') +
          '</div></div>';
      }

      var queueSection = '';
      if (!R) {
        queueSection = '<p class="fine">The kitchen is setting up… walk closer and try again.</p>';
      } else if (!inQ) {
        queueSection =
          '<div class="rest-queue-status empty">' +
          '<div class="rest-queue-icon">🍽️</div>' +
          '<p>Step into the queue lane to place your order with Rowan.</p>' +
          '<button class="btn" id="rest-join">Join the Queue</button>' +
          '</div>';
      } else if (atFront || pos === 0) {
        queueSection =
          '<div class="rest-queue-status front">' +
          '<div class="rest-queue-icon">✨</div>' +
          '<p><b>It\'s your turn!</b> Rowan is waiting at the counter. Pick your item below.</p>' +
          '<button class="btn ghost small" id="rest-leave">Leave the queue</button>' +
          '</div>';
      } else {
        var dots = '';
        for (var k = 0; k < Math.min(pos, 6); k++) dots += '<span class="qdot' + (k === 0 ? ' next' : '') + '"></span>';
        dots += '<span class="qdot you">you</span>';
        queueSection =
          '<div class="rest-queue-status waiting">' +
          '<div class="rest-queue-icon">⏳</div>' +
          '<p>Position <b>' + (pos + 1) + '</b> in the queue.</p>' +
          '<div class="qdots">' + dots + '</div>' +
          '<p class="fine">Customers ahead are being served at the counter.</p>' +
          '<button class="btn ghost small" id="rest-leave">Leave the queue</button>' +
          '</div>';
      }

      var menuSection;
      if (atFront || pos === 0) {
        /* Show full ordering menu */
        menuSection = '<h5 class="sep">Order something from Rowan</h5>' +
          '<div class="menu-grid">' +
          (R.MENU || []).map(function (item) {
            var canAfford = pts >= item.cost;
            return '<div class="menu-card' + (canAfford ? '' : ' cant-afford') + '">' +
              '<span class="menu-emoji">' + item.emoji + '</span>' +
              '<div class="menu-info">' +
              '<b class="menu-name">' + esc(item.name) + '</b>' +
              '<span class="menu-desc">' + esc(item.desc) + '</span>' +
              '</div>' +
              '<div class="menu-price-col">' +
              '<span class="menu-pts">' + item.cost + ' pts</span>' +
              '<button class="btn small menu-order' + (canAfford ? '' : ' ghost') + '" data-id="' + esc(item.id) + '"' +
              (canAfford ? '' : ' disabled') + '>' +
              (canAfford ? 'Order' : 'Need ' + (item.cost - pts) + ' more') + '</button>' +
              '</div></div>';
          }).join('') +
          '</div>';
      } else if (inQ) {
        /* Show menu for preview while waiting */
        menuSection = '<h5 class="sep">Today\'s specials — preview while you wait</h5>' +
          '<div class="menu-grid preview">' +
          (R.MENU || []).map(function (item) {
            return '<div class="menu-card preview">' +
              '<span class="menu-emoji">' + item.emoji + '</span>' +
              '<div class="menu-info"><b class="menu-name">' + esc(item.name) + '</b>' +
              '<span class="menu-desc">' + esc(item.desc) + '</span></div>' +
              '<span class="menu-pts">' + item.cost + ' pts</span>' +
              '</div>';
          }).join('') + '</div>';
      } else {
        menuSection = '<h5 class="sep">Today\'s menu</h5>' +
          '<div class="menu-grid preview">' +
          (R && R.MENU || []).map(function (item) {
            return '<div class="menu-card preview">' +
              '<span class="menu-emoji">' + item.emoji + '</span>' +
              '<div class="menu-info"><b class="menu-name">' + esc(item.name) + '</b>' +
              '<span class="menu-desc">' + esc(item.desc) + '</span></div>' +
              '<span class="menu-pts">' + item.cost + ' pts</span>' +
              '</div>';
          }).join('') + '</div>';
      }

      body().innerHTML =
        '<div class="rest-header">' +
        '<div class="rest-pts-badge"><span class="rest-pts-icon">🏆</span><span>Your balance: <b>' + pts + ' pts</b></span></div>' +
        '<p class="fine">Earn points by writing on blackboards (+15), pinning posters (+20), visiting places (+10) and collecting paper markers (+5).</p>' +
        '</div>' +
        hostBanner +
        servedBanner +
        lineupSection +
        queueSection +
        menuSection;

      /* Bind join/leave */
      var joinBtn = $("#rest-join");
      if (joinBtn) joinBtn.addEventListener("click", function () {
        if (R) R.playerJoin();
        renderRestaurantPanel();
      });
      var leaveBtn = $("#rest-leave");
      if (leaveBtn) leaveBtn.addEventListener("click", function () {
        if (R) R.playerLeave();
        renderRestaurantPanel();
      });

      /* Bind order buttons */
      $$("#sheet-body .menu-order").forEach(function (b) {
        b.addEventListener("click", function () {
          if (!R) return;
          var ok = R.buyItem(b.dataset.id);
          if (ok) {
            /* Close panel briefly, then reopen refreshed */
            setTimeout(function () {
              if (currentPanel === "restaurant") renderRestaurantPanel();
            }, 100);
          } else {
            toast("Not enough points for that one.");
          }
        });
      });
    }

    renderRestaurantPanel();

    /* Auto-refresh the panel while it's open (queue advances) */
    restaurantQueueTimer = setInterval(function () {
      if (currentPanel !== "restaurant") {
        clearInterval(restaurantQueueTimer); restaurantQueueTimer = null; return;
      }
      renderRestaurantPanel();
    }, 3000);

    /* Hook: when player reaches the front, toast them even if panel is closed */
    if (window.QVRestaurant) {
      QVRestaurant.hooks.onPlayerAtFront = function (pName) {
        var who = pName || displayName() || "Resident";
        toast("🔔 <b>" + esc(who) + "!</b> Rowan: “" + esc(who) + ", what can I get for you today?”");
        if (currentPanel === "restaurant") renderRestaurantPanel();
      };
    }
  }

  /* ----------------------------------------------------------- station */
  function openStation(p) {
    openPanel("place", p.name, p.tag || "Transport");
    var isRail = p.kind === "station";
    var deps = [];
    if (isRail && window.QVTransport) {
      try { deps = QVTransport.departures(p.id === "halt" ? -560 : 0, 4); } catch (e) { deps = []; }
    }
    body().innerHTML =
      '<p class="motto lead">' + esc(p.sub || "") + "</p>" +
      (isRail
        ? '<h5 class="sep">Next departures</h5><div id="deps" class="deps"></div>' +
          '<p class="fine">Trains run east and west on the two through lines and call here. ' +
          "The platform is behind the concourse; walk out and wait if you want to see one come in.</p>"
        : '<p class="fine">Ring-road services call at all four bays. Buses stop for a moment ' +
          "at each, so you can watch them come and go — and the ring road will take you anywhere " +
          "on the outer circle if you would rather walk beside one.</p>") +
      '<div class="grid2">' +
      '<button class="tile" data-go="map"><b>World map</b><span>Travel anywhere</span></button>' +
      '<button class="tile" data-go="people"><b>Who is about</b><span>Live residents</span></button>' +
      "</div>";
    if (isRail) {
      var box = $("#deps");
      var paint = function () {
        if (!box || !box.isConnected) { clearInterval(depTimer); depTimer = null; return; }
        var rows = [];
        try { rows = QVTransport.departures(p.id === "halt" ? -560 : 0, 4); } catch (e) {}
        box.innerHTML = rows.length ? rows.map(function (d) {
          var m = Math.floor(d.inSec / 60), sec = Math.round(d.inSec % 60);
          return '<div class="deprow"><b>' + esc(d.dir) + "</b><span class=\"mono\">" +
            (d.inSec < 45 ? "due" : (m ? m + "m " : "") + sec + "s") + "</span></div>";
        }).join("") : '<p class="fine">No service information right now.</p>';
      };
      paint();
      clearInterval(depTimer);
      depTimer = setInterval(paint, 1000);
    }
    $$("#sheet-body .tile").forEach(function (b) {
      b.addEventListener("click", function () { togglePanel(b.dataset.go); });
    });
  }
  var depTimer = null;

  /* -------------------------------------------------------- room panel */
  function openRoomPanel(p) {
    openPanel("place", p.name, p.tag || "Room");
    var room = window.QVRooms && QVRooms.roomOf(p.building || p.id);
    var seats = room ? QVRooms.seatsOf(p.building || p.id) : [];
    var occ = room ? QVRooms.occupancyOf(p.building || p.id) : { seats: {} };
    var taken = Object.keys(occ.seats || {}).length;
    var here = Object.keys(peers).map(function (k) { return peers[k]; })
      .filter(function (pr) { return pr.room === (p.building || p.id); });
    var ps = p.topic ? matchPapers((topicById[p.topic] || {}).name || "", p.topic, 6) : [];

    body().innerHTML =
      '<p class="motto lead">' + esc(p.sub || "") + "</p>" +
      '<div class="stats"><div><b>' + seats.length + "</b><span>seats</span></div>" +
      "<div><b>" + taken + "</b><span>taken</span></div>" +
      "<div><b>" + (here.length + (QVRooms && QVRooms.state().roomId === (p.building || p.id) ? 1 : 0)) +
      "</b><span>in the room</span></div></div>" +
      '<p class="fine">Walk in through the door, stand by a chair and press <b>E</b> to sit. ' +
      (room && room.stage
        ? "Press <b>E</b> again to take the board: your avatar leaves the table and everyone " +
          "else stays where they are. <b>Q</b> stands up instead."
        : "Press <b>E</b> again to stand.") + "</p>" +
      (here.length
        ? '<h5 class="sep">In here now</h5>' + here.map(function (pr) {
            return '<article class="row person"><h5>' + esc(pr.name) + "</h5><p class=\"fine\">" +
              (pr.act === "speak" ? "at the board" : pr.act === "sit" ? "seated" : "standing") + "</p></article>";
          }).join("")
        : "") +
      (ps.length ? '<h5 class="sep">On the table here</h5>' + ps.map(paperCard).join("") : "");
    bindCards("#sheet-body");
  }

  /* A small live badge while you are seated or speaking. */
  function updateRoomHud() {
    var el = $("#roomhud");
    if (!el || !window.QVRooms) return;
    var st = QVRooms.state();
    var room = st.roomId && QVRooms.roomOf(st.roomId);
    paintHallCard(false);
    if (!st.roomId) { el.classList.remove("on"); return; }
    var occ = QVRooms.occupancyOf(st.roomId);
    var speaker = occ.speaker;
    var mine = Net.user() ? Net.user().uid : (window.QVLocalId || "guest");
    var name = (V.PLACES.filter(function (p) { return (p.building || p.id) === st.roomId; })[0] || {}).name || "This room";
    var line = st.speaking ? "You have the board"
      : (speaker && speaker !== mine) ? "Someone is speaking"
      : st.seat ? "Seated" : "Standing";
    var main = el.querySelector(".rh-main") || el;
    main.innerHTML = '<span class="eyebrow">' + esc(name) + "</span><b>" + esc(line) + "</b>" +
      (st.speaking ? '<span class="speaking"><i></i>live</span>' : "");
    el.classList.add("on");
    el.classList.toggle("live", !!st.speaking);
  }

  /* ------------------------------------------------------------ threads */
  var threadUnsub = null;
  function threadKey(id) { return String(id).replace(/[^A-Za-z0-9_.~:@+-]/g, "_"); }
  function openThread(paperId) {
    var p = PAPERS.filter(function (x) { return x.i === paperId; })[0];
    openPanel("thread", "Paper room", paperId);
    body().innerHTML =
      '<div class="threadhead"><h4>' + esc(p ? p.n : paperId) + "</h4>" +
      '<a class="btn small ghost" href="' + absUrl(paperId) + '" target="_blank" rel="noopener">arXiv</a></div>' +
      '<div id="tlog" class="threadlog"><p class="fine">Opening the room…</p></div>' +
      '<form id="tform" class="composer"><input id="tinput" class="field" placeholder="Add to the discussion…" maxlength="600" autocomplete="off"><button class="btn small">Post</button></form>';
    $("#tform").addEventListener("submit", function (e) { e.preventDefault(); postThread(paperId); });
    if (threadUnsub) threadUnsub();
    threadUnsub = Net.docWatch("threads/" + threadKey(paperId), function (d) {
      var all = (d && d.posts) || [];
      var posts = livePosts(all);
      var log = $("#tlog"); if (!log) return;
      log.innerHTML = posts.length ? posts.map(function (x) {
        return '<div class="post"><span class="cw">' + esc(x.n) + "</span>" +
          '<span class="mono when">' + new Date(x.t).toLocaleString() + "</span><p>" + esc(x.m) + "</p></div>";
      }).join("") : '<p class="fine">Nothing in this room at the moment. Nothing said here is kept \u2014 ' +
        "open it and whoever is reading the same paper will see you.</p>";
      log.scrollTop = log.scrollHeight;
      /* whoever opens a room that has gone stale is the one who clears it */
      if (all.length && !posts.length) {
        Net.docSet("threads/" + threadKey(paperId), { paper:paperId, posts:[], at:Date.now() })
          .catch(function () {});
      }
    });
  }
  /* A paper room is a chat section like any other, so it keeps no history
     either. Each post is written with an expiry, and every write sweeps out
     whatever has passed it — which means the sweeping is done by the people
     using the room, with no scheduled job and no server. */
  var THREAD_TTL = 30 * 60000;
  function livePosts(list) {
    var now = Date.now();
    return (list || []).filter(function (x) { return (x.e || (x.t + THREAD_TTL)) > now; });
  }

  function postThread(paperId) {
    var el = $("#tinput"), v = el.value.trim();
    if (!v) return;
    el.value = "";
    var path = "threads/" + threadKey(paperId);
    Net.docGet(path).then(function (d) {
      var posts = livePosts((d && d.posts) || []).slice(-40);
      var now = Date.now();
      posts.push({ n: displayName(), m: v.slice(0, 600), t: now, e: now + THREAD_TTL });
      return Net.docSet(path, { paper:paperId, posts:posts, at:now });
    }).then(function () {
      me.points += 5; saveMe(); setScore(); Net.addScore(5, displayName()).catch(function () {}); objective();
    }).catch(function () { toast("Could not post to that room."); });
  }

  /* ------------------------------------------------------------- groups */
  function groupCard(g) {
    var mem = g.members || [], joined = mem.indexOf(me.uid || me.id) >= 0;
    return '<article class="row"><h5>' + esc(g.name) + "</h5>" +
      '<p class="fine">' + esc((topicById[g.topic] || {}).name || "") + " · " + mem.length +
      " member" + (mem.length === 1 ? "" : "s") + "</p>" +
      '<button class="btn small ' + (joined ? "ghost" : "") + ' join" data-g="' + esc(g.id) + '">' +
      (joined ? "Leave" : "Join") + "</button></article>";
  }
  function bindGroups(scope) {
    $$(scope + " .join").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); toggleGroup(b.dataset.g); });
    });
  }
  function createGroup(name, instId, topic) {
    if (!name) return;
    var g = { id:"g" + Date.now().toString(36), name:name, inst:instId || "", topic:topic || "pheno",
              members:[me.uid || me.id], by:displayName(), at:Date.now() };
    Net.docSet("groups/" + g.id, g).catch(function () { groups.push(g); });
    me.points += 10; saveMe(); setScore(); Net.addScore(10, displayName()).catch(function () {});
    toast("Group started <span class=\"pts\">+10</span>"); objective();
    if (currentPanel === "groups") setTimeout(renderGroups, 200);
  }
  function toggleGroup(id) {
    var g = groups.filter(function (x) { return x.id === id; })[0];
    if (!g) return;
    var mem = (g.members || []).slice(), k = me.uid || me.id, i = mem.indexOf(k);
    if (i >= 0) mem.splice(i, 1); else mem.push(k);
    Net.docUpdate("groups/" + id, { members:mem }).catch(function () { g.members = mem; });
    if (currentPanel === "groups") setTimeout(renderGroups, 250);
  }
  function renderGroups() {
    openPanel("groups", "Research groups", "Open to every resident");
    body().innerHTML =
      '<form id="mkg" class="form"><label>Start a group' +
      '<input id="g-name" class="field" placeholder="e.g. PBH constraints reading group" maxlength="48" required autocomplete="off"></label>' +
      '<label>Topic<select id="g-topic" class="field">' +
      TOPICS.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + "</option>"; }).join("") +
      "</select></label><button class=\"btn\">Create</button></form>" +
      (groups.length ? groups.map(groupCard).join("") : '<p class="fine">No groups yet. They usually start after a seminar.</p>');
    $("#mkg").addEventListener("submit", function (e) {
      e.preventDefault(); createGroup($("#g-name").value.trim(), "", $("#g-topic").value);
    });
    bindGroups("#sheet-body");
  }

  /* ---------------------------------------------------------------- map */
  /* Which quarter of the world a place is in, for the list under the map. */
  var DISTRICTS = [
    { id:"outskirts", name:"Village Outskirts",   test:function (p) { return Math.hypot(p.x, p.z) >= 650; } },
    { id:"old",     name:"The Old Village",       test:function (p) { return Math.hypot(p.x, p.z) < 320; } },
    { id:"campus",  name:"North Campus",          test:function (p) { return p.z <= -320; } },
    { id:"research",name:"Research Park",         test:function (p) { return p.x >= 320; } },
    { id:"west",    name:"Residential & Park",    test:function (p) { return p.x <= -320; } },
    { id:"station", name:"Station Quarter",       test:function (p) { return p.z >= 320; } }
  ];
  function districtOf(p) {
    for (var i = 0; i < DISTRICTS.length; i++) if (DISTRICTS[i].test(p)) return DISTRICTS[i];
    return DISTRICTS[0];
  }

  /* ---------------------------------------------------------------- map
     Thirty-six places is too many identical dots to read, so the map sorts
     them into six things a physicist actually goes somewhere to do, and
     lets you take the rest off the board while you look. Pick a place and
     it tells you what it is before you commit to the walk. */
  var MAP_KEYS = [
    { id:"teach",  name:"Teaching",  c:"#E8B04B", kinds:["lecture","seminar","discussion","poster","poster2"] },
    { id:"res",    name:"Research",  c:"#8FC6C4", kinds:["institute","lab","university","offices","observatory","workshop"] },
    { id:"read",   name:"Reading",   c:"#F0E4C4", kinds:["library"] },
    { id:"social", name:"Social",    c:"#D97B54", kinds:["cafe","common","commons","lodging","restaurant"] },
    { id:"out",    name:"Outdoors",  c:"#7FA87A", kinds:["open","board"] },
    { id:"travel", name:"Travel",    c:"#9BB4D8", kinds:["station","transport","travel"] }
  ];
  var KEY_OF = {};
  MAP_KEYS.forEach(function (g) { g.kinds.forEach(function (k) { KEY_OF[k] = g; }); });
  function keyOf(p) { return KEY_OF[p.kind] || MAP_KEYS[1]; }

  var mapFilter = "all", mapQuery = "", mapSel = -1;

  function mapMatches(p) {
    if (mapFilter !== "all" && keyOf(p).id !== mapFilter) return false;
    if (!mapQuery) return true;
    var q = mapQuery.toLowerCase();
    return (p.name || "").toLowerCase().indexOf(q) >= 0 ||
           (p.sub || "").toLowerCase().indexOf(q) >= 0 ||
           (p.tag || "").toLowerCase().indexOf(q) >= 0 ||
           districtOf(p).name.toLowerCase().indexOf(q) >= 0;
  }

  function renderMap() {
    openPanel("map", "World map", "Pick a place to see what it is");
    var R = V.WORLD_R;
    mapSel = -1;

    body().innerHTML =
      '<div class="maptools">' +
        '<input id="map-q" class="field" type="search" placeholder="Search places, quarters…" ' +
          'autocomplete="off" value="' + esc(mapQuery) + '">' +
        '<div class="mapkeys" id="map-keys">' +
          '<button class="mkey' + (mapFilter === "all" ? " on" : "") + '" data-k="all">' +
            '<b style="background:linear-gradient(90deg,#E8B04B,#8FC6C4)"></b>All ' +
            '<em>' + V.PLACES.length + "</em></button>" +
          MAP_KEYS.map(function (g) {
            var n = V.PLACES.filter(function (p) { return keyOf(p).id === g.id; }).length;
            if (!n) return "";
            return '<button class="mkey' + (mapFilter === g.id ? " on" : "") + '" data-k="' + g.id + '">' +
              '<b style="background:' + g.c + '"></b>' + esc(g.name) + " <em>" + n + "</em></button>";
          }).join("") +
        "</div>" +
      "</div>" +

      '<div class="bigmap" id="bigmap"><canvas id="bigmap-c" width="620" height="620"></canvas>' +
        V.PLACES.map(function (p, i) {
          var g = keyOf(p);
          /* Keyed by where it sits in PLACES rather than by id: two places
             genuinely share the id "field", and an id lookup lights up both. */
          return '<button class="mpin' + (p.kind === "board" ? " mpin-board" : "") + '" data-i="' + i + '" data-x="' + p.x + '" data-z="' + p.z + '" data-kind="' + p.kind + '" ' +
            'style="left:' + ((p.x / R) * 47 + 50).toFixed(2) + "%;top:" + ((p.z / R) * 47 + 50).toFixed(2) +
            "%;--pc:" + g.c + '" title="' + esc(p.name) + '" aria-label="' + esc(p.name) + '">' +
            '<i' + (me.visited[p.id] ? ' class="seen"' : "") + "></i><span>" + esc(p.name) + "</span></button>";
        }).join("") +
        '<span class="myou" id="myou"><b></b><span>You</span></span>' +
      "</div>" +

      '<div class="mapcard" id="map-card" hidden></div>' +
      '<div class="maplist" id="map-list"></div>';

    drawBigMap($("#bigmap-c"), R);
    placeYou(R);

    $("#map-q").addEventListener("input", function () {
      mapQuery = this.value.trim();
      applyMap();
    });
    $("#map-keys").addEventListener("click", function (e) {
      var b = e.target.closest(".mkey"); if (!b) return;
      mapFilter = b.dataset.k;
      $$(".mkey", $("#map-keys")).forEach(function (x) { x.classList.toggle("on", x === b); });
      applyMap();
    });
    $("#bigmap").addEventListener("click", function (e) {
      var b = e.target.closest(".mpin"); if (!b) return;
      selectPlace(+b.dataset.i);
    });
    applyMap();
  }

  function placeYou(R) {
    var you = $("#myou"); if (!you) return;
    you.style.left = ((player.position.x / R) * 47 + 50) + "%";
    you.style.top = ((player.position.z / R) * 47 + 50) + "%";
  }

  /* One pass for the board and the list, so the two can never disagree. */
  function applyMap() {
    var hit = {}, shown = [];
    V.PLACES.forEach(function (p, i) {
      if (!mapMatches(p)) return;
      hit[i] = 1;
      shown.push({ p: p, i: i });
    });
    /* Few enough left on the board? Then there is room to name them. */
    var label = shown.length <= 12;

    $$(".mpin", $("#bigmap")).forEach(function (b) {
      var i = +b.dataset.i, on = !!hit[i];
      b.classList.toggle("dim", !on);
      b.classList.toggle("show", on && label);
      b.classList.toggle("sel", i === mapSel);
    });

    var list = $("#map-list");
    if (!shown.length) {
      list.innerHTML = '<p class="fine">Nothing here by that name. Clear the search to see the whole village.</p>';
      return;
    }
    list.innerHTML = DISTRICTS.map(function (d) {
      var here = shown.filter(function (e) { return districtOf(e.p) === d; });
      if (!here.length) return "";
      return '<h5 class="sep">' + esc(d.name) + ' <em>' + here.length + "</em></h5>" +
        here.map(function (e) {
          var p = e.p, g = keyOf(p);
          return '<button class="mrow' + (e.i === mapSel ? " on" : "") + '" data-i="' + e.i + '">' +
            '<i style="background:' + g.c + '"></i>' +
            "<span><b>" + esc(p.name) + "</b>" +
            (p.sub ? "<em>" + esc(p.sub) + "</em>" : "") + "</span>" +
            (me.visited[p.id] ? '<span class="tick" title="Visited">✓</span>' : "") +
            "</button>";
        }).join("");
    }).join("");
    $$(".mrow", list).forEach(function (b) {
      b.addEventListener("click", function () { selectPlace(+b.dataset.i); });
    });
  }

  function selectPlace(i) {
    var p = V.PLACES[i];
    if (!p) return;
    mapSel = i;
    var g = keyOf(p), d = districtOf(p);
    var dist = Math.round(Math.hypot(p.x - player.position.x, p.z - player.position.z));
    var card = $("#map-card");
    card.hidden = false;
    card.innerHTML =
      '<span class="mdot" style="background:' + g.c + '"></span>' +
      "<div class=\"mtext\"><b>" + esc(p.name) + "</b>" +
      "<em>" + esc(g.name) + " · " + esc(d.name) +
      (p.sub ? " · " + esc(p.sub) : "") + "</em>" +
      '<span class="fine">' + (me.visited[p.id] ? "You have been here. " : "Not visited yet. ") +
      "About " + dist + " paces away.</span></div>" +
      '<button class="btn" id="map-go">Walk there</button>';
    $("#map-go").addEventListener("click", function () { ferry(p.x, p.z); });
    applyMap();
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function drawBigMap(c, R) {
    if (!c) return;
    var ctx = c.getContext("2d"), W = c.width, H = c.height;
    function px(x) { return W / 2 + (x / R) * (W / 2 - 18); }
    function py(z) { return H / 2 + (z / R) * (H / 2 - 18); }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#2B5F55";
    ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 6, 0, 6.283); ctx.fill();
    /* woodland belt */
    ctx.strokeStyle = "rgba(90,140,110,.30)"; ctx.lineWidth = 52;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, (640 / R) * (W / 2 - 18), 0, 6.283); ctx.stroke();
    /* roads */
    ctx.strokeStyle = "rgba(226,220,204,.48)"; ctx.lineWidth = 4;
    (V.ROADS || []).forEach(function (r) {
      var pts = r.closed ? r.pts.concat([r.pts[0]]) : r.pts;
      ctx.beginPath();
      pts.forEach(function (pt, i) { i ? ctx.lineTo(px(pt[0]), py(pt[1])) : ctx.moveTo(px(pt[0]), py(pt[1])); });
      ctx.stroke();
    });
    /* railway, drawn as a dashed line */
    if (V.RAIL) {
      ctx.strokeStyle = "rgba(180,200,200,.8)"; ctx.lineWidth = 2.5;
      ctx.setLineDash([9, 6]);
      [V.RAIL.a, V.RAIL.b].forEach(function (tr) {
        ctx.beginPath(); ctx.moveTo(px(tr.from), py(tr.z)); ctx.lineTo(px(tr.to), py(tr.z)); ctx.stroke();
      });
      ctx.setLineDash([]);
    }
    /* the old lane */
    ctx.strokeStyle = "rgba(232,217,176,.45)"; ctx.lineWidth = 3;
    ctx.beginPath();
    (V.lanePts || []).forEach(function (pt, i) {
      if (i % 6) return;
      i ? ctx.lineTo(px(pt[0]), py(pt[1])) : ctx.moveTo(px(pt[0]), py(pt[1]));
    });
    ctx.stroke();
    /* water */
    ctx.fillStyle = "rgba(143,198,196,.6)";
    [[-118, 84, 46, 34], [-740, 240, 52, 52]].forEach(function (p) {
      ctx.beginPath();
      ctx.ellipse(px(p[0]), py(p[1]), (p[2] / R) * (W / 2), (p[3] / R) * (H / 2), 0, 0, 6.283);
      ctx.fill();
    });
    /* District names, kept clear of the pins and given a dark outline so
       they stay readable wherever they happen to fall. "Old Village" sits
       above its cluster rather than inside it. */
    ctx.font = "700 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    [["NORTH CAMPUS", 0, -640], ["RESEARCH PARK", 640, 20], ["RESIDENTIAL", -640, -90],
     ["NOETHER PARK", -730, 250], ["STATION QUARTER", 60, 560], ["OLD VILLAGE", 0, -210]]
      .forEach(function (d) {
        ctx.strokeStyle = "rgba(16,44,40,.75)"; ctx.lineWidth = 3.5;
        ctx.strokeText(d[0], px(d[1]), py(d[2]));
        ctx.fillStyle = "rgba(244,235,216,.62)";
        ctx.fillText(d[0], px(d[1]), py(d[2]));
      });
    if (window.QVTransport) {
      var stations = QVTransport.cycleStations ? QVTransport.cycleStations() :
        (QVTransport.cycleStation ? [QVTransport.cycleStation()] : []);
      stations.forEach(function (cs) {
        var sx = px(cs.x), sz = py(cs.z);
        ctx.fillStyle = "#E8B04B"; ctx.strokeStyle = "#173A35"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(sx, sz, 11, 0, 6.283); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#173A35"; ctx.font = "700 13px system-ui, sans-serif";
        ctx.fillText("🚲", sx, sz + 5);
      });
      (QVTransport.jeepStations ? QVTransport.jeepStations() : []).forEach(function (js) {
        var sx = px(js.x), sz = py(js.z);
        ctx.fillStyle = "#E8B04B"; ctx.strokeStyle = "#173A35"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(sx, sz, 11, 0, 6.283); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#173A35"; ctx.font = "700 13px system-ui, sans-serif";
        ctx.fillText("🚙", sx, sz + 5);
      });
    }

    /* outdoor blackboards on map */
    V.PLACES.filter(function (p) { return p.kind === "board"; }).forEach(function (ob) {
      var bx = px(ob.x), bz = py(ob.z);
      ctx.fillStyle = "#1E2B26";
      ctx.strokeStyle = "#8A6D47";
      ctx.lineWidth = 1.6;
      ctx.fillRect(bx - 5.5, bz - 4, 11, 8);
      ctx.strokeRect(bx - 5.5, bz - 4, 11, 8);
      ctx.fillStyle = "#EAE3D2";
      ctx.fillRect(bx - 4, bz - 2, 8, 1);
    });
  }
  function ferry(x, z) {
    var s = V.clearSpot(x, z + 7, 1.6);
    player.position.set(s.x, 0, s.z);
    target = null; targetMark.visible = false;
    closePanel();
    toast("Arrived at <b>" + esc(V.placeAt(s.x, s.z).name) + "</b>");
  }

  /* ===================================================== getting to an event
   *
   * "Take Me There" and "Ride to Event" on the Notice Board. An event's
   * location is its hall — a notice's hallId, or the hall a poster session
   * uses — and that hall's place entry already stands on the paved apron
   * outside its main door, so arriving there always means arriving at the
   * way in, whichever side of the building the door is on.
   *
   * A ride is not a second way of moving. It hands the ordinary
   * click-to-walk `target` one road waypoint after another, so the cycle
   * or jeep goes at its own speed, slides along walls, and is seen by
   * everybody else exactly as it is when somebody drives it by hand. */
  var RIDE_BOOST = 1.35;          /* a little quicker than by hand: nobody is steering */
  var ride = null;

  function eventPlace(hallId) {
    return V.PLACES.filter(function (p) { return (p.building || p.id) === hallId; })[0] || null;
  }
  /* A spot `back` metres further out from the door than the apron, clear of
     anything solid, facing the door. */
  function arrivalSpot(pl, back) {
    var b = pl.building && V.buildingById ? V.buildingById(pl.building) : null;
    var dx = 0, dz = 1;
    if (b && b.def) {
      dx = pl.x - b.def.x; dz = pl.z - b.def.z;
      var l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    }
    var s = V.clearSpot(pl.x + dx * back, pl.z + dz * back, 1.6);
    return { x: s.x, z: s.z, ry: Math.atan2(-dx, -dz), dx: dx, dz: dz };
  }
  /* Of a poster session's halls, the one worth going to: the nearest. */
  function nearestHall(ids) {
    var best = null, bd = Infinity;
    (ids || []).forEach(function (id) {
      var pl = eventPlace(id);
      if (!pl) return;
      var d = Math.hypot(pl.x - player.position.x, pl.z - player.position.z);
      if (d < bd) { bd = d; best = id; }
    });
    return best;
  }
  /* The buttons beside "View Event". Nothing when the event has no hall
     in the village to go to. */
  function goButtons(hallIds) {
    var hid = nearestHall([].concat(hallIds || []));
    if (!hid) return "";
    return '<button type="button" class="btn small ghost" data-nbto="' + esc(hid) + '">Take Me There</button>' +
      '<button type="button" class="btn small ghost" data-nbride="' + esc(hid) + '" aria-expanded="false">Ride to Event</button>';
  }
  function rideChooser(hid) {
    return '<div class="nb-ride" role="group" aria-label="Ride to the event by">' +
      '<span class="nb-ride-q">Ride there by</span>' +
      '<button type="button" class="btn small" data-nbrideby="cycle" data-hall="' + esc(hid) + '">🚲 Cycle</button>' +
      '<button type="button" class="btn small" data-nbrideby="jeep" data-hall="' + esc(hid) + '">🚙 Open Jeep</button>' +
      '<button type="button" class="btn small ghost" data-nbridex="1">Cancel</button></div>';
  }
  function toggleRideChooser(btn) {
    var card = btn.closest(".nb-card, .nb-detail") || btn.parentNode;
    var open = card.querySelector(".nb-ride");
    if (open) { open.remove(); btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    btn.parentNode.insertAdjacentHTML("afterend", rideChooser(btn.dataset.nbride));
  }

  /* Out of a chair, off the lectern's script. Holding the board is the one
     thing that has to be finished properly first. */
  function readyToLeave() {
    if (!window.QVRooms) return true;
    var st = QVRooms.state();
    if (st.speaking) { toast("You have the board — step down from it first."); return false; }
    if (QVRooms.isSeated()) QVRooms.stand();
    if (st.goal) QVRooms.cancelScripted();
    return true;
  }

  function takeMeThere(hallId) {
    var pl = eventPlace(hallId);
    if (!pl) { toast("That event has no place in the village to go to."); return; }
    if (!readyToLeave()) return;
    endRide();
    var s = arrivalSpot(pl, 2);
    player.position.set(s.x, 0, s.z);
    player.rotation.y = s.ry;
    target = null; targetMark.visible = false;
    closePanel();
    toast("Arrived at <b>" + esc(pl.name) + "</b> — the entrance is in front of you.");
  }

  /* Waypoints out of the building you are in, if you are in one: to just
     inside its main door, then out onto the apron. */
  function wayOut() {
    var inside = V.insideOf ? V.insideOf(player.position.x, player.position.z) : null;
    var pl = inside ? eventPlace(inside.id) : null;
    if (!pl) return [];
    var o = arrivalSpot(pl, 0);
    return [{ x: pl.x - o.dx * 10.5, z: pl.z - o.dz * 10.5 }, { x: o.x, z: o.z }];
  }

  function startRide(hallId, kind) {
    var pl = eventPlace(hallId);
    if (!pl || !window.QVTransport || !QVTransport.boardVehicle) return;
    if (!readyToLeave()) return;
    endRide();
    var stop = arrivalSpot(pl, kind === "jeep" ? 9 : 5);
    var pts = wayOut();
    var from = pts.length ? pts[pts.length - 1] : { x: player.position.x, z: player.position.z };
    pts = pts.concat(QVTransport.planRoute(from.x, from.z, stop.x, stop.z));
    if (!QVTransport.boardVehicle(player, kind)) return;
    /* what is left of the journey from each waypoint on, for the read-out */
    var left = new Array(pts.length);
    left[pts.length - 1] = 0;
    for (var i = pts.length - 2; i >= 0; i--) {
      left[i] = left[i + 1] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    }
    ride = { kind: kind, pl: pl, stop: stop, pts: pts, left: left, i: 0, cur: null,
             best: Infinity, stall: 0, arrived: false, hudT: 0 };
    target = null; targetMark.visible = false;
    closePanel();
    paintRideHud();
    toast((kind === "jeep" ? "🚙 Jeep" : "🚲 Cycle") + " out from the station. Riding to <b>" + esc(pl.name) + "</b>" +
      '<span class="tsub">Steer or click anywhere to take over.</span>');
  }

  function endRide() {
    if (!ride) return;
    if (ride.cur && target === ride.cur) { target = null; targetMark.visible = false; }
    ride = null;
    paintRideHud();
  }

  function arrive() {
    ride.arrived = true;
    if (target === ride.cur) target = null;
    ride.cur = null;
    player.rotation.y = ride.stop.ry;
    paintRideHud();
    toast("Arrived at <b>" + esc(ride.pl.name) + "</b>. Get off whenever you are ready.");
  }

  function getOff() {
    if (!ride || !window.QVTransport) return;
    var jeep = QVTransport.isDriving(), pl = ride.pl, stop = ride.stop;
    var ok = jeep ? QVTransport.parkJeep(player) : QVTransport.isCycling() ? QVTransport.parkCycle(player) : false;
    endRide();
    if (!ok) return;
    /* step out towards the door, clear of what you just parked */
    var s = V.clearSpot(player.position.x - stop.dx * (jeep ? 4 : 2), player.position.z - stop.dz * (jeep ? 4 : 2), 1.15);
    player.position.x = s.x; player.position.z = s.z;
    player.rotation.y = stop.ry;
    toast((jeep ? "Jeep" : "Cycle") + " parked outside <b>" + esc(pl.name) + "</b>." +
      '<span class="tsub">Press E beside it to ride on later.</span>');
  }

  /* Once a frame, before the player moves. */
  function rideTick(dt) {
    if (!ride) return;
    var px = player.position.x, pz = player.position.z;
    if (ride.arrived) {
      /* driven off again by hand: the ride is over */
      if (Math.hypot(px - ride.stop.x, pz - ride.stop.z) > 12) endRide();
      return;
    }
    /* Somebody took the handlebars — a key, the stick, a click on the
       ground all replace or clear the target. Arriving within a stride of
       a waypoint clears it too, and that is not taking over. */
    if (ride.cur && target !== ride.cur &&
        !(target === null && Math.hypot(ride.cur.x - px, ride.cur.z - pz) < 1)) {
      var kind = ride.kind;
      endRide();
      toast("You have the " + (kind === "jeep" ? "wheel" : "handlebars") + " — riding on by hand.");
      return;
    }
    var last = ride.pts.length - 1;
    var p = ride.pts[ride.i], d = Math.hypot(p.x - px, p.z - pz);
    while (ride.i < last && d < 5) {
      ride.i++; ride.best = Infinity; ride.stall = 0;
      p = ride.pts[ride.i]; d = Math.hypot(p.x - px, p.z - pz);
    }
    if (ride.i === last && d < 1.2) { arrive(); return; }
    /* caught on something: after a moment, try the next waypoint, and on
       the last leg just pull up at the door */
    if (d < ride.best - 0.4) { ride.best = d; ride.stall = 0; }
    else if ((ride.stall += dt) > 2.5) {
      if (ride.i === last) {
        player.position.x = ride.stop.x; player.position.z = ride.stop.z;
        arrive();
        return;
      }
      ride.i++; ride.best = Infinity; ride.stall = 0;
      p = ride.pts[ride.i];
    }
    if (!ride.cur || ride.cur.x !== p.x || ride.cur.z !== p.z) ride.cur = { x: p.x, z: p.z };
    target = ride.cur;
    if ((ride.hudT += dt) > 0.5) { ride.hudT = 0; paintRideHud(); }
  }

  function paintRideHud() {
    var hud = $("#ride-hud");
    if (!hud) return;
    if (!ride) { hud.hidden = true; return; }
    var icon = ride.kind === "jeep" ? "🚙" : "🚲";
    if (ride.arrived) {
      hud.innerHTML = '<span class="rh-ico" aria-hidden="true">' + icon + "</span>" +
        '<span class="rh-txt"><span class="rh-k">Arrived</span><b>' + esc(ride.pl.name) + "</b></span>" +
        '<button type="button" class="btn small" data-ride="off">Get off</button>' +
        '<button type="button" class="btn small ghost" data-ride="stay">Stay on</button>';
    } else {
      var p = ride.pts[ride.i];
      var m = Math.round(ride.left[ride.i] + Math.hypot(p.x - player.position.x, p.z - player.position.z));
      hud.innerHTML = '<span class="rh-ico" aria-hidden="true">' + icon + "</span>" +
        '<span class="rh-txt"><span class="rh-k">Riding to · ' + (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m") +
        "</span><b>" + esc(ride.pl.name) + "</b></span>" +
        '<button type="button" class="btn small ghost" data-ride="stop">Stop</button>';
    }
    hud.hidden = false;
  }
  function wireRideHud() {
    var hud = $("#ride-hud");
    if (!hud) return;
    hud.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b || !ride) return;
      if (b.dataset.ride === "off") getOff();
      else if (b.dataset.ride === "stay") endRide();
      else if (b.dataset.ride === "stop") {
        var kind = ride.kind;
        endRide();
        toast("Stopped. You are still on the " + (kind === "jeep" ? "jeep" : "cycle") +
          '<span class="tsub">Ride on by hand, or press E outside a building to park.</span>');
      }
    });
  }

  /* ------------------------------------------------------------- people */
  function renderPeople(force) {
    if (!force && currentPanel !== "people") return;
    openPanel("people", "Who's about", Net.isLive() ? "Live in the village" : "Solo build");
    var list = Object.keys(peers).map(function (k) {
      var p = peers[k];
      var aff = affiliation(p);
      return '<article class="row person"><h5>' + esc(p.name) + "</h5>" +
        (aff ? '<p class="aff">' + esc(aff) + "</p>" : "") +
        (p.orcid ? '<p class="aff orcid"><a href="' + esc(orcidUrl(p.orcid)) + '" target="_blank" rel="noopener">' +
          esc(fmtOrcid(p.orcid)) + "</a></p>" : "") +
        '<p class="fine">' + esc(p.sub || "somewhere on the lane") + "</p>" +
        '<div class="person-acts"><button class="btn small ghost go" data-k="' + esc(k) + '">Walk over</button>' +
        (window.QVPrivate
          ? '<button class="btn small ghost pv-dm" data-k="' + esc(k) + '">💬 Message' +
              (QVPrivate.unread(k) ? ' <span class="pc-unread">●</span>' : "") + "</button>" +
            '<button class="btn small ghost pv-call" data-k="' + esc(k) + '">🎙️ Call</button>'
          : "") + "</div></article>";
    }).join("");
    body().innerHTML =
      '<article class="row person you"><h5>' + esc(displayName()) + ' <span class="pillmini">you</span></h5>' +
      (affiliation() ? '<p class="aff">' + esc(affiliation()) + "</p>" : "") +
      (me.orcid ? '<p class="aff orcid"><a href="' + esc(orcidUrl(me.orcid)) + '" target="_blank" rel="noopener">' +
        esc(fmtOrcid(me.orcid)) + "</a></p>" : "") +
      '<p class="fine">' + me.shelf.length + " on your shelf · " + me.points + " points</p></article>" +
      (list || '<p class="fine">' + (Net.isLive()
        ? "Nobody else is here right now. Send the link and the commons fills up — everyone walks the same village."
        : "This build is running solo. Add your Firebase config, or open the hosted preview, for live neighbours.") + "</p>");
    $$("#sheet-body .go").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = peers[b.dataset.k]; if (!p) return;
        walkTo(p.g.position.x + 2.5, p.g.position.z + 2.5); closePanel();
      });
    });
    $$("#sheet-body .pv-dm, #sheet-body .pv-call").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.dataset.k, p = peers[k]; if (!p || !window.QVPrivate) return;
        closePanel();
        if (b.classList.contains("pv-dm")) QVPrivate.openChat(k, p.name);
        else QVPrivate.startCall(k, p.name);
      });
    });
  }

  /* -------------------------------------------------------- leaderboard */
  function renderBoard() {
    openPanel("board", "Village standings", "Points for walking, keeping and building");
    var rows = scores.length ? scores : [{ name: displayName(), points: me.points }];
    body().innerHTML =
      '<ol class="board">' + rows.map(function (r, i) {
        return "<li" + ((r.name === displayName()) ? ' class="me"' : "") + '><span class="rank">' + (i + 1) + "</span>" +
          "<span class=\"who\">" + esc(r.name || "Resident") + '</span><span class="pts2">' + (r.points || 0) + "</span></li>";
      }).join("") + "</ol>" +
      '<div class="scorekey"><h5>How points are earned</h5><ul>' +
      "<li><b>+5</b> walking over a paper marker</li>" +
      "<li><b>+10</b> first visit to a place</li>" +
      "<li><b>+5</b> posting in a paper room</li>" +
      "<li><b>+10</b> starting a group or calling a seminar</li>" +
      "<li><b>+15</b> writing on a blackboard (discussion!)</li>" +
      "<li><b>+20</b> pinning a poster to the wall</li>" +
      "<li><b>+25</b> founding an institute</li></ul>" +
      '<p class="fine" style="margin-top:10px">Spend points at <b>The Grand Refectory</b> — walk there and join the queue.</p>' +
      '</div>';
  }

  /* ------------------------------------------------------------ profile */
  function renderProfile() {
    openPanel("profile", "Your resident", "Your name, post, affiliation and look");
    var swatch = function (kind, arr, cur) {
      return '<div class="swatches" data-kind="' + kind + '">' + arr.map(function (c, i) {
        return '<button type="button" class="sw' + (cur === i ? " on" : "") + '" data-i="' + i +
          '" style="background:#' + c.toString(16).padStart(6, "0") + '"></button>';
      }).join("") + "</div>";
    };
    /* named choices — attire and hairstyle — read better as labelled chips
       than as colour squares, because the colour is not what varies */
    var chips = function (kind, arr, cur) {
      return '<div class="lookchips" data-kind="' + kind + '">' + arr.map(function (o, i) {
        return '<button type="button" class="lookchip' + (cur === i ? " on" : "") +
          '" data-i="' + i + '">' + esc(o.name) + "</button>";
      }).join("") + "</div>";
    };
    var check = function (key, label, on) {
      return '<label class="check"><input type="checkbox" class="lookflag" data-key="' + key + '"' +
        (on ? " checked" : "") + "> " + label + "</label>";
    };
    var avatarOptions = '<div class="avatar-grid" id="avatar-grid">' + V.AVATARS.map(function (a) {
      var colors = [V.SKIN[a.skin], V.HAIR[a.hair], V.SHIRT[a.shirt]].map(function (c) {
        return '<i style="background:#' + c.toString(16).padStart(6, "0") + '"></i>';
      }).join("");
      return '<button type="button" class="avatar-option' + (me.look.avatar === a.id ? " on" : "") +
        '" data-avatar="' + a.id + '" aria-pressed="' + (me.look.avatar === a.id ? "true" : "false") + '">' +
        '<span class="avatar-colors">' + colors + '</span><span><b>' + esc(a.name) + '</b><small>' + esc(a.note) +
        '</small></span></button>';
    }).join("") + '</div>';
    body().innerHTML =
      '<form id="prof" class="form">' +
      '<label>Name on the lane<input id="p-name" class="field" maxlength="22" value="' + esc(me.name) + '" autocomplete="name"></label>' +
      '<div class="row2">' +
      '<label>Current position<select id="p-title" class="field">' +
        '<option value="">—</option>' + TITLES.map(function (t) {
          return '<option value="' + t + '"' + (me.title === t ? " selected" : "") + ">" + t + "</option>";
        }).join("") + "</select></label>" +
      '<label>Country<input id="p-country" class="field" list="country-list" maxlength="56" value="' +
        esc(me.country) + '" placeholder="e.g. United Kingdom" autocomplete="country-name"></label>' +
      "</div>" +
      '<label>Institution<input id="p-inst" class="field" maxlength="90" value="' + esc(me.inst) +
        '" placeholder="e.g. University of Cambridge" autocomplete="organization"></label>' +
      '<label class="orcid-label"><span class="lrow">ORCID iD <span class="opt">optional</span></span>' +
      '<span class="orcid-field">' +
      '<svg class="orcid-mark" width="15" height="15" viewBox="0 0 256 256" aria-hidden="true">' +
      '<circle cx="128" cy="128" r="128" fill="#A6CE39"/>' +
      '<path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM78.6 66.9a9.9 9.9 0 1 1 0-19.8 9.9 9.9 0 0 1 0 19.8zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7 0-21.5-13.7-39.7-43.7-39.7h-23.7v79.4z"/></svg>' +
      '<input id="p-orcid" class="field" inputmode="numeric" maxlength="19" value="' + esc(fmtOrcid(me.orcid)) +
        '" placeholder="0000-0000-0000-0000" autocomplete="off"></span>' +
      '<span class="hint" id="p-orcid-hint"></span></label>' +
      (me.orcid ? '<a class="orcid-link fine" href="' + esc(orcidUrl(me.orcid)) +
        '" target="_blank" rel="noopener">View this record on orcid.org ↗</a>' : "") +
      "<label>Researcher avatar</label>" + avatarOptions +
      "<label>Skin</label>" + swatch("skin", V.SKIN, me.look.skin) +
      "<label>Hair colour</label>" + swatch("hair", V.HAIR, me.look.hair) +
      "<label>Shirt</label>" + swatch("shirt", V.SHIRT, me.look.shirt) +
      "<label>Trousers</label>" + swatch("trouser", V.TROUSER, me.look.trouser) +
      "<label>Attire</label>" + chips("outfit", V.OUTFITS, me.look.outfit || 0) +
      "<label>Hairstyle</label>" + chips("style", V.HAIRSTYLES, me.look.style || 0) +
      "<label>Build</label>" + chips("body", V.BODY_TYPES, me.look.body || 0) +
      '<div class="lookchecks">' +
        check("glasses", "Glasses", me.look.glasses) +
        check("beard", "Beard", me.look.beard) +
        check("bag", "Satchel", me.look.bag) +
      "</div>" +
      '<button class="btn">Save</button></form>' +
      '<div class="stats"><div><b>' + me.shelf.length + "</b><span>on your shelf</span></div>" +
      "<div><b>" + Object.keys(me.visited).length + "</b><span>places visited</span></div>" +
      "<div><b>" + me.points + "</b><span>points</span></div></div>" +
      '<div id="account"></div>';
    var syncLookControls = function () {
      $$("#sheet-body .swatches").forEach(function (row) {
        $$(".sw", row).forEach(function (b) { b.classList.toggle("on", +b.dataset.i === me.look[row.dataset.kind]); });
      });
      $$("#sheet-body .lookchips").forEach(function (row) {
        $$(".lookchip", row).forEach(function (b) { b.classList.toggle("on", +b.dataset.i === me.look[row.dataset.kind]); });
      });
      $$("#sheet-body .lookflag").forEach(function (box) { box.checked = !!me.look[box.dataset.key]; });
      $$("#avatar-grid .avatar-option").forEach(function (b) {
        var on = b.dataset.avatar === me.look.avatar;
        b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    };
    var chooseCustom = function () {
      me.look.avatar = "custom";
      $$("#avatar-grid .avatar-option").forEach(function (b) { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
    };
    $("#avatar-grid").addEventListener("click", function (e) {
      var b = e.target.closest(".avatar-option"); if (!b) return;
      me.look = V.avatarLook(b.dataset.avatar);
      syncLookControls();
      reskin();
    });
    $$("#sheet-body .swatches").forEach(function (row) {
      row.addEventListener("click", function (e) {
        var b = e.target.closest(".sw"); if (!b) return;
        me.look[row.dataset.kind] = +b.dataset.i;
        chooseCustom();
        $$(".sw", row).forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        reskin();
      });
    });
    $$("#sheet-body .lookchips").forEach(function (row) {
      row.addEventListener("click", function (e) {
        var b = e.target.closest(".lookchip"); if (!b) return;
        me.look[row.dataset.kind] = +b.dataset.i;
        chooseCustom();
        $$(".lookchip", row).forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        reskin();
      });
    });
    $$("#sheet-body .lookflag").forEach(function (box) {
      box.addEventListener("change", function () {
        me.look[box.dataset.key] = box.checked;
        chooseCustom();
        reskin();
      });
    });
    wireOrcidField($("#p-orcid"), $("#p-orcid-hint"));
    $("#prof").addEventListener("submit", function (e) {
      e.preventDefault();
      if (!applyIdentity({ name:$("#p-name"), title:$("#p-title"), orcid:$("#p-orcid"),
                           inst:$("#p-inst"), country:$("#p-country") }, $("#p-orcid-hint"))) return;
      toast("Saved.");
      renderProfile();
    });
    renderAccount();
  }
  function reskin() {
    me.look = V.normalizeLook(me.look);
    saveMe();
    var pos = player.position.clone(), rot = player.rotation.y;
    V.getScene().remove(player);
    player = V.makePerson(me.look);
    player.position.copy(pos); player.rotation.y = rot;
    V.getScene().add(player);
    publishResident();
  }
  function renderAccount() {
    var el = $("#account"); if (!el) return;
    var u = Net.user();
    /* Nobody is in the village without an account, so there is no signed-out
       state to draw here — only the account you came in with. */
    el.innerHTML = '<div class="acct"><p class="fine">Signed in as <b>' +
      esc((u && (u.email || u.name)) || "") + "</b>. Your shelf, points and institutes " +
      "follow you to any device you sign in from.</p>" +
      '<button class="btn small ghost" id="signout">Sign out</button></div>';
    if ($("#signout")) $("#signout").addEventListener("click", function () {
      /* Take our own deck off the hall's board before letting go of the
         account: dropMine clears the record, but the slate in front of us
         is painted from local state. */
      if (window.QVSlides && QVSlides.dropMine) QVSlides.dropMine();
      Net.signOut();
    });
    var badge = $("#acct-badge");
    if (badge) badge.textContent = u ? ((u.name || u.email || "").slice(0, 1).toUpperCase()) : "";
  }

  /* --------------------------------------------------------------- help */
  function renderHelp() {
    openPanel("help", "How the village works", "A minute to read");
    body().innerHTML =
      "<h5>Getting about</h5><p class=\"fine\"><b>Click the ground</b> and your resident walks there. Drag to look around, " +
      "scroll to pull the camera in or out. WASD works too, and there is a thumbstick on a phone. " +
      "<b>E</b> does whatever the prompt at the bottom of the screen says — open a door, read a paper, " +
      "sit down, take the board. <b>Q</b> is the second option when one is offered. On a phone, the " +
      "round button above the thumbstick is the same key. <b>M</b> opens the world map, and " +
      "<b>B</b> reads whatever is on the nearest blackboard, and <b>P</b> opens the slides in a " +
      "seminar hall.</p>" +
      "<h5>Something wrong?</h5><p class=\"fine\">The <b>flag</b> in the top bar is <b>Report / Feedback</b>: " +
      "abuse, an inappropriate poster, a bug, trouble with voice or chat, or an idea. You can send it from " +
      "wherever you are, and only the village administrators read it. A poster also has its own " +
      "<b>Report</b> button when you open it.</p>" +
      "<h5>Events and the Notice Board</h5><p class=\"fine\"><b>Notices</b> in the side rail is the Village " +
      "Notice Board: every approved seminar, poster session, competition, workshop and discussion, with who is " +
      "presenting, when (in your own time zone) and where. To organise one, stand in a seminar or poster hall " +
      "and press <b>Book This Hall</b>; it goes on the board once an administrator approves it.</p>" +
            "<h5>The campus</h5><p class=\"fine\">The old village is in the middle. The ring road circles it, with the " +
      "university and its lecture halls, seminar rooms and library to the north, the research park and the " +
      "laboratories east, the residences and Noether Park west, and the station south. Every building with a " +
      "door on it can be walked into — the roof lifts off when you are inside.</p>" +
      "<h5>Hearing the village</h5><p class=\"fine\">You can hear anybody speaking near you from the moment " +
      "you arrive. There is no permission to grant and nothing to switch on — your own microphone has " +
      "nothing to do with it. The <b>🔊 Hear</b> button beside the chat box is only there so you can mute " +
      "the village when you want quiet; it never touches your microphone, and nobody else\u2019s microphone " +
      "can touch it. If it turns amber, your browser is holding sound back until the page has been clicked " +
      "once \u2014 click the button and it lets go.</p>" +
      "<h5>Speaking</h5><p class=\"fine\">Click the microphone button and it stays open for the whole " +
      "conversation; click it again to mute yourself. Hold <b>V</b> instead for a single quick " +
      "word. Either way you are on air live, as you speak, not a recording sent afterwards. While you are " +
      "talking everyone else dips a little, which is what stops a room with its speakers up from howling — " +
      "headphones stop it completely. <b>Nearby</b> reaches " +
      "anyone within about seventy metres and fades with distance; <b>Village</b> reaches everybody. " +
      "Several people can talk at once without queueing, and one person muting or unmuting changes nothing " +
      "for anybody else. The sound travels browser to browser and is never stored anywhere.</p>" +
      "<h5>Reading a blackboard</h5><p class=\"fine\">Chalk on a wall three metres away is not something " +
      "anybody can read, so press <b>B</b> — or tap <b>▤ Board</b> on the right-hand rail, or simply click " +
      "the slate itself — and what is written on it comes up on screen at a readable size, equations and " +
      "all. If something has been pinned up beside the chalk, <b>Open the picture</b> gives it the whole " +
      "panel and <b>Save the picture</b> downloads it. <b>B</b> picks the board in the room you are standing " +
      "in, so the right one opens even when two rooms share a wall.</p>" +
      "<h5>Nothing is kept</h5><p class=\"fine\">Village talk is deleted from the database as soon as the people " +
      "who are here have read it, and the line fades off your screen afterwards. There is no chat history, " +
      "by design.</p>" +
      "<h5>Live activities</h5><p class=\"fine\">Take a blackboard, stand up in a seminar room or pin a poster and " +
      "the village is told what you are doing and where — \u201cBlackboard discussion on Dark Photons, " +
      "Seminar Hall Alpha\u201d. The notice has a button that walks you there. <b>Live</b> on the right-hand " +
      "rail, or <b>J</b>, lists everything running right now.</p>" +
      '<h5>The tour</h5><p class="fine">New here, or want it again? ' +
      '<button type="button" class="btn small" id="help-tour">Take the village tour</button></p>' +
      "<h5>Seminars</h5><p class=\"fine\">Walk into a seminar hall or a discussion room, stand by a chair and press <b>E</b> " +
      "to sit. Press <b>E</b> again to take the blackboard: your avatar gets up, walks to the board and becomes " +
      "the focus of the room while everyone else stays seated. Finish, and you walk back to your chair. Everyone " +
      "else connected sees it happen.</p>" +
      "<h5>The seminar halls</h5><p class=\"fine\">Two of them, out on the edge of the village — " +
      "<b>Seminar Hall α</b> beyond the residences to the north-west, <b>Seminar Hall β</b> beyond the " +
      "research park to the south-east. Fifty tiered seats in each, every one facing forty metres of " +
      "blackboard.</p>" +
      "<h5>Slides</h5><p class=\"fine\">Inside a hall, press <b>P</b> — or tap <b>▣ Slides</b> on the " +
      "right-hand rail — and choose a PDF from your own machine. It goes straight up on the blackboard at " +
      "full size. <b>Next</b> and <b>Previous</b> turn the page, and the moment you do, everybody in the hall " +
      "is looking at the same page you are, on their board and in their own panel. Multi-page decks are what " +
      "it is for; the arrow keys turn pages while the panel is open, and on a phone you can swipe. Close the " +
      "panel and a small page-turner stays in the rail so you can walk about while you talk. The PDF itself " +
      "never leaves your browser — only the page the hall is looking at is sent.</p>" +
      "<h5>Papers</h5><p class=\"fine\">The paper stands in the library, the offices and the laboratories each open an " +
      "arXiv archive in a panel over the game. arXiv does not allow itself to be framed by other sites, so the " +
      "listing tab may say so — the reading room beside it draws on the village's own index and always works.</p>" +
      "<h5>Transport</h5><p class=\"fine\">Traffic runs on the ring road and the streets off it, trains call at Central " +
      "and at Westfield Halt, and aircraft cross overhead. None of it is decoration: the buses really do stop, and " +
      "the drivers really will wait for you at a crossing.</p>" +
      "<h5>Paper markers</h5><p class=\"fine\">The discs scattered through the fields are real arXiv records. Walk over one and " +
      "it goes on your shelf. Each is worth five points, and the village keeps a standing.</p>" +
      "<h5>Founding an institute</h5><p class=\"fine\">Name one after any topic and a hall goes up on the lane, stocked with " +
      "the matching records, departments, rooms and faculty. Everyone sees it.</p>" +
      "<h5>What is real here</h5><p class=\"fine\">Every record is a real arXiv entry — titles and identifiers gathered " +
      window.QC_SEEDED_ON + ", with links derived from the identifier rather than typed in. Abstracts live on arXiv and " +
      "open there. Faculty answer through Claude and may only recommend from the indexed shelf; they will not invent " +
      "an identifier.</p>" +
      "<h5>Who you are</h5><p class=\"fine\">" +
      (Net.canSignIn()
        ? "Your account carries your shelf, points and institutes to any device you sign in from."
        : "The village needs its database to let anyone in; check js/firebase-config.js.") +
      "</p>";
    var tb = $("#help-tour");
    if (tb) tb.addEventListener("click", function () { closePanel(); QVTour.start(); });
  }

  /* -------------------------------------------------------------- extras */
  var OBJECTIVES = [
    { id:"walk",    t:"Click the ground to walk somewhere", done:function () { return Object.keys(me.visited).length > 0; } },
    { id:"collect", t:"Collect anything with a number", done:function () { return me.shelf.length > 0; } },
    { id:"archive", t:"Find the Archive and open a record", done:function () { return !!me.visited.archive; } },
    { id:"ask",     t:"Ask a villager something", done:function () { return me.points >= 40; } },
    { id:"found",   t:"Found an institute of your own", done:function () { return institutes.some(function (i) { return i.by === (me.uid || me.id); }); } },
    { id:"all",     t:"Visit every place in the village", done:function () { return Object.keys(me.visited).length >= V.PLACES.length; } }
  ];
  function objective() {
    var next = OBJECTIVES.filter(function (o) { return !o.done(); })[0];
    var el = $("#objective");
    if (!next) { el.innerHTML = '<span class="onote">Where to next?</span><b>You have seen the whole village</b>'; return; }
    el.innerHTML = '<span class="onote">Where to next?</span><b>' + esc(next.t) + "</b>";
  }

  var toastT;
  function toast(html) {
    var el = $("#toast");
    el.innerHTML = html;
    el.classList.add("on");
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.remove("on"); }, 4200);
  }
  function updateBell() {
    var n = me.seen ? PAPERS.filter(function (p) { return p.key > me.seen; }).length : 0;
    var b = $("#newcount");
    b.textContent = n > 0 ? n : "";
    b.style.display = n > 0 ? "grid" : "none";
  }

  /* simple in-sheet prompt, so we never call window.prompt */
  function ask(title, placeholder, cb) {
    var el = $("#ask");
    el.hidden = false;
    $("#ask-title").textContent = title;
    $("#ask-input").value = placeholder || "";
    $("#ask-input").focus();
    el.dataset.open = "1";
    function close(val) {
      el.hidden = true; el.dataset.open = "";
      $("#ask-form").onsubmit = null;
      $("#ask-cancel").onclick = null;
      cb(val);
    }
    $("#ask-form").onsubmit = function (e) { e.preventDefault(); close($("#ask-input").value.trim()); };
    $("#ask-cancel").onclick = function () { close(null); };
  }

  /* ============================================================== wiring */
  function wireUI() {
    /* every button that names a panel opens it — the icon rail, the side
       rail, and the score pill, which is how you reach your own card */
    /* Sign out, where it can actually be found: in the rail, not at the
       bottom of the resident card. The account is what the village is keyed
       to now, so leaving it is a first-class thing to do. */
    var so = $("#signout-btn");
    if (so) so.addEventListener("click", function () {
      so.disabled = true;
      toast("Signing out…");
      if (window.QVSlides && QVSlides.dropMine) QVSlides.dropMine();
      Promise.resolve(Net.signOut()).catch(function () {})
        .then(function () { setTimeout(function () { location.reload(); }, 250); });
    });

    $$("button[data-panel]").forEach(function (b) {
      b.addEventListener("click", function () { togglePanel(b.dataset.panel); });
    });
    $("#sheet-close").addEventListener("click", closePanel);
    $("#sheet-scrim").addEventListener("click", closePanel);
    $("#chat-form").addEventListener("submit", function (e) { e.preventDefault(); sendChat(); });
    if ($("#chat-mode")) {
      $("#chat-mode").addEventListener("click", function () { setAnnouncing(!announcing); });
      setAnnouncing(false);
    }
    $("#chat-toggle").addEventListener("click", function () {
      setChatOpen($("#chat").classList.contains("min"));
    });
    if ($("#chat-open")) {
      $("#chat-open").addEventListener("click", function (e) {
        e.preventDefault();
        var opening = $("#chat").classList.contains("min");
        setChatOpen(opening, opening);
      });
    }
    setChatOpen(!$("#chat").classList.contains("min"));
    $("#btn-enter").addEventListener("click", function () {
      if (window.QVInteract && QVInteract.use()) return;
      if (nearPlace) enterPlace(nearPlace);
    });
    var sb = $("#sound-btn");
    if (sb) sb.addEventListener("click", function () {
      if (!window.QVAmbient) return;
      var on = QVAmbient.toggleSound();
      sb.classList.toggle("on", on);
      sb.title = on ? "Sound on" : "Sound off";
      toast(on ? "Ambient sound <b>on</b>" : "Ambient sound <b>off</b>");
    });
    $("#zoom-in").addEventListener("click", function () { camDist = Math.max(9, camDist - 7); });
    $("#zoom-out").addEventListener("click", function () { camDist = Math.min(110, camDist + 7); });
    $("#cam-mode").addEventListener("click", function () {
      camMode = camMode === "follow" ? "overhead" : "follow";
      $("#cam-mode").textContent = camMode === "follow" ? "Follow" : "Overhead";
    });
    $("#weather-btn").addEventListener("click", function () {
      var order = ["clear", "rain", "mist"];
      var i = (order.indexOf(V.state.weather) + 1) % order.length;
      V.state.weather = order[i];
      $("#weather-btn").title = "Weather: " + order[i];
      toast("Weather — <b>" + order[i] + "</b>");
    });
    $("#time-btn").addEventListener("click", function () {
      /* The sky normally runs on the visitor's own clock. This borrows it,
         steps through dawn, noon, dusk and night, and on the way round
         hands it back rather than leaving the village stuck at an hour
         that is not theirs. */
      var stops = [0.30, 0.50, 0.76, 0.90];
      var next = stops.filter(function (s) { return s > V.state.time + 0.01; })[0];
      if (next == null && !V.state.realTime) V.useRealTime();
      else V.holdTime(next == null ? stops[0] : next);
      toast("Time — <b>" + (V.state.realTime ? "your own clock" : V.phaseLabel()) + "</b>");
      updateHud();
    });
    $("#mini-wrap").addEventListener("click", function () { togglePanel("map"); });
  }

  /* ================================================================ boot */
  /* ================================================================ gate
     The village is walled. Nothing is built, nothing is fetched and nothing
     is shown until somebody signs in with an account, and an account means
     a password — the anonymous visitor pass the village used to hand out is
     gone, so yesterday's residents come back through the front door or not
     at all. */
  var gateMode = "in", gateBusy = false, entered = false;

  function gateSay(msg, ok) {
    var el = $("#g-err");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.classList.toggle("ok", !!ok);
  }
  function setGateMode(m) {
    gateMode = m;
    $("#gtab-in").classList.toggle("on", m === "in");
    $("#gtab-up").classList.toggle("on", m === "up");
    $("#g-name-row").hidden = m !== "up";
    $("#g-reset").hidden = m === "up";
    $("#g-pass").setAttribute("autocomplete", m === "up" ? "new-password" : "current-password");
    goLabel();
    gateSay("");
  }
  function goLabel() {
    $("#g-go").textContent = gateMode === "up" ? "Create account and walk in" : "Sign in";
  }

  function showGate(msg) {
    var g = $("#gate");
    if (!g) return;
    g.hidden = false;
    var l = $("#loading");
    if (l) l.classList.add("gone");
    if (msg) gateSay(msg);
    else if (Net.legacyRejected) {
      gateSay("Your old visitor pass no longer works — the village needs an account now.");
      Net.legacyRejected = false;
    }
    setTimeout(function () { var f = $("#g-email"); if (f && !f.value) f.focus(); }, 40);
  }
  function hideGate() { var g = $("#gate"); if (g) g.hidden = true; }

  /* No database means no accounts, and no accounts means nobody comes in. */
  function gateBlocked(msg) {
    var f = $("#gate-form");
    if (f) f.innerHTML = '<h1>Quantum Village</h1><p class="lede">' + esc(msg) + "</p>";
    showGate();
  }

  function wireGate() {
    var f = $("#gate-form");
    if (!f) return;
    $$(".gtab").forEach(function (t) {
      t.addEventListener("click", function () { setGateMode(t.dataset.mode); });
    });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      /* Still inside the gesture here. A browser holds sound back until the
         page has been interacted with, and this is the interaction — so open
         the audio now, while it still counts, rather than leaving a new
         arrival unable to hear anyone until they happen to click again. */
      if (window.QVVoice && QVVoice.unlock) { try { QVVoice.unlock(); } catch (err) {} }
      submitGate();
    });
    $("#g-reset").addEventListener("click", function () {
      var email = $("#g-email").value.trim();
      if (!email) return gateSay("Type your email above first, then ask for a reset.");
      Net.sendPasswordReset(email)
        .then(function () { gateSay("A reset link is on its way to " + email + ".", true); })
        .catch(function (e) { gateSay(Net.authMessage(e)); });
    });
    setGateMode("in");
  }

  function submitGate() {
    if (gateBusy) return;
    var email = $("#g-email").value.trim();
    var pass = $("#g-pass").value;
    var name = ($("#g-name").value || "").trim();
    if (!email) return gateSay("Enter your email address.");
    if (pass.length < 8) return gateSay("Passwords need at least eight characters.");
    if (gateMode === "up" && !name) return gateSay("Tell the village what to call you.");

    gateBusy = true;
    $("#g-go").disabled = true;
    $("#g-go").textContent = gateMode === "up" ? "Creating…" : "Signing in…";
    gateSay("");

    var mode = gateMode;
    var work = mode === "up" ? Net.createAccount(email, pass, name)
                             : Net.signInWithPassword(email, pass);
    work.then(function () {
      if (mode === "up" && name) { pendingName = name.slice(0, 22); }
      /* onAuth takes it from here and opens the village. */
    }).catch(function (e) {
      gateSay(Net.authMessage(e));
    }).then(function () {
      gateBusy = false;
      $("#g-go").disabled = false;
      goLabel();
    });
  }

  var pendingName = "";

  /* A different account on this browser is a different resident: the name,
     shelf and standing of whoever signed in last do not carry over. */
  function resetMe() {
    Object.keys(me).forEach(function (k) { delete me[k]; });
    Object.assign(me, {
      id: "v" + Math.random().toString(36).slice(2, 10), name: "", title: "", orcid: "",
      inst: "", country: "", look: V.randomLook(), shelf: [], points: 0, visited: {},
      seen: 0, joined: Date.now()
    });
    window.QVLocalId = me.id;
  }

  function enterVillage(u) {
    /* Anything saved against a different account — or against none at all,
       which is what a resident from before the wall looks like — is not this
       person's, so it goes rather than being inherited. */
    if (me.uid !== u.uid) resetMe();
    me.uid = u.uid;
    if (pendingName) { me.name = pendingName; pendingName = ""; }
    if (!me.name && u.name) me.name = u.name;
    saveMe();
    hideGate();

    if (entered) { publishResident(); renderAccount(); return; }
    entered = true;

    start();
    bindInput();
    bindExtraUi();
    wireUI();
    setScore();
    updateHud();
    objective();
    updateBell();
    wireNet();
    updateBackendPill();

    $("#loading").classList.add("gone");
    setTimeout(function () { var l = $("#loading"); if (l) l.remove(); }, 800);

    $("#country-list").innerHTML = COUNTRIES.map(function (c) {
      return '<option value="' + esc(c) + '"></option>';
    }).join("");

    /* A resident who signs in on a new machine should find themselves
       already here, so take their card back off the database first and only
       ask who they are if there is genuinely nothing to go on. */
    Net.docGet("residents/" + u.uid).catch(function () { return null; }).then(function (d) {
      if (d) {
        if (!me.name && d.name) me.name = d.name;
        if (!me.title && d.title) me.title = d.title;
        if (!me.inst && d.inst) me.inst = d.inst;
        if (!me.country && d.country) me.country = d.country;
        if (!me.orcid && d.orcid) me.orcid = d.orcid;
        if (d.look) {
          me.look = V.normalizeLook(d.look);
          reskin();
        }
        saveMe();
        updateHud();
      }
      publishResident();
      renderAccount();
      askWhoYouAre();
    });
  }

  /* The resident card, asked once, for somebody the village has not met. */
  function askWhoYouAre() {
    if (me.name) return;
    $("#welcome").hidden = false;
    $("#w-name").value = me.name || "";
    $("#w-title").innerHTML = '<option value="">—</option>' + TITLES.map(function (t) {
      return '<option value="' + t + '"' + (me.title === t ? " selected" : "") + ">" + t + "</option>";
    }).join("");
    $("#w-inst").value = me.inst || "";
    $("#w-country").value = me.country || "";
    $("#w-orcid").value = fmtOrcid(me.orcid);
    wireOrcidField($("#w-orcid"), $("#w-orcid-hint"));

    $("#w-swatches").innerHTML = V.SHIRT.map(function (c, i) {
      return '<button type="button" class="sw' + (me.look.shirt === i ? " on" : "") + '" data-i="' + i +
        '" style="background:#' + c.toString(16).padStart(6, "0") + '"></button>';
    }).join("");
    $("#w-swatches").addEventListener("click", function (e) {
      var b = e.target.closest(".sw"); if (!b) return;
      me.look.shirt = +b.dataset.i;
      $$("#w-swatches .sw").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on"); reskin();
    });

    /* Attire on the way in, so the first thing anyone sees of you is not a
       stranger in the default coat. Everything else is in the profile panel. */
    var wOut = $("#w-outfits");
    if (wOut) {
      wOut.innerHTML = V.OUTFITS.map(function (o, i) {
        return '<button type="button" class="lookchip' + ((me.look.outfit || 0) === i ? " on" : "") +
          '" data-i="' + i + '">' + esc(o.name) + "</button>";
      }).join("");
      wOut.addEventListener("click", function (e) {
        var b = e.target.closest(".lookchip"); if (!b) return;
        me.look.outfit = +b.dataset.i;
        $$(".lookchip", wOut).forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on"); reskin();
      });
    }
    $("#welcome-form").addEventListener("submit", function (e) {
      e.preventDefault();
      if (!applyIdentity({ name:$("#w-name"), title:$("#w-title"), orcid:$("#w-orcid"),
                           inst:$("#w-inst"), country:$("#w-country") }, $("#w-orcid-hint"))) return;
      $("#welcome").hidden = true;
      toast("Welcome to the village, <b>" + esc(displayName()) + "</b>. Click the ground to walk.");
    });
  }

  function boot() {
    if (!window.THREE) {
      $("#loading").innerHTML = "<div><h1>Quantum Village</h1><p>The 3D library could not load here.</p></div>";
      return;
    }
    wireGate();

    Net.init().then(function (r) {
      bootInfo = r || {};
      if (Net.backend() !== "firebase") {
        gateBlocked("The village could not reach its database, so there is nothing to sign in to. " +
                    "Check js/firebase-config.js and your connection, then reload.");
        return;
      }
      Net.onAuth(function (u) {
        if (u) return enterVillage(u);
        if (!entered) return showGate();
        entered = false;
        /* Signed out: back to the wall — unless an administrator has just
           barred this account, in which case admin.js is already showing
           the reason and reloading would throw it away. */
        if (window.QVAdmin && QVAdmin.isBarred && QVAdmin.isBarred()) return;
        location.reload();
      });
      /* Firebase reports the opening auth state only once it has been able to
         reach its servers. Behind a firewall, on a bad connection or during
         an outage that can be slow or never, and a visitor should not be left
         staring at a loading screen with no way in. Put the wall up anyway
         after a moment; a session that does come back simply opens it. */
      setTimeout(function () { if (!entered) showGate(); }, 1500);
    }).catch(function (e) {
      console.warn("[village] networking did not start:", e && e.message);
      gateBlocked("The village could not start its networking. Reload to try again.");
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 0);
  else window.addEventListener("DOMContentLoaded", boot);
})();
