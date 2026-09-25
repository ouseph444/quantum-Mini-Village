/* Quantum Village — administration.
 *
 * Who this is for
 * ---------------
 * The person who owns the Firebase project, and nobody else. There is
 * exactly one way to become one of those people: put your uid under
 * admins/ in the Realtime Database, from the Firebase console or from a
 * server holding a service-account key. Both sets of security rules make
 * that branch unwritable from a browser, so this file cannot promote
 * anybody — including whoever is reading it in the network tab.
 *
 * What a block actually is
 * ------------------------
 * An entry under blocked/<uid>. Every other rule in database.rules.json and
 * in firestore.rules refuses a request whose auth.uid appears there, so a
 * blocked resident may hold a perfectly valid token, may open the page, may
 * even edit this file in their own browser, and will not be given one byte
 * of the village nor be allowed to write one. Hiding the button below is
 * politeness, not security; the rules are the security.
 *
 * And what it is not, on its own
 * ------------------------------
 * The Firebase Authentication account still exists, and disabling or
 * deleting it needs the Admin SDK, which must never be in a browser. That
 * is what functions/index.js is for: a callable that checks the caller
 * against admins/ on the server and then disables or deletes the account
 * outright. If it has not been deployed, everything here still works and
 * the database block is still absolute — the account simply keeps existing.
 *
 * No credential, service account or privileged key appears in this file or
 * anywhere else the browser can see.
 */
