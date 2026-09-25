/* Quantum Village — live activities.
 *
 * Somebody takes a blackboard, stands up to speak, or pins a poster: that is
 * an activity, and the rest of the village should hear about it as it starts
 * rather than stumble on it half an hour later.
 *
 * Two pieces of UI:
 *   - an announcement that slides in when something begins, carrying the
 *     topic and the place, with a button that takes you straight there;
 *   - a Live Activities panel listing everything running right now.
 *
 * The record itself lives under the organiser's uid in the Realtime Database
 * with an onDisconnect hook, so an activity ends when its organiser leaves
 * whether or not they remember to end it. See QVNet.startActivity.
 */
(function () {
  "use strict";

  var api = window.QVActivities = {};
  var V = window.QV;

  var hooks = { goTo: null, toast: null, isMe: null };
  var live = {};                 /* uid -> record */
  var announced = {};            /* uid+at -> true, so we announce once */
  var queue = [], showing = null, hideTimer = null;
  var mine = null;
  var listeners = [];
  var booted = false;

  var KINDS = {
    blackboard: { icon: "✎", label: "Blackboard discussion" },
    seminar:    { icon: "◉", label: "Seminar" },
    discussion: { icon: "◑", label: "Discussion" },
    lecture:    { icon: "▤", label: "Lecture" },
    poster:     { icon: "▦", label: "Poster presentation" },
    meeting:    { icon: "◇", label: "Meeting" }
  };
  api.KINDS = KINDS;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  api.init = function (h) {
    hooks = Object.assign(hooks, h || {});
    if (booted) return;
    booted = true;

    wireUi();

    if (window.QVNet && QVNet.watchActivities) {
      QVNet.watchActivities(function (map) {
        var fresh = [];
        Object.keys(map).forEach(function (u) {
          var key = u + "|" + map[u].at;
          if (!live[u] || announced[key] === undefined) {
            if (!announced[key]) { announced[key] = true; fresh.push(map[u]); }
          }
        });
        live = map;
        /* The first roster we receive is everything already running, which
           is not news — only announce what starts after we arrive. */
        if (api._seeded) fresh.forEach(announce);
        api._seeded = true;
        paint();
        listeners.forEach(function (fn) { try { fn(live); } catch (e) {} });
      });
    }
    window.addEventListener("beforeunload", function () { api.end(); });
  };

  api.onChange = function (fn) { listeners.push(fn); };
  api.all = function () { return live; };
  api.count = function () { return Object.keys(live).length; };

  /* ------------------------------------------------------------- start/end */
  /* kind, topic and a position. The place name is resolved here so that
     everybody reads the same wording for the same spot. */
  api.start = function (kind, topic, x, z, roomName) {
    var where = roomName || (V && V.placeAt ? (V.placeAt(x, z) || {}).name : "") || "The village";
    var rec = {
      kind: kind || "meeting",
      topic: String(topic || "").slice(0, 90),
      where: String(where).slice(0, 48),
      by: (hooks.getName && hooks.getName()) || "A resident",
      x: Math.round(x * 10) / 10,
      z: Math.round(z * 10) / 10
    };
    mine = rec;
    if (window.QVNet && QVNet.startActivity) QVNet.startActivity(rec);
    return rec;
  };

  api.end = function () {
    if (!mine) return;
    mine = null;
    if (window.QVNet && QVNet.endActivity) QVNet.endActivity();
  };

  api.isRunning = function () { return !!mine; };

  /* ------------------------------------------------------ the announcement */
  function announce(rec) {
    if (!rec) return;
    if (hooks.isMe && hooks.isMe(rec.uid)) return;
    queue.push(rec);
    if (!showing) next();
  }

  function next() {
    var el = document.getElementById("announce");
    if (!el) return;
    var rec = queue.shift();
    if (!rec) {
      showing = null;
      el.classList.remove("on");
      return;
    }
    showing = rec;
    var k = KINDS[rec.kind] || KINDS.meeting;
    el.innerHTML =
      '<div class="ann-mark" aria-hidden="true">' + k.icon + "</div>" +
      '<div class="ann-body">' +
        '<span class="ann-kind">' + esc(k.label) + " · starting now</span>" +
        "<b class=\"ann-title\">" + (rec.topic ? esc(rec.topic) : esc(k.label)) + "</b>" +
        '<span class="ann-where">' + esc(rec.where) + " · " + esc(rec.by) + "</span>" +
      "</div>" +
      '<div class="ann-acts">' +
        '<button type="button" class="btn small" data-go="1">Take me there</button>' +
        '<button type="button" class="btn small ghost" data-close="1">Later</button>' +
      "</div>";
    el.classList.add("on");

    el.querySelector("[data-go]").onclick = function () {
      if (hooks.goTo) hooks.goTo(rec.x, rec.z);
      dismiss();
    };
    el.querySelector("[data-close]").onclick = dismiss;

    clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, 11000);
  }

  function dismiss() {
    clearTimeout(hideTimer);
    var el = document.getElementById("announce");
    if (el) el.classList.remove("on");
    showing = null;
    /* let the panel finish sliding out before the next one arrives */
    setTimeout(next, 420);
  }

  /* ------------------------------------------------------------- the panel */
  function wireUi() {
    var btn = document.getElementById("live-btn");
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener("click", function () { api.openPanel(); });
    }
  }

  /* Repaint the count on the Live Activities button. */
  function paint() {
    var badge = document.getElementById("live-count");
    var n = Object.keys(live).length;
    if (badge) {
      badge.textContent = n > 0 ? n : "";
      badge.style.display = n > 0 ? "grid" : "none";
    }
    var btn = document.getElementById("live-btn");
    if (btn) btn.classList.toggle("has-live", n > 0);
    /* keep an open panel current */
    var host = document.getElementById("acts-list");
    if (host) host.innerHTML = rows();
    bindRows();
  }

  function rows() {
    var keys = Object.keys(live).sort(function (a, b) {
      return (live[b].at || 0) - (live[a].at || 0);
    });
    if (!keys.length) {
      return '<p class="fine">Nothing is running in the village at the moment. ' +
             "Take a blackboard, stand up in a seminar room or pin a poster, and " +
             "everybody will be told where to find you.</p>";
    }
    return '<ul class="acts">' + keys.map(function (u) {
      var r = live[u];
      var k = KINDS[r.kind] || KINDS.meeting;
      var mins = Math.max(0, Math.round((Date.now() - (r.at || Date.now())) / 60000));
      return '<li class="act-row" data-x="' + r.x + '" data-z="' + r.z + '">' +
        '<span class="act-mark">' + k.icon + "</span>" +
        '<span class="act-text">' +
          "<b>" + (r.topic ? esc(r.topic) : esc(k.label)) + "</b>" +
          '<span class="act-sub">' + esc(k.label) + " · " + esc(r.where) + "</span>" +
          '<span class="act-sub fine">' + esc(r.by) +
            (mins > 0 ? " · started " + mins + " min ago" : " · just started") + "</span>" +
        "</span>" +
        '<button type="button" class="btn small go">Go</button>' +
      "</li>";
    }).join("") + "</ul>";
  }

  function bindRows() {
    var host = document.getElementById("acts-list");
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll(".act-row .go"), function (b) {
      b.onclick = function () {
        var row = b.closest(".act-row");
        if (hooks.goTo) hooks.goTo(+row.dataset.x, +row.dataset.z);
        api.closePanel();
      };
    });
  }

  api.openPanel = function () {
    var el = document.getElementById("acts");
    if (!el) return;
    var host = document.getElementById("acts-list");
    if (host) host.innerHTML = rows();
    bindRows();
    el.classList.add("on");
    el.setAttribute("aria-hidden", "false");
  };

  api.closePanel = function () {
    var el = document.getElementById("acts");
    if (!el) return;
    el.classList.remove("on");
    el.setAttribute("aria-hidden", "true");
  };

  api.togglePanel = function () {
    var el = document.getElementById("acts");
    if (!el) return;
    if (el.classList.contains("on")) api.closePanel(); else api.openPanel();
  };
})();
