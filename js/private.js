/* Quantum Village — private messages and private voice calls.
 *
 * Click a resident, and their card offers two things besides who they are:
 * a one-to-one message thread and a one-to-one voice call. Both are between
 * the two of you and nobody else.
 *
 * Messages
 * --------
 * Kept in dm/<a>~<b>, which only the two participants can read (net.js and
 * database.rules.json). An unread flag in dmInbox/<me>/<them> drives the
 * badge on the Messages button and on their card; opening the thread clears
 * it. A message to somebody who is offline waits for them.
 *
 * Calls
 * -----
 * Separate from the village mesh in voice.js in every way that matters: one
 * RTCPeerConnection, carrying audio both ways, with its own <audio> element
 * that the village "Hear" switch does not touch. Nothing about a call is
 * written anywhere another resident can read — the handshake goes through
 * the same per-recipient voiceSignal inbox the village uses, under "c-"
 * note types the village ignores.
 *
 *   c-ring   caller -> callee   { id, n }        please pick up
 *   c-acc    callee -> caller   { id }           picked up, send an offer
 *   c-dec    callee -> caller   { id }           declined
 *   c-busy   callee -> caller   { id }           already on a call
 *   c-end    either way         { id, why? }     hung up / cancelled / failed
 *   c-offr   caller -> callee   { id, sdp }      offer (and ICE-restart offers)
 *   c-ans    callee -> caller   { id, sdp }
 *   c-ice    either way         { id, c }
 *
 * While you are in a call your village microphone is closed and stays
 * closed, so a private conversation is never broadcast by accident.
 */