(function () {
  "use strict";

  var api = {};
  var hooks = {};
  var Net = null;

  var amAdmin = false;
  var blocked = {};                 /* uid -> record, admins only */
  var residents = {};               /* uid -> what we know about them */
  var unsub = [];
  var blockedWatch = null;
  var panelOpen = false;
  var barred = null;                /* our own block record, if any */
  var compReqs = {};                /* pending poster competition requests, admins only */
  var hallComps = {};               /* what each poster hall is running */
  var compWatch = [];
  var reports = {};                 /* id -> report, admins only */
  var allCompReqs = {};             /* every competition request, for the filter */
  var bookings = {};                /* every hall booking, admins only */
  var notices = {};                 /* the Notice Board */
  var eventWatch = [];
  var editing = null;               /* the notice being edited, if any */
  var BOOK_STATUS = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };
  var reportWatch = null;
  var tab = "residents";
  var REPORT_TYPES = {
    abuse: "Abuse / inappropriate behaviour", inappropriate_content: "Inappropriate content",
    technical_problem: "Technical problem", bug: "Bug", voice_chat: "Voice chat issue",
    text_chat: "Text chat issue", login: "Login / authentication issue",
    ui_problem: "Display / UI problem", other: "Other feedback"
  };
  var STATUS_LABEL = { "new": "New", reviewing: "Reviewing", resolved: "Resolved", dismissed: "Dismissed" };
  var HALL_NAMES = { "poster-hall": "The Poster Hall", "poster-hall-2": "The Grand Poster Hall",
                     "seminar-hall-a": "Seminar Hall Alpha", "seminar-hall-b": "Seminar Hall Beta" };

  function net() { return window.QVNet; }
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  api.isAdmin = function () { return amAdmin; };
  api.isBarred = function () { return !!barred; };

  /* ---------------------------------------------------------------- init */
  api.init = function (h) {
    hooks = h || {};
    Net = net();
    if (!Net || Net.backend() !== "firebase") return;

    /* Am I an administrator? Watched rather than read once, so revoking it
       takes effect without a reload. */
    unsub.push(Net.watchAdmin(function (v) {
      if (v === amAdmin) return;
      amAdmin = v;
      if (window.QVEvents && QVEvents.setAdmin) QVEvents.setAdmin(v);
      paintButton();
      if (!amAdmin) {
        stopWatchingBlocked();
        stopWatchingComps();
        stopWatchingReports();
        stopWatchingEvents();
        if (panelOpen) api.close();
      } else {
        startWatchingBlocked();
        startWatchingComps();
        startWatchingReports();
        startWatchingEvents();
      }
    }));

    /* Am I blocked? Also watched: an administrator who bars somebody in the
       middle of a session should not have to wait for them to reload, and
       the rules have already stopped serving them anything by then, so the
       honest thing is to say so rather than let the village quietly freeze. */
    unsub.push(Net.watchMyBlock(function (rec) {
      if (!rec === !barred) return;
      barred = rec || null;
      if (barred) showWall(barred);
    }));

    /* Who is in the village, for the list. Presence is the live half;
       residents/ is everyone who has ever set up a profile. */
    Net.onPeers(function (list) {
      var changed = false;
      (list || []).forEach(function (p) {
        var r = residents[p.key] || (residents[p.key] = { uid: p.key });
        var pr = p.presence || {};
        if (r.name !== pr.n) { r.name = pr.n || r.name; changed = true; }
        r.inst = pr.af || r.inst;
        r.country = pr.co || r.country;
        if (!r.here) changed = true;
        r.here = true;
        r.seen = Date.now();
      });
      var live = {};
      (list || []).forEach(function (p) { live[p.key] = 1; });
      Object.keys(residents).forEach(function (u) {
        if (residents[u].here && !live[u]) { residents[u].here = false; changed = true; }
      });
      if (changed && panelOpen) render();
    });

    var closeBtn = el("admin-close");
    if (closeBtn) closeBtn.addEventListener("click", function () { api.close(); });
    var scrim = el("admin");
    if (scrim) {
      scrim.addEventListener("click", function (e) { if (e.target === scrim) api.close(); });
    }
    var btn = el("admin-btn");
    if (btn) btn.addEventListener("click", function (e) { e.preventDefault(); api.toggle(); });
    Array.prototype.forEach.call(document.querySelectorAll("#admin [data-tab]"), function (b) {
      b.addEventListener("click", function (e) { e.preventDefault(); showTab(b.dataset.tab); });
    });

    paintButton();
  };

  api.dispose = function () {
    unsub.forEach(function (f) { try { f(); } catch (e) {} });
    unsub = [];
    stopWatchingBlocked();
    stopWatchingComps();
    stopWatchingReports();
    stopWatchingEvents();
  };

  /* ------------------------------------------------------------ reports */
  /* Watched for as long as this account is an administrator, so a new
     report is announced wherever they are. The rules refuse this read to
     everybody else. */
  function startWatchingReports() {
    if (reportWatch || !Net || !Net.watchReports) return;
    var first = true;
    reportWatch = Net.watchReports(function (map) {
      map = map || {};
      var fresh = Object.keys(map).filter(function (id) { return !reports[id] && map[id].status === "new"; });
      reports = map;
      if (!first && fresh.length && hooks.toast) {
        var r = reports[fresh[fresh.length - 1]];
        hooks.toast("\u2691 New report: <b>" + esc(REPORT_TYPES[r.reportType] || r.reportType) + "</b> from " +
                    esc(r.userName) + ". Open Administration → Reports.");
      }
      first = false;
      paintButton();
      if (panelOpen) renderReports();
    });
  }
  function stopWatchingReports() {
    if (reportWatch) { try { reportWatch(); } catch (e) {} }
    reportWatch = null;
    reports = {};
  }
  function newReportCount() {
    return Object.keys(reports).filter(function (id) { return reports[id].status === "new"; }).length;
  }

  function renderReports() {
    var host = el("admin-report-list"), sel = el("admin-report-filter");
    if (!host) return;
    var want = sel ? sel.value : "open";
    var ids = Object.keys(reports).filter(function (id) {
      var st = reports[id].status || "new";
      if (want === "all") return true;
      if (want === "open") return st === "new" || st === "reviewing";
      return st === want;
    }).sort(function (a, b) { return (reports[b].createdAt || 0) - (reports[a].createdAt || 0); });
    if (!ids.length) {
      host.innerHTML = '<li class="adm-empty fine">' +
        (Object.keys(reports).length ? "Nothing here with that status." : "No reports have been filed.") + "</li>";
    } else {
      host.innerHTML = ids.map(function (id) {
        var r = reports[id], st = r.status || "new";
        var acts = [["reviewing", "Mark as Reviewing"], ["resolved", "Mark as Resolved"],
                    ["dismissed", "Dismiss"], ["new", "Reopen"]].filter(function (a) {
          return a[0] !== st && !(a[0] === "new" && st === "reviewing");
        });
        return '<li class="adm-report st-' + esc(st) + '" data-rep="' + esc(id) + '">' +
          '<div class="rep-top"><b class="rep-id">REPORT #' + esc(String(id).slice(-6).toUpperCase()) + "</b>" +
            '<span class="rep-status">' + esc(STATUS_LABEL[st] || st) + "</span></div>" +
          '<dl class="rep-meta">' +
            "<dt>Type</dt><dd>" + esc(REPORT_TYPES[r.reportType] || r.reportType) + "</dd>" +
            "<dt>User</dt><dd>" + esc(r.userName) + ' <span class="rep-uid">' + esc(r.userId) + "</span></dd>" +
            "<dt>Location</dt><dd>" + esc(r.location || "—") + "</dd>" +
            (r.subject ? "<dt>About</dt><dd>" + esc(r.subject) + "</dd>" : "") +
            "<dt>Submitted</dt><dd>" + esc(when(r.createdAt)) + "</dd>" +
            (r.userAgent ? "<dt>Device</dt><dd class=\"rep-ua\">" + esc(r.userAgent) +
              (r.viewport ? " · " + esc(r.viewport) : "") + "</dd>" : "") +
          "</dl>" +
          /* the whole message, as text: escaped, never interpreted */
          '<div class="rep-msg">' + esc(r.message) + "</div>" +
          '<div class="rep-acts">' + acts.map(function (a) {
            return '<button class="btn small' + (a[0] === "dismissed" ? " ghost" : "") +
                   '" type="button" data-rstatus="' + a[0] + '">' + a[1] + "</button>";
          }).join("") +
          '<button class="btn small ghost danger" type="button" data-rdelete="1">Delete</button></div>' +
          "</li>";
      }).join("");
    }
    if (!host._wired) {
      host._wired = true;
      host.addEventListener("click", onReportClick);
      if (sel) sel.addEventListener("change", renderReports);
    }
  }

  function onReportClick(e) {
    var btn = e.target.closest ? e.target.closest("button[data-rstatus],button[data-rdelete]") : null;
    if (!btn || btn.disabled) return;
    var row = btn.closest(".adm-report");
    var id = row && row.dataset.rep;
    if (!id || !reports[id]) return;
    e.preventDefault();
    var label = "report #" + String(id).slice(-6).toUpperCase();
    if (btn.dataset.rdelete) {
      if (!window.confirm("Delete " + label + " permanently?\n\nThis cannot be undone. " +
                          "Resolving or dismissing it keeps the record.")) return;
      return run(btn, Net.deleteReport(id), "Deleted " + esc(label) + ".");
    }
    var st = btn.dataset.rstatus;
    return run(btn, Net.setReportStatus(id, st), esc(label) + " marked " + esc(STATUS_LABEL[st]).toLowerCase() + ".");
  }

  /* ---------------------------------------------- bookings and notices */
  function startWatchingEvents() {
    if (eventWatch.length || !Net || !Net.watchAllBookings) return;
    var first = true;
    eventWatch.push(Net.watchAllBookings(function (map) {
      map = map || {};
      var fresh = Object.keys(map).filter(function (id) { return !bookings[id] && map[id].status === "pending"; });
      bookings = map;
      if (!first && fresh.length && hooks.toast) {
        var b = bookings[fresh[fresh.length - 1]];
        hooks.toast("\uD83D\uDCC5 New hall booking request: <b>" + esc(b.topic) + "</b> in " +
                    esc(HALL_NAMES[b.hallId] || b.hallId) + ". Open Administration → Bookings.");
      }
      first = false;
      paintButton();
      if (panelOpen) renderBookings();
    }));
    eventWatch.push(Net.watchNotices(function (map) {
      notices = map || {};
      if (panelOpen) { if (!editing) renderNoticesAdmin(); renderBookings(); }
    }));
    eventWatch.push(Net.watchAllCompetitionRequests(function (map) {
      allCompReqs = map || {};
      if (panelOpen) renderComps();
    }));
  }
  function stopWatchingEvents() {
    eventWatch.forEach(function (f) { try { f(); } catch (e) {} });
    eventWatch = [];
    bookings = {}; notices = {}; allCompReqs = {};
  }
  function pendingBookingCount() {
    return Object.keys(bookings).filter(function (id) { return bookings[id].status === "pending"; }).length;
  }
  function span(a, b) {
    var sameDay = new Date(a).toDateString() === new Date(b).toDateString();
    return fmtDay(a) + ", " + fmtClock(a) + " – " + (sameDay ? "" : fmtDay(b) + ", ") + fmtClock(b);
  }
  function fmtDay(ms) {
    return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  function fmtClock(ms) { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function nowS() { return Net.serverNow ? Net.serverNow() : Date.now(); }
  /* Approved bookings that already hold part of this one's time, and other
     pending requests that want part of it. */
  function clashes(id) {
    var b = bookings[id], hard = [], soft = [];
    Object.keys(bookings).forEach(function (k) {
      var o = bookings[k];
      if (k === id || !o || o.hallId !== b.hallId || !(o.startAt < b.endAt && o.endAt > b.startAt)) return;
      if (o.status === "approved") hard.push(o);
      else if (o.status === "pending") soft.push(o);
    });
    return { hard: hard, soft: soft };
  }

  function renderBookings() {
    var host = el("admin-booking-list"), sel = el("admin-booking-filter");
    if (!host) return;
    var want = sel ? sel.value : "pending";
    var now = nowS();
    var ids = Object.keys(bookings).filter(function (id) {
      return want === "all" || bookings[id].status === want;
    }).sort(function (a, b) {
      return want === "pending" || want === "approved"
        ? bookings[a].startAt - bookings[b].startAt : (bookings[b].createdAt || 0) - (bookings[a].createdAt || 0);
    });
    if (!ids.length) {
      host.innerHTML = '<li class="adm-empty fine">' +
        (want === "pending" ? "No booking requests are waiting." : "Nothing here with that status.") + "</li>";
    } else {
      host.innerHTML = ids.map(function (id) {
        var b = bookings[id], st = b.status, c = st === "pending" ? clashes(id) : { hard: [], soft: [] };
        var past = b.startAt <= now;
        var acts = "";
        if (st === "pending") {
          acts = '<button class="btn small" type="button" data-bact="approve"' +
                 (c.hard.length || past ? " disabled" : "") + ">Approve</button>" +
                 '<button class="btn small ghost danger" type="button" data-bact="reject">Reject</button>';
        } else if (st === "approved" && b.endAt > now) {
          acts = '<button class="btn small ghost danger" type="button" data-bact="cancel">Cancel event</button>';
        }
        return '<li class="adm-report adm-booking st-' + esc(st) + '" data-bk="' + esc(id) + '">' +
          '<div class="rep-top"><b class="rep-id">' + esc(HALL_NAMES[b.hallId] || b.hallId) + "</b>" +
            '<span class="rep-status">' + esc(BOOK_STATUS[st] || st) + "</span></div>" +
          '<h4 class="bk-topic">' + esc(b.topic) + "</h4>" +
          '<dl class="rep-meta">' +
            "<dt>Type</dt><dd>" + esc((Net.EVENT_TYPES || {})[b.eventType] || b.eventType) + "</dd>" +
            "<dt>When</dt><dd>" + esc(span(b.startAt, b.endAt)) +
              (b.tz ? ' <span class="rep-uid">asked as ' + esc(b.date + " " + b.startTime + "–" + b.endTime + " " + b.tz) + "</span>" : "") + "</dd>" +
            "<dt>Organiser</dt><dd>" + esc(b.name) + "</dd>" +
            "<dt>Institution</dt><dd>" + esc(b.institution) + "</dd>" +
            "<dt>Position</dt><dd>" + esc(b.position) + "</dd>" +
            "<dt>Account</dt><dd><span class=\"rep-uid\">" + esc(b.userId) + "</span></dd>" +
            "<dt>Requested</dt><dd>" + esc(when(b.createdAt)) + "</dd>" +
            (b.approvedAt ? "<dt>Approved</dt><dd>" + esc(when(b.approvedAt)) + "</dd>" : "") +
            (st === "rejected" && b.decidedAt ? "<dt>Rejected</dt><dd>" + esc(when(b.decidedAt)) + "</dd>" : "") +
            (b.cancelledAt ? "<dt>Cancelled</dt><dd>" + esc(when(b.cancelledAt)) + "</dd>" : "") +
          "</dl>" +
          '<div class="rep-msg">' + esc(b.abstract) + "</div>" +
          (b.extra ? '<div class="rep-msg bk-extra"><b>Additional information</b>\n' + esc(b.extra) + "</div>" : "") +
          (c.hard.length ? '<p class="adm-why">Clashes with an approved booking: ' + c.hard.map(function (o) {
              return "\u201C" + esc(o.topic) + "\u201D " + esc(fmtClock(o.startAt) + "–" + fmtClock(o.endAt));
            }).join(", ") + ". It cannot be approved unless that one is cancelled.</p>" : "") +
          (c.soft.length ? '<p class="adm-warn">Also requested for part of this time: ' + c.soft.map(function (o) {
              return "\u201C" + esc(o.topic) + "\u201D by " + esc(o.name);
            }).join(", ") + ". Only one can be approved.</p>" : "") +
          (st === "pending" && past ? '<p class="adm-why">This time has already passed.</p>' : "") +
          (acts ? '<div class="rep-acts">' + acts + "</div>" : "") +
          "</li>";
      }).join("");
    }
    if (!host._wired) {
      host._wired = true;
      host.addEventListener("click", onBookingClick);
      if (sel) sel.addEventListener("change", renderBookings);
    }
  }

  function onBookingClick(e) {
    var btn = e.target.closest ? e.target.closest("button[data-bact]") : null;
    if (!btn || btn.disabled) return;
    var row = btn.closest(".adm-booking"), id = row && row.dataset.bk, b = id && bookings[id];
    if (!b) return;
    e.preventDefault();
    var hall = HALL_NAMES[b.hallId] || b.hallId, what = "\"" + b.topic + "\"";
    var act = btn.dataset.bact;
    if (act === "approve") {
      if (!window.confirm("Approve " + what + " in " + hall + ", " + span(b.startAt, b.endAt) +
                          "?\n\nIt goes on the Village Notice Board straight away.")) return;
      return run(btn, Net.approveHallBooking(id, b), "Approved " + esc(what) + ". It is on the Notice Board.");
    }
    if (act === "reject") {
      if (!window.confirm("Reject " + what + "?")) return;
      return run(btn, Net.rejectHallBooking(id), "Rejected " + esc(what) + ".");
    }
    if (act === "cancel") {
      if (!window.confirm("Cancel " + what + "?\n\nThe notice is marked cancelled and the hall is free again for that time.")) return;
      return run(btn, Net.cancelHallBooking(id, b), "Cancelled " + esc(what) + ". The hall is free for that time.");
    }
  }

  /* The notice as a form. Its time and hall stay as they are: the hall's
     quarter hours were taken for exactly that time. */
  function noticeEditor(k, n) {
    var types = Net.EVENT_TYPES || {};
    function input(key, label, max) {
      return "<label>" + label + '<input class="field" data-nf="' + key + '" maxlength="' + max +
             '" value="' + esc(n[key] || "") + '"></label>';
    }
    return '<li class="adm-report st-new" data-notice="' + esc(k) + '">' +
      '<div class="rep-top"><b class="rep-id">Editing notice</b>' +
        '<span class="rep-status">' + esc(span(n.startAt, noticeEndA(n))) + "</span></div>" +
      '<div class="nb-edit">' +
        input("topic", "Title / topic", 160) +
        '<div class="nb-edit-row">' +
          '<label>Type<select class="field" data-nf="eventType">' + Object.keys(types).map(function (t) {
            return '<option value="' + esc(t) + '"' + (t === n.eventType ? " selected" : "") + ">" + esc(types[t]) + "</option>";
          }).join("") + "</select></label>" +
          input("hallName", "Venue name", 60) +
        "</div>" +
        '<div class="nb-edit-row">' +
          input("name", "Presenter", 80) + input("institution", "Institution", 120) + input("position", "Position", 80) +
        "</div>" +
        '<label>Abstract<textarea class="field" data-nf="abstract" rows="6" maxlength="1500">' +
          esc(n.abstract || "") + "</textarea></label>" +
      "</div>" +
      '<div class="rep-acts">' +
        '<button class="btn small" type="button" data-nact="edit-save">Save</button>' +
        '<button class="btn small ghost" type="button" data-nact="edit-cancel">Cancel</button>' +
      "</div></li>";
  }

  function noticeEndA(n) { return typeof n.endAt === "number" ? n.endAt : (n.startAt || 0) + 86400000; }
  /* Everything on the Village Notice Board, as the village sees it: the
     notices for approved bookings and competitions, and the poster sessions
     residents register for (js/events.js), one list in date order. */
  function noticeGroup(n, now) {
    var end = noticeEndA(n);
    return n.status === "cancelled" ? "cancelled" : (n.status === "archived" || end <= now) ? "archived"
      : n.startAt <= now ? "now" : "upcoming";
  }
  var GROUP_LABEL = { now: "On now", upcoming: "Upcoming", archived: "Archived", cancelled: "Cancelled" };
  function renderNoticesAdmin() {
    var host = el("admin-notice-list"), sel = el("admin-notice-filter");
    if (!host) return;
    var want = sel ? sel.value : "current", now = nowS();
    var E = window.QVEvents && QVEvents.live && QVEvents.live() ? QVEvents : null;
    var items = Object.keys(notices).map(function (k) {
      return { kind: "notice", id: k, startAt: notices[k].startAt || 0, group: noticeGroup(notices[k], now) };
    });
    if (E) Object.keys(E.events()).forEach(function (eid) {
      var info = E.boardInfo(eid);
      if (info) items.push({ kind: "poster", id: eid, startAt: info.ev.startAt || 0, group: info.group, info: info });
    });
    var shown = items.filter(function (it) {
      if (want === "all") return true;
      if (want === "current") return it.group === "now" || it.group === "upcoming";
      if (want === "active") return it.group === "now";
      return it.group === want;
    }).sort(function (a, b) {
      return want === "archived" || want === "all" || want === "cancelled" ? b.startAt - a.startAt : a.startAt - b.startAt;
    });
    var counts = { now: 0, upcoming: 0, archived: 0, cancelled: 0 };
    items.forEach(function (it) { counts[it.group]++; });
    var total = Object.keys(notices).length;
    var head = '<li class="adm-wipe"><span class="fine">' + items.length + " event" + (items.length === 1 ? "" : "s") +
      " on the board: " + counts.now + " on now, " + counts.upcoming + " upcoming, " + counts.archived + " archived" +
      (counts.cancelled ? ", " + counts.cancelled + " cancelled" : "") + ".</span>" +
      (total ? '<button class="btn small ghost danger" type="button" data-nact="wipe" title="Bookings and competitions; ' +
        'poster sessions are managed in Poster events">Clear bookings &amp; competitions</button>' : "") + "</li>";
    if (!items.length) {
      host.innerHTML = '<li class="adm-empty fine">Nothing is on the Notice Board yet.</li>';
    } else if (!shown.length) {
      host.innerHTML = head + '<li class="adm-empty fine">' + ({ current: "Nothing is on now or coming up.",
        active: "Nothing is happening right now.", upcoming: "No upcoming events on the board." }[want] || "Nothing here.") +
        (want !== "all" ? ' Choose <b>All</b> above to see every event.' : "") + "</li>";
    } else {
      host.innerHTML = head + shown.map(function (it) {
        return it.kind === "poster" ? posterNoticeRow(it) : noticeRow(it.id, now);
      }).join("");
    }
    if (!host._wired) {
      host._wired = true;
      host.addEventListener("click", onNoticeClick);
      if (sel) sel.addEventListener("change", renderNoticesAdmin);
    }
  }
  function noticeRow(k, now) {
    var n = notices[k], end = noticeEndA(n), over = end <= now, g = noticeGroup(n, now);
    var acts = "";
    if (n.status === "active" && !over) {
      acts = '<button class="btn small ghost" type="button" data-nact="archived">Take off the board</button>' +
        (n.bookingId ? '<button class="btn small ghost danger" type="button" data-nact="cancel">Cancel event</button>' : "");
    } else if (n.status === "archived" && !over) {
      acts = '<button class="btn small ghost" type="button" data-nact="active">Put back on the board</button>';
    }
    acts = '<button class="btn small" type="button" data-nact="edit">Edit</button>' + acts +
      '<button class="btn small ghost danger" type="button" data-nact="delete">Delete</button>';
    if (editing === k) return noticeEditor(k, n);
    return '<li class="adm-report st-' + (g === "now" || g === "upcoming" ? "new" : "resolved") +
      '" data-notice="' + esc(k) + '">' +
      '<div class="rep-top"><b class="rep-id">' + esc((Net.EVENT_TYPES || {})[n.eventType] || n.eventType) + "</b>" +
        '<span class="rep-status">' + esc(GROUP_LABEL[g]) + "</span></div>" +
      '<h4 class="bk-topic">' + esc(n.topic) + "</h4>" +
      '<dl class="rep-meta">' +
        "<dt>When</dt><dd>" + esc(span(n.startAt, end)) + "</dd>" +
        "<dt>Where</dt><dd>" + esc(n.hallName || HALL_NAMES[n.hallId] || n.hallId) + "</dd>" +
        "<dt>Presenter</dt><dd>" + esc([n.name, n.institution, n.position].filter(Boolean).join(" · ")) + "</dd>" +
      "</dl>" +
      (n.abstract ? '<div class="rep-msg">' + esc(n.abstract) + "</div>" : "") +
      '<div class="rep-acts">' + acts + "</div></li>";
  }
  function posterNoticeRow(it) {
    var i = it.info, ev = i.ev, g = it.group;
    var acts = '<button class="btn small" type="button" data-peact="manage">Participants</button>' +
      '<button class="btn small ghost" type="button" data-peact="edit">Edit</button>';
    if (g === "now" || g === "upcoming") {
      acts += ev.status === "open" ? '<button class="btn small ghost" type="button" data-peact="close">Close registration</button>'
        : ev.status === "closed" ? '<button class="btn small ghost" type="button" data-peact="open">Open registration</button>' : "";
      acts += '<button class="btn small ghost" type="button" data-peact="archived">Take off the board</button>';
    } else if (ev.status === "archived" && ev.endAt > nowS()) {
      acts += '<button class="btn small ghost" type="button" data-peact="closed">Put back on the board</button>';
    }
    acts += '<button class="btn small ghost danger" type="button" data-peact="delete">Delete</button>';
    return '<li class="adm-report st-' + (g === "now" || g === "upcoming" ? "new" : "resolved") + '" data-pe-eid="' + esc(it.id) + '">' +
      '<div class="rep-top"><b class="rep-id">Poster session</b>' +
        '<span class="rep-status">' + esc(GROUP_LABEL[g]) + "</span></div>" +
      '<h4 class="bk-topic">' + esc(ev.title) + "</h4>" +
      '<dl class="rep-meta">' +
        "<dt>When</dt><dd>" + esc(i.when) + "</dd>" +
        "<dt>Where</dt><dd>" + esc(i.halls || "—") + (ev.venue ? "<br>" + esc(ev.venue) : "") + "</dd>" +
        (ev.orgName ? "<dt>Organiser</dt><dd>" + esc([ev.orgName, ev.orgInst, ev.orgPos].filter(Boolean).join(" · ")) + "</dd>" : "") +
        "<dt>Registration</dt><dd>" + esc(i.reg) + " · " + i.registered + " registered" + (i.deadline ? " · closes " + esc(i.deadline) : "") + "</dd>" +
      "</dl>" +
      (ev.description ? '<div class="rep-msg">' + esc(ev.description) + "</div>" : "") +
      '<div class="rep-acts">' + acts + "</div></li>";
  }
  /* A poster session's buttons in the Notice Board tab. */
  function onPosterNoticeClick(btn) {
    var row = btn.closest("[data-pe-eid]"), eid = row && row.dataset.peEid, E = window.QVEvents;
    var ev = E && eid && E.events()[eid];
    if (!ev) return;
    var act = btn.dataset.peact;
    if (act === "manage" || act === "edit") { E.adminGoto(eid, act); showTab("events"); return; }
    if (act === "open" || act === "close") {
      return run(btn, Net.setPosterEventStatus(eid, act === "open" ? "open" : "closed"),
                 act === "open" ? "Registration is open." : "Registration is closed.");
    }
    if (act === "archived") {
      if (!window.confirm("Take \"" + ev.title + "\" off the Notice Board?\n\nIts registrations are kept; you can put it back.")) return;
      return run(btn, Net.setPosterEventStatus(eid, "archived"), "Taken off the board.");
    }
    if (act === "closed") return run(btn, Net.setPosterEventStatus(eid, "closed"), "Back on the board, with registration closed.");
    if (act === "delete") {
      if (!window.confirm("Delete \"" + ev.title + "\"?\n\nEvery registration, poster number and uploaded poster for it is " +
                          "removed for good.")) return;
      if (window.prompt("Type DELETE to confirm.", "") !== "DELETE") return;
      return run(btn, Net.deletePosterEvent(eid), "Deleted \"" + esc(ev.title) + "\".");
    }
  }
  function onNoticeClick(e) {
    var pb = e.target.closest ? e.target.closest("button[data-peact]") : null;
    if (pb && !pb.disabled) { e.preventDefault(); onPosterNoticeClick(pb); return; }
    var btn = e.target.closest ? e.target.closest("button[data-nact]") : null;
    if (!btn || btn.disabled) return;
    if (btn.dataset.nact === "wipe") {
      e.preventDefault();
      var total = Object.keys(notices).length;
      if (!window.confirm("Clear the whole Notice Board?\n\nAll " + total + " notices are deleted for good. Bookings " +
                          "that have not happened yet are cancelled and their halls freed, and any running poster " +
                          "competition is ended. This cannot be undone.")) return;
      if (window.prompt("Type CLEAR to confirm.", "") !== "CLEAR") return;
      return run(btn, Net.wipeNotices().then(function (r) {
        return r.failed ? "Cleared " + r.removed + " notices; " + r.failed + " could not be removed."
                        : "The Notice Board is clear (" + r.removed + " notices removed).";
      }), "The Notice Board is clear.");
    }
    var row = btn.closest("[data-notice]"), k = row && row.dataset.notice, n = k && notices[k];
    if (!n) return;
    e.preventDefault();
    var act = btn.dataset.nact;
    if (act === "edit") { editing = k; renderNoticesAdmin(); return; }
    if (act === "edit-cancel") { editing = null; renderNoticesAdmin(); return; }
    if (act === "edit-save") {
      var f = {};
      Array.prototype.forEach.call(row.querySelectorAll("[data-nf]"), function (i) { f[i.dataset.nf] = i.value.trim(); });
      if (!f.topic) return hooks.toast && hooks.toast("The title cannot be empty.");
      if (!f.name) return hooks.toast && hooks.toast("The presenter's name cannot be empty.");
      return run(btn, Net.updateNotice(k, f).then(function () {
        editing = null;
        renderNoticesAdmin();
        return "Saved. The Notice Board shows the new wording.";
      }), "Saved.");
    }
    if (act === "delete") {
      var future = n.status === "active" && noticeEndA(n) > nowS();
      if (!window.confirm("Delete \"" + n.topic + "\" from the Notice Board for good?" +
          (future ? (n.bookingId ? "\n\nThe booking is cancelled and the hall is free again for that time."
                                 : "\n\nThe competition is ended and its posters come down.") : ""))) return;
      return run(btn, Net.deleteNotice(k), "Deleted \"" + esc(n.topic) + "\".");
    }
    if (act === "cancel") {
      var b = bookings[n.bookingId];
      if (!b) return;
      if (!window.confirm("Cancel \"" + n.topic + "\"?\n\nThe notice is marked cancelled and the hall is free again.")) return;
      return run(btn, Net.cancelHallBooking(n.bookingId, b), "Cancelled.");
    }
    return run(btn, Net.setNoticeStatus(k, act), act === "archived" ? "Taken off the board." : "Back on the board.");
  }

  /* ---------------------------------------------------------------- tabs */
  function showTab(name) {
    tab = name;
    var card = el("admin");
    if (!card) return;
    Array.prototype.forEach.call(card.querySelectorAll("[data-tab]"), function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    Array.prototype.forEach.call(card.querySelectorAll("[data-pane]"), function (p) {
      p.hidden = p.dataset.pane !== name;
    });
    var title = el("admin-title");
    if (title) title.textContent = { reports: "Village reports", comps: "Poster competition requests",
      bookings: "Hall booking requests", notices: "Village Notice Board",
      events: "Poster events", residents: "Residents" }[name];
    /* the residents' tally belongs to the residents tab */
    var note = el("admin-note");
    if (note) note.hidden = name !== "residents";
    if (name === "bookings") renderBookings();
    if (name === "notices") renderNoticesAdmin();
    if (name === "events") renderEvents();
    if (name === "reports") renderReports();
    if (name === "comps") renderComps();
    if (name === "residents") render();
  }
  function paintCounts() {
    var r = el("admin-count-reports"), c = el("admin-count-comps"), bk = el("admin-count-bookings");
    var nr = newReportCount(), nc = Object.keys(compReqs).length, nb = pendingBookingCount();
    if (r) r.textContent = nr ? String(nr) : "";
    if (c) c.textContent = nc ? String(nc) : "";
    if (bk) bk.textContent = nb ? String(nb) : "";
    var ev = el("admin-count-events"), np = pendingRegCount();
    if (ev) ev.textContent = np ? String(np) : "";
  }
  /* Poster registrations waiting for an administrator, across events. */
  function pendingRegCount() {
    var E = window.QVEvents;
    if (!E || !E.live || !E.live()) return 0;
    var n = 0, evs = E.events();
    Object.keys(evs).forEach(function (eid) {
      var r = E.regs(eid);
      Object.keys(r).forEach(function (u) { if (r[u].status === "pending") n++; });
    });
    return n + (E.pendingRequests ? E.pendingRequests() : 0);
  }
  /* The Notice Board's "New poster event", for an administrator. */
  api.openEvents = function () {
    if (!amAdmin) return false;
    if (!panelOpen) api.open();
    showTab("events");
    return true;
  };
  api.eventsChanged = function () {
    paintButton();
    if (panelOpen && tab === "events" && window.QVEvents) QVEvents.adminRefresh();
    if (panelOpen && tab === "notices" && !editing) renderNoticesAdmin();
  };

  /* ------------------------------------------------------ poster events */
  function renderEvents() {
    var host = el("admin-events");
    if (!host || !window.QVEvents) return;
    QVEvents.adminRender(host);
    if (host._wired) return;
    host._wired = true;
    host.addEventListener("click", function (e) { QVEvents.adminClick(e, run); });
    host.addEventListener("change", function (e) { QVEvents.adminChange(e); });
    host.addEventListener("submit", function (e) { QVEvents.adminSubmit(e, run); });
  }

  /* --------------------------------------------- poster competitions */
  /* Watched for as long as this account is an administrator, not only
     while the panel is open, so a new request can be announced and the
     shield in the rail can carry a count. */
  function startWatchingComps() {
    if (compWatch.length || !Net || !Net.watchPendingCompetitionRequests) return;
    var first = true;
    compWatch.push(Net.watchPendingCompetitionRequests(function (map) {
      var fresh = Object.keys(map || {}).filter(function (id) { return !compReqs[id]; });
      compReqs = map || {};
      if (!first && fresh.length && hooks.toast) {
        var r = compReqs[fresh[0]];
        hooks.toast("\uD83C\uDFC6 New poster competition request: <b>" + esc(r.title) + "</b> from " +
                    esc(r.userName) + ". Open Administration to review it.");
      }
      first = false;
      paintButton();
      if (panelOpen) renderComps();
    }));
    compWatch.push(Net.watchHallCompetitions(function (map) {
      hallComps = map || {};
      if (panelOpen) renderComps();
    }));
  }
  function stopWatchingComps() {
    compWatch.forEach(function (f) { try { f(); } catch (e) {} });
    compWatch = [];
    compReqs = {};
    hallComps = {};
  }
  function hallBusyUntil(hallId) {
    var l = hallComps[hallId];
    var now = Net.serverNow ? Net.serverNow() : Date.now();
    if (l && l.competition && l.competition.status === "active" &&
        typeof l.expiresAt === "number" && l.expiresAt > now) return l.expiresAt;
    return 0;
  }
  function when(t) { return typeof t === "number" ? new Date(t).toLocaleString() : "—"; }

  function renderComps() {
    var sec = el("admin-comps"), host = el("admin-comp-list"), sel = el("admin-comp-filter");
    if (!sec || !host) return;
    var want = sel ? sel.value : "pending";
    /* the pending list is watched on its own (it drives the count), the
       rest comes from the full list */
    var src = Object.assign({}, allCompReqs, compReqs);
    var ids = Object.keys(src).filter(function (id) {
      return want === "all" || (src[id].status || "pending") === want;
    }).sort(function (a, b) {
      return want === "pending" ? (src[a].requestedAt || 0) - (src[b].requestedAt || 0)
                                : (src[b].requestedAt || 0) - (src[a].requestedAt || 0);
    });
    var running = Object.keys(hallComps).filter(function (h) { return hallBusyUntil(h); });
    var head = running.map(function (h) {
      var c = hallComps[h].competition || {};
      return '<li class="adm-row comp-live" data-live="' + esc(hallComps[h].id) + '" data-hall="' + esc(h) + '">' +
        '<span class="adm-who"><b>\uD83C\uDFC6 ' + esc(c.title || "Competition") +
        '</b><span class="adm-sub">Running in ' + esc(HALL_NAMES[h] || h) + " · organised by " +
        esc(c.organiserName || "a resident") + " · ends " + esc(when(hallComps[h].expiresAt)) + "</span></span>" +
        '<span class="adm-acts"><button class="btn small ghost danger" type="button" data-endcomp="1">End now</button></span></li>';
    }).join("");
    if (!ids.length) {
      host.innerHTML = head + '<li class="adm-empty fine">' +
        (want === "pending" ? "No competition requests are waiting." : "Nothing here with that status.") + "</li>";
    } else {
      host.innerHTML = head + ids.map(function (id) {
        var r = src[id], st = r.status || "pending", busy = hallBusyUntil(r.hallId);
        var who = [r.fullName, r.institution, r.position].filter(Boolean).join(" · ");
        return '<li class="adm-row comp-req" data-req="' + esc(id) + '">' +
          '<span class="adm-who">' +
            "<b>" + esc(r.title) + ' <span class="adm-pill st-' + esc(st) + '">' + esc(BOOK_STATUS[st] || st) + "</span></b>" +
            '<span class="adm-sub">' + esc(r.userName) + " · " + esc(HALL_NAMES[r.hallId] || r.hallId) + "</span>" +
            (who ? '<span class="adm-sub">Organiser: ' + esc(who) + "</span>" : "") +
            (r.description ? '<span class="adm-desc">' + esc(r.description) + "</span>" : "") +
            '<span class="adm-sub">Requested ' + esc(when(r.requestedAt)) +
              (typeof r.preferredStart === "number" ? " · would like it to start " + esc(when(r.preferredStart)) : "") +
              (r.approvedAt ? " · approved " + esc(when(r.approvedAt)) : "") +
              (st === "rejected" && r.decidedAt ? " · rejected " + esc(when(r.decidedAt)) : "") +
            "</span>" +
            (st === "pending" && busy ? '<span class="adm-why">This hall has a competition running until ' + esc(when(busy)) + ".</span>" : "") +
          "</span>" +
          (st === "pending" ? '<span class="adm-acts">' +
            '<button class="btn small" data-comp="approve"' + (busy ? " disabled" : "") + ">Approve</button>" +
            '<button class="btn small ghost danger" data-comp="reject">Reject</button>' +
          "</span>" : "") + "</li>";
      }).join("");
    }
    if (!host._wired) {
      host._wired = true;
      host.addEventListener("click", onCompClick);
      if (sel) sel.addEventListener("change", renderComps);
    }
  }

  function onCompClick(e) {
    var end = e.target.closest ? e.target.closest("button[data-endcomp]") : null;
    if (end && !end.disabled) {
      var live = end.closest(".comp-live"), cid = live.dataset.live, hall = live.dataset.hall;
      var c = (hallComps[hall] && hallComps[hall].competition) || {};
      e.preventDefault();
      if (!window.confirm("End \"" + (c.title || "this competition") + "\" now?\n\nThe timer stops, its posters " +
                          "come down, and the hall goes back to normal mode. Its notice moves to Past.")) return;
      return run(end, Net.endPosterCompetition(cid, hall), "Ended \"" + esc(c.title || "the competition") + "\".");
    }
    var btn = e.target.closest ? e.target.closest("button[data-comp]") : null;
    if (!btn || btn.disabled) return;
    var row = btn.closest(".comp-req");
    if (!row) return;
    /* only a pending request can be decided, and only from the live pending list */
    var id = row.dataset.req, r = compReqs[id];
    if (!r) return;
    e.preventDefault();
    if (btn.dataset.comp === "approve") {
      if (!window.confirm("Approve \"" + r.title + "\" in " + (HALL_NAMES[r.hallId] || r.hallId) +
                          "?\n\nIt starts now and runs for exactly 24 hours.")) return;
      return run(btn, Net.approvePosterCompetition(id, r),
                 "Approved. \"" + esc(r.title) + "\" is running for the next 24 hours.");
    }
    if (!window.confirm("Reject \"" + r.title + "\"?")) return;
    return run(btn, Net.rejectPosterCompetition(id), "Rejected \"" + esc(r.title) + "\".");
  }

  function startWatchingBlocked() {
    if (blockedWatch || !Net) return;
    blockedWatch = Net.watchBlocked(function (map) {
      blocked = map || {};
      Object.keys(blocked).forEach(function (u) {
        var r = residents[u] || (residents[u] = { uid: u });
        r.blockedAt = blocked[u].at;
      });
      if (panelOpen) render();
    });
  }
  function stopWatchingBlocked() {
    if (!blockedWatch) return;
    try { blockedWatch(); } catch (e) {}
    blockedWatch = null;
    blocked = {};
  }

  function paintButton() {
    var btn = el("admin-btn");
    if (!btn) return;
    btn.hidden = !amAdmin;
    var n = amAdmin ? Object.keys(compReqs).length : 0;
    var nr = amAdmin ? newReportCount() : 0;
    var nb = amAdmin ? pendingBookingCount() : 0;
    var np = amAdmin ? pendingRegCount() : 0;
    btn.classList.toggle("has-req", n + nr + nb + np > 0);
    var bits = [];
    if (np) bits.push(np + " poster event item" + (np === 1 ? "" : "s") + " to review");
    if (nb) bits.push(nb + " booking request" + (nb === 1 ? "" : "s"));
    if (nr) bits.push(nr + " new report" + (nr === 1 ? "" : "s"));
    if (n) bits.push(n + " competition request" + (n === 1 ? "" : "s") + " waiting");
    btn.title = bits.length ? "Administration — " + bits.join(", ") : "Administration";
    paintCounts();
  }

  /* ------------------------------------------------------------- the wall */
  /* Being told, rather than watching the village fail silently. */
  function showWall(rec) {
    var wall = el("barred");
    if (wall) {
      var why = el("barred-why");
      if (why) {
        why.textContent = rec && rec.why
          ? rec.why
          : "No reason was recorded.";
      }
      wall.hidden = false;
    }
    if (window.QVVoice) { try { QVVoice.stopSpeaking(); } catch (e) {} }
    if (Net && Net.signOut) Net.signOut().catch(function () {});
  }

  /* ------------------------------------------------------------- panel */
  api.toggle = function () { return panelOpen ? api.close() : api.open(); };
  api.open = function () {
    if (!amAdmin) return false;
    var p = el("admin");
    if (!p) return false;
    panelOpen = true;
    p.hidden = false;
    startWatchingBlocked();
    startWatchingComps();
    startWatchingReports();
    startWatchingEvents();
    loadResidents();
    /* open where the work is */
    showTab(newReportCount() ? "reports" : pendingBookingCount() ? "bookings"
            : Object.keys(compReqs).length ? "comps" : pendingRegCount() ? "events" : tab);
    return true;
  };
  api.close = function () {
    var p = el("admin");
    if (p) p.hidden = true;
    panelOpen = false;
    return false;
  };
  api.isOpen = function () { return panelOpen; };

  var loadedResidents = false;
  function loadResidents() {
    if (loadedResidents || !Net || !Net.collWatch) return;
    loadedResidents = true;
    /* Opened on demand, not at boot: an ordinary resident never reads this
       collection at all, and an administrator reads it when they ask to. */
    unsub.push(Net.collWatch("residents", function (rows) {
      (rows || []).forEach(function (row) {
        var r = residents[row.id] || (residents[row.id] = { uid: row.id });
        r.name = row.name || r.name;
        r.inst = row.inst || r.inst;
        r.country = row.country || r.country;
        r.orcid = row.orcid || r.orcid;
      });
      if (panelOpen) render();
    }, 200));
  }

  function rows() {
    var me = Net && Net.uid ? Net.uid() : null;
    return Object.keys(residents).map(function (u) {
      var r = residents[u];
      return {
        uid: u,
        name: r.name || "Resident",
        inst: r.inst || "",
        here: !!r.here,
        me: u === me,
        blocked: !!blocked[u],
        why: blocked[u] && blocked[u].why,
        byName: blocked[u] && blocked[u].byName
      };
    }).sort(function (a, b) {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
      if (a.here !== b.here) return a.here ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function render() {
    var host = el("admin-list");
    if (!host) return;
    var list = rows();
    var note = el("admin-note");
    if (note) {
      note.textContent = list.length
        ? (list.filter(function (r) { return r.blocked; }).length + " blocked of " +
           list.length + " known · " + list.filter(function (r) { return r.here; }).length + " here now")
        : "Nobody has signed in yet.";
    }
    if (!list.length) { host.innerHTML = ""; return; }

    var q = ((el("admin-res-search") || {}).value || "").trim().toLowerCase();
    host.innerHTML = list.map(function (r) {
      var hide = q && (r.name + " " + r.inst + " " + r.uid).toLowerCase().indexOf(q) < 0;
      return '<li class="adm-row' + (r.blocked ? " barred" : "") + '" data-uid="' + esc(r.uid) + '"' + (hide ? " hidden" : "") + ">" +
        '<span class="adm-dot' + (r.here ? " on" : "") + '" aria-hidden="true"></span>' +
        '<span class="adm-who">' +
          "<b>" + esc(r.name) + (r.me ? ' <span class="adm-you">you</span>' : "") + "</b>" +
          '<span class="adm-sub">' + esc(r.inst || r.uid) + "</span>" +
          (r.blocked ? '<span class="adm-why">Blocked' +
             (r.byName ? " by " + esc(r.byName) : "") +
             (r.why ? " — " + esc(r.why) : "") + "</span>" : "") +
        "</span>" +
        '<span class="adm-acts">' +
          (r.blocked
            ? '<button class="btn small ghost" data-act="unblock">Unblock</button>'
            : '<button class="btn small ghost danger" data-act="block"' +
              (r.me ? " disabled" : "") + ">Block</button>") +
          '<button class="btn small ghost danger" data-act="delete"' +
            (r.me ? " disabled" : "") + ">Delete</button>" +
        "</span></li>";
    }).join("");

    /* One listener on the list, not one per row. */
    if (!host._wired) {
      host._wired = true;
      host.addEventListener("click", onRowClick);
      var search = el("admin-res-search");
      if (search) search.addEventListener("input", render);
    }
  }

  function onRowClick(e) {
    var btn = e.target.closest ? e.target.closest("button[data-act]") : null;
    if (!btn || btn.disabled) return;
    var row = btn.closest(".adm-row");
    if (!row) return;
    var uid = row.dataset.uid;
    var act = btn.dataset.act;
    var who = (residents[uid] && residents[uid].name) || "this resident";
    e.preventDefault();

    if (act === "unblock") return run(btn, unblock(uid), "Unblocked " + who + ".");

    if (act === "block") {
      var why = window.prompt("Block " + who + " permanently.\n\nThe reason is shown to them and kept with the record.", "");
      if (why === null) return;
      return run(btn, block(uid, why), who + " is blocked. They keep their password and get nothing.");
    }

    if (act === "delete") {
      if (!window.confirm("Delete " + who + " permanently?\n\nTheir account, profile and score are removed and cannot be recovered.")) return;
      return run(btn, remove(uid), who + " has been deleted.");
    }
  }

  /* Disable the button while it is working, and say what happened. */
  function run(btn, promise, ok) {
    btn.disabled = true;
    promise.then(function (msg) {
      if (hooks.toast) hooks.toast(typeof msg === "string" ? msg : ok);
    }).catch(function (err) {
      console.warn("[admin]", err);
      if (hooks.toast) {
        hooks.toast("<b>That did not go through</b> — " +
                    esc((err && err.message) || "the database refused it."));
      }
    }).then(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------------------ actions */
  /* Each of these does the database half itself, which the rules enforce,
     and then asks the server for the Authentication half if it is there.
     The order matters: write the block first, so that even if the callable
     is missing or fails the resident is already out. */
  function block(uid, why) {
    return Net.setBlocked(uid, { why: why || "" }).then(function () {
      return Net.adminCall("blockUser", { uid: uid, why: why || "" })
        .then(function () {
          return "Blocked, and the account is disabled in Firebase Authentication.";
        })
        .catch(function () {
          /* No Cloud Function deployed. The database block is still total —
             the rules refuse them everything — so this is a note, not a
             failure. */
          return "Blocked. The database refuses them everything; deploy " +
                 "functions/ to also disable the account itself.";
        });
    });
  }

  function unblock(uid) {
    return Net.setBlocked(uid, null).then(function () {
      return Net.adminCall("unblockUser", { uid: uid }).catch(function () { return null; })
        .then(function () { return true; });
    });
  }

  function remove(uid) {
    /* Delete needs the Admin SDK and has no client-side equivalent, so if
       it is not deployed the honest thing is a permanent block, which is
       what an administrator wanted anyway, plus a clear word about why the
       account itself is still listed. */
    return Net.adminCall("deleteUser", { uid: uid })
      .then(function () {
        return Net.purgeUser(uid).then(function () {
          delete residents[uid];
          render();
          return "Deleted: the account, the profile and the score are gone.";
        });
      })
      .catch(function () {
        return Net.setBlocked(uid, { why: "Removed by an administrator" })
          .then(function () { return Net.purgeUser(uid); })
          .then(function () {
            return "Their profile and score are gone and they are blocked for good. " +
                   "Deleting the login itself needs functions/ deployed — see the README.";
          });
      });
  }

  window.QVAdmin = api;
})();
