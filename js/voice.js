/* Quantum Village — live voice.
 *
 * One press opens your microphone and it stays open until you press again,
 * because a conversation is not a sequence of held buttons. There is no
 * recording, no upload and no playback of a file: the microphone feeds a
 * WebRTC peer connection straight to every listener's browser, and when you
 * mute yourself the connection closes and the sound is gone.
 *
 * Listening and speaking are separate
 * -----------------------------------
 * There is no such thing as permission to use the loudspeakers, so hearing
 * the village costs nothing and is on from the moment you arrive. Incoming
 * audio is played by an ordinary <audio> element in the page and never
 * touches the Web Audio API or an AudioContext — that is deliberate, and
 * the reason is written out over attach(). The "Hear" button mutes those
 * elements and nothing else; the microphone button opens the microphone and
 * nothing else. Neither one can switch the other off.
 *
 * Feedback
 * --------
 * A latched microphone means every microphone in the village is open at
 * once, so the path from a listener's loudspeaker back into their own
 * microphone is always live and the village will howl unless something
 * takes the gain out of it. Two things do. Incoming audio comes out of a
 * media element, which is the reference signal a browser's echo canceller
 * subtracts; and while you are actually making a sound everyone else ducks.
 *
 * What the database holds, and for how long
 * -----------------------------------------
 *   voiceLive/<uid>     a four-field note saying that you are speaking and
 *                       where you stand. Armed with onDisconnect().remove(),
 *                       and deleted the moment you stop.
 *   voiceSignal/<to>/<from>/<key>
 *                       one SDP offer, answer or ICE candidate. The browser
 *                       that reads it deletes it in the same breath.
 *
 * Audio never appears in either. Nothing is stored, so nothing has to be
 * cleaned up afterwards.
 *
 * Several people at once
 * ----------------------
 * Each speaker runs their own mesh of connections, and each listener holds
 * one <audio> element per speaker with its own volume. Two people talking
 * over each other sound like two people talking over each other, which is
 * the point — nobody waits in a queue, and nobody's microphone state has
 * any bearing on anybody else's.
 *
 * Modes
 * -----
 *   nearby   only residents within earshot (70 m) hear you, attenuated by
 *            distance, recomputed as either of you walks.
 *   village  everyone hears you at full volume, wherever they are.
 */
