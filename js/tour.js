/* Quantum Village — the arrival tour.
 *
 * A first-time resident is set down on a green with nine hundred metres of
 * campus around them and no idea that the Grand Poster Hall exists. The tour
 * walks them through it: each stop moves them to a landmark, says what it is
 * and what they can do there, and hands control back at the end.
 *
 * It runs once. The flag lives in localStorage, and "Take the tour" in the
 * help panel starts it again on demand.
 */
(function () {
  "use strict";

  var api = window.QVTour = {};
  var LS = "qv.tour.v1";
  var hooks = { goTo: null, onStart: null, onEnd: null };
  var step = -1, running = false;

  /* Each stop names a place id where one exists, so the tour follows the
     world rather than a list of coordinates that will drift out of date. */
  var STOPS = [
    { place: "commons", title: "The Commons",
      body: "You are here. The green at the centre of the old village — everybody " +
            "passes through it. Click the ground anywhere to walk, drag to look round, " +
            "and press <b>E</b> whenever the prompt at the bottom offers you something." },
    { place: "archive", title: "The Archive",
      body: "Every paper in the village is shelved here, filed by topic. The same " +
            "corpus is behind the book icon in the top bar, so you can read an " +
            "abstract without walking back." },
    { place: "restaurant", title: "The Grand Refectory",
      body: "Food, a quiet table and the best arguments in the village. Join the " +
            "queue, order something, and you will find people to eat with." },
    { place: "barn", title: "The Lecture Barn",
      body: "Seminars and the journal club. Sit down with <b>E</b>, and press it " +
            "again to take the blackboard — your avatar walks up and everybody in " +
            "the room hears you." },
    { place: "library", title: "The Dirac Library, North Campus",
      body: "The campus proper starts north of the ring road: the University, the " +
            "lecture halls, the seminar and discussion rooms, and this library." },
    { place: "poster-hall-2", title: "The Grand Poster Hall",
      body: "Fifty boards across three aisles. Walk up to any of them and press " +
            "<b>E</b> to pin a poster of your own; the most liked one goes up on " +
            "the stand outside." },
    { place: "seminar-hall-a", title: "Seminar Hall Alpha",
      body: "Out past the residences, and its twin is out past the research park. " +
            "Fifty tiered seats, every one of them facing forty metres of blackboard. " +
            "Press <b>P</b> inside and you can put a PDF straight up on that slate \u2014 " +
            "turn a page and everybody in the hall turns it with you." },
    { place: "inst-particle", title: "The Research Park",
      body: "East of the village: the Institute for Particle Physics, the Detector " +
            "Hall, Quantum Optics and the Astrophysics Institute, with the storage " +
            "ring and the telescope behind them." },
    { place: "cafe-planck", title: "Café Planck & the west quarter",
      body: "Houses, the Fellows' Common Room and Noether Park with its pond and " +
            "bandstand. This is where people go when they are not working." },
    { place: "station", title: "Quantum Village Central",
      body: "Trains east and west, the bus interchange, and cycle and jeep stations — press " +
            "<b>E</b> at one to take a bicycle or an open jeep and ride the rest of the campus." }
  ];

  function place(id) {
    var list = (window.QV && QV.PLACES) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  api.seen = function () {
    try { return localStorage.getItem(LS) === "1"; } catch (e) { return false; }
  };
  api.markSeen = function () {
    try { localStorage.setItem(LS, "1"); } catch (e) {}
  };

  api.init = function (h) { hooks = Object.assign(hooks, h || {}); };

  /* Offer rather than impose: a card in the corner with two buttons. */
  api.offer = function () {
    var el = document.getElementById("tour");
    if (!el) return;
    el.innerHTML =
      '<div class="tour-card tour-offer">' +
        '<span class="eyebrow">First time here</span>' +
        "<h3>Would you like the tour?</h3>" +
        "<p>Nine stops, about a minute. It shows you the halls, the boards, the " +
        "poster rooms, the restaurant and the station, and puts you back where " +
        "you started.</p>" +
        '<div class="tour-acts">' +
          '<button type="button" class="btn" id="tour-yes">Show me round</button>' +
          '<button type="button" class="btn ghost" id="tour-no">I’ll explore</button>' +
        "</div>" +
      "</div>";
    el.classList.add("on");
    document.getElementById("tour-yes").onclick = function () { api.start(); };
    document.getElementById("tour-no").onclick = function () {
      api.markSeen();
      hide();
    };
  };

  api.start = function () {
    if (running) return;
    running = true;
    step = -1;
    api.markSeen();
    if (hooks.onStart) hooks.onStart();
    api.next();
  };

  api.next = function () {
    step++;
    /* skip any stop whose place this world does not have */
    while (step < STOPS.length && !place(STOPS[step].place)) step++;
    if (step >= STOPS.length) return api.finish();

    var stop = STOPS[step];
    var p = place(stop.place);
    if (hooks.goTo) hooks.goTo(p.x, p.z, true);
    paint(stop, step);
  };

  api.back = function () {
    step -= 2;
    if (step < -1) step = -1;
    api.next();
  };

  api.finish = function () {
    running = false;
    hide();
    var home = place("commons");
    if (home && hooks.goTo) hooks.goTo(home.x, home.z, true);
    if (hooks.onEnd) hooks.onEnd();
  };

  function paint(stop, i) {
    var el = document.getElementById("tour");
    if (!el) return;
    var n = STOPS.length;
    el.innerHTML =
      '<div class="tour-card">' +
        '<div class="tour-progress"><span style="width:' +
          Math.round(((i + 1) / n) * 100) + '%"></span></div>' +
        '<span class="eyebrow">Stop ' + (i + 1) + " of " + n + "</span>" +
        "<h3>" + stop.title + "</h3>" +
        "<p>" + stop.body + "</p>" +
        '<div class="tour-acts">' +
          (i > 0 ? '<button type="button" class="btn ghost small" id="tour-back">Back</button>' : "") +
          '<button type="button" class="btn small" id="tour-next">' +
            (i === n - 1 ? "Finish" : "Next") + "</button>" +
          '<button type="button" class="btn ghost small" id="tour-skip">Skip the tour</button>' +
        "</div>" +
      "</div>";
    el.classList.add("on");
    var nx = document.getElementById("tour-next");
    nx.onclick = function () { i === n - 1 ? api.finish() : api.next(); };
    var bk = document.getElementById("tour-back");
    if (bk) bk.onclick = function () { api.back(); };
    document.getElementById("tour-skip").onclick = function () { api.finish(); };
  }

  function hide() {
    var el = document.getElementById("tour");
    if (!el) return;
    el.classList.remove("on");
    setTimeout(function () { if (!running) el.innerHTML = ""; }, 400);
  }

  api.isRunning = function () { return running; };
})();
