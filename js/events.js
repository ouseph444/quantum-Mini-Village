/* Quantum Village — poster events: registration, numbered stands, and the
 * administrator's view of them.
 *
 * An administrator announces a poster event and says how many stands of
 * each poster hall it uses. Residents register from the Notice Board; each
 * registration is given the lowest free poster number in its hall, and the
 * participant then pins their poster to that stand — from anywhere, since
 * the stand is theirs. Every stand wears its number on a plate underneath,
 * with what is happening on it.
 *
 * Nothing here decides who gets which number. The page proposes one, and
 * database.rules.json accepts it only if nobody holds it and it is within
 * the hall's capacity (see net.js, "poster events"), so two residents
 * registering at the same moment can never share a stand.
 */
(function () {
  "use strict";

  var api = {};
  var hooks = {};
  var Net = null;
  var events = {};            /* eid -> event */
  var regs = {};              /* eid -> uid -> registration */
  var slots = {};             /* eid -> hall -> num -> uid */
  var regPosters = {};        /* eid -> uid -> { s, t, at } — only for events on the stands now */
  var posterWatch = {};       /* eid -> unsubscribe */
  var current = {};           /* hall -> eid shown on its stands */
  var unsub = [];
  var prevMine = null;
  var HALLS = ["poster-hall", "poster-hall-2"];
  var STATUS = { pending: "Awaiting approval", registered: "Registered", approved: "Approved", rejected: "Not accepted" };
  var REQ_STATUS = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
  var VENUES = { "poster-hall": "Poster Hall 1 — The Poster Hall", "poster-hall-2": "Poster Hall 2 — The Grand Poster Hall",
                 both: "Both poster halls", virtual: "Virtual location", other: "Other location" };
  var myReqs = {}, prevMyReqs = null;   /* this resident's requests to organise */
  var allReqs = {}, reqWatch = null, wantAdmin = false, reqFirst = true;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function now() { return Net && Net.serverNow ? Net.serverNow() : Date.now(); }
  function me() { return (hooks.uid && hooks.uid()) || ""; }
  function H(h) { return (Net.PE_HALLS || {})[h] || { short: h, name: h, stands: 0, cap: "" }; }
  function cap(ev, h) { return Math.min(ev[H(h).cap] | 0, H(h).stands); }
  function halls(ev) { return HALLS.filter(function (h) { return cap(ev, h) > 0; }); }
  function taken(eid, h) { return Object.keys((slots[eid] || {})[h] || {}).length; }
  /* How many stands to show: the capacity, or further if an administrator
     lowered it below a number somebody already holds — they keep it. */
  function shown(eid, h) {
    var n = events[eid] ? cap(events[eid], h) : 0;
    Object.keys((slots[eid] || {})[h] || {}).forEach(function (k) { n = Math.max(n, Math.min(+k, H(h).stands)); });
    return n;
  }
  function free(eid, h) {
    var ev = events[eid], s = (slots[eid] || {})[h] || {}, n = 0;
    for (var i = ev ? cap(ev, h) : 0; i >= 1; i--) if (!s[i]) n++;
    return n;
  }
  function totalFree(eid) { var ev = events[eid]; return halls(ev).reduce(function (a, h) { return a + free(eid, h); }, 0); }
  function over(ev) { return ev.endAt <= now() || ev.status === "archived"; }
  function myReg(eid) { return ((regs[eid] || {})[me()]) || null; }
  function hasPoster(eid, uid) { return !!((regPosters[eid] || {})[uid]); }

  /* Can a new resident register right now, and if not, why not. */
  function regState(ev, eid) {
    if (ev.status === "cancelled") return { open: false, label: "Cancelled" };
    if (over(ev)) return { open: false, label: "Event over" };
    if (ev.status !== "open") return { open: false, label: "Registration closed" };
    if (typeof ev.deadline === "number" && ev.deadline <= now()) return { open: false, label: "Deadline passed" };
    if (!totalFree(eid)) return { open: false, label: "Full" };
    return { open: true, label: "Registration open" };
  }

  function fmtDay(ms) { return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
  function fmtClock(ms) { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function fmtSpan(a, b) {
    return fmtDay(a) + ", " + fmtClock(a) + " – " +
      (new Date(a).toDateString() === new Date(b).toDateString() ? "" : fmtDay(b) + ", ") + fmtClock(b);
  }
  function fmtWhen(ms) { return fmtDay(ms) + ", " + fmtClock(ms); }

  /* ------------------------------------------------------------------ init */
  api.init = function (h) {
    hooks = h || {};
    Net = window.QVNet;
    if (!Net || !Net.posterEventsLive || !Net.posterEventsLive()) return;
    unsub.push(Net.watchPosterEvents(function (m) { events = m || {}; changed(); }));
    unsub.push(Net.watchPosterRegs(function (m) { regs = m || {}; noticeMine(); changed(); }));
    unsub.push(Net.watchPosterSlots(function (m) { slots = m || {}; changed(); }));
    unsub.push(Net.watchMyPosterEventRequests(function (m) { noticeMyReqs(m || {}); myReqs = m || {}; changed(); }));
    if (wantAdmin) startAdmin();
    wireForm();
    wireReqForm();
    /* an event starting or ending moves which one is on the stands */
    setInterval(changed, 60000);
  };
  api.live = function () { return !!(Net && Net.posterEventsLive && Net.posterEventsLive()); };
  api.events = function () { return events; };
  api.regs = function (eid) { return regs[eid] || {}; };
  api.slots = function (eid) { return slots[eid] || {}; };
  api.posters = function (eid) { return regPosters[eid] || {}; };
  api.HALLS = HALLS;
  api.cap = function (eid, h) { return events[eid] ? cap(events[eid], h) : 0; };
  api.free = free;
  api.taken = taken;

  var pending = false;
  function changed() {
    if (pending) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      pickCurrent();
      paintStands();
      if (hooks.onChange) { try { hooks.onChange(); } catch (e) {} }
    }, 30);
  }

  /* Which event each hall's stands belong to: the earliest one that has
     not ended and is not cancelled. Its uploaded posters are watched; any
     other event's are not downloaded at all. */
  function pickCurrent() {
    var t = now(), next = {};
    HALLS.forEach(function (h) {
      var best = null;
      Object.keys(events).forEach(function (eid) {
        var ev = events[eid];
        if (!ev || ev.status === "cancelled" || ev.status === "archived" || ev.endAt <= t || !cap(ev, h)) return;
        if (!best || ev.startAt < events[best].startAt) best = eid;
      });
      if (best) next[h] = best;
    });
    current = next;
    var want = {};
    HALLS.forEach(function (h) { if (current[h]) want[current[h]] = 1; });
    if (adminEid) want[adminEid] = 1;
    Object.keys(posterWatch).forEach(function (eid) {
      if (!want[eid]) { posterWatch[eid](); delete posterWatch[eid]; delete regPosters[eid]; }
    });
    Object.keys(want).forEach(function (eid) {
      if (posterWatch[eid]) return;
      posterWatch[eid] = Net.watchRegPosters(eid, function (m) { regPosters[eid] = m || {}; changed(); });
    });
  }

  function slotState(r, eid) {
    if (r.status === "pending") return "pending";
    if (r.mode === "competition") return "competition";
    if (hasPoster(eid, r.uid)) return "uploaded";
    return "registered";
  }

  function paintStands() {
    if (!window.QVPosters || !QVPosters.frameForSlot) return;
    HALLS.forEach(function (h) {
      var eid = current[h], ev = eid && events[eid], c = ev ? shown(eid, h) : 0;
      var n = QVPosters.slotCount(h);
      for (var num = 1; num <= n; num++) {
        var fid = QVPosters.frameForSlot(h, num);
        if (!fid) continue;
        fid = fid.id || fid;
        if (!ev || num > c) { QVPosters.setSlot(fid, null); QVPosters.setReg(fid, null); continue; }
        var uid = ((slots[eid] || {})[h] || {})[num];
        var r = uid && (regs[eid] || {})[uid];
        if (!r || r.num !== num || r.hallId !== h) {
          QVPosters.setSlot(fid, "available");
          QVPosters.setReg(fid, null);
          continue;
        }
        var p = (regPosters[eid] || {})[uid];
        QVPosters.setSlot(fid, slotState(r, eid), r.name);
        QVPosters.setReg(fid, {
          eid: eid, uid: uid, name: r.name, inst: r.institution, title: r.title,
          comp: r.mode === "competition", pending: r.status === "pending",
          src: p ? p.s : null, ptitle: p ? p.t : "", eventTitle: ev.title
        });
      }
    });
  }

  /* Hooks lent to QVPosters for a registered participant's own stand. */
  api.pinReg = function (fid, src, title) {
    var r = window.QVPosters && QVPosters.reg(fid);
    if (!r || r.uid !== me()) return Promise.reject(new Error("That stand is not yours."));
    return Net.putRegPoster(r.eid, src, title).catch(function (e) {
      throw new Error(/permission|denied/i.test(String(e && (e.code || e.message)))
        ? "The database refused it — your registration may have been changed by an administrator."
        : "That did not go through — check your connection and try again.");
    });
  };
  api.unpinReg = function (fid) {
    var r = window.QVPosters && QVPosters.reg(fid);
    if (!r) return Promise.resolve();
    return Net.removeRegPoster(r.eid, r.uid);
  };

  /* Tell a participant when an administrator decides on their registration. */
  function noticeMine() {
    var u = me();
    if (!u) return;
    var mine = {};
    Object.keys(regs).forEach(function (eid) { if (regs[eid] && regs[eid][u]) mine[eid] = regs[eid][u]; });
    if (prevMine && hooks.toast) {
      Object.keys(prevMine).forEach(function (eid) {
        var a = prevMine[eid], b = mine[eid], ev = events[eid] || {};
        var t = "<b>" + esc(ev.title || "the poster event") + "</b>";
        if (!b) { if (!selfCancel[eid]) hooks.toast("Your registration for " + t + " was removed by an administrator."); return; }
        if (a.status !== b.status) {
          if (b.status === "approved") hooks.toast("✅ Your registration for " + t + " was approved — you are <b>Poster " +
            b.num + "</b> in " + esc(H(b.hallId).short) + ".");
          else if (b.status === "rejected") hooks.toast("Your registration for " + t + " was not accepted.");
        } else if (a.hallId !== b.hallId || a.num !== b.num) {
          if (b.num) hooks.toast("Your poster for " + t + " moved to <b>Poster " + b.num + "</b> in " + esc(H(b.hallId).short) + ".");
        }
      });
    }
    selfCancel = {};
    prevMine = mine;
  }
  var selfCancel = {};

  /* -------------------------------------------------------- notice board */
  /* Poster events, as cards on the Notice Board. `time` is the board's
     own filter: today | week | upcoming | past. */
  api.list = function (time) {
    var t = now(), d = new Date(t);
    var dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), dayEnd = dayStart + 86400000;
    return Object.keys(events).filter(function (eid) {
      var ev = events[eid];
      if (!ev || !ev.title) return false;
      if (time === "past") return over(ev) && ev.status !== "cancelled";
      if (over(ev)) return false;
      if (time === "today") return ev.startAt < dayEnd && ev.endAt > dayStart;
      if (time === "week") return ev.startAt < t + 7 * 86400000;
      return true;
    }).sort(function (a, b) {
      return time === "past" ? events[b].startAt - events[a].startAt : events[a].startAt - events[b].startAt;
    });
  };

  api.cardHtml = function (eid) {
    var ev = events[eid], st = regState(ev, eid), mine = myReg(eid), t = now();
    var head = ev.status === "cancelled" ? "Cancelled · Poster session"
      : over(ev) ? "Past poster session" : ev.startAt <= t ? "On now · Poster session" : "Upcoming poster session";
    var desc = String(ev.description || "");
    return '<article class="nb-card t-poster_presentation pe-card' + (ev.status === "cancelled" ? " cancelled" : "") + '">' +
      '<span class="nb-kind">' + esc(head) + "</span>" +
      "<h4>" + esc(ev.title) + "</h4>" +
      (ev.topic || ev.orgName ? '<p class="nb-who">' + (ev.topic ? esc(ev.topic) : "") +
        (ev.orgName ? (ev.topic ? "<br>" : "") + "Organised by <b>" + esc(ev.orgName) + "</b>" +
          (ev.orgInst ? " · " + esc(ev.orgInst) : "") : "") + "</p>" : "") +
      '<div class="pe-chips">' +
        '<span class="pe-chip ' + (st.open ? "ok" : "no") + '">' + esc(st.label) + "</span>" +
        halls(ev).map(function (h) {
          return '<span class="pe-chip">' + esc(H(h).short) + ": <b>" + free(eid, h) + "</b> of " + cap(ev, h) + " free</span>";
        }).join("") +
        (ev.allowComp ? '<span class="pe-chip comp">🏆 Competition</span>' : "") +
      "</div>" +
      (desc ? '<p class="nb-abs">' + esc(desc.length > 200 ? desc.slice(0, 197).trim() + "…" : desc) + "</p>" : "") +
      '<p class="nb-when"><span>' + esc(fmtSpan(ev.startAt, ev.endAt)) + "</span>" +
        (typeof ev.deadline === "number" ? "<span>Register by " + esc(fmtWhen(ev.deadline)) + "</span>" : "") + "</p>" +
      (mine ? '<p class="pe-mine">' + mineLine(mine) + "</p>" : "") +
      '<div class="pe-acts">' +
        '<button type="button" class="btn small ghost" data-pe="view" data-eid="' + esc(eid) + '">View event</button>' +
        goButtons(ev, mine) +
        (!mine && st.open ? '<button type="button" class="btn small" data-pe="register" data-eid="' + esc(eid) + '">Register</button>' : "") +
      "</div></article>";
  };
  /* "Take Me There" and "Ride to Event" come from the village (app.js), for
     your own hall if you have a stand, else whichever of the event's halls
     is nearest. */
  function goButtons(ev, mine) {
    if (!hooks.goButtons || ev.status === "cancelled") return "";
    return hooks.goButtons(mine && mine.status !== "rejected" && mine.hallId ? [mine.hallId] : halls(ev));
  }
  function mineLine(r) {
    if (r.status === "rejected") return "Your registration was not accepted.";
    return "You are <b>Poster " + r.num + "</b> in " + esc(H(r.hallId).short) + " · " + esc(STATUS[r.status] || r.status) +
      (r.mode === "competition" ? " · 🏆 competition entry" : "");
  }

  api.detailHtml = function (eid) {
    var ev = events[eid];
    if (!ev) return '<p class="fine">That event is no longer on the board.</p>';
    var st = regState(ev, eid), mine = myReg(eid), all = regs[eid] || {};
    var comp = Object.keys(all).filter(function (u) { return all[u].mode === "competition" && all[u].status !== "rejected"; }).length;
    var html = '<button type="button" class="btn small ghost nb-back" data-nb="back">← All notices</button>' +
      '<article class="nb-detail t-poster_presentation pe-detail">' +
      '<span class="nb-kind">Poster session' + (ev.status === "cancelled" ? " · Cancelled" : "") + "</span>" +
      "<h3>" + esc(ev.title) + "</h3>" +
      "<dl>" +
        (ev.orgName ? "<dt>Organised by</dt><dd>" + esc([ev.orgName, ev.orgPos, ev.orgInst].filter(Boolean).join(" · ")) + "</dd>" : "") +
        (ev.topic ? "<dt>Topic</dt><dd>" + esc(ev.topic) + "</dd>" : "") +
        "<dt>When</dt><dd>" + esc(fmtSpan(ev.startAt, ev.endAt)) + "</dd>" +
        "<dt>Where</dt><dd>" + halls(ev).map(function (h) { return esc(H(h).short + " — " + H(h).name); }).join("<br>") +
          (ev.venue ? "<br>" + esc(ev.venue) : "") + "</dd>" +
        "<dt>Registration</dt><dd>" + esc(st.label) + (ev.needsApproval ? ' <span class="fine">(reviewed by an administrator)</span>' : "") + "</dd>" +
        (typeof ev.deadline === "number" ? "<dt>Deadline</dt><dd>" + esc(fmtWhen(ev.deadline)) + "</dd>" : "") +
        (ev.allowComp ? "<dt>Competition</dt><dd>🏆 Open for entries · " + comp + " so far</dd>" : "") +
      "</dl>" +
      (goButtons(ev, mine) ? '<div class="pe-acts">' + goButtons(ev, mine) + "</div>" : "") +
      (ev.description ? '<h5>About</h5><p class="nb-fullabs">' + esc(ev.description) + "</p>" : "") +
      (ev.abstract ? '<h5>Abstract</h5><p class="nb-fullabs">' + esc(ev.abstract) + "</p>" : "") +
      '<div class="pe-halls">' + halls(ev).map(function (h) { return hallGrid(eid, h); }).join("") + "</div>";

    if (mine) {
      html += '<div class="pe-mybox"><h5>Your registration</h5><p>' + mineLine(mine) + "</p>" +
        (mine.status !== "rejected" ? '<p class="fine">' + (hasPoster(eid, me()) || !isCurrent(eid, mine.hallId)
          ? (hasPoster(eid, me()) ? "Your poster is pinned up." : "Your stand becomes live when this event is next in its hall.")
          : "Your stand is reserved — pin your poster to it whenever you are ready.") + "</p>" : "") +
        '<div class="pe-acts">' +
          (mine.status !== "rejected" && isCurrent(eid, mine.hallId)
            ? '<button type="button" class="btn small" data-pe="upload" data-eid="' + esc(eid) + '">' +
              (hasPoster(eid, me()) ? "Replace my poster" : "Upload my poster") + "</button>" +
              '<button type="button" class="btn small ghost" data-pe="goto" data-eid="' + esc(eid) + '">Walk to Poster ' + mine.num + "</button>"
            : "") +
          (mine.status !== "rejected" ? '<button type="button" class="btn small ghost" data-pe="edit" data-eid="' + esc(eid) + '">Edit details</button>' : "") +
          '<button type="button" class="btn small ghost danger" data-pe="cancel" data-eid="' + esc(eid) + '">Cancel registration</button>' +
        "</div></div>";
    } else if (st.open) {
      html += '<div class="pe-acts"><button type="button" class="btn" data-pe="register" data-eid="' + esc(eid) + '">Register to present</button></div>';
    }

    html += participants(eid) + "</article>";
    return html;
  };
  function isCurrent(eid, h) { return current[h] === eid; }

  /* A little map of the stands: which are free, taken, pinned, competing. */
  function hallGrid(eid, h) {
    var ev = events[eid], c = shown(eid, h), s = (slots[eid] || {})[h] || {}, all = regs[eid] || {};
    var cells = "";
    for (var n = 1; n <= c; n++) {
      var r = s[n] && all[s[n]];
      var state = r && r.num === n && r.hallId === h ? slotState(r, eid) : "available";
      /* uploads are only downloaded for the event on the stands now */
      if (state === "uploaded" && !isCurrent(eid, h) && eid !== adminEid) state = "registered";
      cells += '<span class="pe-cell s-' + state + (r && r.uid === me() ? " mine" : "") + '" title="Poster ' + n + " · " +
        esc(state === "available" ? "Available" : (r.name + " — " + r.title)) + '">' + n + "</span>";
    }
    return '<section class="pe-hall"><header><b>' + esc(H(h).short) + '</b><span class="fine">' + esc(H(h).name) + "</span>" +
      '<span class="pe-count">' + taken(eid, h) + " / " + cap(ev, h) + " taken · <b>" + free(eid, h) + "</b> free</span></header>" +
      '<div class="pe-grid">' + cells + "</div></section>";
  }

  function participants(eid) {
    var all = regs[eid] || {};
    var list = Object.keys(all).map(function (u) { return all[u]; })
      .filter(function (r) { return r.status !== "rejected" && r.num >= 1; });
    if (!list.length) return '<h5>Participants</h5><p class="fine">Nobody has registered yet.</p>';
    return '<h5>Participants <span class="fine">(' + list.length + ")</span></h5>" +
      '<input class="field pe-search" type="search" placeholder="Search by name, institution or title" data-pe-search="1">' +
      HALLS.map(function (h) {
        var rows = list.filter(function (r) { return r.hallId === h; }).sort(function (a, b) { return a.num - b.num; });
        if (!rows.length) return "";
        return '<h6 class="pe-hh">' + esc(H(h).short) + "</h6>" + '<ol class="pe-people">' + rows.map(function (r) {
          var hay = [r.name, r.institution, r.position, r.affiliation, r.title].join(" ").toLowerCase();
          return '<li data-hay="' + esc(hay) + '"><span class="pe-num">' + r.num + "</span><div>" +
            '<b class="pe-ptitle">' + esc(r.title) + "</b>" +
            '<span class="pe-who">' + esc(r.name) + " · " + esc([r.position, r.institution].filter(Boolean).join(", ")) +
              (r.affiliation ? " · " + esc(r.affiliation) : "") + "</span>" +
            '<span class="pe-tags">' + (r.mode === "competition" ? '<span class="pe-chip comp">🏆 Competition</span>' : "") +
              (r.status === "pending" ? '<span class="pe-chip">Awaiting approval</span>' : "") +
              (hasPoster(eid, r.uid) ? '<span class="pe-chip ok">Poster up</span>' : "") + "</span>" +
            (r.abstract ? '<details><summary>Abstract</summary><p>' + esc(r.abstract) + "</p></details>" : "") +
          "</div></li>";
        }).join("") + "</ol>";
      }).join("");
  }

  /* A click on the Notice Board. Returns true if it was ours. */
  api.onBoardClick = function (btn, rerender) {
    var act = btn.dataset.pe, eid = btn.dataset.eid;
    if (!act) return false;
    if (act === "view") { rerender(eid); return true; }
    if (act === "request") { api.openRequest(); return true; }
    if (act === "adminnew") {
      if (window.QVAdmin && QVAdmin.openEvents) { if (hooks.closePanel) hooks.closePanel(); adminEdit = "new"; QVAdmin.openEvents(); }
      return true;
    }
    if (act === "pdf") { downloadPdf(btn.dataset.rid, btn); return true; }
    if (act === "withdraw") {
      var q = myReqs[btn.dataset.rid];
      if (!q || !window.confirm("Withdraw your request for \"" + q.title + "\"?\n\nIt and its PDF are deleted.")) return true;
      btn.disabled = true;
      Net.deletePosterEventRequest(btn.dataset.rid).then(function () {
        if (hooks.toast) hooks.toast("Request withdrawn.");
      }, function () { btn.disabled = false; if (hooks.toast) hooks.toast("<b>That did not go through</b> — it may already have been decided."); });
      return true;
    }
    if (act === "register") { api.openForm(eid); return true; }
    if (act === "edit") { api.openForm(eid, true); return true; }
    if (act === "upload") { api.upload(eid); return true; }
    if (act === "goto") {
      var r = myReg(eid), f = r && QVPosters.frameForSlot(r.hallId, r.num);
      if (f && hooks.goTo) hooks.goTo(f.x, f.z);
      return true;
    }
    if (act === "cancel") {
      var mine = myReg(eid);
      if (!mine || !window.confirm("Cancel your registration for \"" + events[eid].title + "\"?\n\n" +
          "Your poster number is given up and your poster, if pinned, comes down.")) return true;
      btn.disabled = true;
      selfCancel[eid] = true;
      Net.cancelPosterReg(eid, me(), mine).then(function () {
        if (hooks.toast) hooks.toast("Registration cancelled. Poster " + mine.num + " is free for someone else.");
      }, function (e) {
        delete selfCancel[eid];
        btn.disabled = false;
        if (hooks.toast) hooks.toast("<b>That did not go through</b> — " + esc((e && e.message) || "try again."));
      });
      return true;
    }
    return false;
  };
  api.onBoardInput = function (input) {
    if (!input.dataset.peSearch) return;
    var q = input.value.trim().toLowerCase();
    var host = input.parentNode;
    Array.prototype.forEach.call(host.querySelectorAll(".pe-people li"), function (li) {
      li.hidden = !!q && li.dataset.hay.indexOf(q) < 0;
    });
  };

  api.upload = function (eid) {
    var r = myReg(eid);
    if (!r || !r.num || !window.QVPosters) return;
    var f = QVPosters.frameForSlot(r.hallId, r.num);
    if (!f || !QVPosters.reg(f.id)) {
      if (hooks.toast) hooks.toast("Your stand is not live yet — it opens when this event is next in " + esc(H(r.hallId).short) + ".");
      return;
    }
    if (hooks.closePanel) hooks.closePanel();
    QVPosters.openPin(f.id);
  };

  /* ------------------------------------------------------------ the form */
  var formEid = null, formEdit = false;
  function wireForm() {
    var form = el("pe-form");
    if (!form || form._wired) return;
    form._wired = true;
    form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
    el("pe-cancel").addEventListener("click", closeForm);
    el("pe-reg").addEventListener("click", function (e) { if (e.target === el("pe-reg")) closeForm(); });
    el("pe-comp").addEventListener("change", function () { if (this.checked) el("pe-present").checked = true; });
    el("pe-present").addEventListener("change", function () { if (!this.checked) el("pe-comp").checked = false; });
  }
  api.isOpen = function () { var o = el("pe-reg"); return !!(o && !o.hidden); };
  api.close = closeForm;
  function closeForm() {
    var o = el("pe-reg");
    if (!o || o.hidden) return;
    o.hidden = true;
    formEid = null;
    if (hooks.onClose) hooks.onClose();
  }
  function say(msg, ok) {
    var e = el("pe-err");
    e.textContent = msg || ""; e.hidden = !msg; e.classList.toggle("ok", !!ok);
  }

  api.openForm = function (eid, edit) {
    var ev = events[eid], o = el("pe-reg");
    if (!ev || !o) return;
    var mine = myReg(eid);
    if (!edit && mine) { edit = true; }
    if (!edit && !regState(ev, eid).open) {
      if (hooks.toast) hooks.toast(esc(regState(ev, eid).label) + " for <b>" + esc(ev.title) + "</b>.");
      return;
    }
    formEid = eid; formEdit = !!edit;
    var p = (hooks.profile && hooks.profile()) || {};
    var v = mine || { name: p.name || "", institution: p.inst || "", position: "", affiliation: p.inst || "",
                      title: "", abstract: "", mode: "presentation" };
    el("pe-head").textContent = edit ? "Your registration" : "Register for the poster session";
    el("pe-event").innerHTML = "<b>" + esc(ev.title) + "</b> · " + esc(fmtSpan(ev.startAt, ev.endAt)) +
      (typeof ev.deadline === "number" ? "<br>Register by " + esc(fmtWhen(ev.deadline)) : "");
    ["name", "institution", "position", "affiliation", "title", "abstract"].forEach(function (k) {
      el("pe-" + k).value = v[k] || "";
    });
    el("pe-present").checked = true;
    el("pe-comp").checked = v.mode === "competition";
    el("pe-comp-row").hidden = !ev.allowComp && v.mode !== "competition";
    var hs = halls(ev), sel = el("pe-hall");
    if (edit) {
      sel.innerHTML = '<option value="">' + esc(H(v.hallId).short) + " · Poster " + v.num + "</option>";
      sel.disabled = true;
      el("pe-hall-note").textContent = "Only an administrator can move you to a different stand.";
    } else {
      sel.disabled = false;
      sel.innerHTML = (hs.length > 1 ? '<option value="">Whichever has room</option>' : "") + hs.map(function (h) {
        var n = free(eid, h);
        return '<option value="' + h + '"' + (n ? "" : " disabled") + ">" + esc(H(h).short + " — " + H(h).name) +
          " (" + n + " of " + cap(ev, h) + " free)</option>";
      }).join("");
      el("pe-hall-note").textContent = "You get the next free poster number in the hall" +
        (ev.needsApproval ? ". An administrator confirms each registration." : ".");
    }
    el("pe-go").textContent = edit ? "Save changes" : "Register";
    say("");
    o.hidden = false;
    if (hooks.onOpen) hooks.onOpen();
    setTimeout(function () { el("pe-name").focus(); }, 30);
  };

  function submit() {
    var eid = formEid, ev = events[eid];
    if (!ev) return;
    var f = {};
    ["name", "institution", "position", "affiliation", "title", "abstract"].forEach(function (k) { f[k] = el("pe-" + k).value.trim(); });
    if (!f.name) return say("Add your name.");
    if (!f.institution) return say("Add your university or institution.");
    if (!f.position) return say("Add your position — e.g. PhD student, postdoc, professor.");
    if (!f.title) return say("Add your poster's title.");
    if (f.abstract.length > 1500) return say("The abstract is " + f.abstract.length + " characters; keep it under 1500.");
    if (!el("pe-present").checked) return say("Tick “Participate in Poster Presentation” to register.");
    f.mode = el("pe-comp").checked ? "competition" : "presentation";
    var go = el("pe-go");
    go.disabled = true;
    say(formEdit ? "Saving…" : "Finding you a stand…", true);
    var job = formEdit ? Net.updateMyPosterReg(eid, f) : Net.registerForPosterEvent(eid, f, el("pe-hall").value);
    job.then(function (res) {
      go.disabled = false;
      closeForm();
      if (!hooks.toast) return;
      if (formEdit || !res) { hooks.toast("Registration updated."); return; }
      hooks.toast("🎉 Registered for <b>" + esc(ev.title) + "</b>. You are <b>Poster " + res.num + "</b> in " +
        esc(H(res.hallId).short) + (ev.needsApproval ? " — awaiting an administrator's approval." :
        ". Open the event on the Notice Board to upload your poster."));
    }, function (e) {
      go.disabled = false;
      say((e && e.message) || "That did not go through — try again.");
    });
  }

  /* ============================================== requests to organise one */
  function isAdminNow() { return wantAdmin; }
  /* The Notice Board's own button: residents ask, administrators create. */
  api.boardButton = function () {
    if (!api.live()) return "";
    return isAdminNow()
      ? '<button type="button" class="btn small ghost" data-pe="adminnew">New poster event</button>'
      : '<button type="button" class="btn small ghost" data-pe="request">Request a poster event</button>';
  };
  api.setAdmin = function (v) {
    wantAdmin = !!v;
    if (!Net) return;
    if (wantAdmin) startAdmin(); else stopAdmin();
  };
  function startAdmin() {
    if (reqWatch || !Net.watchPosterEventRequests) return;
    reqFirst = true;
    reqWatch = Net.watchPosterEventRequests(function (m) {
      m = m || {};
      if (!reqFirst && hooks.toast) {
        var fresh = Object.keys(m).filter(function (id) { return !allReqs[id] && m[id].status === "pending"; });
        if (fresh.length) {
          var r = m[fresh[fresh.length - 1]];
          hooks.toast("\uD83D\uDCCB New poster event request: <b>" + esc(r.title) + "</b> from " + esc(r.name) +
                      ". Open Administration → Poster events.");
        }
      }
      reqFirst = false;
      allReqs = m;
      changed();
    });
  }
  function stopAdmin() {
    if (reqWatch) { try { reqWatch(); } catch (e) {} }
    reqWatch = null; allReqs = {};
  }
  api.pendingRequests = function () {
    return Object.keys(allReqs).filter(function (id) { return allReqs[id].status === "pending"; }).length;
  };

  function noticeMyReqs(m) {
    if (prevMyReqs && hooks.toast) {
      Object.keys(m).forEach(function (id) {
        var a = prevMyReqs[id], b = m[id];
        if (!a || !b || a.status === b.status) return;
        if (b.status === "approved") hooks.toast("\u2705 Your poster event <b>" + esc(b.title) + "</b> was approved. " +
          "It is on the Notice Board and residents can register.");
        else if (b.status === "rejected") hooks.toast("Your poster event request <b>" + esc(b.title) + "</b> was not approved" +
          (b.note ? ": " + esc(b.note) : "."));
      });
    }
    prevMyReqs = m;
  }

  /* Rows for the board's "My requests" tab. */
  api.myRequests = function () {
    return Object.keys(myReqs).map(function (id) {
      var q = myReqs[id];
      return { at: q.createdAt || 0, html:
        '<article class="nb-req st-' + esc(q.status) + '"><span class="nb-kind">Poster event request</span>' +
        '<span class="nb-st">' + esc(REQ_STATUS[q.status] || q.status) + "</span>" +
        "<h4>" + esc(q.title) + "</h4>" +
        '<p class="nb-when"><span>' + esc(VENUES[q.venue] || q.venue) + "</span><span>" + esc(fmtSpan(q.startAt, q.endAt)) + "</span></p>" +
        (q.status === "rejected" && q.note ? '<p class="pq-note">Administrator: ' + esc(q.note) + "</p>" : "") +
        '<div class="pe-acts">' +
          '<button type="button" class="btn small ghost" data-pe="pdf" data-rid="' + esc(id) + '">Download PDF</button>' +
          (q.status === "pending" ? '<button type="button" class="btn small ghost" data-pe="withdraw" data-rid="' + esc(id) + '">Withdraw</button>' : "") +
          (q.status === "approved" && q.eventId && events[q.eventId]
            ? '<button type="button" class="btn small ghost" data-pe="view" data-eid="' + esc(q.eventId) + '">View on the board</button>' : "") +
        "</div></article>" };
    });
  };

  /* ---- the form ---- */
  function wireReqForm() {
    var form = el("pq-form");
    if (!form || form._wired) return;
    form._wired = true;
    form.addEventListener("submit", function (e) { e.preventDefault(); sendRequest(); });
    el("pq-cancel").addEventListener("click", closeRequest);
    el("pereq").addEventListener("click", function (e) { if (e.target === el("pereq")) closeRequest(); });
    el("pq-venue").addEventListener("change", paintVenue);
    ["start-date", "start-time", "end-date", "end-time", "deadline-date", "deadline-time"].forEach(function (k) {
      el("pq-" + k).addEventListener("change", function () { settleDates(k); });
      el("pq-" + k).addEventListener("input", function () { paintWhen(); });
    });
    /* a field put right stops being marked */
    form.addEventListener("input", function (e) { if (e.target.classList) e.target.classList.remove("bad"); });
    form.addEventListener("change", function (e) { if (e.target.classList) e.target.classList.remove("bad"); });
  }
  var VENUE_STANDS = { "poster-hall": 12, "poster-hall-2": 50, both: 62, virtual: 62, other: 62 };
  function paintVenue() {
    var v = el("pq-venue").value, need = v === "virtual" || v === "other", max = VENUE_STANDS[v] || 62;
    el("pq-vd-tag").textContent = need ? "required" : "optional";
    el("pq-vd-tag").classList.toggle("req", need);
    el("pq-venueDetail").placeholder = v === "virtual" ? "Meeting link or platform" : v === "other" ? "Where it will be held"
      : "A room or meeting point, if any";
    el("pq-vd-hint").textContent = v === "virtual" ? "Posters are still shown in the village; the link is for the talks and discussion."
      : v === "other" ? "Posters are still shown in the village; say where the rest of the event happens." : "";
    el("pq-posters").max = String(max);
    el("pq-posters").placeholder = "1–" + max;
  }
  /* Keep the three moments sensible as they are chosen: an end that is not
     after the start moves to three hours after it, a deadline date gets a
     time, and the summary underneath says what has been picked. */
  function settleDates(changed) {
    var st = readPair(el("pq-start-date"), el("pq-start-time"));
    var en = readPair(el("pq-end-date"), el("pq-end-time"));
    if (/^start/.test(changed) && st.ms != null) {
      if (!el("pq-end-date").value || (en.ms != null && en.ms <= st.ms)) {
        var e3 = st.ms + 3 * 3600000;
        el("pq-end-date").value = dayOf(e3);
        el("pq-end-time").innerHTML = timeOptions(hmOf(e3), "Choose…");
      }
      el("pq-end-date").min = el("pq-start-date").value;
      el("pq-deadline-date").max = el("pq-start-date").value;
    }
    if (changed === "end-date" && el("pq-end-date").value && !el("pq-end-time").value && st.ms != null) {
      el("pq-end-time").value = hmOf(st.ms + 3 * 3600000);
    }
    if (changed === "deadline-date") {
      if (el("pq-deadline-date").value && !el("pq-deadline-time").value) {
        el("pq-deadline-time").value = st.ms != null && el("pq-deadline-date").value === el("pq-start-date").value
          ? hmOf(st.ms - 3600000) : "23:45";
      }
      if (!el("pq-deadline-date").value) el("pq-deadline-time").value = "";
    }
    paintWhen();
  }
  function paintWhen() {
    var box = el("pq-when");
    if (!box) return;
    var st = readPair(el("pq-start-date"), el("pq-start-time"));
    var en = readPair(el("pq-end-date"), el("pq-end-time"));
    var dl = readPair(el("pq-deadline-date"), el("pq-deadline-time"));
    var msg = "", bad = false;
    if (st.ms == null || en.ms == null) {
      msg = st.ms == null ? pairProblem(st, "start") : pairProblem(en, "end");
      bad = st.err !== "empty" || en.err !== "empty";
      if (!bad) msg = "";
    } else if (st.ms <= now()) { msg = "That start is in the past — choose a later date or time."; bad = true; }
    else if (en.ms <= st.ms) { msg = "The end has to be after the start."; bad = true; }
    else {
      msg = "\uD83D\uDCC5 " + spanText(st.ms, en.ms);
      if (dl.ms != null) {
        if (dl.ms <= now()) { msg += " · the registration deadline is in the past"; bad = true; }
        else if (dl.ms > en.ms) { msg += " · the deadline is after the event ends"; bad = true; }
        else msg += " · registration closes " + fmtWhen(dl.ms);
      } else if (dl.err !== "empty") { msg += " · " + pairProblem(dl, "deadline").toLowerCase(); bad = true; }
    }
    box.textContent = msg;
    box.classList.toggle("no", bad);
  }
  function fillDates() {
    var tomorrow = new Date(now() + 86400000);
    var st = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 10, 0).getTime();
    var keepS = readPair(el("pq-start-date"), el("pq-start-time")), keepE = readPair(el("pq-end-date"), el("pq-end-time"));
    var keepD = readPair(el("pq-deadline-date"), el("pq-deadline-time"));
    var s0 = keepS.ms != null ? keepS.ms : st, e0 = keepE.ms != null ? keepE.ms : s0 + 3 * 3600000;
    el("pq-start-date").value = dayOf(s0);
    el("pq-start-time").innerHTML = timeOptions(hmOf(s0), "Choose…");
    el("pq-end-date").value = dayOf(e0);
    el("pq-end-time").innerHTML = timeOptions(hmOf(e0), "Choose…");
    el("pq-deadline-date").value = keepD.ms != null ? dayOf(keepD.ms) : "";
    el("pq-deadline-time").innerHTML = timeOptions(keepD.ms != null ? hmOf(keepD.ms) : "", "—");
    var today = dayOf(now());
    ["pq-start-date", "pq-end-date", "pq-deadline-date"].forEach(function (k) { el(k).min = today; });
    el("pq-end-date").min = el("pq-start-date").value;
    el("pq-deadline-date").max = el("pq-start-date").value;
    paintWhen();
  }
  api.requestOpen = function () { var o = el("pereq"); return !!(o && !o.hidden); };
  function closeRequest() {
    var o = el("pereq");
    if (!o || o.hidden) return;
    o.hidden = true;
    if (hooks.onClose) hooks.onClose();
  }
  api.closeRequest = closeRequest;
  function pqSay(msg, ok) { var e = el("pq-err"); e.textContent = msg || ""; e.hidden = !msg; e.classList.toggle("ok", !!ok); }
  api.openRequest = function () {
    var o = el("pereq");
    if (!o || !api.live()) return;
    var p = (hooks.profile && hooks.profile()) || {}, u = (Net.user && Net.user()) || {};
    if (!el("pq-name").value) el("pq-name").value = p.name || "";
    if (!el("pq-institution").value) el("pq-institution").value = p.inst || "";
    if (!el("pq-email").value) el("pq-email").value = u.email || "";
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    el("pq-tz").textContent = "Times are in your own time zone" + (tz ? " (" + tz + ")" : "") +
      ". The deadline, if you set one, is when registration for the posters closes.";
    paintVenue();
    fillDates();
    Array.prototype.forEach.call(el("pq-form").querySelectorAll(".bad"), function (x) { x.classList.remove("bad"); });
    pqSay("");
    o.hidden = false;
    el("pq-form").scrollTop = 0;
    if (hooks.onOpen) hooks.onOpen();
    setTimeout(function () { el("pq-title").focus(); }, 30);
  };

  function sendRequest() {
    var g = function (k) { return el("pq-" + k).value.trim(); };
    var f = {
      name: g("name"), institution: g("institution"), email: g("email"), position: g("position"),
      title: g("title"), topic: g("topic"), description: g("description"), venue: el("pq-venue").value,
      venueDetail: g("venueDetail"), abstract: g("abstract"), responsibilities: g("responsibilities"),
      extra: g("extra"), other: g("other"),
      posters: parseInt(el("pq-posters").value, 10) || 0, comp: el("pq-comp").checked
    };
    try { f.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { f.tz = ""; }
    var st = readPair(el("pq-start-date"), el("pq-start-time")), en = readPair(el("pq-end-date"), el("pq-end-time"));
    var dl = readPair(el("pq-deadline-date"), el("pq-deadline-time"));
    f.startAt = st.ms != null ? st.ms : null;
    f.endAt = en.ms != null ? en.ms : null;
    f.deadline = dl.ms != null ? dl.ms : null;
    var pairField = function (r, base) { return base + (r.err === "notime" ? "-time" : "-date"); };
    var bad = !f.name ? ["Add your name.", "name"]
      : !f.institution ? ["Add your institution or organisation.", "institution"]
      : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email) ? ["Add an email address the administrators can reach you at.", "email"]
      : !f.position ? ["Add your position or role.", "position"]
      : !f.title ? ["Give the event a title.", "title"]
      : !f.topic ? ["Say what the topic is.", "topic"]
      : !f.description ? ["Describe the event.", "description"]
      : f.startAt == null ? [pairProblem(st, "start"), pairField(st, "start")]
      : f.endAt == null ? [pairProblem(en, "end"), pairField(en, "end")]
      : f.startAt <= now() ? ["The start has to be in the future.", "start-date"]
      : f.endAt <= f.startAt ? ["The end has to be after the start.", "end-time"]
      : f.deadline == null && dl.err !== "empty" ? [pairProblem(dl, "registration deadline"), pairField(dl, "deadline")]
      : f.deadline != null && f.deadline > f.endAt ? ["The registration deadline should be before the event ends.", "deadline-date"]
      : (f.venue === "virtual" || f.venue === "other") && !f.venueDetail ? ["Say where it will be held.", "venueDetail"]
      : f.deadline != null && f.deadline <= now() ? ["The registration deadline has to be in the future.", "deadline-date"]
      : el("pq-posters").value && (!f.posters || f.posters < 1 || f.posters > (VENUE_STANDS[f.venue] || 62))
        ? ["Expected posters: between 1 and " + (VENUE_STANDS[f.venue] || 62) + " for that venue.", "posters"]
      : !f.responsibilities ? ["Describe what you will do as organiser.", "responsibilities"]
      : !el("pq-agree").checked ? ["Tick the box to agree to the organiser responsibilities.", "agree"] : null;
    if (bad) {
      pqSay(bad[0]);
      var fe = el("pq-" + bad[1]);
      if (fe) {
        if (fe.type !== "checkbox") fe.classList.add("bad");
        fe.focus();
        if (fe.scrollIntoView) fe.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return;
    }
    if (f.deadline == null) delete f.deadline;
    if (!f.posters) delete f.posters;
    var go = el("pq-go"), id = Net.newPosterEventRequestId();
    go.disabled = true;
    pqSay("Preparing the PDF…", true);
    var rec = Object.assign({}, f, { status: "pending", createdAt: Date.now() });
    makePdf(rec, id).catch(function (e) {
      console.warn("[events] PDF", e);
      return null;
    }).then(function (pdf) {
      pqSay("Sending…", true);
      return Net.requestPosterEvent(id, f, pdf).then(function () { return pdf; });
    }).then(function (pdf) {
      go.disabled = false;
      closeRequest();
      el("pq-form").reset();
      paintVenue();
      if (hooks.toast) hooks.toast("\uD83D\uDCCB Request sent. An administrator will review <b>" + esc(f.title) + "</b>" +
        (pdf ? " — your PDF copy is under Notice Board → My requests." : ". (The PDF could not be made; the administrators can generate it.)"));
    }, function (e) {
      go.disabled = false;
      pqSay((e && e.message) || "That did not go through — try again.");
    });
  }

  /* ---- the PDF ----
     jsPDF, from cdnjs, loaded the first time one is needed. Its built-in
     fonts cover Western European text; anything else (Greek letters in a
     title, say) is spelled out rather than dropped. The request itself
     keeps every character exactly as typed. */
  var jsPdfLib = null;
  function jspdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (jsPdfLib) return jsPdfLib;
    jsPdfLib = new Promise(function (res, rej) {
      var sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      sc.onload = function () { window.jspdf && window.jspdf.jsPDF ? res(window.jspdf.jsPDF) : rej(new Error("jsPDF did not start")); };
      sc.onerror = function () { jsPdfLib = null; rej(new Error("could not fetch jsPDF")); };
      document.head.appendChild(sc);
    });
    return jsPdfLib;
  }
  var GREEK = "αalpha βbeta γgamma δdelta εepsilon ζzeta ηeta θtheta ιiota κkappa λlambda μmu νnu ξxi οomicron πpi ρrho σsigma ςsigma τtau υupsilon φphi χchi ψpsi ωomega";
  var GREEK_MAP = {};
  GREEK.split(" ").forEach(function (w) { var c = w.charAt(0); GREEK_MAP[c] = w.slice(1); GREEK_MAP[c.toUpperCase()] = w.charAt(1).toUpperCase() + w.slice(2); });
  var WIN = "\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178";
  function pdfText(t) {
    return String(t == null ? "" : t).normalize("NFC").replace(/[\u0391-\u03C9]+/g, function (run) {
      return run.split("").map(function (c) { return GREEK_MAP[c] || c; }).join(" ");
    }).replace(/[^\n\t\x20-\x7E\xA0-\xFF]/g, function (ch) {
      if (WIN.indexOf(ch) >= 0) return ch;
      if (GREEK_MAP[ch]) return GREEK_MAP[ch];
      var d = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      return /^[\x20-\x7E]+$/.test(d) ? d : "?";
    });
  }
  function makePdf(q, id) {
    return jspdf().then(function (JsPDF) {
      var doc = new JsPDF({ unit: "mm", format: "a4" });
      var W = 210, M = 18, y = 0, CW = W - 2 * M;
      var INK = [26, 43, 40], MUTED = [96, 110, 106], GOLD = [184, 134, 47], LINE = [214, 208, 192];
      function band() {
        doc.setFillColor(31, 61, 54); doc.rect(0, 0, W, 30, "F");
        doc.setTextColor(232, 176, 75); doc.setFont("helvetica", "bold"); doc.setFontSize(8.5);
        doc.text("QUANTUM VILLAGE", M, 12, { charSpace: 0.8 });
        doc.setTextColor(244, 235, 216); doc.setFont("times", "normal"); doc.setFontSize(19);
        doc.text("Poster Event Request", M, 23);
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(217, 224, 210);
        doc.text("Request " + String(id || "").slice(-8).toUpperCase(), W - M, 12, { align: "right" });
        doc.text("Status: " + (REQ_STATUS[q.status] || q.status || "Pending"), W - M, 17.5, { align: "right" });
        doc.text("Submitted " + fmtWhen(q.createdAt || Date.now()), W - M, 23, { align: "right" });
        y = 40;
      }
      function room(h) { if (y + h > 280) { doc.addPage(); y = 20; } }
      function section(t) {
        room(14);
        y += 2;
        doc.setTextColor.apply(doc, GOLD); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
        doc.text(pdfText(t).toUpperCase(), M, y, { charSpace: 0.5 });
        doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.3); doc.line(M, y + 1.8, W - M, y + 1.8);
        y += 7;
      }
      function row(label, value) {
        if (value == null || value === "") return;
        doc.setFont("helvetica", "normal"); doc.setFontSize(10);
        var lines = doc.splitTextToSize(pdfText(value), CW - 46);
        room(lines.length * 5 + 2);
        doc.setTextColor.apply(doc, MUTED); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
        doc.text(pdfText(label), M, y);
        doc.setTextColor.apply(doc, INK); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
        lines.forEach(function (ln, i) { if (i) room(5); doc.text(ln, M + 46, y); y += 5; });
        y += 1.5;
      }
      function para(label, value) {
        if (!value) return;
        section(label);
        doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor.apply(doc, INK);
        String(value).split(/\n/).forEach(function (p) {
          var lines = doc.splitTextToSize(pdfText(p) || " ", CW);
          lines.forEach(function (ln) { room(5.2); doc.text(ln, M, y); y += 5.2; });
          y += 1.2;
        });
      }
      band();
      section("Organiser");
      row("Name", q.name); row("Institution", q.institution); row("Position / role", q.position); row("Email", q.email);
      section("Event");
      row("Title", q.title); row("Topic", q.topic);
      row("Date and time", fmtSpan(q.startAt, q.endAt) + (q.tz ? " (" + q.tz + ")" : ""));
      if (typeof q.deadline === "number") row("Registration deadline", fmtWhen(q.deadline));
      row("Venue", (VENUES[q.venue] || q.venue) + (q.venueDetail ? " — " + q.venueDetail : ""));
      if (q.posters) row("Expected posters", String(q.posters));
      row("Competition", q.comp ? "Yes — include a Poster Presentation Competition" : "No");
      para("Event description", q.description);
      para("Short abstract", q.abstract);
      para("Organiser responsibilities", q.responsibilities);
      para("Additional information", q.extra);
      para("Other event details", q.other);
      if (q.status && q.status !== "pending") {
        section("Decision");
        row("Status", REQ_STATUS[q.status] || q.status);
        if (q.decidedAt) row("Decided", fmtWhen(q.decidedAt));
        if (q.note) row("Note", q.note);
      }
      var n = doc.getNumberOfPages();
      for (var i = 1; i <= n; i++) {
        doc.setPage(i);
        doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor.apply(doc, MUTED);
        doc.text("Quantum Village · poster event request " + String(id || "").slice(-8).toUpperCase(), M, 290);
        doc.text("Page " + i + " of " + n, W - M, 290, { align: "right" });
      }
      return doc.output("datauristring");
    }).then(function (uri) {
      /* jsPDF names the file inside the data URL; the rules want it plain */
      return "data:application/pdf;base64," + uri.slice(uri.indexOf("base64,") + 7);
    });
  }
  api.makePdf = makePdf;

  /* The stored PDF if there is one; otherwise made now from the request. */
  function downloadPdf(id, btn) {
    var q = myReqs[id] || allReqs[id];
    if (!q) return;
    if (btn) btn.disabled = true;
    Net.getPosterEventRequestPdf(id).then(function (rec) {
      return rec && rec.d ? rec.d : makePdf(q, id);
    }).then(function (uri) {
      var bin = atob(uri.slice(uri.indexOf(",") + 1)), buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
      var a = document.createElement("a");
      a.href = url;
      a.download = "poster-event-request-" + String(q.title || "event").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) +
                   "-" + String(id).slice(-6).toLowerCase() + ".pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    }).catch(function (e) {
      if (hooks.toast) hooks.toast("<b>The PDF could not be opened</b> — " + esc((e && e.message) || "try again."));
    }).then(function () { if (btn) btn.disabled = false; });
  }
  api.downloadPdf = downloadPdf;

  /* ============================================================ admin pane */
  var adminEid = null, adminEdit = null, adminFilter = "all", adminHost = null, reqFilter = "pending";

  function reqRow(id) {
    var q = allReqs[id], st = q.status || "pending";
    function long(label, v) { return v ? '<div class="pq-long"><b>' + esc(label) + '</b><div class="rep-msg">' + esc(v) + "</div></div>" : ""; }
    return '<li class="adm-report pq-req st-' + (st === "pending" ? "new" : st === "approved" ? "reviewing" : "dismissed") +
      '" data-rid="' + esc(id) + '">' +
      '<div class="rep-top"><b class="rep-id">REQUEST #' + esc(String(id).slice(-6).toUpperCase()) + "</b>" +
        '<span class="rep-status">' + esc(REQ_STATUS[st] || st) + "</span></div>" +
      '<h4 class="bk-topic">' + esc(q.title) + "</h4>" +
      '<dl class="rep-meta">' +
        "<dt>Organiser</dt><dd>" + esc(q.name) + "</dd>" +
        "<dt>Institution</dt><dd>" + esc(q.institution) + "</dd>" +
        "<dt>Position</dt><dd>" + esc(q.position) + "</dd>" +
        '<dt>Email</dt><dd><a href="mailto:' + esc(q.email) + '">' + esc(q.email) + "</a></dd>" +
        "<dt>Topic</dt><dd>" + esc(q.topic) + "</dd>" +
        "<dt>When</dt><dd>" + esc(fmtSpan(q.startAt, q.endAt)) + (q.tz ? ' <span class="rep-uid">' + esc(q.tz) + "</span>" : "") + "</dd>" +
        (typeof q.deadline === "number" ? "<dt>Deadline</dt><dd>" + esc(fmtWhen(q.deadline)) + "</dd>" : "") +
        "<dt>Venue</dt><dd>" + esc(VENUES[q.venue] || q.venue) + (q.venueDetail ? " — " + esc(q.venueDetail) : "") + "</dd>" +
        (q.posters ? "<dt>Expected posters</dt><dd>" + esc(String(q.posters)) + "</dd>" : "") +
        "<dt>Competition</dt><dd>" + (q.comp ? "Yes" : "No") + "</dd>" +
        "<dt>Submitted</dt><dd>" + esc(fmtWhen(q.createdAt)) + ' <span class="rep-uid">' + esc(q.userId) + "</span></dd>" +
        (q.decidedAt ? "<dt>Decided</dt><dd>" + esc(fmtWhen(q.decidedAt)) + "</dd>" : "") +
        (q.note ? "<dt>Note</dt><dd>" + esc(q.note) + "</dd>" : "") +
      "</dl>" +
      long("Event description", q.description) + long("Short abstract", q.abstract) +
      long("Organiser responsibilities", q.responsibilities) + long("Additional information", q.extra) +
      long("Other event details", q.other) +
      '<div class="rep-acts">' +
        '<button class="btn small ghost" type="button" data-pq="pdf">Download PDF</button>' +
        (st === "pending" ? '<button class="btn small" type="button" data-pq="approve">Approve…</button>' +
          '<button class="btn small ghost danger" type="button" data-pq="reject">Reject</button>' : "") +
        (st === "approved" && q.eventId && events[q.eventId] ? '<button class="btn small ghost" type="button" data-pq="event">Open the event</button>' : "") +
        '<button class="btn small ghost danger" type="button" data-pq="delete">Delete</button>' +
      "</div></li>";
  }

  api.adminRender = function (host) {
    adminHost = host || adminHost;
    if (!adminHost) return;
    if (!api.live()) { adminHost.innerHTML = '<p class="fine">Poster events need the live village.</p>'; return; }
    if (adminEdit) { adminHost.innerHTML = eventForm(adminEdit); return; }
    if (adminEid && events[adminEid]) { adminHost.innerHTML = manageView(adminEid); return; }
    adminEid = null;
    var ids = Object.keys(events).sort(function (a, b) { return events[b].startAt - events[a].startAt; });
    var rids = Object.keys(allReqs).filter(function (id) {
      return reqFilter === "all" || allReqs[id].status === reqFilter;
    }).sort(function (a, b) { return (allReqs[b].createdAt || 0) - (allReqs[a].createdAt || 0); });
    adminHost.innerHTML =
      '<div class="pe-subhead"><h4 class="adm-sec-title">Requests to organise a poster event</h4>' +
        '<select class="field" data-pq-filter="1" aria-label="Show requests">' +
        [["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["all", "All"]].map(function (o) {
          return '<option value="' + o[0] + '"' + (o[0] === reqFilter ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("") + "</select></div>" +
      (rids.length ? '<ul class="adm-list">' + rids.map(reqRow).join("") + "</ul>"
        : '<p class="adm-empty fine">' + (reqFilter === "pending" ? "No requests are waiting." : "Nothing here with that status.") + "</p>") +
      '<div class="pe-subhead"><h4 class="adm-sec-title">Poster events</h4>' +
        '<button class="btn small" type="button" data-pa="new">+ New poster event</button></div>' +
      (ids.length ? '<ul class="adm-list">' + ids.map(eventRow).join("") + "</ul>"
        : '<p class="adm-empty fine">No poster events yet. Create one and it goes on the Notice Board for residents to register.</p>');
  };
  api.adminRefresh = function () { if (adminHost && adminHost.offsetParent !== null && !adminEdit) api.adminRender(); };
  /* For the admin panel's Notice Board tab, which lists every event on the
     board: where a poster session stands, and a way into its management. */
  api.boardInfo = function (eid) {
    var ev = events[eid];
    if (!ev) return null;
    var t = now(), st = regState(ev, eid);
    var group = ev.status === "cancelled" ? "cancelled" : over(ev) ? "archived" : ev.startAt <= t ? "now" : "upcoming";
    var all = regs[eid] || {}, n = Object.keys(all).filter(function (u) { return all[u].status !== "rejected"; }).length;
    return {
      ev: ev, group: group, reg: st.label, open: ev.status === "open", registered: n,
      halls: halls(ev).map(function (h) { return H(h).short + ": " + taken(eid, h) + " of " + cap(ev, h) + " taken"; }).join(" · "),
      when: fmtSpan(ev.startAt, ev.endAt), deadline: typeof ev.deadline === "number" ? fmtWhen(ev.deadline) : ""
    };
  };
  api.adminGoto = function (eid, mode) {
    adminEdit = mode === "edit" ? eid : null;
    adminEid = mode === "manage" ? eid : null;
    pickCurrent();
  };

  /* From the Notice Board: an administrator's "New poster event". */
  api.adminNew = function () { adminEdit = "new"; adminEid = null; };

  function stats(eid) {
    var all = regs[eid] || {}, ev = events[eid], o = { total: 0, pending: 0, comp: 0, rejected: 0, up: 0 };
    Object.keys(all).forEach(function (u) {
      var r = all[u];
      if (r.status === "rejected") { o.rejected++; return; }
      o.total++;
      if (r.status === "pending") o.pending++;
      if (r.mode === "competition") o.comp++;
      if (hasPoster(eid, u)) o.up++;
    });
    o.halls = halls(ev).map(function (h) { return H(h).short + ": " + taken(eid, h) + "/" + cap(ev, h); }).join(" · ");
    return o;
  }

  function eventRow(eid) {
    var ev = events[eid], s = stats(eid), st = regState(ev, eid);
    return '<li class="adm-report st-' + (st.open ? "new" : "resolved") + '" data-eid="' + esc(eid) + '">' +
      '<div class="rep-top"><b class="rep-id">Poster event</b><span class="rep-status">' + esc(ev.status === "open" && !st.open ? st.label : ev.status) + "</span></div>" +
      '<h4 class="bk-topic">' + esc(ev.title) + "</h4>" +
      '<dl class="rep-meta">' +
        "<dt>When</dt><dd>" + esc(fmtSpan(ev.startAt, ev.endAt)) + "</dd>" +
        (typeof ev.deadline === "number" ? "<dt>Deadline</dt><dd>" + esc(fmtWhen(ev.deadline)) + "</dd>" : "") +
        "<dt>Stands</dt><dd>" + esc(s.halls) + "</dd>" +
        "<dt>Registered</dt><dd>" + s.total + (s.pending ? " · " + s.pending + " awaiting approval" : "") +
          (ev.allowComp ? " · 🏆 " + s.comp + " competition" : "") + "</dd>" +
      "</dl>" +
      '<div class="rep-acts">' +
        '<button class="btn small" type="button" data-pa="manage">Participants</button>' +
        '<button class="btn small ghost" type="button" data-pa="edit">Edit</button>' +
        (ev.status === "open" ? '<button class="btn small ghost" type="button" data-pa="close">Close registration</button>'
          : ev.status === "closed" ? '<button class="btn small ghost" type="button" data-pa="open">Open registration</button>' : "") +
        '<button class="btn small ghost danger" type="button" data-pa="delete">Delete</button>' +
      "</div></li>";
  }

  /* ---- a date box and a list of quarter hours, read together ---- */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function dayOf(ms) {
    if (typeof ms !== "number") return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function hmOf(ms) { if (typeof ms !== "number") return ""; var d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function joinDT(day, hm) {
    var a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || ""), b = /^(\d{2}):(\d{2})$/.exec(hm || "");
    if (!a || !b) return null;
    var t = new Date(+a[1], +a[2] - 1, +a[3], +b[1], +b[2]).getTime();
    return isNaN(t) ? null : t;
  }
  function hmLabel(hm) {
    var m = /^(\d{2}):(\d{2})$/.exec(hm);
    return m ? new Date(2000, 0, 1, +m[1], +m[2]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : hm;
  }
  /* every quarter hour, labelled the way this visitor's clock reads; a time
     that is not on a quarter (an older event) is kept as its own entry */
  function timeOptions(selected, placeholder) {
    var out = placeholder != null ? '<option value="">' + esc(placeholder) + "</option>" : "", found = !selected;
    for (var q = 0; q < 96; q++) {
      var hm = pad2(Math.floor(q / 4)) + ":" + pad2((q % 4) * 15);
      if (hm === selected) found = true;
      out += '<option value="' + hm + '"' + (hm === selected ? " selected" : "") + ">" + esc(hmLabel(hm)) + "</option>";
    }
    if (!found) out += '<option value="' + esc(selected) + '" selected>' + esc(hmLabel(selected)) + "</option>";
    return out;
  }
  /* { ms } or { err: "empty" | "nodate" | "notime" | "baddate" } */
  function readPair(dateEl, timeEl) {
    var dv = dateEl.value, tv = timeEl.value;
    if (dateEl.validity && dateEl.validity.badInput) return { err: "baddate" };
    if (!dv && !tv) return { err: "empty" };
    if (!dv) return { err: "nodate" };
    if (!tv) return { err: "notime" };
    var ms = joinDT(dv, tv);
    return ms == null ? { err: "baddate" } : { ms: ms };
  }
  function pairProblem(r, what) {
    return r.err === "nodate" ? "Choose the " + what + " date."
      : r.err === "notime" ? "Choose the " + what + " time."
      : r.err === "baddate" ? "The " + what + " date is not complete — pick it from the calendar."
      : "Choose the " + what + " date and time.";
  }
  function spanText(a, b) {
    var sameDay = new Date(a).toDateString() === new Date(b).toDateString();
    var mins = Math.round((b - a) / 60000), h = Math.floor(mins / 60), m = mins % 60;
    /* over several days: count the calendar days it touches */
    var d0 = new Date(a), d1 = new Date(b);
    var days = Math.round((new Date(d1.getFullYear(), d1.getMonth(), d1.getDate()) -
                           new Date(d0.getFullYear(), d0.getMonth(), d0.getDate())) / 86400000) + 1;
    var dur = !sameDay ? "over " + days + " days"
      : (h ? h + " hour" + (h === 1 ? "" : "s") : "") + (m ? (h ? " " : "") + m + " min" : "");
    return fmtDay(a) + ", " + fmtClock(a) + " – " + (sameDay ? "" : fmtDay(b) + ", ") + fmtClock(b) + " · " + dur;
  }

  /* A request, as the event it would become. */
  function fromRequest(q) {
    var n = q.posters || 0;
    var c1 = q.venue === "poster-hall" || q.venue === "both" || q.venue === "virtual" || q.venue === "other" ? 12 : 0;
    var c2 = q.venue === "poster-hall-2" ? Math.min(50, n || 50) : q.venue === "both" ? Math.min(50, n ? Math.max(1, n - 12) : 50) : 0;
    if (q.venue === "poster-hall") c1 = Math.min(12, n || 12);
    return { title: q.title, description: q.description, topic: q.topic, abstract: q.abstract,
      venue: q.venue === "virtual" || q.venue === "other" ? (VENUES[q.venue] + (q.venueDetail ? ": " + q.venueDetail : "")) : (q.venueDetail || ""),
      startAt: q.startAt, endAt: q.endAt, deadline: q.deadline, cap1: c1, cap2: c2, status: "open",
      allowComp: !!q.comp, needsApproval: false };
  }
  function dtPair(name, label, ms, placeholder, optional) {
    return '<label>' + esc(label) + " date" + (optional ? ' <span class="opt">optional</span>' : "") +
        '<input class="field" type="date" name="' + name + '_d" value="' + dayOf(ms) + '"></label>' +
      '<label>' + esc(label) + ' time<select class="field" name="' + name + '_t">' + timeOptions(hmOf(ms), placeholder) + "</select></label>";
  }
  function eventForm(which) {
    var rq = which.indexOf("req:") === 0 ? allReqs[which.slice(4)] : null;
    var ev = rq ? fromRequest(rq)
      : which === "new" ? { title: "", description: "", cap1: 12, cap2: 50, status: "open", allowComp: true, needsApproval: false }
      : events[which] || {};
    return '<form class="pe-aform" data-pa-form="' + esc(which) + '" novalidate>' +
      '<h4 class="adm-sec-title">' + (rq ? "Approve and publish: " + esc(rq.name) + "'s poster event"
        : which === "new" ? "New poster event" : "Edit poster event") + "</h4>" +
      (rq ? '<p class="fine">Filled in from the request — adjust anything before publishing. Nothing reaches the Notice Board until you press Approve.</p>' : "") +
      '<label>Title<input class="field" name="title" maxlength="160" value="' + esc(ev.title) + '"></label>' +
      '<label>Topic <span class="opt">optional</span><input class="field" name="topic" maxlength="160" value="' + esc(ev.topic || "") + '"></label>' +
      '<label>Description<textarea class="field" name="description" rows="4" maxlength="2000">' + esc(ev.description || "") + "</textarea></label>" +
      '<label>Abstract <span class="opt">optional</span><textarea class="field" name="abstract" rows="3" maxlength="1500">' + esc(ev.abstract || "") + "</textarea></label>" +
      '<label>Venue details <span class="opt">optional — a room, or a virtual link, shown on the board</span><input class="field" name="venue" maxlength="300" value="' + esc(ev.venue || "") + '"></label>' +
      (rq && rq.status !== "pending" ? '<p class="gerr">This request has already been decided.</p>' : "") +
      '<div class="pe-dt">' +
        dtPair("startAt", "Starts", ev.startAt, "Choose…") +
        dtPair("endAt", "Ends", ev.endAt, "Choose…") +
        dtPair("deadline", "Registration deadline", ev.deadline, "—", true) +
      "</div>" +
      '<div class="nb-edit-row">' +
        '<label>Poster Hall 1 capacity <span class="opt">0–12, 0 = not used</span><input class="field" type="number" min="0" max="12" step="1" name="cap1" value="' + (ev.cap1 | 0) + '"></label>' +
        '<label>Poster Hall 2 capacity <span class="opt">0–50, 0 = not used</span><input class="field" type="number" min="0" max="50" step="1" name="cap2" value="' + (ev.cap2 | 0) + '"></label>' +
        '<label>Registration<select class="field" name="status">' + ["open", "closed", "cancelled", "archived"].map(function (s) {
          return '<option value="' + s + '"' + (ev.status === s ? " selected" : "") + ">" + s.charAt(0).toUpperCase() + s.slice(1) + "</option>";
        }).join("") + "</select></label>" +
      "</div>" +
      '<label class="pe-check"><input type="checkbox" name="allowComp"' + (ev.allowComp ? " checked" : "") + "> Accept Poster Presentation Competition entries</label>" +
      '<label class="pe-check"><input type="checkbox" name="needsApproval"' + (ev.needsApproval ? " checked" : "") + "> An administrator approves each registration</label>" +
      '<p class="fine">Hall 1 has 12 stands and Hall 2 has 50. Lowering a capacity never takes a stand away from somebody already registered.</p>' +
      (rq ? '<label>Note to the organiser <span class="opt">optional</span><input class="field" name="note" maxlength="500"></label>' : "") +
      '<div class="rep-acts"><button class="btn small" type="submit">' + (rq ? "Approve and publish" : "Save event") + "</button>" +
      '<button class="btn small ghost" type="button" data-pa="formcancel">Cancel</button></div></form>';
  }

  function manageView(eid) {
    var ev = events[eid], all = regs[eid] || {}, s = stats(eid);
    var rows = Object.keys(all).map(function (u) { return all[u]; }).filter(function (r) {
      if (adminFilter === "all") return true;
      if (adminFilter === "pending") return r.status === "pending";
      if (adminFilter === "competition") return r.mode === "competition" && r.status !== "rejected";
      if (adminFilter === "rejected") return r.status === "rejected";
      if (adminFilter === "uploaded") return hasPoster(eid, r.uid);
      return r.hallId === adminFilter && r.status !== "rejected";
    }).sort(function (a, b) {
      return (a.hallId === b.hallId ? 0 : a.hallId < b.hallId ? -1 : 1) || (a.num || 999) - (b.num || 999);
    });
    var filters = [["all", "All"], ["pending", "Awaiting approval"], ["competition", "Competition"], ["uploaded", "Poster uploaded"],
                   ["poster-hall", "Hall 1"], ["poster-hall-2", "Hall 2"], ["rejected", "Rejected"]];
    return '<div class="adm-filter pe-bar"><button class="btn small ghost" type="button" data-pa="back">← All events</button>' +
      '<select class="field" data-pa-filter="1">' + filters.map(function (f) {
        return '<option value="' + f[0] + '"' + (f[0] === adminFilter ? " selected" : "") + ">" + f[1] + "</option>";
      }).join("") + "</select></div>" +
      '<h4 class="bk-topic">' + esc(ev.title) + "</h4>" +
      '<div class="pe-stats">' +
        stat(s.total, "registered") + halls(ev).map(function (h) { return stat(taken(eid, h) + "/" + cap(ev, h), H(h).short); }).join("") +
        stat(s.comp, "competition") + stat(s.up, "posters up") + stat(s.pending, "awaiting") +
      "</div>" +
      '<div class="pe-halls">' + halls(ev).map(function (h) { return hallGrid(eid, h); }).join("") + "</div>" +
      (rows.length ? '<ul class="adm-list">' + rows.map(function (r) { return regRow(eid, ev, r); }).join("") + "</ul>"
        : '<p class="adm-empty fine">Nobody here.</p>');
  }
  function stat(v, l) { return '<span class="pe-stat"><b>' + esc(String(v)) + "</b>" + esc(l) + "</span>"; }

  function regRow(eid, ev, r) {
    var up = (regPosters[eid] || {})[r.uid];
    var other = HALLS.filter(function (h) { return h !== r.hallId && cap(ev, h) > 0; })[0];
    return '<li class="adm-report st-' + (r.status === "pending" ? "new" : r.status === "rejected" ? "dismissed" : "reviewing") +
      '" data-uid="' + esc(r.uid) + '">' +
      '<div class="rep-top"><b class="rep-id">' + (r.num ? esc(H(r.hallId).short) + " · Poster " + r.num : "No stand") + "</b>" +
        '<span class="rep-status">' + esc(STATUS[r.status] || r.status) + (r.mode === "competition" ? " · 🏆" : "") + "</span></div>" +
      '<h4 class="bk-topic">' + esc(r.title) + "</h4>" +
      '<dl class="rep-meta">' +
        "<dt>Name</dt><dd>" + esc(r.name) + "</dd>" +
        "<dt>Institution</dt><dd>" + esc(r.institution) + "</dd>" +
        "<dt>Position</dt><dd>" + esc(r.position) + "</dd>" +
        (r.affiliation ? "<dt>Affiliation</dt><dd>" + esc(r.affiliation) + "</dd>" : "") +
        "<dt>Entry</dt><dd>" + (r.mode === "competition" ? "Poster presentation + 🏆 competition" : "Poster presentation") + "</dd>" +
        "<dt>Poster</dt><dd>" + (up ? "Uploaded " + esc(fmtWhen(up.at)) : "Not uploaded") + "</dd>" +
        "<dt>Registered</dt><dd>" + esc(fmtWhen(r.createdAt)) + ' <span class="rep-uid">' + esc(r.uid) + "</span></dd>" +
      "</dl>" +
      (r.abstract ? '<div class="rep-msg">' + esc(r.abstract) + "</div>" : "") +
      '<div class="rep-acts">' +
        (r.status === "pending" ? '<button class="btn small" type="button" data-pr="approve">Approve</button>' : "") +
        (r.status !== "rejected" ? '<button class="btn small ghost danger" type="button" data-pr="reject">Reject</button>' : "") +
        (other ? '<button class="btn small ghost" type="button" data-pr="move" data-to="' + other + '">' +
          (r.status === "rejected" ? "Reinstate in " : "Move to ") + esc(H(other).short) + "</button>" : "") +
        (r.status === "rejected" && cap(ev, r.hallId) ? '<button class="btn small ghost" type="button" data-pr="move" data-to="' + r.hallId + '">Reinstate in ' + esc(H(r.hallId).short) + "</button>" : "") +
        (up ? '<button class="btn small ghost" type="button" data-pr="view">View poster</button>' +
              '<button class="btn small ghost danger" type="button" data-pr="unpost">Remove poster</button>' : "") +
        '<button class="btn small ghost danger" type="button" data-pr="remove">Remove registration</button>' +
      "</div></li>";
  }

  /* One listener for the whole pane. */
  api.adminClick = function (e, run) {
    var b = e.target.closest ? e.target.closest("button[data-pa],button[data-pr],button[data-pq]") : null;
    if (!b || b.disabled) return;
    e.preventDefault();
    if (b.dataset.pq) {
      var rli = b.closest("[data-rid]"), rid = rli && rli.dataset.rid, q = rid && allReqs[rid];
      if (!q) return;
      var pq = b.dataset.pq;
      if (pq === "pdf") return downloadPdf(rid, b);
      if (pq === "approve") { adminEdit = "req:" + rid; return api.adminRender(); }
      if (pq === "event") { adminEid = q.eventId; pickCurrent(); return api.adminRender(); }
      if (pq === "reject") {
        var why = window.prompt("Reject \"" + q.title + "\"?\n\nOptionally, say why — the organiser sees this.", "");
        if (why === null) return;
        return run(b, Net.rejectPosterEventRequest(rid, why.trim()), "Rejected \"" + esc(q.title) + "\".");
      }
      if (pq === "delete") {
        if (!window.confirm("Delete the request \"" + q.title + "\" and its PDF for good?" +
            (q.status === "approved" ? "\n\nThe poster event it created stays on the board." : ""))) return;
        return run(b, Net.deletePosterEventRequest(rid), "Deleted the request.");
      }
      return;
    }
    var act = b.dataset.pa, row = b.closest("[data-eid]"), eid = (row && row.dataset.eid) || b.dataset.eid || adminEid;
    if (act === "new") { adminEdit = "new"; return api.adminRender(); }
    if (act === "formcancel") { adminEdit = null; return api.adminRender(); }
    if (act === "back") { adminEid = null; adminFilter = "all"; pickCurrent(); return api.adminRender(); }
    if (act === "manage") { adminEid = eid; pickCurrent(); return api.adminRender(); }
    if (act === "edit") { adminEdit = eid; return api.adminRender(); }
    var ev = events[eid];
    if (act === "open" || act === "close") {
      return run(b, Net.setPosterEventStatus(eid, act === "open" ? "open" : "closed"),
                 act === "open" ? "Registration is open." : "Registration is closed.");
    }
    if (act === "delete") {
      if (!window.confirm("Delete \"" + ev.title + "\"?\n\nEvery registration, poster number and uploaded poster for it is " +
                          "removed for good. To keep the record, set it to Cancelled or Archived instead.")) return;
      if (window.prompt("Type DELETE to confirm.", "") !== "DELETE") return;
      return run(b, Net.deletePosterEvent(eid), "Deleted \"" + esc(ev.title) + "\".");
    }
    var pr = b.dataset.pr, li = b.closest("[data-uid]"), uid = li && li.dataset.uid, r = uid && (regs[adminEid] || {})[uid];
    if (!pr || !r) return;
    var who = r.name + " (" + (r.num ? H(r.hallId).short + ", Poster " + r.num : "no stand") + ")";
    if (pr === "approve") return run(b, Net.setPosterRegStatus(adminEid, uid, r, "approved"), "Approved " + esc(who) + ".");
    if (pr === "reject") {
      if (!window.confirm("Reject " + who + "?\n\nTheir poster number is freed and any poster they pinned comes down.")) return;
      return run(b, Net.setPosterRegStatus(adminEid, uid, r, "rejected"), "Rejected " + esc(r.name) + ".");
    }
    if (pr === "move") {
      return run(b, Net.movePosterReg(adminEid, uid, r, b.dataset.to).then(function (res) {
        return esc(r.name) + " is now Poster " + res.num + " in " + esc(H(res.hallId).short) + ".";
      }), "Moved.");
    }
    if (pr === "remove") {
      if (!window.confirm("Remove " + who + "'s registration?\n\nTheir number is freed; nobody else's number changes.")) return;
      return run(b, Net.cancelPosterReg(adminEid, uid, r), "Removed " + esc(r.name) + ".");
    }
    if (pr === "unpost") {
      if (!window.confirm("Take down " + r.name + "'s poster?\n\nThey keep their stand and can pin a new one.")) return;
      return run(b, Net.removeRegPoster(adminEid, uid), "Poster taken down.");
    }
    if (pr === "view") {
      var p = (regPosters[adminEid] || {})[uid];
      if (!p) return;
      var w = window.open("", "_blank");
      if (w) {
        w.document.title = r.title;
        var im = w.document.createElement("img");
        im.src = p.s; im.style.maxWidth = "100%";
        w.document.body.appendChild(im);
      }
    }
  };
  api.adminChange = function (e) {
    if (e.target.dataset.paFilter) { adminFilter = e.target.value; api.adminRender(); }
    if (e.target.dataset.pqFilter) { reqFilter = e.target.value; api.adminRender(); }
  };
  api.adminSubmit = function (e, run) {
    var form = e.target.closest ? e.target.closest("form[data-pa-form]") : null;
    if (!form) return;
    e.preventDefault();
    var which = form.dataset.paForm, g = function (n) { return form.elements[n]; };
    var f = {
      title: g("title").value.trim(), description: g("description").value.trim(),
      cap1: parseInt(g("cap1").value, 10) || 0, cap2: parseInt(g("cap2").value, 10) || 0,
      status: g("status").value, allowComp: g("allowComp").checked, needsApproval: g("needsApproval").checked,
      topic: g("topic").value.trim(), abstract: g("abstract").value.trim(), venue: g("venue").value.trim()
    };
    var ps = readPair(g("startAt_d"), g("startAt_t")), pe = readPair(g("endAt_d"), g("endAt_t"));
    var pd = readPair(g("deadline_d"), g("deadline_t"));
    f.startAt = ps.ms != null ? ps.ms : null;
    f.endAt = pe.ms != null ? pe.ms : null;
    f.deadline = pd.ms != null ? pd.ms : null;
    var bad = !f.title ? "Give the event a title."
      : f.startAt == null ? pairProblem(ps, "start")
      : f.endAt == null ? pairProblem(pe, "end")
      : f.deadline == null && pd.err !== "empty" ? pairProblem(pd, "registration deadline")
      : f.endAt <= f.startAt ? "The end has to be after the start."
      : f.cap1 < 0 || f.cap1 > 12 || f.cap2 < 0 || f.cap2 > 50 ? "Hall 1 takes 0–12 posters and Hall 2 0–50."
      : f.cap1 + f.cap2 < 1 ? "Give at least one hall some stands."
      : f.deadline != null && f.deadline > f.endAt ? "The deadline should be before the event ends." : "";
    if (bad) { if (hooks.toast) hooks.toast(bad); return; }
    if (f.deadline == null) delete f.deadline;
    var btn = form.querySelector("button[type=submit]");
    if (which.indexOf("req:") === 0) {
      var rid = which.slice(4), q = allReqs[rid];
      if (!q || q.status !== "pending") { if (hooks.toast) hooks.toast("That request has already been decided."); return; }
      var note = g("note") ? g("note").value.trim() : "";
      return run(btn, Net.approvePosterEventRequest(rid, q, f, note).then(function (eid) {
        adminEdit = null;
        adminEid = eid;
        pickCurrent();
        api.adminRender();
        return "Approved. \"" + esc(f.title) + "\" is on the Notice Board.";
      }), "Approved.");
    }
    run(btn, Net.savePosterEvent(which === "new" ? null : which, f).then(function () {
      adminEdit = null;
      api.adminRender();
      return which === "new" ? "Created \"" + esc(f.title) + "\". It is on the Notice Board." : "Saved.";
    }), "Saved.");
  };

  window.QVEvents = api;
})();
