/* Quantum Village — networking.
 *
 * One API, three back ends, picked at boot:
 *
 *   firebase  Google sign-in (Firebase Auth), live presence + chat on the
 *             Realtime Database, durable records in Firestore.  This is the
 *             back end you get when you host the village yourself and fill
 *             in js/firebase-config.js.
 *   claude    Presence, chat and storage through the Claude artifact runtime,
 *             so the preview build is live without any configuration.
 *   local     Solo. Everything is kept in memory for this tab only.
 *
 * app.js never learns which one is running; it just calls QVNet.
 *
 * Firebase specifics worth knowing:
 *   - Everyone is signed in. If you have not used Google, the village signs
 *     you in anonymously, because the security rules require an account
 *     before anything may be written. Anonymous accounts can be upgraded to
 *     Google later without losing the resident.
 *   - Presence is written at most four times a second, and only when
 *     something actually changed, with a slow heartbeat when it has not.
 *   - Seats and speaking slots are claimed with transactions, so two people
 *     cannot take the same chair, and released on disconnect.
 */
(function () {
  "use strict";
  var N = (window.QVNet = {});

  var backend = "local";
  var fb = null;          /* firebase namespace */
  var fs = null;          /* firestore */
  var rtdb = null;        /* realtime database */
  var claudeRoom = null, claudeDb = null;
  var currentUser = null;
  var authHandlers = [];
  var peerHandlers = [], chatHandlers = [], voiceHandlers = [];
  var lastPeers = {};          /* the most recent presence snapshot, by key */
  var localDocs = {};
  var myKey = null, presenceRef = null;
  var lastPresence = 0, pendingPresence = null, lastSent = null, lastBeat = 0;
  var connHandlers = [], connected = false, everConnected = false;
  var roomWatches = {}, myClaims = [];
  var fsLive = false, presenceDoc = null, fsUnsub = [];
  /* "rtdb" | "firestore" | "none" | the non-firebase back end name */
  N.liveMode = function () { return backend !== "firebase" ? backend : (rtdb ? "rtdb" : (fsLive ? "firestore" : "none")); };
  var localRooms = {};
  var lastError = null;

  function fail(where, e) {
    lastError = { where: where, message: (e && e.message) || String(e) };
    if (!fail.seen) fail.seen = {};
    if (!fail.seen[where]) {
      fail.seen[where] = 1;
      console.warn("[village] " + where + ": " + lastError.message);
    }
    return lastError;
  }
  N.lastError = function () { return lastError; };

  N.backend = function () { return backend; };
  N.connected = function () { return backend === "local" ? true : connected; };
  N.onConnection = function (h) { connHandlers.push(h); h(N.connected()); };
  function setConnected(v) {
    if (connected === v) return;
    connected = v;
    if (v) everConnected = true;
    connHandlers.forEach(function (h) { try { h(v); } catch (e) {} });
  }
  N.user = function () { return currentUser; };
  N.isLive = function () { return backend !== "local"; };

  /* ---------------------------------------------------------------- boot */
  N.init = function () {
    return (window.QV_LIBS || Promise.resolve(false)).then(function () { return boot(); });
  };

  function boot() {
    return new Promise(function (resolve) {
      var cfg = window.QV_FIREBASE_CONFIG;
      var configured = cfg && cfg.apiKey && cfg.apiKey.indexOf("PASTE") !== 0 && cfg.projectId;

      if (configured && window.firebase && window.firebase.initializeApp) {
        try {
          fb = window.firebase;
          if (!fb.apps.length) fb.initializeApp(cfg);
          try { fs = fb.firestore ? fb.firestore() : null; }
          catch (e1) { fs = null; fail("firestore init", e1); }
          /* The Realtime Database needs databaseURL in the config; without
             it presence and chat are unavailable but the rest still works. */
          try { rtdb = (fb.database && cfg.databaseURL) ? fb.database() : null; }
          catch (e2) { rtdb = null; fail("realtime database init", e2); }
          /* No Realtime Database? Fall back to Firestore for the live layer
             too. It is not what Firestore is for — every peer update is a
             document read — so the cadence drops from four a second to one
             every two and a half, and the village says so. Creating the
             Realtime Database switches this off again by itself. */
          fsLive = !rtdb && !!fs;
          if (fsLive) {
            fail("realtime database", { message: "No Realtime Database on this project. " +
              "Presence and chat are running on Firestore instead, which updates more slowly. " +
              "Create one under Build \u2192 Realtime Database for smooth multiplayer." });
          }
          backend = "firebase";
          watchConnection();
          wireFirebaseAuth();
          resolve({ backend: backend, rtdb: !!rtdb, firestore: !!fs });
          return;
        } catch (e) {
          fail("firebase init", e);
          backend = "local";
        }
      }

      if (window.claude && window.claude.use) {
        var got = 0, need = 2;
        var done = function () { if (++got >= need) resolve({ backend: backend }); };
        window.claude.use("room").then(function (r) {
          if (r) { claudeRoom = r; backend = "claude"; wireClaudeRoom(); }
          done();
        }).catch(done);
        window.claude.use("db").then(function (d) {
          if (d) { claudeDb = d; backend = "claude"; }
          done();
        }).catch(done);
        setTimeout(function () { resolve({ backend: backend }); }, 4000);
        return;
      }
      resolve({ backend: backend });
    });
  }

  /* ---------------------------------------------------- connection state */
  /* A databaseURL can be present and still point at nothing — the Realtime
     Database has to be created in the console before it exists, and it takes
     a region-specific hostname. Rather than sit there looking connected,
     give it a few seconds to answer and then move the live layer to
     Firestore. Creating the database later needs no code change. */
  var rtdbAnswered = false;
  function probeRtdb() {
    if (!rtdb) return;
    setTimeout(function () {
      if (rtdbAnswered || !fs || fsLive) return;
      fail("realtime database", { message: "The Realtime Database at this databaseURL did not " +
        "answer. Presence and chat have moved to Firestore, which updates more slowly. " +
        "Create the database (Build \u2192 Realtime Database) and check databaseURL in " +
        "js/firebase-config.js matches the one the console shows." });
      rtdb = null;
      presenceRef = null;
      fsLive = true;
      startFirestoreLive();
    }, 5000);
  }

  function watchConnection() {
    if (!rtdb) {
      /* Firestore has no .info/connected; trust the browser instead. */
      setConnected(typeof navigator === "undefined" || navigator.onLine !== false);
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("online", function () { setConnected(true); });
        window.addEventListener("offline", function () { setConnected(false); });
      }
      return;
    }
    try {
      probeRtdb();
      rtdb.ref(".info/connected").on("value", function (snap) {
        var up = snap.val() === true;
        if (up) rtdbAnswered = true;
        setConnected(up);
        /* a reconnect has to re-arm the disconnect hook and re-publish us */
        if (up && presenceRef) {
          presenceRef.onDisconnect().remove().catch(function () {});
          if (lastSent) { lastSent = null; }
          reclaimAll();
          reArmMine();
        }
      }, function (e) { fail("connection watch", e); });
    } catch (e) { fail("connection watch", e); }
  }

  /* ---------------------------------------------------------------- auth */
  /* The village is walled: an account with a password is the only way in.
     Anonymous visitors are gone, and a session left over from before the
     wall went up is signed straight back out rather than honoured — which
     is what stops yesterday's residents wandering back in. */
  N.anonBlocked = function () { return false; };

  function hasPassword(u) {
    if (!u || u.isAnonymous) return false;
    var pd = u.providerData || [];
    for (var i = 0; i < pd.length; i++) if (pd[i] && pd[i].providerId === "password") return true;
    return false;
  }
  N.legacyRejected = false;

  /* Firebase reports the opening auth state — usually "nobody" — as soon as
     it starts, which can be before app.js has asked to hear about it. Latch
     it, so a handler that arrives late is still told where things stand
     instead of waiting for an event that has already been and gone. */
  var authReady = false;

  function wireFirebaseAuth() {
    if (!fb.auth) return;
    fb.auth().onAuthStateChanged(function (u) {
      authReady = true;
      if (u && !hasPassword(u)) {
        /* An anonymous account, or one from a provider that is no longer
           allowed. Turn it away and let the gate ask for a password. */
        N.legacyRejected = true;
        currentUser = null;
        fb.auth().signOut().catch(function () {});
        authHandlers.forEach(function (h) { try { h(null); } catch (e) {} });
        return;
      }
      currentUser = u ? {
        uid: u.uid,
        name: u.displayName || "",
        photo: u.photoURL || "",
        email: u.email || "",
        anon: false
      } : null;
      if (currentUser) startFirebasePresence();
      authHandlers.forEach(function (h) { try { h(currentUser); } catch (e) { } });
    });
  }

  N.onAuth = function (h) {
    authHandlers.push(h);
    if (backend !== "firebase" || authReady) { try { h(currentUser); } catch (e) {} }
  };

  /* ------------------------------------------------- accounts: password */
  N.createAccount = function (email, pass, name) {
    if (!N.canSignIn()) return Promise.reject(new Error("no back end"));
    return fb.auth().createUserWithEmailAndPassword(String(email).trim(), pass)
      .then(function (res) {
        var u = res && res.user;
        if (u && name && u.updateProfile) {
          return u.updateProfile({ displayName: String(name).slice(0, 32) }).then(function () { return u; });
        }
        return u;
      });
  };
  N.signInWithPassword = function (email, pass) {
    if (!N.canSignIn()) return Promise.reject(new Error("no back end"));
    return fb.auth().signInWithEmailAndPassword(String(email).trim(), pass)
      .then(function (res) { return res && res.user; });
  };
  N.sendPasswordReset = function (email) {
    if (!N.canSignIn()) return Promise.reject(new Error("no back end"));
    return fb.auth().sendPasswordResetEmail(String(email).trim());
  };

  /* Firebase speaks in codes; residents do not. */
  N.authMessage = function (e) {
    var c = (e && e.code) || "";
    switch (c) {
      case "auth/invalid-email":          return "That does not look like an email address.";
      case "auth/missing-password":       return "Enter your password.";
      case "auth/weak-password":          return "Passwords need at least six characters — eight or more is better.";
      case "auth/email-already-in-use":   return "There is already an account with that email. Sign in instead.";
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":     return "No account with that email and password.";
      case "auth/too-many-requests":      return "Too many attempts. Wait a minute and try again.";
      case "auth/network-request-failed": return "The network dropped. Check your connection and try again.";
      case "auth/operation-not-allowed":  return "Email and password sign-in is switched off for this project. " +
                                                 "Enable it under Authentication → Sign-in method.";
      case "auth/user-disabled":          return "That account has been disabled.";
      default: return (e && e.message) || "Something went wrong signing in.";
    }
  };

  N.canSignIn = function () { return backend === "firebase" && !!(fb && fb.auth); };

  N.signIn = function () {
    if (!N.canSignIn()) return Promise.resolve(null);
    var provider = new fb.auth.GoogleAuthProvider();
    var cur = fb.auth().currentUser;
    /* Upgrade the anonymous account in place, so the resident keeps their
       uid, their score and anything else already keyed to it. */
    var attempt = (cur && cur.isAnonymous && cur.linkWithPopup)
      ? cur.linkWithPopup(provider).catch(function (e) {
          /* already a Google account on this project: just sign in as it */
          if (e && (e.code === "auth/credential-already-in-use" ||
                    e.code === "auth/email-already-in-use" ||
                    e.code === "auth/provider-already-linked")) {
            return fb.auth().signInWithPopup(provider);
          }
          throw e;
        })
      : fb.auth().signInWithPopup(provider);

    return attempt
      .then(function (res) { return res && res.user; })
      .catch(function (e) {
        if (e && e.code === "auth/popup-blocked") return fb.auth().signInWithRedirect(provider);
        throw e;
      });
  };
  N.signOut = function () {
    if (backend !== "firebase" || !fb.auth) return Promise.resolve();
    if (presenceRef) presenceRef.remove().catch(function () { });
    /* Nothing of this session outlives it: talk in flight, the handshake
       inbox and any activity we were running all go first. */
    if (N.flushChat) N.flushChat();
    if (N.endActivity) N.endActivity();
    if (N.voiceLiveClear) N.voiceLiveClear();
    if (N.clearSignals) N.clearSignals();
    /* Take the chalk and the posters down before letting go of the account:
       after sign-out the rules would refuse the delete. */
    return N.dropMine().then(function () { return fb.auth().signOut(); });
  };

  /* ------------------------------------------------------------ presence */
  var presenceStarted = false;
  function startFirebasePresence() {
    if (fsLive) { startFirestoreLive(); return; }
    if (!rtdb || !currentUser || presenceStarted) return;
    presenceStarted = true;
    myKey = currentUser.uid;
    presenceRef = rtdb.ref("presence/" + myKey);
    presenceRef.onDisconnect().remove().catch(function () {});
    rtdb.ref("presence").on("value", function (snap) {
      var val = snap.val() || {};
      var peers = [], stale = [];
      Object.keys(val).forEach(function (k) {
        if (k === myKey) return;
        var p = val[k] || {};
        /* Someone whose tab was killed without a clean disconnect leaves a
           record behind. Hide them after a minute, and tidy up after five. */
        var age = p.at ? Date.now() - p.at : 0;
        if (age > 60000) { if (age > 300000) stale.push(k); return; }
        peers.push({ key: k, presence: p });
      });
      lastPeers = {};
      peers.forEach(function (pp) { lastPeers[pp.key] = { uid: pp.key, n: pp.presence.n }; });
      peerHandlers.forEach(function (h) { try { h(peers); } catch (e) { } });
      /* one client in six does the tidying, and only now and then */
      if (stale.length && Math.random() < 0.15) {
        stale.slice(0, 5).forEach(function (k) {
          rtdb.ref("presence/" + k).remove().catch(function () {});
        });
      }
    }, function (e) { fail("presence read", e); });
    rtdb.ref("chat").limitToLast(30).on("child_added", function (snap) {
      var m = snap.val() || {};
      m.key = snap.key;
      /* Talk is ephemeral; anything older than its time to live is a
         straggler somebody's crashed tab left behind. */
      if (Date.now() - (m.at || 0) > CHAT_TTL) return;
      /* Your own line is put up the moment you press send, so the copy the
         database hands back is the same line a second time. Drop it, the
         way the Firestore listener below already does. Compared against the
         signed-in uid rather than myKey, which is only set once presence
         has started and may not be there yet for a very early message. */
      var mine = currentUser ? currentUser.uid : null;
      if (m.uid && mine && m.uid === mine) return;
      chatHandlers.forEach(function (h) { try { h(m, false); } catch (e) { } });
      /* Tell the author it has been read, so they can delete it. */
      ackChat(snap.key);
    }, function (e) { fail("chat read", e); });
    /* Speech no longer passes through the database at all: see the live
       voice section below, which keeps only the WebRTC handshake here. */
  }

  /* ==================================================== Firestore live
   * Presence, chat, announcements and room claims over Firestore, for a
   * project that has no Realtime Database. Deliberately slower, and honest
   * about being slower; the shapes on the wire are the same either way. */
  var FS_PRESENCE_MS = 2500, FS_BEAT_MS = 25000;
  var fsStarted = false, fsSince = 0;

  function startFirestoreLive() {
    if (!fs || !currentUser || fsStarted) return;
    fsStarted = true;
    myKey = currentUser.uid;
    fsSince = Date.now();
    presenceDoc = fs.collection("presence").doc(myKey);

    /* There is no onDisconnect here, so leave on the way out and let
       staleness cover the cases the browser does not tell us about. */
    if (typeof window !== "undefined" && window.addEventListener) {
      var bye = function () { try { presenceDoc.delete(); } catch (e) {} };
      window.addEventListener("pagehide", bye);
      window.addEventListener("beforeunload", bye);
    }

    fsUnsub.push(fs.collection("presence").onSnapshot(function (snap) {
      var peers = [], stale = [];
      snap.docs.forEach(function (d) {
        if (d.id === myKey) return;
        var pr = d.data() || {};
        var age = pr.at ? Date.now() - pr.at : 0;
        if (age > 60000) { if (age > 300000) stale.push(d.id); return; }
        peers.push({ key: d.id, presence: pr });
      });
      peerHandlers.forEach(function (h) { try { h(peers); } catch (e) {} });
      if (stale.length && Math.random() < 0.1) {
        stale.slice(0, 3).forEach(function (k) {
          fs.collection("presence").doc(k).delete().catch(function () {});
        });
      }
    }, function (e) { fail("presence read", e); }));

    fsUnsub.push(fs.collection("chat").onSnapshot(function (snap) {
      snap.docChanges().forEach(function (ch) {
        if (ch.type !== "added") return;
        var m = ch.doc.data() || {};
        if (!m.at || m.at < Date.now() - CHAT_TTL) return;
        if (m.uid === myKey) return;              /* already echoed locally */
        chatHandlers.forEach(function (h) { try { h(m, false); } catch (e) {} });
        /* Read once, then gone: on Firestore the reader clears it too, so
           nothing survives past the people who were online for it. */
        if (m.exp && Date.now() > m.exp) ch.doc.ref.delete().catch(function () {});
      });
    }, function (e) { fail("chat read", e); }));

    setConnected(true);
  }

  function fsRoomDoc(roomId) {
    return fs.collection("rooms").doc(String(roomId).replace(/[^A-Za-z0-9_-]/g, "_"));
  }
  /* One document per room, so a claim is one transaction. */
  function fsClaim(roomId, leaf, take) {
    var doc = fsRoomDoc(roomId);
    /* leaf arrives as the Realtime Database path ("seats/3" or "speaker");
       inside one Firestore document the seat is just its number. */
    var isSeat = leaf.indexOf("seats/") === 0;
    var key = isSeat ? leaf.slice(6) : leaf;
    return fs.runTransaction(function (tx) {
      return tx.get(doc).then(function (snap) {
        var data = (snap.exists && snap.data()) || {};
        data.seats = data.seats || {};
        if (data.speaker === undefined) data.speaker = null;
        var cur = isSeat ? data.seats[key] : data.speaker;
        if (take) {
          if (cur != null && claimOwner(cur) !== uid() && !claimStale(cur)) return false;
          if (isSeat) data.seats[key] = claimValue(); else data.speaker = claimValue();
        } else {
          if (cur != null && claimOwner(cur) !== uid()) return true;
          if (isSeat) delete data.seats[key]; else data.speaker = null;
        }
        tx.set(doc, data);
        return true;
      });
    }).catch(function (e) { fail("room claim", e); return false; });
  }

  function wireClaudeRoom() {
    claudeRoom.onPeers(function (change) {
      var peers = [];
      change.peers.forEach(function (p) {
        if (p.isMe) return;
        peers.push({ key: p.peer, presence: p.presence || {} });
      });
      peerHandlers.forEach(function (h) { try { h(peers); } catch (e) { } });
    }, function () { });
    claudeRoom.on("chat", function (msg) {
      var d = msg.data || {};
      chatHandlers.forEach(function (h) { try { h(d, msg.isMe); } catch (e) { } });
    });
    claudeRoom.on("village", function (msg) {
      if (msg.isMe) return;
      var d = msg.data || {};
      (N._onEvent || function () { })(d.kind, d);
    });
  }

  /* Presence is the only thing written continuously, so it is the only
     thing worth being careful about:
       - at most once every 240ms, however often the loop calls in;
       - and only when something actually moved or changed, otherwise a
         heartbeat every 12 seconds just to prove we are still here.
     Standing still therefore costs five writes a minute, not 240. */
  function samePresence(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < 0.25 && Math.abs(a.z - b.z) < 0.25 &&
           Math.abs(a.r - b.r) < 0.12 && a.n === b.n && a.p === b.p &&
           a.rm === b.rm && a.st === b.st && a.si === b.si && !!a.cy === !!b.cy &&
           JSON.stringify(a.l || null) === JSON.stringify(b.l || null);
  }
  N.setPresence = function (obj) {
    pendingPresence = obj;
    var now = Date.now();
    var minGap = fsLive ? FS_PRESENCE_MS : 240;
    var beat = fsLive ? FS_BEAT_MS : 12000;
    if (now - lastPresence < minGap) return;

    var p = pendingPresence; pendingPresence = null;
    var still = samePresence(p, lastSent);
    if (still && now - lastBeat < beat) return;

    lastPresence = now;
    if (!still || now - lastBeat >= beat) lastBeat = now;
    lastSent = { x: p.x, z: p.z, r: p.r, n: p.n, p: p.p, rm: p.rm, st: p.st, si: p.si, cy: p.cy, l:p.l };
    p.at = now;
    if (backend === "firebase" && presenceRef) {
      presenceRef.set(p).catch(function (e) { fail("presence write", e); });
    } else if (backend === "firebase" && presenceDoc) {
      presenceDoc.set(p).catch(function (e) { fail("presence write", e); });
    } else if (backend === "claude" && claudeRoom) {
      claudeRoom.presence(p).catch(function () {});
    }
  };
  N.onPeers = function (h) { peerHandlers.push(h); };

  /* Prune a push-keyed log from the OLD end.
   *
   * Push ids sort chronologically, so orderByKey().limitToFirst(n) is the
   * genuinely oldest slice — and ordering by key needs no .indexOn, unlike
   * orderByChild("at"). Anything past maxAgeMs goes; the rules allow a
   * signed-in resident to delete entries older than an hour, so the window
   * here must stay comfortably above that. Runs on roughly one call in six,
   * because every resident does this and the log only needs tidying now and
   * then. */
  function prune(path, maxAgeMs) {
    if (backend !== "firebase" || !rtdb) return;
    if (Math.random() > 0.17) return;
    var cutoff = Date.now() - maxAgeMs;
    rtdb.ref(path).orderByKey().limitToFirst(25).once("value", function (snap) {
      snap.forEach(function (child) {
        var v = child.val();
        if (v && typeof v.at === "number" && v.at < cutoff) {
          child.ref.remove().catch(function () { });
        }
      });
    }, function () { });
  }

  /* ---------------------------------------------------------------- chat
   *
   * Village talk is deliberately ephemeral. A line lives in the database
   * only long enough to reach the people who are online:
   *
   *   - the author pushes it and immediately arms onDisconnect().remove(),
   *     so a closed tab takes the line with it;
   *   - every reader writes seen/<their uid> once the line is on screen;
   *   - the author watches that list and deletes the line as soon as each
   *     resident who was present has read it;
   *   - a hard timer removes it regardless after CHAT_TTL, so a reader who
   *     wanders off mid-sentence cannot pin a message to the database.
   *
   * Nothing is kept. There is no history to fetch, and on a cold start a
   * client only ever sees what is still in flight. */
  var CHAT_TTL = 45000;
  var ownChat = {};             /* push key -> { ref, timer, off } */
  var seenChat = {};            /* push key -> true, so we ack only once */

  function knownPeerUids() {
    var out = [];
    Object.keys(lastPeers || {}).forEach(function (k) {
      var p = lastPeers[k];
      var u = (p && p.uid) || k;
      if (u && u !== uid()) out.push(u);
    });
    return out;
  }

  function dropChat(key) {
    var rec = ownChat[key];
    if (!rec) return;
    delete ownChat[key];
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.off) { try { rec.off(); } catch (e) {} }
    try { rec.ref.onDisconnect().cancel().catch(function () {}); } catch (e) {}
    rec.ref.remove().catch(function () {});
  }

  /* Watch our own line and bin it the moment everyone present has read it. */
  function trackChat(ref) {
    var key = ref.key;
    var expected = knownPeerUids();
    var rec = ownChat[key] = { ref: ref, timer: null, off: null };
    rec.timer = setTimeout(function () { dropChat(key); }, CHAT_TTL);
    if (!expected.length) {
      /* nobody else is here: give it a beat on screen, then bin it */
      rec.timer = setTimeout(function () { dropChat(key); }, 4000);
      return;
    }
    var seenRef = ref.child("seen");
    var handler = seenRef.on("value", function (snap) {
      var seen = snap.val() || {};
      for (var i = 0; i < expected.length; i++) {
        if (!seen[expected[i]]) return;
      }
      dropChat(key);
    }, function () {});
    rec.off = function () { try { seenRef.off("value", handler); } catch (e) {} };
  }

  /* Acknowledge a line we have just put on screen, so its author can bin it. */
  function ackChat(key) {
    if (!key || seenChat[key]) return;
    seenChat[key] = true;
    if (backend !== "firebase" || !rtdb || !currentUser) return;
    rtdb.ref("chat/" + key + "/seen/" + currentUser.uid).set(true).catch(function () {});
  }
  N.ackChat = ackChat;

  N.sendChat = function (obj) {
    obj.at = Date.now();
    if (backend === "firebase" && rtdb) {
      obj.uid = currentUser ? currentUser.uid : "anon";
      var ref = rtdb.ref("chat").push();
      ref.onDisconnect().remove().catch(function () {});
      ref.set(obj).then(function () { trackChat(ref); }).catch(function () {});
      chatHandlers.forEach(function (h) { try { h(obj, true); } catch (e) { } });
    } else if (backend === "firebase" && fsLive && fs) {
      obj.uid = currentUser ? currentUser.uid : "anon";
      obj.exp = obj.at + CHAT_TTL;
      fs.collection("chat").add(obj).then(function (d) {
        setTimeout(function () { d.delete().catch(function () {}); }, CHAT_TTL);
      }).catch(function (e) { fail("chat write", e); });
      chatHandlers.forEach(function (h) { try { h(obj, true); } catch (e) { } });
    } else if (backend === "claude" && claudeRoom) {
      claudeRoom.emit("chat", obj).catch(function () { });
    } else {
      chatHandlers.forEach(function (h) { try { h(obj, true); } catch (e) { } });
    }
  };
  N.onChat = function (h) { chatHandlers.push(h); };

  /* Clear everything of ours still in flight — sign-out and page unload. */
  N.flushChat = function () {
    Object.keys(ownChat).forEach(dropChat);
  };

  /* ------------------------------------------------------- live voice
   *
   * Speech never touches the database. The audio itself rides a WebRTC
   * peer connection straight between two browsers; the database carries
   * nothing but the handshake, and each handshake note is deleted by the
   * client that reads it.
   *
   *   voiceLive/<uid>   who is speaking right now, and from where. Armed
   *                     with onDisconnect, so a dropped tab stops speaking.
   *   voiceSignal/<to>/<from>/<key>
   *                     one offer, answer or ICE candidate. The recipient
   *                     removes it the instant it has been consumed.
   *
   * Because every speaker has their own set of peer connections, any number
   * of people can talk at once without queueing behind each other. */
  var liveVoiceRef = null, liveVoiceWatch = null, signalWatch = null;

  /* The database's clock, as best this browser can tell.
   *
   * A speaker's note is stamped with a time and a listener throws it away
   * once it is two minutes old — but "old" was worked out by comparing the
   * speaker's clock with the listener's. A laptop whose clock is a few
   * minutes out is common enough, and to a listener ahead of it every note
   * that speaker writes is already stale: that one resident is dropped from
   * the roster and never heard, while everybody else hears them fine.
   * Stamping and judging by the server's clock takes the two machines'
   * disagreement out of it. */
  var serverOffset = 0, offsetWatched = false;
  function serverNow() {
    if (!offsetWatched && rtdb) {
      offsetWatched = true;
      try {
        rtdb.ref(".info/serverTimeOffset").on("value", function (s) {
          var v = s && s.val();
          if (typeof v === "number" && isFinite(v)) serverOffset = v;
        });
      } catch (e) {}
    }
    return Date.now() + serverOffset;
  }

  N.uid = function () { return uid(); };
  N.hasRtdb = function () { return backend === "firebase" && !!rtdb; };

  /* Announce (or refresh) that we are speaking. */
  N.voiceLiveSet = function (obj) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve(false);
    obj.at = serverNow();
    obj.uid = currentUser.uid;
    liveVoiceRef = rtdb.ref("voiceLive/" + currentUser.uid);
    liveVoiceRef.onDisconnect().remove().catch(function () {});
    return liveVoiceRef.set(obj).then(function () { return true; })
      .catch(function (e) { fail("voiceLive write", e); return false; });
  };

  /* Stop speaking. */
  N.voiceLiveClear = function () {
    if (!liveVoiceRef) return Promise.resolve();
    var ref = liveVoiceRef; liveVoiceRef = null;
    try { ref.onDisconnect().cancel().catch(function () {}); } catch (e) {}
    return ref.remove().catch(function () {});
  };

  /* Everyone who is speaking, as a map of uid -> record. */
  N.watchVoiceLive = function (cb) {
    if (backend !== "firebase" || !rtdb) return function () {};
    var ref = rtdb.ref("voiceLive");
    serverNow();
    var h = ref.on("value", function (snap) {
      var all = snap.val() || {}, now = serverNow(), out = {};
      Object.keys(all).forEach(function (u) {
        var v = all[u] || {};
        /* a record nobody refreshed for two minutes is a crashed tab */
        if (v.at && now - v.at > 120000) {
          if (u === uid()) rtdb.ref("voiceLive/" + u).remove().catch(function () {});
          return;
        }
        v.uid = u;
        out[u] = v;
      });
      cb(out);
    }, function (e) { fail("voiceLive read", e); });
    liveVoiceWatch = function () { try { ref.off("value", h); } catch (e) {} };
    return liveVoiceWatch;
  };

  /* One handshake note to one peer. Small, and short-lived by contract. */
  N.sendSignal = function (toUid, payload) {
    if (backend !== "firebase" || !rtdb || !currentUser || !toUid) return Promise.resolve(false);
    var ref = rtdb.ref("voiceSignal/" + toUid + "/" + currentUser.uid).push();
    ref.onDisconnect().remove().catch(function () {});
    payload.at = Date.now();
    return ref.set(payload).then(function () { return true; })
      .catch(function (e) {
        /* A handshake note that cannot be written is the one failure that
           looks exactly like success from the outside: the speaker's light
           comes on, the roster says they are talking, and the offer that
           would have carried the audio never leaves the building. Say so
           once, or the only symptom is silence. */
        fail("voiceSignal write", e);
        return false;
      });
  };

  /* Handshake notes addressed to us. Each one is deleted as it is read.
   *
   * The inbox is two levels deep — voiceSignal/<me>/<from>/<key> — so a
   * child_added on the inbox fires for the *sender*, not the note, and the
   * handler has to walk that sender's notes itself. Watching child_added and
   * child_changed to catch both the first note and later ones delivered the
   * same note twice whenever a second arrived before the first removal had
   * been acknowledged: child_added handed over {k1}, child_changed then
   * handed over {k1, k2}. A repeated offer makes the listener throw away the
   * peer connection it just built and answer a second time, and the speaker
   * rejects that second answer because its own connection is already stable —
   * so the connection the listener is actually holding never gets an answer
   * and the call is silent.
   *
   * One "value" watch over a mailbox that is never more than a few hundred
   * bytes, with each note's push key remembered, delivers every note exactly
   * once however the events happen to land. */
  /* The inbox is shared by the village mesh (voice.js) and private calls
     (private.js). Two "value" listeners on one mailbox would each delete
     notes out from under the other, so there is one listener and every
     note is handed to every subscriber; each ignores the types it does not
     own. */
  var signalCbs = [];
  N.watchSignals = function (cb) {
    if (backend !== "firebase" || !rtdb || !currentUser) return function () {};
    signalCbs.push(cb);
    var unsub = function () {
      var i = signalCbs.indexOf(cb);
      if (i >= 0) signalCbs.splice(i, 1);
    };
    if (signalWatch) return unsub;
    var ref = rtdb.ref("voiceSignal/" + currentUser.uid);
    var seen = {};          /* push key -> when we handled it */
    var h = ref.on("value", function (snap) {
      var now = Date.now();
      snap.forEach(function (fromSnap) {
        var from = fromSnap.key;
        fromSnap.forEach(function (msgSnap) {
          var key = msgSnap.key;
          msgSnap.ref.remove().catch(function () {});
          if (seen[key]) return;      /* the delete has not landed yet */
          seen[key] = now;
          var v = msgSnap.val();
          if (v) signalCbs.slice().forEach(function (f) { try { f(from, v); } catch (e) {} });
        });
      });
      /* a handshake is over in well under a minute, so nothing older than
         that can still arrive and the list cannot grow with the session */
      var keys = Object.keys(seen);
      if (keys.length > 300) {
        keys.forEach(function (k) { if (now - seen[k] > 60000) delete seen[k]; });
      }
    }, function (e) { fail("voiceSignal read", e); });
    signalWatch = function () {
      try { ref.off("value", h); } catch (e) {}
      seen = {};
    };
    return unsub;
  };

  /* Drop our whole signalling inbox — used on sign-out. */
  N.clearSignals = function () {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve();
    return rtdb.ref("voiceSignal/" + currentUser.uid).remove().catch(function () {});
  };

  /* ---------------------------------------------------- private messages
   *
   * One thread per pair of residents, readable by those two and nobody
   * else — the rules check that the reader's uid is one half of the key.
   *
   *   dm/<a>~<b>/<key>      { f: sender uid, m: text, at }   a < b
   *   dmInbox/<to>/<from>   { n: sender name, p: preview, at }
   *                         the unread flag: written by the sender, read
   *                         and cleared only by the recipient.
   *
   * Unlike village talk these are kept, so a message to somebody who has
   * just left is waiting for them next time. Anything older than a month
   * is tidied away by either participant when they open the thread. */
  var DM_KEEP = 30 * 24 * 3600 * 1000;
  function dmPair(other) {
    var a = currentUser.uid, b = String(other);
    return a < b ? a + "~" + b : b + "~" + a;
  }
  N.dmAvailable = function () { return backend === "firebase" && !!rtdb && !!currentUser; };

  N.dmSend = function (toUid, text, myName) {
    if (!N.dmAvailable() || !toUid) return Promise.reject(new Error("Private messages need the live village."));
    var m = String(text || "").slice(0, 1000);
    var at = serverNow();
    var ref = rtdb.ref("dm/" + dmPair(toUid)).push();
    return ref.set({ f: currentUser.uid, m: m, at: at }).then(function () {
      return rtdb.ref("dmInbox/" + toUid + "/" + currentUser.uid).set({
        n: String(myName || "Resident").slice(0, 32), p: m.slice(0, 80), at: at
      }).catch(function (e) { fail("dmInbox write", e); });
    }).then(function () { return ref.key; }, function (e) { fail("dm write", e); throw e; });
  };

  /* The last fifty messages with one resident, then each new one as it
     lands. cb(message) per message, in order. */
  N.dmWatch = function (otherUid, cb, onErr) {
    if (!N.dmAvailable() || !otherUid) return function () {};
    var path = "dm/" + dmPair(otherUid);
    var q = rtdb.ref(path).limitToLast(50);
    var h = q.on("child_added", function (snap) {
      var v = snap.val() || {};
      v.key = snap.key;
      try { cb(v); } catch (e) {}
    }, function (e) { fail("dm read", e); if (onErr) onErr(e); });
    prune(path, DM_KEEP);
    return function () { try { q.off("child_added", h); } catch (e) {} };
  };

  /* Who has written to us that we have not read yet: uid -> { n, p, at }. */
  N.dmInboxWatch = function (cb) {
    if (!N.dmAvailable()) return function () {};
    var ref = rtdb.ref("dmInbox/" + currentUser.uid);
    var h = ref.on("value", function (snap) {
      try { cb(snap.val() || {}); } catch (e) {}
    }, function (e) { fail("dmInbox read", e); });
    return function () { try { ref.off("value", h); } catch (e) {} };
  };

  N.dmMarkRead = function (fromUid) {
    if (!N.dmAvailable() || !fromUid) return Promise.resolve();
    return rtdb.ref("dmInbox/" + currentUser.uid + "/" + fromUid).remove().catch(function () {});
  };

  /* ---------------------------------------------------------- activities
   *
   * A seminar starting, somebody taking a blackboard, a poster going up.
   * Each is one record under its author's uid, armed with onDisconnect, so
   * an activity ends by itself when the person running it leaves. */
  var myActivityRef = null;

  var localActivities = {};
  function pushLocalActivities() {
    (activityHandlers || []).forEach(function (h) {
      try { h(localActivities); } catch (e) {}
    });
  }

  N.startActivity = function (obj) {
    if (backend !== "firebase" || !rtdb || !currentUser) {
      /* Solo: the activity still shows up in your own Live Activities list,
         which is the only place it could go. */
      obj.at = Date.now();
      obj.uid = obj.id = "local";
      localActivities = { local: obj };
      pushLocalActivities();
      return Promise.resolve(false);
    }
    obj.at = Date.now();
    obj.uid = currentUser.uid;
    myActivityRef = rtdb.ref("activities/" + currentUser.uid);
    myActivityRef.onDisconnect().remove().catch(function () {});
    return myActivityRef.set(obj).then(function () { return true; })
      .catch(function (e) { fail("activity write", e); return false; });
  };

  N.endActivity = function () {
    if (localActivities.local) { localActivities = {}; pushLocalActivities(); }
    if (!myActivityRef) return Promise.resolve();
    var ref = myActivityRef; myActivityRef = null;
    try { ref.onDisconnect().cancel().catch(function () {}); } catch (e) {}
    return ref.remove().catch(function () {});
  };

  var activityHandlers = [];
  N.watchActivities = function (cb) {
    activityHandlers.push(cb);
    if (backend !== "firebase" || !rtdb) { cb(localActivities); return function () {}; }
    var ref = rtdb.ref("activities");
    var h = ref.on("value", function (snap) {
      var all = snap.val() || {}, now = Date.now(), out = {};
      Object.keys(all).forEach(function (u) {
        var v = all[u] || {};
        if (v.at && now - v.at > 4 * 3600000) {
          if (u === uid()) rtdb.ref("activities/" + u).remove().catch(function () {});
          return;
        }
        v.uid = u; v.id = u;
        out[u] = v;
      });
      cb(out);
    }, function (e) { fail("activities read", e); });
    return function () { try { ref.off("value", h); } catch (e) {} };
  };

  /* ------------------------------------------- boards and posters (live)
   * Both the chalk and the posters live here, under the uid of whoever put
   * them up, and both are armed with onDisconnect. That is the whole design:
   * the server drops your work the moment your connection goes, so closing
   * the tab, losing the network or signing out all clear the village by
   * themselves and nothing outlives the session.
   *
   * Filing each one under its author rather than over the top of whatever
   * was there matters — otherwise the first person to leave would take the
   * board down on everybody still reading it. Each board shows whichever
   * entry was written last.
   */
  var mine = {};              /* path -> payload, everything this session owns */

  function ephemeralSet(base, value) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve();
    var path = base + "/" + currentUser.uid;
    var ref = rtdb.ref(path);
    if (value == null) {
      delete mine[path];
      return ref.remove().catch(function (e) { fail("clearing " + base, e); });
    }
    mine[path] = value;
    ref.onDisconnect().remove().catch(function () {});
    return ref.set(value).catch(function (e) { fail("writing " + base, e); });
  }
  /* The one exception: a poster pinned during an approved poster
     competition. It carries competitionId and expiresAt, the rules check
     both against the competition record, and it has to outlive its
     author's session — so it gets no disconnect hook, is not kept in
     `mine` (sign-out and reconnect leave it alone), and is swept once
     expiresAt has passed rather than when its author leaves. */
  function persistentSet(base, value) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve();
    var path = base + "/" + currentUser.uid;
    var ref = rtdb.ref(path);
    var wasNormal = !!mine[path];
    delete mine[path];
    try { ref.onDisconnect().cancel().catch(function () {}); } catch (e) {}
    /* the rules will not turn a session poster into a competition one in
       place, so an ordinary poster of ours comes down first */
    var first = wasNormal ? ref.remove() : Promise.resolve();
    return first.then(function () { return ref.set(value); })
      .catch(function (e) { fail("writing competition " + base, e); throw e; });
  }
  N.putBoard  = function (id, v) { return ephemeralSet("boards/" + id, v); };
  N.putPoster = function (id, v) {
    if (v && v.competitionId) return persistentSet("posters/" + id, v);
    return ephemeralSet("posters/" + id, v);
  };
  /* The slide on a seminar hall's board. One page at a time, never the whole
     PDF: the deck stays in the presenter's browser and only the page
     everybody is looking at is on the wire. Same disconnect hook as the
     chalk, so a presenter who closes the tab takes their deck down with
     them and the hall is not left staring at page four for ever. */
  N.putSlides = function (id, v) { return ephemeralSet("slides/" + id, v); };

  /* ------------------------------------------- one document per surface
   *
   * A poster stand or a blackboard shows one person's document at a time,
   * and whoever pins first keeps it until they take it down. The server
   * enforces that rather than trusting every browser to be polite:
   *
   *   pins/posters/<frame>   { u, n, at }   who holds a poster stand
   *   pins/boards/<board>    { u, n, at }   who holds a blackboard — a
   *                                         pinned picture or a slide deck
   *
   * A claim is taken in a transaction, so of two people pressing "Pin it
   * up" at the same instant exactly one wins and the other is told who got
   * there first. The rules refuse a poster, a slide or a board picture from
   * anybody who does not hold the claim, and the claim carries the same
   * disconnect hook as the document, so it frees itself when its holder
   * leaves. Chalk is not a document and stays open to everyone. */
  var claims = {};            /* "kind/id" -> our name on it, what this session holds */
  var lasting = {};           /* "kind/id" -> true for a competition claim, which outlives the session */
  var claimLostHandlers = [];

  function claimPath(kind, id) { return "pins/" + kind + "/" + id; }
  /* A competition claim whose competition is over holds nothing. */
  function claimExpired(c) {
    return !!(c && typeof c.expiresAt === "number" && c.expiresAt <= serverNow());
  }

  /* `comp`, when given, is { competitionId, expiresAt }: the stand is being
     taken for a competition poster, so the claim lasts until the
     competition ends instead of until we disconnect. */
  N.claimSurface = function (kind, id, name, comp) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve({ ok: true });
    var me = currentUser.uid, holder = null;
    var ref = rtdb.ref(claimPath(kind, id));
    var k = kind + "/" + id;
    return ref.transaction(function (cur) {
      if (cur && cur.u && cur.u !== me && !claimExpired(cur)) { holder = cur; return; }   /* taken: abort */
      holder = null;
      var v = { u: me, n: String(name || "").slice(0, 32),
                at: (cur && cur.u === me && !claimExpired(cur) && cur.at) || Date.now() };
      if (comp && comp.competitionId) {
        v.competitionId = comp.competitionId;
        v.expiresAt = comp.expiresAt;
      }
      return v;
    }, null, false).then(function (res) {
      if (!res.committed) {
        return { ok: false, holder: holder || (res.snapshot && res.snapshot.val()) || null };
      }
      claims[k] = String(name || "").slice(0, 32);
      if (comp && comp.competitionId) {
        lasting[k] = true;
        try { ref.onDisconnect().cancel().catch(function () {}); } catch (e) {}
      } else {
        delete lasting[k];
        ref.onDisconnect().remove().catch(function () {});
      }
      return { ok: true };
    }).catch(function (e) {
      /* A competition claim the rules refused (the competition ended in
         the meantime, say) is a refusal, not an old rule set. */
      if (comp && comp.competitionId) {
        fail("claiming " + kind + "/" + id + " for a competition", e);
        return { ok: false, holder: null, refused: true };
      }
      /* The rules that carry pins/ are not the ones deployed. Pinning still
         works — it did before — but nothing stops two people sharing a
         stand until database.rules.json is deployed, so say so loudly. */
      fail("claiming " + kind + "/" + id + " (deploy database.rules.json)", e);
      claims[kind + "/" + id] = String(name || "").slice(0, 32);
      return { ok: true, unenforced: true };
    });
  };

  /* `force` also gives back a claim this session does not remember taking —
     a competition claim from before a page refresh is still ours. The
     transaction below only ever deletes our own. */
  N.releaseSurface = function (kind, id, force) {
    var k = kind + "/" + id;
    if (!claims[k] && !force) return Promise.resolve();
    delete claims[k];
    delete lasting[k];
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve();
    var ref = rtdb.ref(claimPath(kind, id)), me = currentUser.uid;
    try { ref.onDisconnect().cancel().catch(function () {}); } catch (e) {}
    /* only ever delete our own claim — never one somebody took after us */
    return ref.transaction(function (cur) {
      if (cur && cur.u === me) return null;
      return;
    }, null, false).catch(function () {});
  };

  N.holdsSurface = function (kind, id) { return !!claims[kind + "/" + id]; };

  /* Every claim in the village: { posters: {id: {u,n,at}}, boards: {...} }. */
  N.watchSurfaces = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var ref = rtdb.ref("pins");
    var h = ref.on("value", function (snap) {
      try { cb(snap.val() || {}); } catch (e) {}
    }, function (e) {
      fail("pins read (deploy database.rules.json)", e);
      cb({});
    });
    return function () { try { ref.off("value", h); } catch (e) {} };
  };

  /* Somebody else holds a surface we thought was ours — we were offline
     long enough for the disconnect hook to fire, and they pinned in the
     meantime. (kind, id) */
  N.onClaimLost = function (cb) { claimLostHandlers.push(cb); };

  /* Which claim a record in `mine` needs before it may go back up. */
  function claimFor(path) {
    var p = path.split("/");
    var v = mine[path];
    if (p[0] === "posters") return "posters/" + p[1];
    if (p[0] === "slides") return "boards/" + p[1];
    if (p[0] === "boards" && v && v.p) return "boards/" + p[1];
    return null;
  }

  /* A dropped connection loses the server-side disconnect hooks, so put them
     back — and the work with them — when it returns. A surface somebody
     else took while we were gone is theirs now: our document comes down
     rather than being written over theirs (the rules would refuse it). */
  function reArmMine() {
    if (!rtdb || !currentUser) return;
    /* a competition claim has no disconnect hook to lose */
    var held = Object.keys(claims).filter(function (k) { return !lasting[k]; });
    Promise.all(held.map(function (k) {
      var parts = k.split("/");
      var ref = rtdb.ref(claimPath(parts[0], parts[1])), me = currentUser.uid;
      return ref.transaction(function (cur) {
        if (cur && cur.u && cur.u !== me) return;
        return { u: me, n: claims[k] || "", at: (cur && cur.at) || Date.now() };
      }, null, false).then(function (res) {
        if (res.committed) {
          ref.onDisconnect().remove().catch(function () {});
          return null;
        }
        delete claims[k];
        return k;
      }, function () { return null; });   /* rules not deployed: keep going */
    })).then(function (lost) {
      lost = lost.filter(Boolean);
      Object.keys(mine).forEach(function (path) {
        var ref = rtdb.ref(path);
        var need = claimFor(path);
        if (need && lost.indexOf(need) >= 0) {
          if (path.indexOf("boards/") === 0) {
            /* the chalk is still ours to keep; only the picture goes */
            mine[path] = Object.assign({}, mine[path], { p: "" });
          } else {
            delete mine[path];
            ref.remove().catch(function () {});
            return;
          }
        }
        ref.onDisconnect().remove().catch(function () {});
        ref.set(mine[path]).catch(function () {});
      });
      lost.forEach(function (k) {
        var parts = k.split("/");
        claimLostHandlers.forEach(function (h) { try { h(parts[0], parts[1]); } catch (e) {} });
      });
    });
  }

  /* Signing out is a deliberate goodbye: take it all down now rather than
     waiting for the socket to close. */
  N.dropMine = function () {
    var paths = Object.keys(mine);
    /* Competition posters are not in `mine`, and their claims are left
       standing: both stay up until the competition ends. */
    var held = Object.keys(claims).filter(function (k) { return !lasting[k]; });
    mine = {};
    Object.keys(lasting).forEach(function (k) { delete claims[k]; });
    lasting = {};
    if (backend !== "firebase" || !rtdb) { claims = {}; return Promise.resolve(); }
    /* the documents first, then the claims, so nobody else can pin into a
       stand that is still showing ours */
    return Promise.all(paths.map(function (p) {
      return rtdb.ref(p).remove().catch(function () {});
    })).then(function () {
      return Promise.all(held.map(function (k) {
        var parts = k.split("/");
        return N.releaseSurface(parts[0], parts[1]);
      }));
    });
  };

  /* One listener per tree. Each id resolves to whichever author wrote last;
     the second argument is every author's record, id -> uid -> record, for
     a caller that needs to pick by who holds the surface rather than by
     who wrote last. */
  function watchLatest(base, cb) {
    if (backend !== "firebase" || !rtdb) return function () {};
    var ref = rtdb.ref(base);
    var h = ref.on("value", function (snap) {
      var all = snap.val() || {}, out = {};
      Object.keys(all).forEach(function (id) {
        var byUid = all[id] || {}, best = null;
        Object.keys(byUid).forEach(function (u) {
          var v = byUid[u];
          if (v && (!best || (v.at || 0) > (best.at || 0))) best = v;
        });
        if (best) out[id] = best;
      });
      try { cb(out, all); } catch (e) {}
    }, function (e) { fail(base + " read", e); });
    return function () { try { ref.off("value", h); } catch (e) {} };
  }
  N.watchBoards  = function (cb) { return watchLatest("boards", cb); };
  N.watchPosters = function (cb) { return watchLatest("posters", cb); };
  N.watchSlides  = function (cb) { return watchLatest("slides", cb); };

  /* Poster votes are durable, one per signed-in resident, and live. A child
     keyed by uid gives us deduplication without trusting a client counter. */
  N.likePoster = function (id) {
    id = String(id || "");
    if (!id || backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve(false);
    return rtdb.ref("posterLikes/" + id + "/" + currentUser.uid).set(true)
      .then(function () { return true; })
      .catch(function (e) { fail("poster like", e); return false; });
  };
  N.clearMyPosterLike = function (id) {
    id = String(id || "");
    if (!id || backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve(false);
    return rtdb.ref("posterLikes/" + id + "/" + currentUser.uid).remove()
      .then(function () { return true; })
      .catch(function () { return false; });
  };
  N.watchPosterLikes = function (cb) {
    if (backend !== "firebase" || !rtdb) return function () {};
    var ref = rtdb.ref("posterLikes");
    var h = ref.on("value", function (snap) {
      var all = snap.val() || {}, counts = {};
      var mine = {};
      var uid = currentUser && currentUser.uid;
      Object.keys(all).forEach(function (id) {
        counts[id] = Object.keys(all[id] || {}).length;
        if (uid && all[id] && all[id][uid] === true) mine[id] = true;
      });
      try { cb(counts, mine); } catch (e) {}
    }, function (e) { fail("poster likes read", e); });
    return function () { try { ref.off("value", h); } catch (e) {} };
  };

  /* ------------------------------------------- poster competitions
   *
   * A poster hall can hold a 24-hour poster competition, asked for by any
   * resident and approved by an administrator. Four branches, all in the
   * Realtime Database so the rules can check one against another:
   *
   *   posterCompetitionRequests/<id>  the request, pending → approved|rejected
   *   posterCompetitions/<id>         the competition (same id as its request)
   *   posterHallCompetition/<hall>    { id, approvedAt, expiresAt } — the one
   *                                   running in a hall; the rules refuse a
   *                                   second while it is unexpired
   *   posters/<frame>/<uid>           a competition poster is an ordinary
   *                                   poster plus competitionId, hallId and
   *                                   expiresAt (see persistentSet above)
   *
   * approvedAt is the database's own clock (ServerValue.TIMESTAMP, which the
   * rules check against `now`), and every expiry the rules accept is
   * exactly approvedAt + 24 h, so no browser clock decides when anything
   * ends. The rules enforce the end on their own: once approvedAt + 24 h has
   * passed, nothing more may be pinned under the competition, and anybody
   * may sweep what is left. Clients hide expired posters by the server
   * clock straight away; the sweeping is tidying, not what hides them. */
  var COMP_MS = 24 * 3600000;
  N.COMPETITION_MS = COMP_MS;
  N.serverNow = function () { return serverNow(); };
  N.competitionsLive = function () { return backend === "firebase" && !!rtdb; };
  function TS() { return fb.database.ServerValue.TIMESTAMP; }
  function needRtdb() {
    if (backend !== "firebase" || !rtdb || !currentUser) {
      return Promise.reject(new Error("Poster competitions need the live village (Firebase Realtime Database)."));
    }
    return null;
  }

  N.requestPosterCompetition = function (o) {
    var no = needRtdb(); if (no) return no;
    o = o || {};
    var rec = {
      userId: currentUser.uid,
      userName: String(o.userName || "Resident").slice(0, 32),
      hallId: String(o.hallId || ""),
      title: String(o.title || "").trim().slice(0, 90),
      requestedAt: TS(),
      status: "pending"
    };
    var d = String(o.description || "").trim().slice(0, 500);
    if (d) rec.description = d;
    if (typeof o.preferredStart === "number" && isFinite(o.preferredStart)) rec.preferredStart = o.preferredStart;
    /* who is organising it, for the Notice Board */
    if (o.fullName) rec.fullName = String(o.fullName).trim().slice(0, 80);
    if (o.institution) rec.institution = String(o.institution).trim().slice(0, 120);
    if (o.position) rec.position = String(o.position).trim().slice(0, 80);
    var ref = rtdb.ref("posterCompetitionRequests").push();
    return ref.set(rec).then(function () { return ref.key; })
      .catch(function (e) { fail("competition request", e); throw e; });
  };

  N.withdrawPosterCompetitionRequest = function (id) {
    var no = needRtdb(); if (no) return no;
    return rtdb.ref("posterCompetitionRequests/" + id).remove();
  };

  /* Requests still waiting on an administrator: what the halls show as
     "pending", and what the administration panel lists. */
  N.watchPendingCompetitionRequests = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var q = rtdb.ref("posterCompetitionRequests").orderByChild("status").equalTo("pending");
    var h = q.on("value", function (snap) { try { cb(snap.val() || {}); } catch (e) {} },
                 function (e) { fail("competition requests read (deploy database.rules.json)", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };
  /* Our own requests, so the person who asked hears the answer. */
  N.watchMyCompetitionRequests = function (cb) {
    if (backend !== "firebase" || !rtdb || !currentUser) { cb({}); return function () {}; }
    var q = rtdb.ref("posterCompetitionRequests").orderByChild("userId").equalTo(currentUser.uid);
    var h = q.on("value", function (snap) { try { cb(snap.val() || {}); } catch (e) {} },
                 function (e) { fail("my competition requests read", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };

  /* What is running in each hall: { hallId: { id, approvedAt, expiresAt,
     competition } }, with the competition record joined on. Watching the
     hall branch rather than every competition keeps this to two nodes. */
  N.watchHallCompetitions = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var halls = {}, comps = {}, compRefs = {};
    function emit() {
      var out = {};
      Object.keys(halls).forEach(function (h) {
        var l = halls[h];
        if (!l || !l.id) return;
        out[h] = { id: l.id, approvedAt: l.approvedAt,
                   expiresAt: typeof l.approvedAt === "number" ? l.approvedAt + COMP_MS : null,
                   competition: comps[l.id] || null };
      });
      try { cb(out); } catch (e) {}
    }
    function follow(id) {
      if (compRefs[id]) return;
      var r = rtdb.ref("posterCompetitions/" + id);
      compRefs[id] = { ref: r, h: r.on("value", function (s) { comps[id] = s.val(); emit(); },
                                        function (e) { fail("competition read", e); }) };
    }
    var ref = rtdb.ref("posterHallCompetition");
    var h = ref.on("value", function (snap) {
      halls = snap.val() || {};
      var want = {};
      Object.keys(halls).forEach(function (k) { if (halls[k] && halls[k].id) { want[halls[k].id] = 1; follow(halls[k].id); } });
      Object.keys(compRefs).forEach(function (id) {
        if (want[id]) return;
        try { compRefs[id].ref.off("value", compRefs[id].h); } catch (e) {}
        delete compRefs[id]; delete comps[id];
      });
      emit();
    }, function (e) { fail("hall competitions read (deploy database.rules.json)", e); cb({}); });
    return function () {
      try { ref.off("value", h); } catch (e) {}
      Object.keys(compRefs).forEach(function (id) { try { compRefs[id].ref.off("value", compRefs[id].h); } catch (e) {} });
      compRefs = {};
    };
  };

  /* Administrator only — the rules refuse everybody else. One atomic
     write marks the request approved, creates the competition and takes
     the hall, all stamped with the same server time; the rules refuse the
     lot if the hall already has an unexpired competition. The expiry
     follows in a second write, because it can only be worked out once the
     server has said what time it stamped — and the rules accept exactly
     one value for it, approvedAt + 24 h, so it cannot be stretched. */
  N.approvePosterCompetition = function (id, req) {
    var no = needRtdb(); if (no) return no;
    if (!req || req.status !== "pending") return Promise.reject(new Error("That request is no longer pending."));
    var u = {}, rp = "posterCompetitionRequests/" + id + "/";
    u[rp + "status"] = "approved";
    u[rp + "approvedAt"] = TS();
    u[rp + "decidedAt"] = TS();
    u[rp + "decidedBy"] = currentUser.uid;
    u["posterCompetitions/" + id] = {
      requestId: id, hallId: req.hallId, title: req.title,
      organiserId: req.userId, organiserName: req.userName,
      status: "active", approvedAt: TS()
    };
    u["posterHallCompetition/" + req.hallId] = { id: id, approvedAt: TS() };
    /* and it goes on the Notice Board in the same write */
    u["villageNotices/c-" + id] = {
      noticeId: "c-" + id, competitionId: id, eventType: "poster_competition",
      name: String(req.fullName || req.userName || "A resident").slice(0, 80),
      institution: req.institution || "", position: req.position || "",
      topic: req.title, abstract: req.description || "", hallId: req.hallId,
      hallName: (N.BOOKABLE_HALLS[req.hallId] || {}).name || req.hallId,
      startAt: TS(), status: "active", createdAt: TS()
    };
    return rtdb.ref().update(u).then(function () {
      return N.fillCompetitionExpiry(id, req.hallId);
    });
  };

  /* Write the derived expiresAt wherever it is missing. Anybody may do this
     — the rules accept only approvedAt + 24 h — so if the administrator's
     tab closed between the two writes the next visitor finishes the job. */
  N.fillCompetitionExpiry = function (id, hallId) {
    if (backend !== "firebase" || !rtdb) return Promise.resolve();
    return rtdb.ref("posterCompetitions/" + id).once("value").then(function (s) {
      var c = s.val();
      if (!c || typeof c.approvedAt !== "number") return;
      var exp = c.approvedAt + COMP_MS, jobs = [];
      if (c.expiresAt !== exp) jobs.push(rtdb.ref("posterCompetitions/" + id + "/expiresAt").set(exp));
      jobs.push(rtdb.ref("posterCompetitionRequests/" + id + "/expiresAt").once("value").then(function (r) {
        if (r.val() !== exp) return r.ref.set(exp);
      }));
      jobs.push(rtdb.ref("villageNotices/c-" + id + "/endAt").once("value").then(function (r) {
        if (r.val() == null) return rtdb.ref("villageNotices/c-" + id).once("value").then(function (n) {
          if (n.exists()) return r.ref.set(exp);
        });
      }));
      jobs.push(rtdb.ref("posterHallCompetition/" + (hallId || c.hallId)).once("value").then(function (l) {
        var v = l.val();
        if (v && v.id === id && v.expiresAt !== exp) return l.ref.child("expiresAt").set(exp);
      }));
      return Promise.all(jobs.map(function (j) { return j.catch(function (e) { fail("competition expiry", e); }); }));
    });
  };

  N.rejectPosterCompetition = function (id) {
    var no = needRtdb(); if (no) return no;
    var u = {}, rp = "posterCompetitionRequests/" + id + "/";
    u[rp + "status"] = "rejected";
    u[rp + "decidedAt"] = TS();
    u[rp + "decidedBy"] = currentUser.uid;
    return rtdb.ref().update(u);
  };

  /* End a competition early — its organiser or an administrator. One write
     marks it over, lets the hall go and moves its notice to Past; the rules
     then let anybody sweep its posters and stands, and this sweeps the
     ones it can find. Every browser hides them as soon as the hall is let
     go, so nothing waits on the sweep. */
  N.endPosterCompetition = function (id, hallId) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    var u = {};
    u["posterCompetitions/" + id + "/status"] = "expired";
    u["posterCompetitions/" + id + "/endedAt"] = TS();
    u["posterCompetitions/" + id + "/endedBy"] = currentUser.uid;
    return Promise.all([
      rtdb.ref("posterHallCompetition/" + hallId).once("value"),
      rtdb.ref("villageNotices/c-" + id).once("value")
    ]).then(function (r) {
      var lock = r[0].val(), notice = r[1].val();
      if (lock && lock.id === id) u["posterHallCompetition/" + hallId] = null;
      if (notice && notice.status === "active") u["villageNotices/c-" + id + "/status"] = "archived";
      return rtdb.ref().update(u);
    }).then(function () {
      return N.sweepCompetitionPosters(id);
    });
  };
  /* Take down every stand claim and poster of a competition that is over.
     Stands are found from pins/posters (small); only those stands'
     posters are read, never the whole poster tree. */
  N.sweepCompetitionPosters = function (id) {
    if (backend !== "firebase" || !rtdb) return Promise.resolve();
    return rtdb.ref("pins/posters").once("value").then(function (s) {
      var pins = s.val() || {}, frames = Object.keys(pins).filter(function (f) {
        return pins[f] && pins[f].competitionId === id;
      });
      return Promise.all(frames.map(function (f) {
        return rtdb.ref("posters/" + f).once("value").then(function (ps) {
          var u = {}, all = ps.val() || {};
          Object.keys(all).forEach(function (uid) {
            if (all[uid] && all[uid].competitionId === id) u["posters/" + f + "/" + uid] = null;
          });
          return Object.keys(u).length ? rtdb.ref().update(u) : null;
        }).catch(function () {}).then(function () {
          return rtdb.ref("pins/posters/" + f).remove().catch(function () {});
        });
      }));
    });
  };

  /* Tidy up after a competition that is over. Every step is allowed to
     anybody by the rules once approvedAt + 24 h has passed, and every step
     is idempotent, so it does not matter how many visitors race to it or
     whether a Cloud Function got there first. `posters` and `pins` are the
     paths the caller has seen expire: "posters/<frame>/<uid>", "pins/posters/<frame>". */
  N.sweepExpiredCompetition = function (o) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.resolve();
    o = o || {};
    var jobs = [];
    (o.posters || []).concat(o.pins || []).forEach(function (p) {
      jobs.push(rtdb.ref(p).remove().catch(function () {}));
    });
    /* the competition is marked over before the hall is let go, so a
       half-finished sweep never leaves an "active" competition that no hall
       points at */
    var marked = o.id
      ? rtdb.ref("posterCompetitions/" + o.id + "/status").set("expired").then(function () { return true; },
          function () { return false; })
      : Promise.resolve(false);
    jobs.push(marked);
    if (o.id && o.hallId) {
      /* only this competition's hold on the hall — never a newer one's
         (the rules refuse that to anybody but an administrator anyway) */
      var lock = rtdb.ref("posterHallCompetition/" + o.hallId);
      jobs.push(marked.then(function () { return lock.once("value"); }).then(function (s) {
        var cur = s.val();
        if (cur && cur.id === o.id) return lock.remove();
      }).catch(function () {}));
    }
    return Promise.all(jobs);
  };

  /* ------------------------------------------ hall bookings and notices
   *
   *   hallBookings/<id>          a request to book a seminar or poster hall;
   *                              private to its author and administrators
   *   bookingsByUser/<uid>/<id>  how an author finds their own requests
   *   hallSlots/<hall>/<ms>      { b, t }: who holds each quarter hour —
   *                              taken only on approval, only if free, so
   *                              two overlapping bookings cannot both be
   *                              approved however close the two approvals
   *   villageNotices/<id>        the Notice Board: approved events only,
   *                              "b-<booking>" or "c-<competition>"
   *
   * Times are absolute (startAt/endAt, ms since the epoch), so everybody
   * sees an event in their own time zone; date/startTime/endTime/tz keep
   * what the organiser typed, for the record. */
  var SLOT_MS = 15 * 60000;
  N.BOOKING_SLOT_MS = SLOT_MS;
  N.BOOKING_MAX_MS = 12 * 3600000;
  N.BOOKABLE_HALLS = {
    "seminar-hall-a": { name: "Seminar Hall Alpha", type: "seminar" },
    "seminar-hall-b": { name: "Seminar Hall Beta", type: "seminar" },
    "poster-hall":    { name: "The Poster Hall", type: "poster" },
    "poster-hall-2":  { name: "The Grand Poster Hall", type: "poster" }
  };
  N.EVENT_TYPES = {
    seminar: "Seminar", poster_presentation: "Poster Presentation",
    poster_competition: "Poster Competition", workshop: "Workshop",
    conference: "Conference / Mini-conference", research_discussion: "Research Discussion",
    journal_club: "Journal Club", other: "Other academic event"
  };
  N.bookingsLive = function () { return backend === "firebase" && !!rtdb; };
  function slotKeys(startAt, endAt) {
    var out = [];
    for (var t = startAt; t < endAt; t += SLOT_MS) out.push(t);
    return out;
  }

  N.requestHallBooking = function (o) {
    if (backend !== "firebase" || !rtdb || !currentUser) {
      return Promise.reject(new Error("Bookings need the live village — sign in and try again."));
    }
    var ref = rtdb.ref("hallBookings").push();
    var hall = N.BOOKABLE_HALLS[o.hallId];
    if (!hall) return Promise.reject(new Error("That hall cannot be booked."));
    var rec = {
      bookingId: ref.key, userId: currentUser.uid,
      name: String(o.name || "").slice(0, 80), institution: String(o.institution || "").slice(0, 120),
      position: String(o.position || "").slice(0, 80), topic: String(o.topic || "").slice(0, 160),
      abstract: String(o.abstract || "").slice(0, 1500),
      hallId: o.hallId, hallType: hall.type, eventType: o.eventType,
      date: o.date, startTime: o.startTime, endTime: o.endTime, tz: String(o.tz || "").slice(0, 64),
      startAt: o.startAt, endAt: o.endAt, status: "pending", createdAt: TS()
    };
    if (o.extra) rec.extra = String(o.extra).slice(0, 1000);
    var u = {};
    u["hallBookings/" + ref.key] = rec;
    u["bookingsByUser/" + currentUser.uid + "/" + ref.key] = true;
    u["bookingThrottle/" + currentUser.uid] = TS();
    return rtdb.ref().update(u).then(function () { return ref.key; })
      .catch(function (e) { fail("booking request", e); throw e; });
  };

  N.withdrawHallBooking = function (id) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    var u = {};
    u["hallBookings/" + id] = null;
    u["bookingsByUser/" + currentUser.uid + "/" + id] = null;
    return rtdb.ref().update(u);
  };

  /* Our own requests, each read by id — the rules let an author read their
     own bookings and nobody else's. */
  N.watchMyBookings = function (cb) {
    if (backend !== "firebase" || !rtdb || !currentUser) { cb({}); return function () {}; }
    var idx = rtdb.ref("bookingsByUser/" + currentUser.uid), subs = {}, recs = {};
    function emit() { try { cb(Object.assign({}, recs)); } catch (e) {} }
    var h = idx.on("value", function (snap) {
      var ids = snap.val() || {};
      Object.keys(ids).forEach(function (id) {
        if (subs[id]) return;
        var r = rtdb.ref("hallBookings/" + id);
        subs[id] = { ref: r, h: r.on("value", function (s) {
          if (s.exists()) recs[id] = s.val(); else delete recs[id];
          emit();
        }, function () {}) };
      });
      Object.keys(subs).forEach(function (id) {
        if (ids[id]) return;
        try { subs[id].ref.off("value", subs[id].h); } catch (e) {}
        delete subs[id]; delete recs[id];
      });
      emit();
    }, function (e) { fail("my bookings read", e); cb({}); });
    return function () {
      try { idx.off("value", h); } catch (e) {}
      Object.keys(subs).forEach(function (id) { try { subs[id].ref.off("value", subs[id].h); } catch (e) {} });
    };
  };

  /* Administrator only. */
  N.watchAllBookings = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var q = rtdb.ref("hallBookings").orderByChild("createdAt").limitToLast(500);
    var h = q.on("value", function (s) { try { cb(s.val() || {}); } catch (e) {} },
                 function (e) { fail("bookings read (deploy database.rules.json)", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };
  N.watchAllCompetitionRequests = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var q = rtdb.ref("posterCompetitionRequests").orderByChild("requestedAt").limitToLast(300);
    var h = q.on("value", function (s) { try { cb(s.val() || {}); } catch (e) {} },
                 function (e) { fail("competition requests read", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };

  N.watchNotices = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var q = rtdb.ref("villageNotices").orderByChild("startAt").limitToLast(400);
    var h = q.on("value", function (s) { try { cb(s.val() || {}); } catch (e) {} },
                 function (e) { fail("notice board read (deploy database.rules.json)", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };

  /* Which approved bookings already hold any quarter hour of [startAt,
     endAt) in a hall: { bookingId: true }. Slot keys are all thirteen
     digits, so their string order is their time order. */
  N.hallConflicts = function (hallId, startAt, endAt) {
    if (backend !== "firebase" || !rtdb) return Promise.resolve({});
    return rtdb.ref("hallSlots/" + hallId).orderByKey()
      .startAt(String(startAt)).endAt(String(endAt - SLOT_MS)).once("value")
      .then(function (s) {
        var out = {};
        s.forEach(function (c) { var v = c.val(); if (v && v.b) out[v.b] = true; });
        return out;
      });
  };

  /* Administrator only. The booking, every quarter hour it covers and its
     notice go in one write; the rules refuse the lot if any slot is taken,
     which is what makes a race between two approvals safe. */
  N.approveHallBooking = function (id, b) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    if (!b || b.status !== "pending") return Promise.reject(new Error("That booking is no longer pending."));
    return N.hallConflicts(b.hallId, b.startAt, b.endAt).then(function (taken) {
      if (Object.keys(taken).length) {
        var err = new Error("That hall is already booked for part of this time.");
        err.conflicts = taken;
        throw err;
      }
      var u = {}, p = "hallBookings/" + id + "/", nid = "b-" + id;
      u[p + "status"] = "approved";
      u[p + "approvedAt"] = TS();
      u[p + "decidedAt"] = TS();
      u[p + "decidedBy"] = currentUser.uid;
      u[p + "noticeId"] = nid;
      var n = {
        noticeId: nid, bookingId: id, eventType: b.eventType, name: b.name,
        institution: b.institution || "", position: b.position || "", topic: b.topic,
        abstract: b.abstract || "", hallId: b.hallId,
        hallName: (N.BOOKABLE_HALLS[b.hallId] || {}).name || b.hallId,
        date: b.date || "", startTime: b.startTime || "", endTime: b.endTime || "", tz: b.tz || "",
        startAt: b.startAt, endAt: b.endAt, status: "active", createdAt: TS()
      };
      u["villageNotices/" + nid] = n;
      slotKeys(b.startAt, b.endAt).forEach(function (t) {
        u["hallSlots/" + b.hallId + "/" + t] = { b: id, t: t };
      });
      return rtdb.ref().update(u).catch(function (e) {
        /* Look again rather than guess: a slot taken in the last moment is
           one reason, security rules older than this page are the other. */
        return N.hallConflicts(b.hallId, b.startAt, b.endAt).then(function (now) {
          var err = new Error(Object.keys(now).length
            ? "Another booking was approved for part of this time a moment ago."
            : "The database refused it (" + ((e && (e.code || e.message)) || "permission denied") +
              "). Check that the latest database.rules.json is published.");
          err.cause = e;
          throw err;
        });
      });
    });
  };
  N.rejectHallBooking = function (id) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    var u = {}, p = "hallBookings/" + id + "/";
    u[p + "status"] = "rejected";
    u[p + "decidedAt"] = TS();
    u[p + "decidedBy"] = currentUser.uid;
    return rtdb.ref().update(u);
  };
  /* An approved booking called off: its notice says so, and its quarter
     hours are free again. */
  N.cancelHallBooking = function (id, b) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    var u = {};
    u["hallBookings/" + id + "/status"] = "cancelled";
    u["hallBookings/" + id + "/cancelledAt"] = TS();
    u["villageNotices/b-" + id + "/status"] = "cancelled";
    return rtdb.ref("hallSlots/" + b.hallId).orderByKey()
      .startAt(String(b.startAt)).endAt(String(b.endAt - SLOT_MS)).once("value")
      .then(function (s) {
        s.forEach(function (c) { if (c.val() && c.val().b === id) u["hallSlots/" + b.hallId + "/" + c.key] = null; });
        return rtdb.ref().update(u);
      });
  };
  /* Administrator: take a notice off the board for good. A booking that
     has not happened yet is cancelled with it and its hall freed, and a
     running competition is ended — so deleting a notice never leaves a
     hall reserved or a competition running with nothing on the board. */
  N.deleteNotice = function (nid) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    return rtdb.ref("villageNotices/" + nid).once("value").then(function (s) {
      var n = s.val();
      if (!n) return;
      if (n.competitionId) {
        return rtdb.ref("posterCompetitions/" + n.competitionId).once("value").then(function (c) {
          var comp = c.val();
          var first = comp && comp.status === "active"
            ? N.endPosterCompetition(n.competitionId, comp.hallId) : Promise.resolve();
          return first.then(function () { return rtdb.ref("villageNotices/" + nid).remove(); });
        });
      }
      if (!n.bookingId) return rtdb.ref("villageNotices/" + nid).remove();
      return rtdb.ref("hallBookings/" + n.bookingId).once("value").then(function (bs) {
        var b = bs.val(), u = {};
        u["villageNotices/" + nid] = null;
        if (!b || b.status !== "approved" || b.endAt <= serverNow()) return rtdb.ref().update(u);
        u["hallBookings/" + n.bookingId + "/status"] = "cancelled";
        u["hallBookings/" + n.bookingId + "/cancelledAt"] = TS();
        return rtdb.ref("hallSlots/" + b.hallId).orderByKey()
          .startAt(String(b.startAt)).endAt(String(b.endAt - SLOT_MS)).once("value")
          .then(function (sl) {
            sl.forEach(function (x) { if (x.val() && x.val().b === n.bookingId) u["hallSlots/" + b.hallId + "/" + x.key] = null; });
            return rtdb.ref().update(u);
          });
      });
    });
  };
  /* Administrator: clear the whole Notice Board, one notice at a time so
     each gets the same care as a single delete. */
  N.wipeNotices = function () {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    return rtdb.ref("villageNotices").once("value").then(function (s) {
      var ids = Object.keys(s.val() || {}), failed = 0;
      return ids.reduce(function (p, nid) {
        return p.then(function () { return N.deleteNotice(nid).catch(function (e) { failed++; fail("delete notice", e); }); });
      }, Promise.resolve()).then(function () { return { removed: ids.length - failed, failed: failed }; });
    });
  };
  N.setNoticeStatus = function (nid, status) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    return rtdb.ref("villageNotices/" + nid + "/status").set(status);
  };
  /* Administrator: correct what a notice says. Only the wording — the
     rules keep its time and its hall fixed, since the hall's quarter hours
     were taken for exactly that time. */
  N.NOTICE_EDITABLE = { eventType: 1, topic: 160, name: 80, institution: 120, position: 80, abstract: 1500, hallName: 60 };
  N.updateNotice = function (nid, fields) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    var u = {};
    Object.keys(fields || {}).forEach(function (k) {
      if (!N.NOTICE_EDITABLE[k]) return;
      u["villageNotices/" + nid + "/" + k] = k === "eventType" ? fields[k]
        : String(fields[k] == null ? "" : fields[k]).slice(0, N.NOTICE_EDITABLE[k]);
    });
    return rtdb.ref().update(u);
  };

  /* ------------------------------------------- poster events
   *
   *   posterEvents/<eid>                  the event, written by an administrator
   *   posterRegs/<eid>/<uid>              one registration per resident, with
   *                                       the stand it holds: hallId + num
   *   posterSlots/<eid>/<hall>/<num>      = uid; who holds each numbered stand
   *   posterRegPosters/<eid>/<uid>        the poster they pinned to it
   *
   * A registration and its slot are written together and the rules accept
   * them only if each names the other, so a number can never be held twice
   * and the capacity cannot be exceeded from a browser. Two residents
   * racing for the same number: the second write is refused, and we look
   * again and take the next free one. */
  N.PE_HALLS = {
    "poster-hall":   { short: "Poster Hall 1", name: "The Poster Hall", stands: 12, cap: "cap1" },
    "poster-hall-2": { short: "Poster Hall 2", name: "The Grand Poster Hall", stands: 50, cap: "cap2" }
  };
  N.posterEventsLive = function () { return backend === "firebase" && !!rtdb; };
  function watchTree(path, cb, what) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var ref = rtdb.ref(path);
    var h = ref.on("value", function (s) { try { cb(s.val() || {}); } catch (e) {} },
                   function (e) { fail(what + " read (deploy database.rules.json)", e); cb({}); });
    return function () { try { ref.off("value", h); } catch (e) {} };
  }
  N.watchPosterEvents = function (cb) { return watchTree("posterEvents", cb, "poster events"); };
  N.watchPosterRegs = function (cb) { return watchTree("posterRegs", cb, "poster registrations"); };
  N.watchPosterSlots = function (cb) { return watchTree("posterSlots", cb, "poster slots"); };
  N.watchRegPosters = function (eid, cb) { return watchTree("posterRegPosters/" + eid, cb, "registered posters"); };

  function needLive() {
    return backend !== "firebase" || !rtdb || !currentUser ? Promise.reject(new Error("The live village is not connected.")) : null;
  }
  function denied(e) { return e && /permission|denied/i.test(String(e.code || "") + " " + String(e.message || "")); }

  /* Administrator: create (eid null) or edit an event. */
  N.savePosterEvent = function (eid, f) {
    var no = needLive(); if (no) return no;
    var v = {
      title: String(f.title || "").slice(0, 160), description: String(f.description || "").slice(0, 2000),
      startAt: f.startAt, endAt: f.endAt, cap1: f.cap1 | 0, cap2: f.cap2 | 0,
      status: f.status || "open", allowComp: !!f.allowComp, needsApproval: !!f.needsApproval
    };
    if (typeof f.deadline === "number") v.deadline = f.deadline;
    /* what an event carries over from the request it was approved from */
    var EXTRA = { topic: 160, venue: 300, abstract: 1500, orgName: 80, orgInst: 120, orgPos: 80 };
    Object.keys(EXTRA).forEach(function (k) {
      if (typeof f[k] === "string") v[k] = f[k].trim().slice(0, EXTRA[k]);
    });
    if (!eid) {
      var ref = rtdb.ref("posterEvents").push();
      v.createdAt = TS(); v.createdBy = currentUser.uid;
      return ref.set(v).then(function () { return ref.key; });
    }
    v.updatedAt = TS();
    var u = {};
    Object.keys(v).forEach(function (k) { u["posterEvents/" + eid + "/" + k] = v[k]; });
    if (typeof f.deadline !== "number") u["posterEvents/" + eid + "/deadline"] = null;
    return rtdb.ref().update(u).then(function () { return eid; });
  };
  N.setPosterEventStatus = function (eid, status) {
    var no = needLive(); if (no) return no;
    var u = {};
    u["posterEvents/" + eid + "/status"] = status;
    u["posterEvents/" + eid + "/updatedAt"] = TS();
    return rtdb.ref().update(u);
  };
  N.deletePosterEvent = function (eid) {
    var no = needLive(); if (no) return no;
    var u = {};
    ["posterEvents", "posterRegs", "posterSlots", "posterRegPosters"].forEach(function (b) { u[b + "/" + eid] = null; });
    return rtdb.ref().update(u);
  };

  /* The lowest number in a hall nobody holds, within the event's capacity. */
  function freeNumber(ev, hallId, taken) {
    var cap = Math.min(ev[N.PE_HALLS[hallId].cap] | 0, N.PE_HALLS[hallId].stands);
    for (var n = 1; n <= cap; n++) if (!(taken && taken[n])) return n;
    return 0;
  }
  function readEvent(eid) {
    return Promise.all([rtdb.ref("posterEvents/" + eid).once("value"),
                        rtdb.ref("posterSlots/" + eid).once("value")])
      .then(function (r) { return { ev: r[0].val(), slots: r[1].val() || {} }; });
  }
  /* Take the next free stand in one of `halls` for `uid`, writing `extra`
     alongside (the registration itself, or a move). Retries when somebody
     takes the same number first. */
  function takeSlot(eid, uid, halls, build) {
    var tries = 0;
    function attempt() {
      return readEvent(eid).then(function (st) {
        if (!st.ev) throw new Error("That event no longer exists.");
        var hall = null, num = 0;
        for (var i = 0; i < halls.length && !num; i++) {
          num = freeNumber(st.ev, halls[i], st.slots[halls[i]]);
          if (num) hall = halls[i];
        }
        if (!num) {
          var err = new Error(halls.length > 1 ? "Every poster stand for this event is taken."
            : N.PE_HALLS[halls[0]].short + " is full for this event.");
          err.full = true;
          throw err;
        }
        var u = build(hall, num, st.ev);
        u["posterSlots/" + eid + "/" + hall + "/" + num] = uid;
        return rtdb.ref().update(u).then(function () { return { hallId: hall, num: num }; }, function (e) {
          /* the number went to somebody a moment ago: look again */
          if (denied(e) && ++tries < 40) {
            return rtdb.ref("posterSlots/" + eid + "/" + hall + "/" + num).once("value").then(function (s) {
              if (!s.exists() || s.val() === uid) throw e;
              /* a moment's jitter, so a crowd registering at once spreads out */
              return new Promise(function (res) { setTimeout(res, Math.random() * 120 * Math.min(tries, 4)); }).then(attempt);
            });
          }
          throw e;
        });
      });
    }
    return attempt();
  }

  var REG_FIELDS = { name: 80, institution: 120, position: 80, affiliation: 160, title: 200, abstract: 1500 };
  function regText(f) {
    var o = {};
    Object.keys(REG_FIELDS).forEach(function (k) { o[k] = String(f[k] == null ? "" : f[k]).trim().slice(0, REG_FIELDS[k]); });
    o.mode = f.mode === "competition" ? "competition" : "presentation";
    return o;
  }

  /* A resident registers: `hall` is a hall id, or "" for whichever has room. */
  N.registerForPosterEvent = function (eid, f, hall) {
    var no = needLive(); if (no) return no;
    var uid = currentUser.uid;
    return readEvent(eid).then(function (st) {
      var ev = st.ev;
      if (!ev) throw new Error("That event no longer exists.");
      var halls = Object.keys(N.PE_HALLS).filter(function (h) { return (ev[N.PE_HALLS[h].cap] | 0) > 0; });
      if (hall) halls = halls.filter(function (h) { return h === hall; });
      if (!halls.length) throw new Error("That hall is not part of this event.");
      return takeSlot(eid, uid, halls, function (h, num, ev2) {
        var r = regText(f), u = {};
        r.uid = uid; r.hallId = h; r.num = num;
        r.status = ev2.needsApproval ? "pending" : "registered";
        r.createdAt = TS();
        u["posterRegs/" + eid + "/" + uid] = r;
        return u;
      });
    }).catch(function (e) {
      if (!denied(e)) throw e;
      /* say why, if it is something we can see */
      return rtdb.ref("posterEvents/" + eid).once("value").then(function (s) {
        var ev = s.val() || {}, now = serverNow();
        if (ev.status !== "open") throw new Error("Registration for this event is closed.");
        if (typeof ev.deadline === "number" && ev.deadline <= now) throw new Error("The registration deadline has passed.");
        if (ev.endAt <= now) throw new Error("This event is over.");
        return rtdb.ref("posterRegs/" + eid + "/" + uid).once("value").then(function (m) {
          if (m.exists()) throw new Error("You are already registered for this event.");
          throw new Error("The database refused the registration. The administrator may need to publish " +
                          "the latest database.rules.json.");
        });
      });
    });
  };
  N.updateMyPosterReg = function (eid, f) {
    var no = needLive(); if (no) return no;
    var r = regText(f), u = {}, p = "posterRegs/" + eid + "/" + currentUser.uid + "/";
    Object.keys(r).forEach(function (k) { u[p + k] = r[k]; });
    u[p + "updatedAt"] = TS();
    return rtdb.ref().update(u);
  };
  /* The registration, its stand and its poster go in one write, so the
     number is free again the moment the registration is gone and nobody
     else's number moves. Works for the resident and for an administrator. */
  N.cancelPosterReg = function (eid, uid, reg) {
    var no = needLive(); if (no) return no;
    var u = {};
    u["posterRegs/" + eid + "/" + uid] = null;
    u["posterRegPosters/" + eid + "/" + uid] = null;
    if (reg && reg.num >= 1) u["posterSlots/" + eid + "/" + reg.hallId + "/" + reg.num] = null;
    return rtdb.ref().update(u);
  };
  /* Administrator. Rejecting gives the stand back. */
  N.setPosterRegStatus = function (eid, uid, reg, status) {
    var no = needLive(); if (no) return no;
    var u = {}, p = "posterRegs/" + eid + "/" + uid + "/";
    u[p + "status"] = status;
    u[p + "updatedAt"] = TS();
    if (status === "rejected") {
      u[p + "num"] = 0;
      if (reg.num >= 1) u["posterSlots/" + eid + "/" + reg.hallId + "/" + reg.num] = null;
      u["posterRegPosters/" + eid + "/" + uid] = null;
    }
    return rtdb.ref().update(u);
  };
  /* Administrator: to the next free number in the other hall (or back into
     a hall, for a registration that was rejected). */
  N.movePosterReg = function (eid, uid, reg, toHall) {
    var no = needLive(); if (no) return no;
    return takeSlot(eid, uid, [toHall], function (h, num) {
      var u = {}, p = "posterRegs/" + eid + "/" + uid + "/";
      if (reg.num >= 1) u["posterSlots/" + eid + "/" + reg.hallId + "/" + reg.num] = null;
      u[p + "hallId"] = h; u[p + "num"] = num; u[p + "updatedAt"] = TS();
      if (reg.status === "rejected") u[p + "status"] = "approved";
      return u;
    });
  };
  N.putRegPoster = function (eid, src, title) {
    var no = needLive(); if (no) return no;
    return rtdb.ref("posterRegPosters/" + eid + "/" + currentUser.uid)
      .set({ s: src, t: String(title || "").slice(0, 200), at: TS() });
  };
  N.removeRegPoster = function (eid, uid) {
    var no = needLive(); if (no) return no;
    return rtdb.ref("posterRegPosters/" + eid + "/" + (uid || currentUser.uid)).remove();
  };
  /* ------------------------------------------- poster event requests
   *
   *   posterEventRequests/<id>       a resident asking to organise one;
   *                                  private to them and the administrators
   *   posterEventRequestPdfs/<id>    the PDF made from it when it was sent
   *   posterEventReqThrottle/<uid>   one request every thirty seconds
   *
   * Approving creates the event (posterEvents) and marks the request in
   * one write: nothing is on the Notice Board until then. */
  var REQ_FIELDS = { name: 80, institution: 120, email: 200, position: 80, title: 160, topic: 160,
    description: 3000, venueDetail: 300, abstract: 1500, extra: 2000, responsibilities: 2000, other: 2000, tz: 64 };
  N.newPosterEventRequestId = function () {
    return backend === "firebase" && rtdb ? rtdb.ref("posterEventRequests").push().key : null;
  };
  /* `pdf`, if given, is a data: URL made from the same fields. */
  N.requestPosterEvent = function (id, f, pdf) {
    var no = needLive(); if (no) return no;
    var r = {};
    Object.keys(REQ_FIELDS).forEach(function (k) { r[k] = String(f[k] == null ? "" : f[k]).trim().slice(0, REQ_FIELDS[k]); });
    r.userId = currentUser.uid;
    r.startAt = f.startAt; r.endAt = f.endAt;
    if (typeof f.deadline === "number") r.deadline = f.deadline;
    r.venue = f.venue;
    if (f.posters) r.posters = f.posters | 0;
    r.comp = !!f.comp;
    r.status = "pending";
    r.createdAt = TS();
    var u = {};
    u["posterEventRequests/" + id] = r;
    u["posterEventReqThrottle/" + currentUser.uid] = TS();
    if (pdf) u["posterEventRequestPdfs/" + id] = { d: pdf, at: TS() };
    return rtdb.ref().update(u).catch(function (e) {
      throw new Error(denied(e)
        ? "The request was refused. If you sent one in the last thirty seconds, wait a moment and try again; " +
          "otherwise the administrator may need to publish the latest database.rules.json."
        : "The request did not go through — check your connection and try again.");
    });
  };
  N.watchMyPosterEventRequests = function (cb) {
    if (backend !== "firebase" || !rtdb || !currentUser) { cb({}); return function () {}; }
    var q = rtdb.ref("posterEventRequests").orderByChild("userId").equalTo(currentUser.uid);
    var h = q.on("value", function (s) { try { cb(s.val() || {}); } catch (e) {} },
                 function (e) { fail("my poster event requests read (deploy database.rules.json)", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };
  N.watchPosterEventRequests = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var q = rtdb.ref("posterEventRequests").orderByChild("createdAt").limitToLast(300);
    var h = q.on("value", function (s) { try { cb(s.val() || {}); } catch (e) {} },
                 function (e) { fail("poster event requests read", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };
  N.getPosterEventRequestPdf = function (id) {
    var no = needLive(); if (no) return no;
    return rtdb.ref("posterEventRequestPdfs/" + id).once("value").then(function (s) { return s.val(); });
  };
  /* The requester withdrawing a pending request, or an administrator
     deleting any: the request and its PDF go together. */
  N.deletePosterEventRequest = function (id) {
    var no = needLive(); if (no) return no;
    var u = {};
    u["posterEventRequests/" + id] = null;
    u["posterEventRequestPdfs/" + id] = null;
    return rtdb.ref().update(u);
  };
  N.rejectPosterEventRequest = function (id, note) {
    var no = needLive(); if (no) return no;
    var u = {}, p = "posterEventRequests/" + id + "/";
    u[p + "status"] = "rejected";
    u[p + "decidedAt"] = TS();
    u[p + "decidedBy"] = currentUser.uid;
    if (note) u[p + "note"] = String(note).slice(0, 500);
    return rtdb.ref().update(u);
  };
  /* `ev` is the event as the administrator finalised it (savePosterEvent's
     fields). The event and the approval are one write. */
  N.approvePosterEventRequest = function (id, req, ev, note) {
    var no = needLive(); if (no) return no;
    var eid = rtdb.ref("posterEvents").push().key;
    var v = {
      title: String(ev.title || "").slice(0, 160), description: String(ev.description || "").slice(0, 2000),
      startAt: ev.startAt, endAt: ev.endAt, cap1: ev.cap1 | 0, cap2: ev.cap2 | 0, status: ev.status || "open",
      allowComp: !!ev.allowComp, needsApproval: !!ev.needsApproval,
      createdAt: TS(), createdBy: currentUser.uid, requestId: id, organiserId: req.userId,
      orgName: String(req.name || "").slice(0, 80), orgInst: String(req.institution || "").slice(0, 120),
      orgPos: String(req.position || "").slice(0, 80)
    };
    if (typeof ev.deadline === "number") v.deadline = ev.deadline;
    ["topic", "venue", "abstract"].forEach(function (k) { if (typeof ev[k] === "string" && ev[k]) v[k] = ev[k]; });
    var u = {}, p = "posterEventRequests/" + id + "/";
    u["posterEvents/" + eid] = v;
    u[p + "status"] = "approved";
    u[p + "eventId"] = eid;
    u[p + "decidedAt"] = TS();
    u[p + "decidedBy"] = currentUser.uid;
    if (note) u[p + "note"] = String(note).slice(0, 500);
    return rtdb.ref().update(u).then(function () { return eid; });
  };

  /* ------------------------------------------- reports and feedback
   *
   *   reports/<id>          one report: who, what kind, where, the whole
   *                         message, createdAt (server time), status.
   *                         Written once by its author; readable, and its
   *                         status changeable, only by an administrator.
   *   reportThrottle/<uid>  when this resident last sent one — the rules
   *                         require it to be stamped in the same write, and
   *                         refuse a second report within thirty seconds.
   *
   * Nothing here is ever swept. Talk is deleted once it has been read;
   * reports are records, and stay until an administrator deletes them. */
  N.REPORT_MAX = 5000;
  N.REPORT_STATUSES = ["new", "reviewing", "resolved", "dismissed"];
  N.reportsLive = function () { return backend === "firebase" && !!rtdb; };

  N.submitReport = function (o) {
    if (backend !== "firebase" || !rtdb || !currentUser) {
      return Promise.reject(new Error("Reports need the live village — sign in and try again."));
    }
    o = o || {};
    var ref = rtdb.ref("reports").push();
    var rec = {
      reportId: ref.key,
      userId: currentUser.uid,
      userName: String(o.userName || "Resident").slice(0, 32) || "Resident",
      reportType: String(o.reportType || ""),
      message: String(o.message || ""),
      createdAt: TS(),
      status: "new"
    };
    if (o.location) rec.location = String(o.location).slice(0, 80);
    if (o.subject) rec.subject = String(o.subject).slice(0, 200);
    if (o.userAgent) rec.userAgent = String(o.userAgent).slice(0, 300);
    if (o.viewport) rec.viewport = String(o.viewport).slice(0, 20);
    var u = {};
    u["reports/" + ref.key] = rec;
    u["reportThrottle/" + currentUser.uid] = TS();
    return rtdb.ref().update(u).then(function () { return ref.key; })
      .catch(function (e) { fail("report", e); throw e; });
  };

  /* Administrator only; the rules refuse the read to anybody else. */
  N.watchReports = function (cb) {
    if (backend !== "firebase" || !rtdb) { cb({}); return function () {}; }
    var q = rtdb.ref("reports").orderByChild("createdAt").limitToLast(500);
    var h = q.on("value", function (snap) { try { cb(snap.val() || {}); } catch (e) {} },
                 function (e) { fail("reports read (deploy database.rules.json)", e); cb({}); });
    return function () { try { q.off("value", h); } catch (e) {} };
  };
  N.setReportStatus = function (id, status) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    var u = {}, p = "reports/" + id + "/";
    u[p + "status"] = status;
    u[p + "statusAt"] = TS();
    u[p + "statusBy"] = currentUser.uid;
    return rtdb.ref().update(u);
  };
  N.deleteReport = function (id) {
    if (backend !== "firebase" || !rtdb || !currentUser) return Promise.reject(new Error("not available"));
    return rtdb.ref("reports/" + id).remove();
  };

  /* ------------------------------------------------------- world events */
  N.broadcast = function (kind, data) {
    data = data || {}; data.kind = kind; data.at = Date.now();
    if (backend === "firebase" && rtdb) {
      rtdb.ref("events").push(data).catch(function () { });
      prune("events", 24 * 3600000);   /* announcements are stale after a day */
    }
    else if (backend === "firebase" && fsLive && fs) {
      fs.collection("events").add(data).catch(function () { });
    }
    else if (backend === "claude" && claudeRoom) claudeRoom.emit("village", data).catch(function () { });
  };
  N.onEvent = function (h) {
    N._onEvent = h;
    if (backend === "firebase" && fsLive && fs) {
      var since = Date.now();
      fsUnsub.push(fs.collection("events").onSnapshot(function (snap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type !== "added") return;
          var d = ch.doc.data() || {};
          if (!d.at || d.at < since) return;
          if (currentUser && d.by === currentUser.uid) return;
          h(d.kind, d);
        });
      }, function () {}));
      return;
    }
    if (backend === "firebase" && rtdb) {
      rtdb.ref("events").limitToLast(10).on("child_added", function (snap) {
        var d = snap.val() || {};
        if (Date.now() - (d.at || 0) > 60000) return;
        if (currentUser && d.by === currentUser.uid) return;
        h(d.kind, d);
      });
    }
  };

  /* ============================================================== rooms
   * Seats and the speaking slot are contested resources, so they are claimed
   * with a transaction rather than a plain write: if two people press E on
   * the same chair in the same instant, exactly one of them sits down.
   *
   * Everything here is released automatically on disconnect, and re-claimed
   * after a reconnection, so a dropped connection does not leave a ghost
   * sitting in a seminar for the rest of the day.
   *
   * In the solo build the same API answers from memory. */
  function roomRef(roomId, leaf) {
    return rtdb.ref("rooms/" + String(roomId).replace(/[.#$\[\]\/]/g, "_") + "/" + leaf);
  }
  function uid() { return currentUser ? currentUser.uid : (window.QVLocalId || "guest"); }

  function remember(path) { if (myClaims.indexOf(path) < 0) myClaims.push(path); }
  function forget(path) { var i = myClaims.indexOf(path); if (i >= 0) myClaims.splice(i, 1); }
  function reclaimAll() {
    if (backend !== "firebase" || !rtdb) return;
    myClaims.slice().forEach(function (path) {
      var ref = rtdb.ref(path);
      ref.transaction(function (cur) {
        return (cur == null || claimOwner(cur) === uid() || claimStale(cur)) ? claimValue() : undefined;
      }).then(function (res) { if (res && res.committed) ref.onDisconnect().remove().catch(function () {}); })
        .catch(function () {});
    });
  }

  /* A claim is stored as { u: uid, t: when }. The timestamp is what lets a
     claim be broken after an hour: onDisconnect normally cleans up, but a
     client that died mid-write must not leave a chair occupied for ever. */
  var CLAIM_STALE = 3600000;
  function claimValue() { return { u: uid(), t: Date.now() }; }
  function claimOwner(v) { return v && typeof v === "object" ? v.u : v; }
  function claimStale(v) {
    return !!(v && typeof v === "object" && typeof v.t === "number" && Date.now() - v.t > CLAIM_STALE);
  }

  /* Claim `leaf` in `roomId`. Resolves true if it is yours. */
  function claim(roomId, leaf) {
    if (backend === "firebase" && fsLive && fs && currentUser) return fsClaim(roomId, leaf, true);
    if (backend !== "firebase" || !rtdb || !currentUser) {
      var key = roomId + "/" + leaf;
      if (localRooms[key] && localRooms[key] !== uid()) return Promise.resolve(false);
      localRooms[key] = uid();
      notifyLocalRoom(roomId);
      return Promise.resolve(true);
    }
    var ref = roomRef(roomId, leaf);
    return ref.transaction(function (cur) {
      if (cur == null || claimOwner(cur) === uid() || claimStale(cur)) return claimValue();
      return undefined;                      /* taken: abort, do not write */
    }).then(function (res) {
      var got = !!(res && res.committed && res.snapshot &&
                   claimOwner(res.snapshot.val()) === uid());
      if (got) {
        remember(ref.toString().replace(/^https?:\/\/[^/]+\//, ""));
        ref.onDisconnect().remove().catch(function () {});
      }
      return got;
    }).catch(function (e) { fail("room claim", e); return false; });
  }
  function release(roomId, leaf) {
    if (backend === "firebase" && fsLive && fs && currentUser) return fsClaim(roomId, leaf, false);
    if (backend !== "firebase" || !rtdb || !currentUser) {
      var key = roomId + "/" + leaf;
      if (localRooms[key] === uid()) delete localRooms[key];
      notifyLocalRoom(roomId);
      return Promise.resolve();
    }
    var ref = roomRef(roomId, leaf);
    forget(ref.toString().replace(/^https?:\/\/[^/]+\//, ""));
    ref.onDisconnect().cancel().catch(function () {});
    return ref.transaction(function (cur) { return claimOwner(cur) === uid() ? null : undefined; })
      .then(function () {}).catch(function () {});
  }

  N.claimSeat    = function (roomId, index) { return claim(roomId, "seats/" + index); };
  N.releaseSeat  = function (roomId, index) { return release(roomId, "seats/" + index); };
  N.claimSpeaker = function (roomId) { return claim(roomId, "speaker"); };
  N.releaseSpeaker = function (roomId) { return release(roomId, "speaker"); };

  var localRoomWatch = {};
  function notifyLocalRoom(roomId) {
    (localRoomWatch[roomId] || []).forEach(function (cb) { cb(localRoomState(roomId)); });
  }
  function localRoomState(roomId) {
    var out = { seats: {}, speaker: null };
    Object.keys(localRooms).forEach(function (k) {
      if (k.indexOf(roomId + "/") !== 0) return;
      var leaf = k.slice(roomId.length + 1);
      if (leaf === "speaker") out.speaker = localRooms[k];
      else if (leaf.indexOf("seats/") === 0) out.seats[leaf.slice(6)] = localRooms[k];
    });
    return out;
  }
  /* Watch one room's seats and speaker. Returns an unsubscribe function. */
  N.watchRoom = function (roomId, cb) {
    if (backend === "firebase" && fsLive && fs) {
      return fsRoomDoc(roomId).onSnapshot(function (snap) {
        var v = (snap.exists && snap.data()) || {};
        var seats = {};
        Object.keys(v.seats || {}).forEach(function (k) {
          if (!claimStale(v.seats[k])) seats[k] = claimOwner(v.seats[k]);
        });
        cb({ seats: seats, speaker: claimStale(v.speaker) ? null : (claimOwner(v.speaker) || null) });
      }, function (e) { fail("room watch", e); });
    }
    if (backend !== "firebase" || !rtdb) {
      (localRoomWatch[roomId] = localRoomWatch[roomId] || []).push(cb);
      cb(localRoomState(roomId));
      return function () {
        var list = localRoomWatch[roomId] || [];
        var i = list.indexOf(cb); if (i >= 0) list.splice(i, 1);
      };
    }
    var ref = rtdb.ref("rooms/" + String(roomId).replace(/[.#$\[\]\/]/g, "_"));
    var handler = ref.on("value", function (snap) {
      var v = snap.val() || {};
      var seats = {};
      Object.keys(v.seats || {}).forEach(function (k) {
        if (!claimStale(v.seats[k])) seats[k] = claimOwner(v.seats[k]);
      });
      var sp = claimStale(v.speaker) ? null : claimOwner(v.speaker);
      cb({ seats: seats, speaker: sp || null });
    }, function (e) { fail("room watch", e); });
    roomWatches[roomId] = { ref: ref, handler: handler };
    return function () { try { ref.off("value", handler); } catch (e) {} delete roomWatches[roomId]; };
  };
  /* Let go of everything — used when leaving a room or signing out. */
  N.releaseAll = function () {
    if (backend === "firebase" && fsLive) return Promise.resolve();
    if (backend !== "firebase" || !rtdb) { localRooms = {}; return Promise.resolve(); }
    return Promise.all(myClaims.slice().map(function (path) {
      var ref = rtdb.ref(path);
      forget(path);
      ref.onDisconnect().cancel().catch(function () {});
      return ref.transaction(function (cur) { return claimOwner(cur) === uid() ? null : undefined; }).catch(function () {});
    }));
  };

  /* ------------------------------------------------------ durable store */
  /* Paths look like "institutes/abc" (document) or "institutes" (collection). */
  N.docSet = function (path, data) {
    if (backend === "firebase" && fs) return fs.doc(path).set(data);
    if (backend === "claude" && claudeDb) return claudeDb.doc(path).set(data);
    localDocs[path] = data; notifyLocal(path);
    return Promise.resolve();
  };
  N.docUpdate = function (path, data) {
    if (backend === "firebase" && fs) return fs.doc(path).set(data, { merge: true });
    if (backend === "claude" && claudeDb) return claudeDb.doc(path).update(data);
    localDocs[path] = Object.assign(localDocs[path] || {}, data); notifyLocal(path);
    return Promise.resolve();
  };
  N.docGet = function (path) {
    if (backend === "firebase" && fs) {
      return fs.doc(path).get().then(function (s) { return s.exists ? s.data() : null; });
    }
    if (backend === "claude" && claudeDb) {
      return claudeDb.doc(path).get().then(function (s) { return s.exists ? s.data() : null; });
    }
    return Promise.resolve(localDocs[path] || null);
  };
  /* onError is optional: a refused or dropped listener is otherwise silent. */
  N.docWatch = function (path, cb, onError) {
    var err = function (e) { if (onError) { try { onError(e); } catch (x) { } } };
    if (backend === "firebase" && fs) {
      return fs.doc(path).onSnapshot(function (s) { cb(s.exists ? s.data() : null); }, err);
    }
    if (backend === "claude" && claudeDb) {
      return claudeDb.doc(path).onSnapshot(function (s) { cb(s.exists ? s.data() : null); }, err);
    }
    (localWatch[path] = localWatch[path] || []).push(cb);
    cb(localDocs[path] || null);
    return function () { };
  };
  N.collWatch = function (path, cb, limit) {
    limit = limit || 80;
    if (backend === "firebase" && fs) {
      return fs.collection(path).limit(limit).onSnapshot(function (snap) {
        cb(snap.docs.map(function (d) { var o = d.data() || {}; o.id = d.id; return o; }));
      }, function () { });
    }
    if (backend === "claude" && claudeDb) {
      return claudeDb.collection(path).limit(limit).onSnapshot(function (snap) {
        cb(snap.docs.map(function (d) { var o = d.data() || {}; o.id = d.id; return o; }));
      }, function () { });
    }
    (localCollWatch[path] = localCollWatch[path] || []).push(cb);
    cb(localCollection(path));
    return function () { };
  };

  var localWatch = {}, localCollWatch = {};
  function localCollection(path) {
    return Object.keys(localDocs).filter(function (k) {
      return k.indexOf(path + "/") === 0 && k.slice(path.length + 1).indexOf("/") < 0;
    }).map(function (k) { var o = Object.assign({}, localDocs[k]); o.id = k.slice(path.length + 1); return o; });
  }
  function notifyLocal(path) {
    (localWatch[path] || []).forEach(function (cb) { cb(localDocs[path]); });
    var coll = path.split("/").slice(0, -1).join("/");
    (localCollWatch[coll] || []).forEach(function (cb) { cb(localCollection(coll)); });
  }

  /* ------------------------------------------------- administration
   *
   * Two small trees in the Realtime Database, and the rules do the work:
   *
   *   admins/<uid>   true. Readable by anyone signed in, writable by
   *                  NOBODY from a browser (".write": false). The only way
   *                  in is the Firebase console or a server holding a
   *                  service account, which is the point — an administrator
   *                  cannot be appointed by the page that checks for them.
   *   blocked/<uid>  { at, by, why }. Written only by an administrator, and
   *                  every other rule in the database and in Firestore
   *                  refuses a request from a uid that appears here. So a
   *                  blocked resident may still hold a valid token and may
   *                  still open the page, and the database will not give
   *                  them a single byte or accept a single write.
   *
   * Hiding the button is not the mechanism. The button is hidden because
   * showing a control that will be refused is bad manners, and that is all.
   */
  N.watchAdmin = function (cb) {
    if (backend !== "firebase" || !currentUser) { cb(false); return function () {}; }
    if (rtdb) {
      var ref = rtdb.ref("admins/" + currentUser.uid);
      var h = ref.on("value", function (snap) { cb(snap.val() === true); },
                     function () { cb(false); });
      return function () { try { ref.off("value", h); } catch (e) {} };
    }
    if (fs) return N.docWatch("admins/" + currentUser.uid, function (d) { cb(!!d); });
    cb(false);
    return function () {};
  };

  /* Our own block record. Watched for the whole session, not just checked
     at sign-in: an administrator who blocks somebody mid-session should not
     have to wait for them to reload. */
  N.watchMyBlock = function (cb) {
    if (backend !== "firebase" || !currentUser) { cb(null); return function () {}; }
    if (rtdb) {
      var ref = rtdb.ref("blocked/" + currentUser.uid);
      var h = ref.on("value", function (snap) { cb(snap.val() || null); },
                     function () { cb(null); });
      return function () { try { ref.off("value", h); } catch (e) {} };
    }
    if (fs) return N.docWatch("blocked/" + currentUser.uid, cb);
    cb(null);
    return function () {};
  };

  /* Everybody who is blocked. Only an administrator may read this. */
  N.watchBlocked = function (cb) {
    if (backend !== "firebase") { cb({}); return function () {}; }
    if (rtdb) {
      var ref = rtdb.ref("blocked");
      var h = ref.on("value", function (snap) { cb(snap.val() || {}); },
                     function (e) { fail("blocked read", e); cb({}); });
      return function () { try { ref.off("value", h); } catch (e) {} };
    }
    if (fs) {
      return N.collWatch("blocked", function (rows) {
        var out = {};
        rows.forEach(function (r) { out[r.id] = r; });
        cb(out);
      }, 200);
    }
    cb({});
    return function () {};
  };

  /* Block or unblock, straight into the database. This is the path that
     always works, with or without a deployed Cloud Function, and it is the
     one the security rules enforce. The function below does more — it also
     disables the account in Firebase Authentication, so a blocked resident
     cannot even get a token — but it is optional. */
  N.setBlocked = function (targetUid, rec) {
    if (backend !== "firebase" || !currentUser || !targetUid) {
      return Promise.reject(new Error("not available"));
    }
    var body = rec ? {
      at: Date.now(),
      by: String(currentUser.uid),
      byName: String((currentUser.name || "").slice(0, 32)),
      why: String((rec.why || "").slice(0, 140))
    } : null;
    var jobs = [];
    if (rtdb) jobs.push(rtdb.ref("blocked/" + targetUid).set(body));
    if (fs) {
      jobs.push(body ? fs.doc("blocked/" + targetUid).set(body)
                     : fs.doc("blocked/" + targetUid).delete());
    }
    return Promise.all(jobs).then(function () { return true; })
      .catch(function (e) { fail("blocked write", e); throw e; });
  };

  /* Everything we hold about somebody, cleared. The Authentication account
     itself needs the Admin SDK — see N.adminCall("deleteUser") — but the
     village's own record of them is ours to remove. */
  N.purgeUser = function (targetUid) {
    if (backend !== "firebase" || !targetUid) return Promise.resolve(false);
    var jobs = [];
    if (rtdb) {
      /* Everything filed under a uid that an administrator is allowed to
         clear. Chalk and posters are filed under the board instead
         (boards/<board>/<uid>) and carry onDisconnect hooks, so they leave
         with the tab; a signalling inbox is readable only by its owner and
         empties itself within a second, so neither is swept here. */
      ["presence", "voiceLive", "activities"].forEach(function (top) {
        jobs.push(rtdb.ref(top + "/" + targetUid).remove().catch(function () {}));
      });
    }
    if (fs) {
      jobs.push(fs.doc("residents/" + targetUid).delete().catch(function () {}));
      jobs.push(fs.doc("scores/" + targetUid).delete().catch(function () {}));
    }
    return Promise.all(jobs).then(function () { return true; });
  };

  /* The privileged half, which cannot be done from a browser at all:
     disabling and deleting a Firebase Authentication account. It lives in a
     Cloud Function that checks the caller against admins/<uid> with the
     Admin SDK. If it has not been deployed this rejects, and the caller
     falls back to the database block, which is already enough to keep
     somebody out of the village. */
  var fnsLoaded = null;
  function ensureFunctions() {
    if (fnsLoaded) return fnsLoaded;
    fnsLoaded = new Promise(function (res, rej) {
      if (!fb) return rej(new Error("no firebase"));
      if (fb.functions) return res(true);
      var sc = document.createElement("script");
      sc.src = "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js";
      sc.onload = function () { res(true); };
      sc.onerror = function () { rej(new Error("functions sdk")); };
      document.head.appendChild(sc);
    });
    return fnsLoaded;
  }

  N.adminCall = function (name, data) {
    if (backend !== "firebase" || !fb) return Promise.reject(new Error("no back end"));
    return ensureFunctions().then(function () {
      if (!fb.functions) throw new Error("functions sdk");
      var region = (window.QV_FUNCTIONS_REGION || "us-central1");
      return fb.app().functions(region).httpsCallable(name)(data || {});
    }).then(function (r) { return (r && r.data) || null; });
  };

  /* ------------------------------------------------------------ scoring */
  N.addScore = function (points, name) {
    if (!points) return Promise.resolve();
    var id = currentUser ? currentUser.uid : (window.QVLocalId || "guest");
    return N.docGet("scores/" + id).then(function (prev) {
      var total = ((prev && prev.points) || 0) + points;
      return N.docSet("scores/" + id, {
        name: name || (currentUser && currentUser.name) || "Resident",
        points: total, at: Date.now()
      }).then(function () { return total; });
    });
  };
  N.watchScores = function (cb) {
    return N.collWatch("scores", function (rows) {
      rows.sort(function (a, b) { return (b.points || 0) - (a.points || 0); });
      cb(rows.slice(0, 12));
    }, 60);
  };

  /* ------------------------------------------------------- Claude sampling */
  N.ask = null;
  if (window.claude && window.claude.use) {
    window.claude.use("sample").then(function (s) { if (s) N.ask = s; }).catch(function () { });
  }
})();