(function () {
  "use strict";

  var api = {};
  var RING_TIMEOUT = 35000;       /* how long a call rings before it is a missed call */
  var CONNECT_TIMEOUT = 20000;    /* accepted, but no audio path yet */
  var RECONNECT_GRACE = 6000;     /* "disconnected" this long before we try an ICE restart */
  var OFFLINE_GRACE = 12000;      /* peer missing from presence this long ends the call */
  var MAX_RESTARTS = 2;

  var hooks = {
    toast: function () {},
    myName: function () { return "Resident"; },
    peerName: function () { return ""; },
    isOnline: function () { return false; }
  };

  function net() { return window.QVNet; }
  function voice() { return window.QVVoice; }
  function rtc() { return (voice() && voice().rtc) || null; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ names */
  var RECENT_LS = "qv-dm-recent";
  var recent = [];                /* [{ u, n, at }] newest first */
  try { recent = JSON.parse(localStorage.getItem(RECENT_LS) || "[]") || []; } catch (e) { recent = []; }
  function remember(uid, name) {
    if (!uid) return;
    var prev = null;
    recent = recent.filter(function (r) { if (r.u === uid) prev = r; return r.u !== uid; });
    recent.unshift({ u: uid, n: name || (prev && prev.n) || "Resident", at: Date.now() });
    recent = recent.slice(0, 12);
    try { localStorage.setItem(RECENT_LS, JSON.stringify(recent)); } catch (e) {}
  }
  function nameOf(uid) {
    var n = hooks.peerName(uid);
    if (n) return n;
    if (inbox[uid] && inbox[uid].n) return inbox[uid].n;
    for (var i = 0; i < recent.length; i++) if (recent[i].u === uid) return recent[i].n;
    return "Resident";
  }

  /* ========================================================= messages */
  var inbox = {};                 /* uid -> { n, p, at } unread from them */
  var toldAt = {};                /* uid -> the inbox 'at' we already toasted */
  var dm = { uid: null, unsub: null, keys: {}, sending: false };

  api.available = function () { return !!(net() && net().dmAvailable && net().dmAvailable()); };
  api.unread = function (uid) { return uid ? !!inbox[uid] : Object.keys(inbox).length; };

  function onInbox(map) {
    inbox = map || {};
    /* the thread that is open on screen is read the moment it arrives */
    if (dm.uid && inbox[dm.uid]) {
      delete inbox[dm.uid];
      net().dmMarkRead(dm.uid);
    }
    Object.keys(inbox).forEach(function (u) {
      var e = inbox[u] || {};
      if (toldAt[u] === e.at) return;
      var first = toldAt[u] === undefined && !booted;
      toldAt[u] = e.at;
      remember(u, e.n);
      if (first) return;          /* what was waiting at sign-in is counted, not shouted */
      hooks.toast("<b>💬 " + esc(e.n || "Someone") + "</b> sent you a private message" +
        (e.p ? '<span class="tsub">' + esc(e.p) + "</span>" : ""));
    });
    booted = true;
    paintBadges();
  }
  var booted = false;

  function paintBadges() {
    var n = Object.keys(inbox).length;
    var b = $("dm-unread");
    if (b) { b.textContent = n > 9 ? "9+" : String(n); b.hidden = !n; }
    var btn = $("dm-open");
    if (btn) btn.classList.toggle("has-unread", !!n);
    if (hooks.onUnread) hooks.onUnread(n);
    if (inboxOpen) renderInbox();
  }

  function dmEl() {
    var el = $("pv-dm");
    if (el) return el;
    el = document.createElement("section");
    el.id = "pv-dm";
    el.className = "pv-win";
    el.setAttribute("role", "dialog");
    el.hidden = true;
    el.innerHTML =
      '<header class="pv-head">' +
        '<div class="pv-who"><span class="eyebrow">🔒 Private messages</span>' +
        '<b class="pv-name"></b><span class="pv-presence"></span></div>' +
        '<button type="button" class="pv-icon" data-pv="call" title="Private voice call" aria-label="Start a private voice call">🎙️</button>' +
        '<button type="button" class="pv-icon" data-pv="close" title="Close" aria-label="Close private messages">✕</button>' +
      "</header>" +
      '<div class="pv-log" role="log" aria-live="polite"></div>' +
      '<form class="pv-form" autocomplete="off">' +
        '<input class="pv-input" type="text" maxlength="1000" aria-label="Private message" />' +
        '<button type="submit" class="btn small">Send</button>' +
      "</form>";
    /* the window's clicks and keys are its own, not the village's */
    ["pointerdown", "keydown", "keyup", "wheel", "touchstart"].forEach(function (t) {
      el.addEventListener(t, function (e) {
        if (t === "keydown" && e.key === "Escape") { closeChat(); return; }
        e.stopPropagation();
      }, t === "wheel" || t === "touchstart" ? { passive: true } : false);
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-pv]");
      if (!b) return;
      if (b.dataset.pv === "close") closeChat();
      else if (b.dataset.pv === "call" && dm.uid) api.startCall(dm.uid, nameOf(dm.uid));
    });
    el.querySelector(".pv-form").addEventListener("submit", function (e) {
      e.preventDefault();
      sendDm();
    });
    document.body.appendChild(el);
    return el;
  }

  function paintDmHead() {
    var el = $("pv-dm");
    if (!el || !dm.uid) return;
    var online = hooks.isOnline(dm.uid);
    el.querySelector(".pv-name").textContent = nameOf(dm.uid);
    var p = el.querySelector(".pv-presence");
    p.textContent = online ? "online" : "offline — they will see it next time";
    p.classList.toggle("on", online);
    var callBtn = el.querySelector('[data-pv="call"]');
    var why = callBlocked(dm.uid);
    callBtn.classList.toggle("unavailable", !!why);
    callBtn.title = why || "Private voice call";
  }

  api.openChat = function (uid, name) {
    if (!uid) return;
    if (!api.available()) {
      hooks.toast("<b>Private messages</b> need the live village — sign in on the hosted build.");
      return;
    }
    closeInbox();
    if (name) remember(uid, name);
    if (dm.uid !== uid) {
      closeChat(true);
      dm.uid = uid; dm.keys = {};
      var el = dmEl();
      el.querySelector(".pv-log").innerHTML = "";
      el.setAttribute("aria-label", "Private messages with " + nameOf(uid));
      el.querySelector(".pv-input").placeholder = "Message " + nameOf(uid) + "…";
      dm.unsub = net().dmWatch(uid, addDmLine, function () {
        addDmNote("These messages could not be loaded. The database rules may need deploying.");
      });
    }
    var w = dmEl();
    w.hidden = false;
    paintDmHead();
    if (inbox[uid]) { delete inbox[uid]; net().dmMarkRead(uid); paintBadges(); }
    setTimeout(function () { try { w.querySelector(".pv-input").focus(); } catch (e) {} }, 0);
  };

  function closeChat(quiet) {
    if (dm.unsub) { try { dm.unsub(); } catch (e) {} }
    dm.unsub = null; dm.uid = null; dm.keys = {};
    var el = $("pv-dm");
    if (el && !quiet) el.hidden = true;
  }
  api.closeChat = function () { closeChat(); };

  function fmtTime(at) {
    var d = new Date(at || Date.now()), now = new Date();
    var hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hm;
  }

  function addDmLine(m) {
    if (!m || !m.key || dm.keys[m.key]) return;
    dm.keys[m.key] = 1;
    var el = $("pv-dm");
    if (!el) return;
    var log = el.querySelector(".pv-log");
    var mine = net() && m.f === net().uid();
    var line = document.createElement("div");
    line.className = "pv-msg" + (mine ? " me" : "");
    line.innerHTML = '<span class="pv-text"></span><span class="pv-at">' + esc(fmtTime(m.at)) + "</span>";
    line.querySelector(".pv-text").textContent = m.m || "";
    var stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(line);
    if (stick || mine) log.scrollTop = log.scrollHeight;
    if (!mine && dm.uid && inbox[dm.uid]) { delete inbox[dm.uid]; net().dmMarkRead(dm.uid); paintBadges(); }
  }
  function addDmNote(text) {
    var el = $("pv-dm");
    if (!el) return;
    var n = document.createElement("p");
    n.className = "pv-note";
    n.textContent = text;
    el.querySelector(".pv-log").appendChild(n);
  }

  function sendDm() {
    var el = $("pv-dm"), input = el && el.querySelector(".pv-input");
    var text = input ? input.value.trim() : "";
    if (!text || !dm.uid || dm.sending) return;
    dm.sending = true;
    input.value = "";
    var to = dm.uid;
    remember(to, nameOf(to));
    net().dmSend(to, text, hooks.myName()).catch(function () {
      if (dm.uid === to) {
        input.value = input.value || text;
        addDmNote("Not sent — check your connection and try again.");
      }
    }).then(function () { dm.sending = false; });
  }

  /* ------------------------------------------------------ inbox popover */
  var inboxOpen = false;
  function inboxEl() {
    var el = $("pv-inbox");
    if (el) return el;
    el = document.createElement("div");
    el.id = "pv-inbox";
    el.className = "pv-win";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Private messages");
    el.hidden = true;
    ["pointerdown", "wheel", "touchstart"].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); }, t === "pointerdown" ? false : { passive: true });
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-pv-open],[data-pv-x]");
      if (!b) return;
      if (b.hasAttribute("data-pv-x")) closeInbox();
      else api.openChat(b.getAttribute("data-pv-open"));
    });
    document.body.appendChild(el);
    return el;
  }
  function renderInbox() {
    var el = inboxEl();
    var seen = {}, rows = [];
    Object.keys(inbox).sort(function (a, b) { return (inbox[b].at || 0) - (inbox[a].at || 0); })
      .forEach(function (u) { seen[u] = 1; rows.push({ u: u, n: inbox[u].n, p: inbox[u].p, unread: true }); });
    recent.forEach(function (r) { if (!seen[r.u]) rows.push({ u: r.u, n: r.n, p: "", unread: false }); });
    el.innerHTML =
      '<header class="pv-head"><div class="pv-who"><span class="eyebrow">🔒 Private messages</span></div>' +
      '<button type="button" class="pv-icon" data-pv-x aria-label="Close">✕</button></header>' +
      (rows.length
        ? '<ul class="pv-list">' + rows.map(function (r) {
            var on = hooks.isOnline(r.u);
            return '<li><button type="button" data-pv-open="' + esc(r.u) + '" class="' + (r.unread ? "unread" : "") + '">' +
              '<span class="pv-dot' + (on ? " on" : "") + '" title="' + (on ? "online" : "offline") + '"></span>' +
              '<span class="pv-li"><b>' + esc(nameOf(r.u)) + "</b>" +
              (r.p ? '<span class="pv-prev">' + esc(r.p) + "</span>" : "") + "</span>" +
              (r.unread ? '<span class="pv-new">new</span>' : "") + "</button></li>";
          }).join("") + "</ul>"
        : '<p class="pv-note">No conversations yet. Click a resident and choose <b>Message</b>.</p>');
  }
  function openInbox() {
    if (!api.available()) {
      hooks.toast("<b>Private messages</b> need the live village — sign in on the hosted build.");
      return;
    }
    inboxOpen = true;
    renderInbox();
    inboxEl().hidden = false;
  }
  function closeInbox() {
    inboxOpen = false;
    var el = $("pv-inbox");
    if (el) el.hidden = true;
  }

  /* ============================================================== calls */
  var call = null;
  /* call = { id, peer, name, role: "caller"|"callee",
              state: "outgoing"|"incoming"|"connecting"|"active"|"reconnecting",
              stream, pc, el, muted, ice: [], startedAt, restarts, timers: {} } */

  api.inCall = function () { return !!call && call.state !== "incoming"; };
  api.callState = function () { return call ? { peer: call.peer, state: call.state, muted: !!call.muted } : null; };

  /* Why a call to this resident cannot be made right now, or "". */
  function callBlocked(uid) {
    if (!api.available()) return "Private calls need the live village.";
    var v = voice();
    if (!v || !rtc()) return "Voice is not loaded.";
    if (v.unavailable && v.unavailable()) return v.unavailable();
    if (call && call.peer !== uid) return "You are already in a private call.";
    if (!hooks.isOnline(uid)) return nameOf(uid) + " is offline.";
    return "";
  }
  api.callBlocked = callBlocked;

  function send(to, t, obj) {
    if (!net() || !net().sendSignal) return Promise.resolve(false);
    return net().sendSignal(to, { t: t, d: JSON.stringify(obj || {}) });
  }

  function timer(name, ms, fn) {
    if (!call) return;
    var c = call;
    if (c.timers[name]) clearTimeout(c.timers[name]);
    c.timers[name] = setTimeout(function () {
      c.timers[name] = null;
      if (call === c) fn();
    }, ms);
  }
  function clearTimer(name) {
    if (call && call.timers[name]) { clearTimeout(call.timers[name]); call.timers[name] = null; }
  }

  /* The village microphone and a private call must never be open at once:
     the village would hear one half of a private conversation. */
  function closeVillageMic() {
    var v = voice();
    if (v && v.isSpeaking && v.isSpeaking()) {
      v.stopSpeaking();
      hooks.toast("Your <b>village microphone</b> was closed for the private call.");
    }
  }

  function openMic() {
    var r = rtc();
    if (!r.secureOrigin()) return Promise.reject({ name: "SecurityError" });
    return r.openMicrophone();
  }
  function micError(err) {
    var r = rtc();
    return r ? r.micMessage(err) : "The microphone could not be opened.";
  }

  api.startCall = function (uid, name) {
    if (!uid) return;
    if (call && call.peer === uid) { paintCall(); return; }
    var why = callBlocked(uid);
    if (why) { hooks.toast("<b>Private call</b> — " + esc(why)); return; }
    if (name) remember(uid, name);
    var id = String(Date.now()) + "." + Math.random().toString(36).slice(2, 8);
    call = { id: id, peer: uid, name: name || nameOf(uid), role: "caller", state: "outgoing",
             ice: [], restarts: 0, timers: {}, micPending: true };
    closeVillageMic();
    paintCall("Opening your microphone…");
    var c = call;
    /* The microphone first, inside the click: iOS only honours a permission
       prompt that a gesture asked for, and there is no point ringing
       somebody we could not talk to. */
    openMic().then(function (stream) {
      if (call !== c) { stopStream(stream); return; }
      c.stream = stream; c.micPending = false;
      send(uid, "c-ring", { id: id, n: String(hooks.myName() || "Resident").slice(0, 32) });
      paintCall();
      timer("ring", RING_TIMEOUT, function () {
        send(uid, "c-end", { id: id, why: "timeout" });
        endCall("<b>" + esc(c.name) + "</b> did not answer.");
      });
    }, function (err) {
      if (call !== c) return;
      endCall(micError(err));
    });
  };

  function acceptCall() {
    if (!call || call.state !== "incoming") return;
    var c = call;
    clearTimer("ring");
    stopRinging();
    closeVillageMic();
    c.state = "connecting";
    c.micPending = true;
    paintCall("Opening your microphone…");
    openMic().then(function (stream) {
      if (call !== c) { stopStream(stream); return; }
      c.stream = stream; c.micPending = false;
      send(c.peer, "c-acc", { id: c.id });
      paintCall();
      timer("connect", CONNECT_TIMEOUT, function () { connectionTrouble(); });
    }, function (err) {
      if (call !== c) return;
      send(c.peer, "c-end", { id: c.id, why: "mic" });
      endCall(micError(err));
    });
  }

  function declineCall() {
    if (!call || call.state !== "incoming") return;
    send(call.peer, "c-dec", { id: call.id });
    endCall(null);
  }

  api.hangup = function () {
    if (!call) return;
    var c = call;
    if (c.state === "incoming") { declineCall(); return; }
    send(c.peer, "c-end", { id: c.id, why: c.state === "outgoing" ? "cancel" : "hangup" });
    endCall(c.state === "outgoing" ? "Call cancelled." : "Private call ended.");
  };

  api.toggleMute = function () {
    if (!call || !call.stream) return;
    call.muted = !call.muted;
    call.stream.getAudioTracks().forEach(function (t) { t.enabled = !call.muted; });
    paintCall();
  };

  function stopStream(s) {
    try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  }

  function endCall(message) {
    var c = call;
    if (!c) return;
    call = null;
    Object.keys(c.timers).forEach(function (k) { if (c.timers[k]) clearTimeout(c.timers[k]); });
    stopRinging();
    if (c.stream) stopStream(c.stream);
    if (c.pc) {
      var r = rtc();
      if (r) r.unwatchPcState(c.pc);
      try { c.pc.close(); } catch (e) {}
    }
    if (c.el) {
      try { c.el.pause(); c.el.srcObject = null; } catch (e) {}
      if (c.el.parentNode) c.el.parentNode.removeChild(c.el);
    }
    paintCall();
    if (message) hooks.toast(message);
  }

  /* -------------------------------------------------- the connection */
  function makePc() {
    var r = rtc(), c = call;
    var pc = c.pc = new r.PC({ iceServers: r.iceServers });
    if (c.stream) c.stream.getAudioTracks().forEach(function (t) {
      t.enabled = !c.muted;
      pc.addTrack(t, c.stream);
    });
    pc.onicecandidate = function (e) {
      if (e.candidate && call === c && c.pc === pc) {
        var cand = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
        send(c.peer, "c-ice", { id: c.id, c: cand });
      }
    };
    pc.ontrack = function (e) {
      if (call !== c || c.pc !== pc) return;
      var stream = (e.streams && e.streams[0]) || (e.track && new window.MediaStream([e.track]));
      if (!stream) return;
      if (!c.el) {
        c.el = new Audio();
        c.el.autoplay = true;
        c.el.playsInline = true;
        c.el.setAttribute("playsinline", "");
        c.el.setAttribute("aria-hidden", "true");
        (document.body || document.documentElement).appendChild(c.el);
      }
      try { c.el.srcObject = stream; } catch (err) {}
      var p = c.el.play && c.el.play();
      if (p && p.catch) p.catch(function () {
        if (call === c) hooks.toast("Tap anywhere to hear <b>" + esc(c.name) + "</b>.");
        var retry = function () {
          window.removeEventListener("pointerdown", retry, true);
          if (call === c && c.el) c.el.play().catch(function () {});
        };
        window.addEventListener("pointerdown", retry, true);
      });
    };
    r.watchPcState(pc, function (state) {
      if (call !== c || c.pc !== pc) return;
      if (state === "connected") {
        clearTimer("connect"); clearTimer("grace"); clearTimer("restart");
        if (!c.startedAt) c.startedAt = Date.now();
        c.state = "active";
        paintCall();
      } else if (state === "disconnected") {
        c.state = "reconnecting";
        paintCall();
        timer("grace", RECONNECT_GRACE, function () { connectionTrouble(); });
      } else if (state === "failed") {
        connectionTrouble();
      }
    });
    return pc;
  }

  /* No audio path, or it went: try an ICE restart (the caller drives it),
     and give up honestly after a couple of goes. */
  function connectionTrouble() {
    var c = call;
    if (!c) return;
    if (c.restarts >= MAX_RESTARTS || !c.pc) {
      send(c.peer, "c-end", { id: c.id, why: "failed" });
      var r = rtc();
      if (r && r.reportNat) r.reportNat();
      endCall("<b>Private call dropped</b> — the connection to " + esc(c.name) +
              " could not be kept up. This network may block direct browser connections.");
      return;
    }
    c.restarts++;
    c.state = c.startedAt ? "reconnecting" : "connecting";
    paintCall();
    if (c.role === "caller") offer(true);
    timer("restart", CONNECT_TIMEOUT, function () { connectionTrouble(); });
  }

  function offer(restart) {
    var c = call, pc = c.pc;
    pc.createOffer(restart ? { iceRestart: true } : undefined).then(function (o) {
      return pc.setLocalDescription(o).then(function () {
        if (call !== c || c.pc !== pc) return;
        var d = pc.localDescription || o;
        send(c.peer, "c-offr", { id: c.id, sdp: { type: d.type, sdp: d.sdp } });
      });
    }).catch(function (e) {
      console.warn("[private call] offer failed", e);
      if (call === c) connectionTrouble();
    });
  }

  function drainIce() {
    var c = call;
    if (!c || !c.pc || !c.pc.remoteDescription) return;
    var r = rtc(), q = c.ice;
    c.ice = [];
    q.forEach(function (cand) { c.pc.addIceCandidate(r.iceOf(cand)).catch(function () {}); });
  }

  /* ------------------------------------------------------- signalling */
  function onSignal(from, msg) {
    if (!msg || typeof msg.t !== "string" || msg.t.indexOf("c-") !== 0) return;
    var p;
    try { p = JSON.parse(msg.d || "{}"); } catch (e) { return; }
    if (!p || !p.id) return;
    var r = rtc();

    if (msg.t === "c-ring") {
      /* a note left over from a ring long gone */
      if (msg.at && Math.abs(Date.now() - msg.at) > 120000) return;
      if (call) {
        if (call.peer === from && call.id === p.id) return;       /* a replay */
        /* two people calling each other at the same moment: the lower uid
           keeps its outgoing call, the other side answers it */
        if (call.peer === from && call.state === "outgoing" && call.stream && net().uid() > from) {
          var mine = call;
          clearTimer("ring");
          send(from, "c-end", { id: mine.id, why: "cancel" });
          call = { id: p.id, peer: from, name: mine.name, role: "callee", state: "connecting",
                   ice: [], restarts: 0, timers: {}, stream: mine.stream };
          send(from, "c-acc", { id: p.id });
          paintCall();
          timer("connect", CONNECT_TIMEOUT, function () { connectionTrouble(); });
          return;
        }
        send(from, "c-busy", { id: p.id });
        return;
      }
      remember(from, p.n);
      call = { id: p.id, peer: from, name: p.n || nameOf(from), role: "callee", state: "incoming",
               ice: [], restarts: 0, timers: {} };
      startRinging();
      paintCall();
      timer("ring", RING_TIMEOUT, function () {
        endCall("Missed private call from <b>" + esc(p.n || "a resident") + "</b>.");
      });
      return;
    }

    if (!call || call.peer !== from || call.id !== p.id) return;
    var c = call;

    if (msg.t === "c-end") {
      var why = p.why;
      if (c.state === "incoming") {
        endCall(why === "timeout" || why === "cancel"
          ? "Missed private call from <b>" + esc(c.name) + "</b>." : null);
      } else if (why === "mic") {
        endCall("<b>" + esc(c.name) + "</b> could not open their microphone.");
      } else if (why === "failed") {
        endCall("<b>Private call dropped</b> — the connection could not be kept up.");
      } else {
        endCall("<b>" + esc(c.name) + "</b> ended the private call.");
      }
      return;
    }
    if (msg.t === "c-dec") { endCall("<b>" + esc(c.name) + "</b> declined the call."); return; }
    if (msg.t === "c-busy") { endCall("<b>" + esc(c.name) + "</b> is on another call."); return; }

    if (msg.t === "c-acc" && c.role === "caller" && c.state === "outgoing") {
      clearTimer("ring");
      c.state = "connecting";
      paintCall();
      makePc();
      offer(false);
      timer("connect", CONNECT_TIMEOUT, function () { connectionTrouble(); });
      return;
    }

    if (msg.t === "c-offr" && c.role === "callee" && p.sdp) {
      if (!c.pc) makePc();
      var pc = c.pc;
      pc.setRemoteDescription(r.sdpOf(p.sdp))
        .then(function () { drainIce(); return pc.createAnswer(); })
        .then(function (a) {
          return pc.setLocalDescription(a).then(function () {
            if (call !== c || c.pc !== pc) return;
            var d = pc.localDescription || a;
            send(c.peer, "c-ans", { id: c.id, sdp: { type: d.type, sdp: d.sdp } });
          });
        })
        .catch(function (e) {
          console.warn("[private call] answer failed", e);
          if (call === c) connectionTrouble();
        });
      return;
    }

    if (msg.t === "c-ans" && c.role === "caller" && c.pc && p.sdp) {
      if (c.pc.signalingState !== "have-local-offer") return;
      c.pc.setRemoteDescription(r.sdpOf(p.sdp)).then(drainIce).catch(function (e) {
        console.warn("[private call] remote answer failed", e);
        if (call === c) connectionTrouble();
      });
      return;
    }

    if (msg.t === "c-ice" && p.c) {
      if (c.pc && c.pc.remoteDescription && c.pc.remoteDescription.type) {
        c.pc.addIceCandidate(r.iceOf(p.c)).catch(function () {});
      } else {
        c.ice.push(p.c);
      }
    }
  }

  /* ------------------------------------------------------ ringing */
  var ringTimer = null;
  function startRinging() {
    stopRinging();
    var buzz = function () {
      try { if (navigator.vibrate) navigator.vibrate([180, 120, 180]); } catch (e) {}
    };
    buzz();
    ringTimer = setInterval(buzz, 2400);
  }
  function stopRinging() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {}
  }

  /* ------------------------------------------ keeping an eye on things */
  var offlineSince = 0;
  function watch() {
    if (call) {
      if (call.state !== "incoming" && !hooks.isOnline(call.peer)) {
        if (!offlineSince) offlineSince = Date.now();
        else if (Date.now() - offlineSince > OFFLINE_GRACE) {
          var c = call;
          send(c.peer, "c-end", { id: c.id, why: "hangup" });
          endCall("<b>" + esc(c.name) + "</b> went offline. The private call has ended.");
        }
      } else offlineSince = 0;
      if (call && call.state === "active") paintClock();
    } else offlineSince = 0;
    if (dm.uid) paintDmHead();
  }

  /* ------------------------------------------------------------ call UI */
  function callEl() {
    var el = $("pv-call");
    if (el) return el;
    el = document.createElement("div");
    el.id = "pv-call";
    el.hidden = true;
    ["pointerdown", "touchstart"].forEach(function (t) {
      el.addEventListener(t, function (e) { e.stopPropagation(); }, t === "touchstart" ? { passive: true } : false);
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-call]");
      if (!b) return;
      var a = b.dataset.call;
      if (a === "accept") acceptCall();
      else if (a === "decline") declineCall();
      else if (a === "end") api.hangup();
      else if (a === "mute") api.toggleMute();
      else if (a === "msg" && call) api.openChat(call.peer, call.name);
    });
    document.body.appendChild(el);
    return el;
  }

  function clockText() {
    if (!call || !call.startedAt) return "";
    var s = Math.floor((Date.now() - call.startedAt) / 1000);
    var m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }
  function paintClock() {
    var t = document.querySelector("#pv-call .pv-clock");
    if (t) t.textContent = clockText();
  }

  function paintCall(note) {
    var el = callEl();
    document.body.classList.toggle("in-private-call", !!call && call.state !== "incoming");
    if (!call) { el.hidden = true; el.innerHTML = ""; el.className = ""; return; }
    var c = call, name = esc(c.name);
    var status, cls = c.state, buttons;
    if (c.state === "incoming") {
      el.setAttribute("role", "alertdialog");
      el.setAttribute("aria-label", "Incoming private call from " + c.name);
      status = "Private voice call";
      buttons =
        '<button type="button" class="btn small pv-accept" data-call="accept">Accept</button>' +
        '<button type="button" class="btn small pv-decline" data-call="decline">Decline</button>';
      el.innerHTML =
        '<div class="pv-call-main"><span class="pv-call-ico" aria-hidden="true">🎙️</span>' +
        '<div class="pv-call-txt"><b>' + name + " is calling you</b>" +
        '<span class="pv-call-status">🔒 ' + status + "</span></div></div>" +
        '<div class="pv-call-btns">' + buttons + "</div>";
    } else {
      el.setAttribute("role", "status");
      el.setAttribute("aria-label", "Private call with " + c.name);
      status = note ||
        (c.state === "outgoing" ? "Calling… waiting for them to answer"
         : c.state === "connecting" ? "Connecting…"
         : c.state === "reconnecting" ? "Connection unstable — reconnecting…"
         : "Connected");
      var mute = c.state === "outgoing" && !c.stream ? "" :
        '<button type="button" class="btn small ghost pv-mute' + (c.muted ? " on" : "") + '" data-call="mute" aria-pressed="' +
        (c.muted ? "true" : "false") + '">' + (c.muted ? "🔇 Unmute" : "🎙️ Mute") + "</button>";
      el.innerHTML =
        '<div class="pv-call-main"><span class="pv-live-dot" aria-hidden="true"></span>' +
        '<div class="pv-call-txt"><b>🔒 Private call · ' + name + '</b> <span class="pv-clock">' + clockText() + "</span>" +
        '<span class="pv-call-status">' + esc(status) + (c.muted ? " · you are muted" : "") + "</span></div></div>" +
        '<div class="pv-call-btns">' +
          '<button type="button" class="btn small ghost pv-msg-btn" data-call="msg" title="Open private messages" aria-label="Open private messages">💬</button>' +
          mute +
          '<button type="button" class="btn small pv-end" data-call="end">' + (c.state === "outgoing" ? "Cancel" : "End") + "</button>" +
        "</div>";
    }
    el.className = "pv-call-" + cls;
    el.hidden = false;
  }

  /* -------------------------------------------------------------- init */
  var inited = false;
  api.init = function (h) {
    hooks = Object.assign(hooks, h || {});
    if (inited) return;
    inited = true;
    var n = net();
    if (n && n.watchSignals && n.hasRtdb && n.hasRtdb()) n.watchSignals(onSignal);
    if (api.available()) n.dmInboxWatch(onInbox);
    if (n && n.onConnection) n.onConnection(function (up) {
      if (!call || call.state === "incoming") return;
      if (!up) hooks.toast("<b>Network lost</b> — trying to keep your private call going.");
    });

    var btn = $("dm-open");
    if (btn && !btn._pvBound) {
      btn._pvBound = true;
      if (!api.available()) {
        btn.classList.add("unavailable");
        btn.title = "Private messages need the live village";
      }
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        if (inboxOpen) closeInbox(); else openInbox();
      });
    }
    /* a click out in the village folds the inbox list away */
    window.addEventListener("pointerdown", function (e) {
      if (!inboxOpen) return;
      if (e.target.closest && e.target.closest("#pv-inbox,#dm-open")) return;
      closeInbox();
    });
    setInterval(watch, 1000);
    ["pagehide", "beforeunload"].forEach(function (t) {
      window.addEventListener(t, function () {
        if (!call) return;
        send(call.peer, call.state === "incoming" ? "c-dec" : "c-end", { id: call.id, why: "hangup" });
        endCall(null);
      });
    });
    paintBadges();
  };

  window.QVPrivate = api;
})();