(function () {
  "use strict";

  var api = {};
  var EARSHOT = 70;
  /* STUN is enough for most home connections. Behind a symmetric NAT — a
     lot of office and mobile networks — the two browsers cannot find a path
     to each other without a relay, and the connection goes to "failed" with
     no sound and no error. Set window.QV_ICE_SERVERS before this file loads
     to add a TURN server and those networks work too. */
  var ICE = (window.QV_ICE_SERVERS && window.QV_ICE_SERVERS.length)
    ? window.QV_ICE_SERVERS
    : [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        { urls: ["stun:global.stun.twilio.com:3478"] }
      ];

  /* ------------------------------------------ what this browser can do
   *
   * The village is opened in whatever is to hand: desktop Chrome, Firefox,
   * Safari, a phone, a tablet, the web view inside somebody's mail client.
   * They disagree about voice in ways that are worth finding out once, up
   * front, rather than tripping over halfway through a seminar.
   *
   * Every check below is a feature test. Nothing reads the user agent — a
   * browser that grows a capability picks it up on its own, one that loses
   * it degrades on its own, and a web view pretending to be Safari is
   * judged on what it can actually do rather than on what it claims.
   */
  var PC_CTOR = window.RTCPeerConnection || window.webkitRTCPeerConnection ||
                window.mozRTCPeerConnection || null;
  var SDP_CTOR = window.RTCSessionDescription || window.webkitRTCSessionDescription ||
                 window.mozRTCSessionDescription || null;
  var ICE_CTOR = window.RTCIceCandidate || window.webkitRTCIceCandidate ||
                 window.mozRTCIceCandidate || null;

  /* The two wrappers exist because the constructors are deprecated and some
     engines have already dropped them: every browser that ever shipped
     WebRTC accepts the plain dictionary, and the ones that still want the
     object get it. */
  function sdpOf(d) { return SDP_CTOR ? new SDP_CTOR(d) : d; }
  function iceOf(c) { return ICE_CTOR ? new ICE_CTOR(c) : c; }

  /* A secure origin. getUserMedia is refused without one everywhere, and
     Safari withholds RTCPeerConnection too, so "the microphone is blocked"
     would be a lie: the page is being served over plain http. */
  function secureOrigin() {
    if (typeof window.isSecureContext === "boolean") return window.isSecureContext;
    var l = window.location || {};
    return l.protocol === "https:" || l.protocol === "file:" ||
           l.hostname === "localhost" || l.hostname === "127.0.0.1" || !l.protocol;
  }

  /* Promise getUserMedia, or the callback form that older WebKit and the
     Android web views still ship, wrapped to look the same. */
  function getMicStream(constraints) {
    var md = navigator.mediaDevices;
    if (md && md.getUserMedia) return md.getUserMedia(constraints);
    var legacy = navigator.getUserMedia || navigator.webkitGetUserMedia ||
                 navigator.mozGetUserMedia || navigator.msGetUserMedia;
    if (!legacy) {
      var e = new Error("getUserMedia is not available");
      e.name = "NotSupportedError";
      return Promise.reject(e);
    }
    return new Promise(function (res, rej) {
      try { legacy.call(navigator, constraints, res, rej); } catch (err) { rej(err); }
    });
  }

  /* iOS settles loudspeaker volume with the switch on the side of the phone
     and ignores HTMLMediaElement.volume outright: the property takes the
     write without complaint and reads back 1. Distance attenuation would
     quietly stop meaning anything and nothing would say so — a colleague
     across the village would be exactly as loud as the one beside you. So
     ask the engine, once, by writing a value and reading it back. */
  var volumeWorks = null;
  function volumeIsHonoured() {
    if (volumeWorks !== null) return volumeWorks;
    volumeWorks = false;
    try {
      var probe = new Audio();
      probe.volume = 0.5;
      volumeWorks = Math.abs(probe.volume - 0.5) < 0.01;
    } catch (e) { volumeWorks = false; }
    return volumeWorks;
  }
  /* Where a fade would have taken a voice below the level of background
     conversation, an engine that cannot fade mutes instead. Coarse, but it
     keeps "near" and "far" meaning something. */
  var QUIET = 0.12;

  /* Why voice is not available at all, if it is not: a sentence the
     resident can act on, or "" while everything is fine. */
  var voiceDown = "";

  /* Ducking. Hold-to-talk kept a lid on feedback by accident: only one
     microphone in the village was ever open. A latched microphone is open
     for the whole conversation, so while you are actually making a sound
     everybody else drops back, and the loop through your speakers and back
     into your microphone never has enough gain left to howl. It lifts again
     a moment after you stop, so an interruption still gets through. */
  var DUCK = 0.3;
  var VAD_ON = 0.045;             /* RMS at which the microphone counts as live */
  var VAD_HOLD = 400;             /* ms of quiet before the village comes back */
  var micAnalyser = null, micMeterSrc = null, micBuf = null, micHotAt = 0;

  var voiceMode = "nearby";       /* "nearby" | "village" */
  var speaking = false;
  /* Listening is not speaking, and never was. The speakers and the
     microphone are two different devices with two different permissions —
     one of which does not exist — so they get two different switches and two
     different buttons. This one starts on, because arriving in a village and
     hearing nobody is not a sensible default. */
  var listening = true;
  var micStream = null;
  var audioCtx = null;
  var pttActive = false;
  var refreshTimer = null;

  /* uid -> { pc, el, stream, vol } for people we are listening to */
  var inbound = {};
  /* uid -> { pc } for people listening to us */
  var outbound = {};
  /* the live roster, uid -> { n, mode, x, z } */
  var liveNow = {};
  /* Candidates that arrived before the description they belong to, keyed by
     uid *and direction*: talking to somebody who is talking back means two
     separate connections with the same peer, and their candidates are not
     interchangeable. */
  var pendingIce = {};            /* uid|dir -> [candidate] */
  var retryAt = {};               /* uid -> do not re-dial before this */
  var failures = {};              /* uid -> connections to them that failed in a row */
  var stalls = {};                /* uid -> requests to them that went unanswered in a row */
  var warned = {};                /* one message per kind of trouble */
  var joinSeq = 0;                /* makes each request to be heard unique */
  var maintainTimer = null;

  /* How long a connection may take to come up, and how long it may sit
     "disconnected", before it is thrown away and dialled again. A listener
     who is left holding a connection that will never carry sound hears
     nothing and is told nothing, so neither wait is allowed to be open-ended. */
  var CONNECT_TIMEOUT = 15000;
  var DISCONNECT_GRACE = 5000;

  /* Every handshake belongs to one request to be heard.
   *
   * With three or more people in the village the notes for several
   * handshakes are in flight at once, and a request that timed out, a
   * listener who walked out of earshot and back, or a database replaying
   * after a reconnect all leave a late offer, answer or candidate behind.
   * Applied to the wrong connection, a late answer settles the speaker's
   * end on descriptions the listener is not using; the real answer is then
   * refused as a duplicate, and that one pair of residents is silent while
   * everybody else can hear each other.
   *
   * So every offer, answer and candidate carries the tag of the join it
   * answers, and a note whose tag is not the one the connection was opened
   * for is dropped. The tag rides inside the JSON the database already
   * carries — the description and candidate constructors ignore members
   * they do not know — so the rules do not change, and a browser still on
   * the previous version (whose notes carry no tag) is taken at its word. */
  function withTag(obj, tag) {
    var o = obj && obj.toJSON ? obj.toJSON() : obj;
    var out = {};
    Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; });
    /* toJSON() on an RTCSessionDescription is the only reliable way to its
       fields, but a plain object from a fake or an older engine may lack it */
    if (obj && out.type === undefined && obj.type !== undefined) out.type = obj.type;
    if (obj && out.sdp === undefined && obj.sdp !== undefined) out.sdp = obj.sdp;
    if (tag) out.s = tag;
    return JSON.stringify(out);
  }
  function tagOf(parsed) { return (parsed && typeof parsed.s === "string") ? parsed.s : null; }
  function untagged(parsed) {
    var out = {};
    Object.keys(parsed || {}).forEach(function (k) { if (k !== "s") out[k] = parsed[k]; });
    return out;
  }

  var hooks = {
    toast: null,
    getPosition: null,
    getDisplayName: null,
    getUid: null,
    getPeers: null,
    getNpcs: null,
    onSpeakingChange: null,
    onListenChange: null
  };

  try {
    if (localStorage.getItem("qv-listen") === "0") listening = false;
  } catch (e) {}

  function net() { return window.QVNet; }
  function myUid() {
    var n = net();
    return (n && n.uid && n.uid()) || (hooks.getUid && hooks.getUid()) || "anon";
  }

  /* ------------------------------------------------------------------ init */
  api.init = function (h) {
    hooks = Object.assign(hooks, h || {});

    /* Three things have to be true before anybody can be heard, and when
       one of them is not the honest thing is to say which — a microphone
       button that opens the microphone and goes nowhere is the one failure
       that looks exactly like success from the inside. */
    if (!PC_CTOR) {
      voiceDown = secureOrigin()
        ? "This browser cannot make the browser-to-browser connection live voice needs. Village talk still works."
        : "Live voice needs a secure (https) address. Village talk still works.";
    } else if (net() && net().hasRtdb && net().hasRtdb()) {
      net().watchSignals(onSignal);
      net().watchVoiceLive(onLiveRoster);
      /* Keeping every connection alive is not left to the render loop.
         update() runs on animation frames, and a browser stops those
         entirely in a tab that is minimised or behind another window —
         which is exactly where somebody listening to a seminar while
         taking notes has put it. Their failed or timed-out connections
         would then never be re-dialled. */
      if (!maintainTimer) maintainTimer = setInterval(maintain, 1000);
    } else {
      /* No Realtime Database means no signalling, and the handshake is the
         whole of what the database carries. The microphone would open, the
         light would come on and not one listener would ever be offered the
         stream. */
      voiceDown = "Live voice needs the Realtime Database, which this village is running without. Village talk still works.";
    }

    var micBtn = document.getElementById("voice-toggle");
    if (micBtn && !micBtn._voiceBound) {
      micBtn._voiceBound = true;
      /* One press opens your microphone and it stays open; the next press
         closes it. A conversation is not a sequence of held buttons, and
         holding one through somebody else's sentence is the surest way to
         miss it. The V key is still there for a quick interjection. */
      micBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (speaking) api.stopSpeaking();
        else api.startSpeaking();
      });
    }

    var listenBtn = document.getElementById("voice-listen");
    if (listenBtn && !listenBtn._voiceBound) {
      listenBtn._voiceBound = true;
      listenBtn.addEventListener("click", function (e) {
        e.preventDefault();
        /* A click is a gesture, so this doubles as the way out of a browser
           that is holding sound back: if we are already listening and the
           browser refused, the honest thing for the button to do is try
           again rather than mute. */
        if (listening && audioBlocked) unlockAudio();
        else api.toggleListening();
      });
    }

    var modeBtn = document.getElementById("voice-mode");
    if (modeBtn && !modeBtn._voiceBound) {
      modeBtn._voiceBound = true;
      modeBtn.addEventListener("click", function (e) {
        e.preventDefault();
        api.toggleMode();
      });
    }

    /* beforeunload is not fired on iOS, and is unreliable on any phone that
       kills a backgrounded tab — pagehide is the one every browser agrees
       on. The database has an onDisconnect hook behind this either way;
       this is about letting go of the microphone promptly, so the recording
       light on somebody's phone goes out when they leave. */
    ["pagehide", "beforeunload"].forEach(function (t) {
      window.addEventListener(t, function () { hardStop(); });
    });
    bindUnlock();
    updateUi();
  };

  api.getMode = function () { return voiceMode; };
  api.setMode = function (m) {
    voiceMode = (m === "village") ? "village" : "nearby";
    if (speaking) publishLive();
    reconcile();
    updateUi();
    return voiceMode;
  };
  api.toggleMode = function () {
    return api.setMode(voiceMode === "nearby" ? "village" : "nearby");
  };
  api.isSpeaking = function () { return speaking; };
  /* "" when live voice works here, otherwise why it does not. */
  api.unavailable = function () { return voiceDown; };
  api.isRecording = function () { return speaking; };   /* old name, kept */
  api.speakers = function () { return liveNow; };

  /* ----------------------------------------------------------- listening */
  /* Muting the village is a local thing and always has been: the connections
     stay up, so unmuting is instant and nobody else's microphone is touched.
     The choice is remembered, because somebody who works in a quiet office
     should not have to make it again every morning. */
  api.isListening = function () { return listening; };
  api.setListening = function (v) {
    listening = !!v;
    try { localStorage.setItem("qv-listen", listening ? "1" : "0"); } catch (e) {}
    Object.keys(inbound).forEach(function (u) {
      var r = inbound[u];
      if (!r || !r.el) return;
      r.el.muted = !listening;
      if (listening) tryPlay(r.el);
    });
    if (listening) unlockAudio();
    updateUi();
    return listening;
  };
  api.toggleListening = function () { return api.setListening(!listening); };

  /* ------------------------------------------------------------- audio ctx */
  function ctx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  /* A listener never presses anything — somebody else starts talking and the
     audio graph is built from a database callback. A graph built without a
     gesture behind it starts suspended, and because the <audio> element that
     feeds it is muted its play() resolves happily, so nothing ever notices
     and the listener sits in silence. Watch for the next gesture, whatever
     it is, and open the tap then. Walking counts, so in practice this costs
     nobody a click. */
  var unlockBound = false;
  var audioBlocked = false;

  /* Start playing, and notice when the browser says no.
   *
   * The element the village is heard through is not muted — it cannot be,
   * the whole point of it is to be audible — so autoplay policy applies, and
   * a browser that has not seen a gesture on this page will reject play()
   * with the rejection arriving quietly on a promise. Swallowing it is how a
   * listener ends up sitting in silence with everything else working. */
  function tryPlay(el) {
    if (!el) return;
    var p;
    try { p = el.play(); } catch (e) { audioBlocked = true; updateUi(); return; }
    if (p && p.catch) {
      p.catch(function () {
        if (el.muted) return;
        audioBlocked = true;
        /* the button is the only honest place to say so: a toast scrolls
           away, and the resident needs somewhere to click */
        updateUi();
      });
    }
  }

  function unlockAudio() {
    audioBlocked = false;
    /* so a later block — a new speaker, a tab that was backgrounded — can
       say so again rather than being swallowed by the first one */
    warned.blocked = false;
    /* An AudioContext is *not* created here. Listening does not use one any
       more (see attach), and building one for every visitor who will never
       press the microphone costs a thread and a chunk of battery for
       nothing. If one exists — it does once you speak — a gesture is the
       right moment to resume it. */
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
    Object.keys(inbound).forEach(function (u) {
      var r = inbound[u];
      if (r && r.el && r.el.paused) tryPlay(r.el);
    });
    updateUi();
    return audioCtx;
  }

  function bindUnlock() {
    if (unlockBound) return;
    unlockBound = true;
    /* Never unbound. Audio can be blocked again later — a new speaker, a
       tab that was backgrounded — and the next gesture has to fix it. */
    ["pointerdown", "keydown", "touchstart"].forEach(function (t) {
      window.addEventListener(t, unlockAudio, true);
    });
  }

  function reportFailure() {
    if (warned.nat) return;
    warned.nat = true;
    console.warn("[voice] a peer connection failed — no route between the two browsers. " +
                 "Set window.QV_ICE_SERVERS with a TURN server to cover networks that block direct paths.");
    if (hooks.toast) {
      hooks.toast("<b>Voice could not connect</b> \u2014 this network blocks the direct " +
                  "path between browsers. Chat still works.");
    }
  }

  /* The offer never came. Almost always the signalling path is shut: the
     database rules that carry voiceSignal are not the ones deployed, so
     every handshake note is refused as it is written. Check the console for
     "voiceSignal write" and deploy database.rules.json. */
  function reportStalled() {
    if (warned.stall) return;
    warned.stall = true;
    console.warn("[voice] asked a speaker for their stream and got no offer back within 6s. " +
                 "The audio path is browser-to-browser, but the handshake goes through the " +
                 "Realtime Database — check that database.rules.json is deployed " +
                 "(firebase deploy --only database) and look for a 'voiceSignal' error above.");
    if (hooks.toast) {
      hooks.toast("<b>Voice could not connect</b> \u2014 the handshake did not get through. " +
                  "Chat still works.");
    }
  }

  /* ---------------------------------------------------------- speaking side */
  /* What actually went wrong, in a sentence somebody can act on. A browser
     reports all of these as a rejected promise, and telling a resident with
     no microphone plugged in to "allow it in the address bar" sends them
     looking for a button that is not there. */
  function micMessage(err) {
    var name = (err && (err.name || err.code)) || "";
    if (!secureOrigin()) {
      return "The microphone needs a secure (<b>https</b>) address. This page is not on one, " +
             "so no browser will hand it over.";
    }
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      return "The microphone is blocked. Allow it in the address bar \u2014 on a phone, in the site " +
             "settings \u2014 and press again.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No microphone found. Plug one in, or turn one on, and press again.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "Something else on this device is holding the microphone. Close it and press again.";
    }
    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      return "This microphone could not be opened the way the village asked for it.";
    }
    if (name === "NotSupportedError") {
      return "This browser will not give the village a microphone.";
    }
    return "The microphone could not be opened. Village talk still works.";
  }

  /* Echo cancellation, noise suppression and a single channel are what a
     room full of open microphones needs, and every current browser gives
     them. Some Android web views and desktop capture devices refuse the
     whole request rather than ignoring the parts they cannot do, so a
     refusal that is about the constraints and not about permission is worth
     one more try with nothing asked for at all. */
  function openMicrophone() {
    return getMicStream({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    }).catch(function (err) {
      var name = (err && err.name) || "";
      if (name !== "OverconstrainedError" && name !== "ConstraintNotSatisfiedError" &&
          name !== "NotReadableError" && name !== "TypeError") {
        throw err;
      }
      console.warn("[voice] retrying the microphone with no constraints after", name);
      return getMicStream({ audio: true });
    });
  }

  api.startSpeaking = function () {
    if (speaking) return Promise.resolve(false);
    if (voiceDown) {
      if (hooks.toast) hooks.toast("<b>Live voice is not available here</b> \u2014 " + voiceDown);
      return Promise.resolve(false);
    }
    if (!secureOrigin()) {
      if (hooks.toast) hooks.toast(micMessage({ name: "SecurityError" }));
      return Promise.resolve(false);
    }
    /* A private call has the microphone. Opening it to the village as well
       would broadcast one half of a private conversation. */
    if (window.QVPrivate && QVPrivate.inCall && QVPrivate.inCall()) {
      if (hooks.toast) hooks.toast("<b>You are in a private call</b> \u2014 end it to talk to the village.");
      return Promise.resolve(false);
    }
    ctx();
    speaking = true;          /* set first, so a fast double-press cannot race */
    updateUi();

    return openMicrophone().then(function (stream) {
      if (!speaking) {
        /* Let go before permission came back — which is what happens the
           first time anyone holds the button, because the prompt sits there
           until they answer it. Say so, or the village looks broken. */
        stream.getTracks().forEach(function (t) { t.stop(); });
        if (hooks.toast) hooks.toast("Microphone allowed. Hold <b>V</b> or the button again to speak.");
        return false;
      }
      micStream = stream;
      watchOwnLevel(stream);
      publishLive();
      /* keep the note fresh, and move it as we walk, so nearby listeners
         fade in and out properly while somebody is mid-sentence */
      refreshTimer = setInterval(publishLive, 4000);
      if (hooks.onSpeakingChange) hooks.onSpeakingChange(true, voiceMode);
      if (hooks.toast) {
        hooks.toast(voiceMode === "village"
          ? "<b>📢 Village voice</b> — everyone can hear you"
          : "<b>🎙️ Speaking</b> — anyone within earshot can hear you");
      }
      return true;
    }).catch(function (err) {
      console.warn("[voice] microphone refused", err);
      if (hooks.toast) hooks.toast(micMessage(err));
      speaking = false;
      updateUi();
      return false;
    });
  };

  api.stopSpeaking = function () {
    if (!speaking) return Promise.resolve(false);
    speaking = false;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
    stopWatchingOwnLevel();
    Object.keys(outbound).forEach(closeOutbound);
    if (net() && net().voiceLiveClear) net().voiceLiveClear();
    if (hooks.onSpeakingChange) hooks.onSpeakingChange(false, voiceMode);
    updateUi();
    return Promise.resolve(true);
  };

  /* old names, so nothing else in the village has to change */
  api.startRecording = api.startSpeaking;
  api.stopRecording = api.stopSpeaking;

  function hardStop() {
    try { api.stopSpeaking(); } catch (e) {}
    Object.keys(inbound).forEach(closeInbound);
  }

  function publishLive() {
    if (!speaking || !net() || !net().voiceLiveSet) return;
    var pos = hooks.getPosition ? hooks.getPosition() : { x: 0, z: 0 };
    net().voiceLiveSet({
      n: (hooks.getDisplayName && hooks.getDisplayName()) || "Resident",
      mode: voiceMode,
      x: Math.round(pos.x * 10) / 10,
      z: Math.round(pos.z * 10) / 10
    });
  }

  /* One connection's state, whichever name this browser has for it.
   *
   * Safari only grew RTCPeerConnection.connectionState in 15.4, and plenty
   * of web views still ship without it; there the property reads undefined,
   * `=== "failed"` is never true, and a connection that dies says nothing
   * at all — no message, no retry, just a speaker whose light is on and a
   * listener hearing nothing. iceConnectionState has been there since the
   * beginning and carries the same news a moment earlier, so take whichever
   * exists and listen for both events. */
  function pcState(pc) {
    var s = pc.connectionState;
    if (s) return s;
    var i = pc.iceConnectionState;
    if (i === "completed") return "connected";
    return i || "new";
  }

  function watchPcState(pc, onState) {
    var last = null;
    function fire() {
      var now = pcState(pc);
      if (now === last) return;
      last = now;
      onState(now);
    }
    pc.onconnectionstatechange = fire;
    pc.oniceconnectionstatechange = fire;
  }

  function unwatchPcState(pc) {
    try { pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null; } catch (e) {}
  }

  /* A listener has asked to hear us: make them a connection of their own.
   *
   * A second request from somebody we are already sending to is not a
   * duplicate to be ignored — it is somebody who walked out of earshot,
   * dropped the connection at their end, and has now walked back. Their old
   * connection here is dead, so tear it down and offer them a fresh one, or
   * they will stand next to us hearing nothing. */
  function openOutbound(toUid, tag) {
    if (!speaking || !micStream) return;
    /* ...but a second copy of the *same* request, which a reconnecting
       database will happily replay, is not somebody walking back. Redialling
       on that throws away the connection we are already bringing up and
       leaves the first offer unanswered. Every request carries a tag of its
       own, so the two cases can be told apart exactly rather than guessed at
       from how long ago the last one was. */
    var prev = outbound[toUid];
    if (prev && tag && prev.tag === tag) return;
    if (prev && !tag && Date.now() - prev.at < 2000) return;   /* older client */
    if (prev) closeOutbound(toUid);
    var pc = new PC_CTOR({ iceServers: ICE });
    outbound[toUid] = { pc: pc, at: Date.now(), tag: tag || null };

    micStream.getAudioTracks().forEach(function (t) { pc.addTrack(t, micStream); });

    /* "ice-s" — sent by the end that is speaking. The listener files it
       against the connection they are listening on, which is the only one
       it can possibly belong to even when they are talking back to us. */
    pc.onicecandidate = function (e) {
      if (e.candidate && outbound[toUid] && outbound[toUid].pc === pc) {
        net().sendSignal(toUid, { t: "ice-s", d: withTag(e.candidate, tag) });
      }
    };
    /* The listener is the one who re-dials — they know whether they still
       want to hear us — so a dead connection here only has to be let go of.
       One that never comes up at all is let go of too, rather than being
       kept for as long as we talk. */
    var rec = outbound[toUid];
    rec.watchdog = setTimeout(function () {
      if (outbound[toUid] === rec && pcState(pc) !== "connected") closeOutbound(toUid);
    }, CONNECT_TIMEOUT + DISCONNECT_GRACE);
    watchPcState(pc, function (state) {
      if (outbound[toUid] !== rec) return;
      if (state === "failed") { reportFailure(); closeOutbound(toUid); }
      else if (state === "closed") closeOutbound(toUid);
    });

    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () {
        if (outbound[toUid] !== rec) return;
        net().sendSignal(toUid, { t: "offer", d: withTag(pc.localDescription || offer, tag) });
      });
    }).catch(function (e) { console.warn("[voice] offer failed", e); });
  }

  function closeOutbound(toUid) {
    var o = outbound[toUid];
    if (!o) return;
    delete outbound[toUid];
    delete pendingIce[toUid + "|out"];
    if (o.watchdog) clearTimeout(o.watchdog);
    unwatchPcState(o.pc);
    try { o.pc.close(); } catch (e) {}
  }

  /* --------------------------------------------------------- listening side */
  /* The roster changed: open a connection to anyone we should now hear, and
     close the ones we should not. Volume and panning are recomputed every
     frame from update(), because both ends are walking about. */
  function onLiveRoster(map) {
    liveNow = map || {};
    reconcile();
    if (hooks.onListenChange) hooks.onListenChange(liveNow);
    paintSpeakerBubbles();
  }

  function audible(info) {
    if (!info) return false;
    if (info.uid === myUid()) return false;
    if (info.mode === "village") return true;
    var me = hooks.getPosition ? hooks.getPosition() : { x: 0, z: 0 };
    return Math.hypot((info.x || 0) - me.x, (info.z || 0) - me.z) <= EARSHOT * 1.15;
  }

  function reconcileOne(u) {
    if (!liveNow[u] || !audible(liveNow[u])) { closeInbound(u); return; }
    if (inbound[u]) return;
    if (retryAt[u] && Date.now() < retryAt[u]) return;
    requestStream(u);
  }

  function reconcile() {
    Object.keys(liveNow).forEach(reconcileOne);
    Object.keys(inbound).forEach(function (u) {
      if (!liveNow[u] || !audible(liveNow[u])) closeInbound(u);
    });
    /* forget the history of people who are no longer speaking, so that
       next time they start they are dialled at once */
    [retryAt, failures, stalls].forEach(function (m) {
      Object.keys(m).forEach(function (u) { if (!liveNow[u]) delete m[u]; });
    });
  }

  /* Once a second, whether or not the page is being drawn. */
  function maintain() {
    if (!Object.keys(liveNow).length && !Object.keys(inbound).length) return;
    reconcile();
    if (Object.keys(inbound).length) ensureAudible();
  }

  /* Ask a speaker to send to us. They answer with an offer.
   *
   * If no offer comes back — the speaker stopped between our reading the
   * roster and their reading our request, or a packet went missing — the
   * placeholder has to be cleared, or we would never try that speaker
   * again for as long as the page is open. */
  function requestStream(fromUid) {
    if (inbound[fromUid] || !net() || !net().sendSignal) return;
    delete pendingIce[fromUid + "|in"];
    /* the tag lets the speaker tell this request apart from a replay of the
       last one, so walking out of earshot and straight back in works — and
       it is echoed on every note of the handshake that follows, so notes
       left over from an earlier attempt cannot land on this one */
    var tag = String(++joinSeq) + "." + Date.now();
    var rec = inbound[fromUid] = { pc: null, pending: true, tag: tag };
    net().sendSignal(fromUid, { t: "join", d: tag });
    rec.timeout = setTimeout(function () {
      if (inbound[fromUid] !== rec || !rec.pending) return;
      /* Six seconds and no offer back. The speaker is still on the roster —
         that is why we asked — so ask again straight away, under a new tag
         so that a late offer to this request is recognised and dropped.
         Once is a lost note; twice in a row is the handshake itself not
         getting through, and silence there reads as a broken village, so
         name it. */
      stalls[fromUid] = (stalls[fromUid] || 0) + 1;
      if (stalls[fromUid] >= 2) reportStalled();
      closeInbound(fromUid);
      if (liveNow[fromUid] && audible(liveNow[fromUid])) requestStream(fromUid);
    }, 6000);
  }

  /* A connection to a speaker died, or never came up. Dial again — soon
     after a blip, backing off after repeated failures, so a pair of
     networks that genuinely cannot reach each other is not hammered. */
  function redial(fromUid, failed) {
    if (failed) {
      var n = failures[fromUid] = (failures[fromUid] || 0) + 1;
      retryAt[fromUid] = Date.now() + Math.min(30000, 1000 * Math.pow(2, n));
    }
    closeInbound(fromUid);
    reconcileOne(fromUid);
  }

  function makeInbound(fromUid, tag) {
    var pc = new PC_CTOR({ iceServers: ICE });
    var rec = inbound[fromUid] || (inbound[fromUid] = {});
    if (rec.timeout) { clearTimeout(rec.timeout); rec.timeout = null; }
    if (rec.watchdog) { clearTimeout(rec.watchdog); rec.watchdog = null; }
    if (rec.graceTimer) { clearTimeout(rec.graceTimer); rec.graceTimer = null; }
    /* a real re-offer replaces what was here; let go of the old connection
       and its corner of the mixer rather than leaving both running */
    if (rec.pc) {
      teardownAudio(rec);
      unwatchPcState(rec.pc);
      try { rec.pc.close(); } catch (e) {}
    }
    rec.pc = pc;
    rec.pending = false;
    if (tag) rec.tag = tag;
    delete stalls[fromUid];

    /* "ice-l" — sent by the end that is listening, so the speaker files it
       against the connection they are speaking on. */
    pc.onicecandidate = function (e) {
      if (e.candidate && inbound[fromUid] === rec && rec.pc === pc) {
        net().sendSignal(fromUid, { t: "ice-l", d: withTag(e.candidate, rec.tag) });
      }
    };

    /* An answer that went missing leaves a connection sitting at "new" or
       "connecting" for ever: nothing fails, so nothing retries, and one
       resident simply never hears another. Give it a deadline. */
    rec.watchdog = setTimeout(function () {
      rec.watchdog = null;
      if (inbound[fromUid] === rec && rec.pc === pc && pcState(pc) !== "connected") {
        console.warn("[voice] connection to " + fromUid + " did not come up; dialling again");
        /* no back-off: the deadline is itself fifteen seconds */
        redial(fromUid, false);
      }
    }, CONNECT_TIMEOUT);

    watchPcState(pc, function (state) {
      if (inbound[fromUid] !== rec || rec.pc !== pc) return;
      if (rec.graceTimer && state !== "disconnected") {
        clearTimeout(rec.graceTimer); rec.graceTimer = null;
      }
      if (state === "failed") {
        reportFailure();
        redial(fromUid, true);
      } else if (state === "closed") {
        redial(fromUid, false);
      } else if (state === "disconnected") {
        /* A dropped packet or two, a Wi-Fi hand-over, or the speaker having
           stopped and started again: a browser can sit in "disconnected"
           for half a minute before it admits to "failed". Give it a few
           seconds to recover by itself, then dial a fresh connection. */
        if (!rec.graceTimer) {
          rec.graceTimer = setTimeout(function () {
            rec.graceTimer = null;
            if (inbound[fromUid] === rec && rec.pc === pc && pcState(pc) !== "connected") {
              redial(fromUid, false);
            }
          }, DISCONNECT_GRACE);
        }
      } else if (state === "connected") {
        if (rec.watchdog) { clearTimeout(rec.watchdog); rec.watchdog = null; }
        delete retryAt[fromUid];
        delete failures[fromUid];
      }
    });
    pc.ontrack = function (e) {
      if (inbound[fromUid] !== rec || rec.pc !== pc) return;
      attach(fromUid, (e.streams && e.streams[0]) || (e.track && new window.MediaStream([e.track])));
    };
    return pc;
  }

  /* Somebody is talking and the browser will not let us make a sound yet.
     Listening takes no gesture of its own — you just stand there — so a
     listener who has not clicked anything since the page loaded has given
     the browser no reason to unblock audio, and turning your own microphone
     on is not the fix, it is just the gesture that happens to do it. Say so,
     once; the next click of any kind clears it. */
  function noteBlocked() {
    updateUi();
    if (warned.blocked) return;
    warned.blocked = true;
    if (hooks.toast) {
      hooks.toast("<b>Someone is speaking</b> \u2014 click anywhere to hear the village. " +
                  "Your browser holds sound back until the page has been clicked once.");
    }
  }

  /* Play one speaker.
   *
   * Straight out of an <audio> element in the document, and nothing else.
   *
   * This is the fix for "I can only hear people once I turn my own
   * microphone on". The audio used to go through a Web Audio graph — a gain
   * and a stereo panner — and that graph is where the dependency lived:
   *
   *   • createMediaStreamSource() over a *remote* WebRTC stream produces
   *     silence on iOS Safari, and produced silence in Chromium unless the
   *     page happened to be holding a live capture of its own. Pressing the
   *     microphone button is exactly what gave it one.
   *   • An AudioContext is born suspended and only a user gesture resumes
   *     it. A listener presses nothing — they just stand there — so the
   *     first thing anybody pressed was the microphone button, and that was
   *     the gesture that switched their hearing on.
   *   • The elements were never in the document, and WebKit will not play a
   *     media element that is not.
   *
   * A media element in the page has none of those problems: one gesture
   * anywhere unblocks it and signing in is already one, no capture is
   * needed, and it is also the signal a browser hands its echo canceller —
   * so playing here rather than through a graph is what stops a latched
   * microphone howling. Distance rides on element volume, which costs one
   * property write when it actually changes instead of a graph node per
   * speaker running in the audio thread.
   *
   * The price is stereo placement, which a media element cannot do. Distance
   * attenuation, which is what tells you whether somebody is near you, is
   * unchanged. */
  function audioHost() {
    return document.body || document.documentElement;
  }

  function attach(fromUid, stream) {
    var rec = inbound[fromUid];
    if (!rec || !stream) return;

    var el = rec.el;
    if (!el) {
      el = rec.el = new Audio();
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute("playsinline", "");     /* older WebKit reads the attribute */
      el.setAttribute("aria-hidden", "true");
      audioHost().appendChild(el);            /* an <audio> with no controls takes no space */
    }
    el.muted = !listening;
    /* mixOne sets the real level on the next line, before anything can be
       rendered. Starting at 1 rather than 0 only matters in the case where
       it cannot — a roster entry that vanished between the offer and the
       track — and there, too loud is a better failure than silent. */
    el.volume = 1;
    try { el.srcObject = stream; }
    catch (e) { try { el.src = URL.createObjectURL(stream); } catch (e2) {} }
    rec.stream = stream;
    rec.vol = undefined;
    tryPlay(el);
    mixOne(fromUid);
    bindUnlock();
    /* play() rejects on a promise, so the answer is not here yet. Ask again
       in a moment, and once more from update() a second later. */
    setTimeout(function () {
      if (inbound[fromUid] === rec) ensureAudible();
    }, 350);
  }

  /* Let go of one speaker's element. Leaving it attached holds the decoder
     and the stream alive long after the person stopped talking. */
  function teardownAudio(rec) {
    if (!rec || !rec.el) return;
    var el = rec.el;
    try { el.pause(); } catch (e) {}
    try { el.srcObject = null; } catch (e) {}
    try { el.removeAttribute("src"); el.load(); } catch (e) {}
    if (el.parentNode) el.parentNode.removeChild(el);
    rec.el = null;
    rec.stream = null;
    rec.vol = undefined;
  }

  function closeInbound(fromUid) {
    var rec = inbound[fromUid];
    if (!rec) return;
    delete inbound[fromUid];
    delete pendingIce[fromUid + "|in"];
    if (rec.timeout) clearTimeout(rec.timeout);
    if (rec.watchdog) clearTimeout(rec.watchdog);
    if (rec.graceTimer) clearTimeout(rec.graceTimer);
    teardownAudio(rec);
    if (rec.pc) {
      unwatchPcState(rec.pc);
      try { rec.pc.close(); } catch (e) {}
    }
  }

  /* ------------------------------------------------------------ signalling */
  function onSignal(fromUid, msg) {
    if (!msg || !msg.t) return;
    /* "c-" notes are private calls (private.js), which share this inbox */
    if (String(msg.t).indexOf("c-") === 0) return;

    if (msg.t === "join") {
      delete pendingIce[fromUid + "|out"];
      openOutbound(fromUid, msg.d || "");
      return;
    }

    /* everything past the join carries a JSON description or candidate */
    var parsed;
    try { parsed = JSON.parse(msg.d); } catch (e) { return; }
    if (!parsed || typeof parsed !== "object") return;
    var s = tagOf(parsed);

    if (msg.t === "offer") {
      /* The same offer twice would mean tearing down the connection we just
         built and answering again, and the speaker rejects the second answer
         because their end is already settled — so the live connection never
         gets one. A genuine re-offer carries a different description. */
      var have = inbound[fromUid];
      if (have && have.offer === msg.d) return;
      /* An offer made for a request we have since given up on — it timed
         out, or we walked away and back — belongs to a connection the
         speaker has already replaced. Answering it would hand them an
         answer for the wrong one. */
      if (s && (!have || have.tag !== s)) return;
      var pc = makeInbound(fromUid, s);
      var rec = inbound[fromUid];
      rec.offer = msg.d;
      pc.setRemoteDescription(sdpOf(untagged(parsed)))
        .then(function () { return drainIce(fromUid, "in", pc); })
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) {
          return pc.setLocalDescription(answer).then(function () {
            if (inbound[fromUid] !== rec || rec.pc !== pc) return;
            net().sendSignal(fromUid, { t: "answer", d: withTag(pc.localDescription || answer, s) });
          });
        })
        .catch(function (e) {
          console.warn("[voice] answer failed", e);
          if (inbound[fromUid] === rec && rec.pc === pc) redial(fromUid, true);
        });
      return;
    }

    if (msg.t === "answer") {
      var out = outbound[fromUid];
      if (!out || !out.pc) return;
      /* an answer to an offer we have since replaced would settle this
         connection on the wrong descriptions; the right one is on its way */
      if (s && out.tag && s !== out.tag) return;
      /* an answer for a connection that has already settled is a duplicate,
         and applying it throws rather than being quietly ignored */
      if (out.pc.signalingState !== "have-local-offer") return;
      var opc = out.pc;
      opc.setRemoteDescription(sdpOf(untagged(parsed)))
        .then(function () { return drainIce(fromUid, "out", opc); })
        .catch(function (e) {
          console.warn("[voice] remote answer failed", e);
          /* the listener will notice the silence and ask again */
          if (outbound[fromUid] === out) closeOutbound(fromUid);
        });
      return;
    }

    /* A candidate belongs to exactly one of the two connections we may have
       with this person. "ice-s" came from their speaking end, so it is for
       the connection we listen on; "ice-l" came from their listening end, so
       it is for the one we speak on. Untagged "ice" is the older form, which
       had no way of saying — send it wherever there is a description
       waiting, preferring the listening side. */
    if (msg.t === "ice" || msg.t === "ice-s" || msg.t === "ice-l") {
      var cand = untagged(parsed);
      var dir = msg.t === "ice-l" ? "out" : msg.t === "ice-s" ? "in" : null;
      var target = null;
      /* a candidate from an earlier attempt at this connection points at a
         path the other end has already closed; queued, it would be drained
         into the new connection and hold it up */
      if (s && dir === "in" && (!inbound[fromUid] || inbound[fromUid].tag !== s)) return;
      if (s && dir === "out" && (!outbound[fromUid] || outbound[fromUid].tag !== s)) return;
      if (dir === "in") target = inbound[fromUid] && inbound[fromUid].pc;
      else if (dir === "out") target = outbound[fromUid] && outbound[fromUid].pc;
      else {
        var i = inbound[fromUid] && inbound[fromUid].pc;
        var o = outbound[fromUid] && outbound[fromUid].pc;
        if (i && i.remoteDescription) { target = i; dir = "in"; }
        else if (o && o.remoteDescription) { target = o; dir = "out"; }
        else { target = null; dir = "in"; }
      }
      if (target && target.remoteDescription && target.remoteDescription.type) {
        target.addIceCandidate(iceOf(cand)).catch(function () {});
      } else {
        var k = fromUid + "|" + dir;
        (pendingIce[k] = pendingIce[k] || []).push(cand);
      }
    }
  }

  /* Candidates that arrived before the description they belong to. */
  function drainIce(fromUid, dir, pc) {
    var k = fromUid + "|" + dir;
    var queue = pendingIce[k];
    if (!queue) return Promise.resolve();
    delete pendingIce[k];
    return Promise.all(queue.map(function (c) {
      return pc.addIceCandidate(iceOf(c)).catch(function () {});
    }));
  }

  /* ------------------------------------------------- am I actually talking */
  /* A tap off the microphone that goes nowhere. The analyser is deliberately
     left unconnected to any destination: it only has to read the level, and
     wiring your own microphone to the speakers is the one thing guaranteed
     to howl. */
  function watchOwnLevel(stream) {
    stopWatchingOwnLevel();
    var c = ctx();
    if (!c || !c.createAnalyser || !c.createMediaStreamSource) return;
    try {
      micMeterSrc = c.createMediaStreamSource(stream);
      micAnalyser = c.createAnalyser();
      micAnalyser.fftSize = 512;
      micAnalyser.smoothingTimeConstant = 0.3;
      micMeterSrc.connect(micAnalyser);
      micBuf = new Uint8Array(micAnalyser.fftSize);
    } catch (e) {
      stopWatchingOwnLevel();
    }
  }

  function stopWatchingOwnLevel() {
    try { if (micMeterSrc) micMeterSrc.disconnect(); } catch (e) {}
    try { if (micAnalyser) micAnalyser.disconnect(); } catch (e) {}
    micMeterSrc = micAnalyser = micBuf = null;
    micHotAt = 0;
  }

  function sampleOwnLevel() {
    if (!speaking || !micAnalyser || !micBuf) return;
    micAnalyser.getByteTimeDomainData(micBuf);
    var sum = 0;
    for (var i = 0; i < micBuf.length; i++) {
      var v = (micBuf[i] - 128) / 128;
      sum += v * v;
    }
    if (Math.sqrt(sum / micBuf.length) > VAD_ON) micHotAt = Date.now();
  }

  /* No analyser — an old browser, or the microphone is shut — means no
     ducking rather than permanent ducking. */
  function ducking() {
    return speaking && !!micAnalyser && (Date.now() - micHotAt) < VAD_HOLD;
  }

  /* ------------------------------------------------------------- the mixer */
  /* Called ten times a second from app.js. Distance changes while people
     walk, so the level is re-derived rather than fixed when the connection
     opened. It does nothing at all when nobody is talking. */
  var lastReconcile = 0;
  api.update = function () {
    var keys = Object.keys(inbound);
    var anyone = keys.length || Object.keys(liveNow).length;
    /* An empty village is the common case, and it should cost nothing. */
    if (!speaking && !anyone) return;

    sampleOwnLevel();
    var duck = ducking();
    for (var i = 0; i < keys.length; i++) mixOne(keys[i], duck);

    /* Walking towards somebody who is already talking has to bring them
       into earshot without waiting for their next roster refresh. */
    var now = Date.now();
    if (now - lastReconcile > 900) {
      lastReconcile = now;
      var before = keys.length;
      reconcile();
      if (Object.keys(inbound).length !== before) paintSpeakerBubbles();
      if (keys.length) ensureAudible();
    }
  };

  /* Somebody is talking: is any of it actually reaching the speakers? An
     element that was refused when it was attached stays refused until
     something asks again, and nothing else would ask. */
  function ensureAudible() {
    if (!listening) return;
    var stuck = false;
    Object.keys(inbound).forEach(function (u) {
      var r = inbound[u];
      if (r && r.el && r.el.paused) { stuck = true; tryPlay(r.el); }
    });
    if (stuck) { audioBlocked = true; noteBlocked(); }
    else if (audioBlocked && Object.keys(inbound).length) {
      /* it came good on its own — a gesture we did not see, or the browser
         relenting — so stop telling the resident their sound is off */
      audioBlocked = false;
      updateUi();
    }
  }

  function mixOne(u, duck) {
    var rec = inbound[u], info = liveNow[u];
    if (!rec || !rec.el || !info) return;
    if (duck === undefined) duck = ducking();
    var volume = 1;

    if (info.mode !== "village") {
      var me = hooks.getPosition ? hooks.getPosition() : { x: 0, z: 0 };
      var dist = Math.hypot((info.x || 0) - me.x, (info.z || 0) - me.z);
      /* full volume up close, silent at the edge of earshot, with an
         inverse-square-ish curve in between so walking away sounds right */
      var k = Math.min(1, Math.max(0, dist / EARSHOT));
      volume = Math.max(0, 1 - k * k * 0.92);
    }

    if (duck) volume *= DUCK;
    volume = Math.max(0, Math.min(1, volume));

    var mute = !listening;

    if (volumeIsHonoured()) {
      /* Writing .volume is a DOM property write, and the number barely moves
         while somebody walks. Ten times a second times a hundredth of a step
         is a change nobody can hear and work nobody has to do. */
      if (rec.vol === undefined || Math.abs(rec.vol - volume) > 0.01) {
        rec.vol = volume;
        try { rec.el.volume = volume; } catch (e) {}
      }
    } else {
      /* An engine that ignores .volume — iOS settles loudspeaker level with
         the switch on the side of the phone — cannot be given the fade, so
         it gets the nearest honest thing instead: once a voice has faded
         below the level of background conversation it is muted rather than
         played at full volume. Walking away from somebody still means
         something, which is the whole job distance was doing. */
      rec.vol = volume;
      if (volume < QUIET) mute = true;
    }

    if (rec.el.muted !== mute) rec.el.muted = mute;
  }

  /* What the mesh is actually doing. Useful from the console when somebody
     says they cannot hear anyone, and it is how the voice path is tested. */
  api.stats = function () {
    var heard = {};
    Object.keys(inbound).forEach(function (u) {
      var r = inbound[u];
      heard[u] = {
        state: r.pc ? pcState(r.pc) : (r.pending ? "waiting" : "none"),
        ice: r.pc ? r.pc.iceConnectionState : null,
        track: !!r.stream,
        playing: !!(r.el && !r.el.paused),
        muted: !!(r.el && r.el.muted),
        volume: r.el ? Math.round(r.el.volume * 1000) / 1000 : null
      };
    });
    var sending = {};
    Object.keys(outbound).forEach(function (u) {
      sending[u] = outbound[u].pc ? pcState(outbound[u].pc) : "none";
    });
    return {
      speaking: speaking, listening: api.isListening(), mode: voiceMode, ducking: ducking(),
      audio: {
        context: audioCtx ? audioCtx.state : "none",
        blocked: audioBlocked,
        /* false on iOS, where distance is carried by muting instead */
        volumeControl: volumeIsHonoured()
      },
      available: !voiceDown,
      unavailable: voiceDown || null,
      secureOrigin: secureOrigin(),
      webrtc: !!PC_CTOR,
      roster: Object.keys(liveNow),
      listeningTo: heard,
      sendingTo: sending
    };
  };

  /* --------------------------------------------------- bubbles over heads */
  function paintSpeakerBubbles() {
    var peers = hooks.getPeers ? hooks.getPeers() : {};
    Object.keys(peers).forEach(function (k) {
      var pr = peers[k];
      if (!pr) return;
      var u = pr.uid || k;
      var live = liveNow[u];
      if (live && audible(live)) {
        pr.voiceActive = true;
        pr.bubble = (live.mode === "village" ? "📢 " : "🎙️ ") + (live.n || "Resident") + " is speaking…";
      } else if (pr.voiceActive) {
        pr.voiceActive = false;
        if (pr.bubble && pr.bubble.indexOf("speaking") >= 0) pr.bubble = "";
      }
    });
  }

  /* ------------------------------------------------------------- UI & HUD */
  function updateUi() {
    var listenBtn = document.getElementById("voice-listen");
    if (listenBtn) {
      var stuck = listening && audioBlocked;
      listenBtn.classList.toggle("off", !listening);
      listenBtn.classList.toggle("stuck", stuck);
      listenBtn.setAttribute("aria-pressed", listening ? "true" : "false");
      listenBtn.title = !listening
        ? "Sound is off \u2014 click to hear the village"
        : stuck
          ? "Your browser is holding sound back \u2014 click here to allow it"
          : "You can hear anyone speaking near you. Click to mute the village";
      var lIco = listenBtn.querySelector(".ico");
      if (lIco) lIco.textContent = !listening ? "\uD83D\uDD07" : stuck ? "\uD83D\uDD08" : "\uD83D\uDD0A";
      var lLab = listenBtn.querySelector(".voice-label");
      if (lLab) lLab.textContent = !listening ? "Muted" : stuck ? "Tap" : "Hear";
    }

    var modeBtn = document.getElementById("voice-mode");
    if (modeBtn) {
      modeBtn.classList.toggle("unavailable", !!voiceDown);
      var isVillage = voiceMode === "village";
      /* One word, not two. It sits between a loudspeaker and a microphone in
         a header that has to fit on a phone, and the tooltip and the
         aria-label carry the rest. */
      modeBtn.textContent = isVillage ? "Village" : "Nearby";
      modeBtn.classList.toggle("village", isVillage);
      modeBtn.title = isVillage
        ? "Village voice: everyone hears you live, wherever they are"
        : "Nearby voice: only residents within 70 m hear you, and it fades with distance";
      modeBtn.setAttribute("aria-label",
        isVillage ? "Village voice \u2014 everyone hears you" : "Nearby voice \u2014 people within earshot hear you");
    }

    var micBtn = document.getElementById("voice-toggle");
    if (micBtn) {
      micBtn.classList.toggle("recording", speaking);
      micBtn.setAttribute("aria-pressed", speaking ? "true" : "false");
      var label = micBtn.querySelector(".voice-label");
      if (label) label.textContent = speaking ? "Live" : "Talk";
      /* A microphone button that opens a microphone nobody can hear is
         worse than no button: mark it, say why on hover, and let the press
         explain itself rather than quietly doing nothing. */
      micBtn.classList.toggle("unavailable", !!voiceDown);
      micBtn.setAttribute("aria-disabled", voiceDown ? "true" : "false");
      micBtn.title = voiceDown
        ? "Live voice is not available here \u2014 " + voiceDown
        : speaking
          ? "Your microphone is open \u2014 click to mute it"
          : "Click to open your microphone and stay in the conversation (or hold V for a quick word)";
    }

    var wave = document.getElementById("voice-wave");
    if (wave) wave.classList.toggle("active", speaking);
  }

  /* ------------------------------------------------------------ PTT hotkey */
  /* Is this the V key?
   *
   * e.key is the letter the layout produces, which on a Cyrillic, Greek or
   * Arabic keyboard is not "v" at all — the village would simply have no
   * push-to-talk for those residents. e.code is the physical key and says
   * "KeyV" whatever is printed on the cap, so try that first and keep the
   * letter for the browsers and remote keyboards that do not report one. */
  function isTalkKey(e) {
    if (e.code) return e.code === "KeyV";
    return e.key === "v" || e.key === "V";
  }

  function releasePtt() {
    if (!pttActive) return;
    pttActive = false;
    api.stopSpeaking();
  }

  api.bindHotkey = function () {
    window.addEventListener("keydown", function (e) {
      if (isTalkKey(e) && !pttActive && !e.repeat) {
        /* a modifier means somebody is reaching for a browser command, not
           asking to speak */
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var el = document.activeElement;
        var tag = (el && el.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || (el && el.isContentEditable)) return;
        /* The button latches the microphone open. V is for a quick word on
           top of that, so if the microphone is already open V must not arm
           itself — letting go of it would close a session it never opened. */
        if (speaking) return;
        pttActive = true;
        api.startSpeaking();
      }
    });
    window.addEventListener("keyup", function (e) {
      if (isTalkKey(e)) releasePtt();
    });

    /* A keyup that never arrives leaves the microphone latched open with
       nobody holding anything — switch apps, or hit a browser shortcut,
       while V is down and the keyup is delivered to somewhere else. The
       recording light then stays on in a village somebody has walked away
       from, which is the one thing a microphone must never do. */
    window.addEventListener("blur", releasePtt);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) releasePtt();
    });
  };

  /* Bound at load, not from init().
   *
   * There is no such thing as permission to use the speakers — a browser
   * never asks — but it does hold sound back on a page nobody has touched
   * yet, and it lifts that the moment anyone clicks or types anything. So
   * the only thing standing between a new arrival and hearing the village is
   * one gesture, and signing in *is* one.
   *
   * init() runs on the far side of an authentication round-trip, so binding
   * there missed the click on the gate by a long way and left the first
   * gesture of the session unused. Whoever opens the page then had to click
   * once more before anything could be heard — and pressing the microphone
   * button was the obvious thing to press, which is why speaking seemed to
   * be what switched listening on. Binding here means the sign-in click
   * itself opens the audio, and by the time the village appears there is
   * nothing left to unlock. */
  bindUnlock();

  /* For a caller that is already inside a gesture and wants to be certain —
     app.js calls this as the gate is submitted. */
  api.unlock = function () { return unlockAudio(); };

  /* The same browser plumbing, for private one-to-one calls (private.js):
     one set of feature tests, ICE servers and microphone messages. */
  api.rtc = PC_CTOR ? {
    PC: PC_CTOR,
    iceServers: ICE,
    sdpOf: sdpOf,
    iceOf: iceOf,
    secureOrigin: secureOrigin,
    openMicrophone: openMicrophone,
    micMessage: micMessage,
    watchPcState: watchPcState,
    unwatchPcState: unwatchPcState,
    reportNat: function () {
      console.warn("[voice] a private call failed — no route between the two browsers. " +
                   "Set window.QV_ICE_SERVERS with a TURN server to cover networks that block direct paths.");
    }
  } : null;

  window.QVVoice = api;
})();
