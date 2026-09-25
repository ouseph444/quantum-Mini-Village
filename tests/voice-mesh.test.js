/* A crowded village: everybody hears everybody.
 *
 * voice.test.js proves the happy path with three residents and a WebRTC
 * fake that connects whatever it is given. This one uses a stricter fake —
 * a listener's connection only comes up when the speaker applies the answer
 * to *that* listener's offer, a mismatched answer fails, and closing one end
 * leaves the other "disconnected" — and then does to the handshake what a
 * real network does once there are more than two people in the room: loses
 * a note, delivers one late, drops a connection mid-sentence. Timers run
 * twenty times faster than in a browser so the whole thing takes seconds. */
const fs = require("fs"), vm = require("vm"), path = require("path");
const dom = require("./dom.js");

const SRC = fs.readFileSync(path.join(process.argv[2] || ".", "js/voice.js"), "utf8");
const SCALE = 20;

/* ------------------------------------------------------------ the world */
const roster = {};
const seats = {};
const people = {};
/* (to, from, payload) -> false to drop, a number to delay by that many ms */
let tamper = null;
const log = [];

function deliver(to, from, payload) {
  const seat = seats[to];
  log.push({ to, from, t: payload.t });
  let delay = 0;
  if (tamper) {
    const r = tamper(to, from, payload);
    if (r === false) return;
    if (typeof r === "number") delay = r;
  }
  setTimeout(() => { if (seat && seat.onSignal) seat.onSignal(from, payload); }, delay);
}
function publishRoster() {
  Object.values(seats).forEach(s => s.onRoster && s.onRoster(JSON.parse(JSON.stringify(roster))));
}

/* ------------------------------------------------ a strict WebRTC fake */
const allPcs = {};
let pcSeq = 0;
function installRtc(g) {
  function PC() {
    this.id = ++pcSeq;
    allPcs[this.id] = this;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.localDescription = null;
    this.remoteDescription = null;
    this._streams = [];
    this.peer = null;
  }
  const set = (pc, st) => {
    if (pc.connectionState === st || pc.connectionState === "closed") return;
    pc.connectionState = st;
    pc.iceConnectionState = st === "connected" ? "connected" : st;
    if (pc.onconnectionstatechange) pc.onconnectionstatechange();
  };
  PC.prototype.addTrack = function (t, s) { this._streams.push(s); };
  PC.prototype.createOffer = function () {
    return Promise.resolve({ type: "offer", sdp: "o:" + this.id });
  };
  PC.prototype.createAnswer = function () {
    return Promise.resolve({ type: "answer", sdp: "a:" + this.id + ":" + this.remoteDescription.sdp.slice(2) });
  };
  PC.prototype.setLocalDescription = function (d) {
    this.localDescription = { type: d.type, sdp: d.sdp };
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
    const self = this;
    setTimeout(() => {
      if (self.onicecandidate && self.connectionState !== "closed") {
        self.onicecandidate({ candidate: { candidate: "c:" + self.id, sdpMid: "0", sdpMLineIndex: 0 } });
      }
    }, 1);
    return Promise.resolve();
  };
  PC.prototype.setRemoteDescription = function (d) {
    if (d.s !== undefined) return Promise.reject(new Error("tag leaked into the description"));
    if (d.type === "answer" && this.signalingState !== "have-local-offer") {
      return Promise.reject(new Error("InvalidStateError: answer in " + this.signalingState));
    }
    this.remoteDescription = { type: d.type, sdp: d.sdp };
    const self = this;
    if (d.type === "offer") {
      this.signalingState = "have-remote-offer";
      set(this, "connecting");
    } else {
      this.signalingState = "stable";
      const parts = d.sdp.split(":");            /* a:<listener>:<offer> */
      const listener = allPcs[+parts[1]], offerId = +parts[2];
      setTimeout(() => {
        if (offerId === self.id && listener && listener.connectionState !== "closed" &&
            listener.remoteDescription && listener.remoteDescription.sdp === "o:" + self.id) {
          self.peer = listener; listener.peer = self;
          set(self, "connected"); set(listener, "connected");
          if (listener.ontrack) listener.ontrack({ streams: [self._streams[0]] });
        } else {
          /* the answer was made for somebody else's offer */
          set(self, "failed");
          if (listener) set(listener, "failed");
        }
      }, 2);
    }
    return Promise.resolve();
  };
  PC.prototype.addIceCandidate = function (c) {
    if (c && c.s !== undefined) return Promise.reject(new Error("tag leaked into the candidate"));
    return Promise.resolve();
  };
  PC.prototype.close = function () {
    const peer = this.peer;
    this.connectionState = "closed";
    this.signalingState = "closed";
    if (peer && peer.connectionState !== "closed") set(peer, "disconnected");
  };
  g.RTCPeerConnection = PC;
  g.RTCSessionDescription = function (d) { return Object.assign({}, d); };
  g.RTCIceCandidate = function (d) { return Object.assign({}, d); };
}

/* ------------------------------------------------------------ a resident */
function spawn(uid) {
  const g = {}; dom.install(g);
  vm.createContext(g);
  g.console = { log() {}, warn() {}, error: console.error };
  g.setTimeout = (f, ms) => setTimeout(f, (ms || 0) / SCALE);
  g.clearTimeout = clearTimeout;
  g.setInterval = (f, ms) => setInterval(f, (ms || 0) / SCALE);
  g.clearInterval = clearInterval;
  Object.assign(g, { Promise, Math, Date, JSON, Object, Array, String, Number, Error, isFinite });
  g._toasts = [];
  installRtc(g);

  const seat = seats[uid] = { onSignal: null, onRoster: null };
  g.QVNet = {
    hasRtdb: () => true,
    uid: () => uid,
    watchSignals: cb => { seat.onSignal = cb; return () => {}; },
    watchVoiceLive: cb => { seat.onRoster = cb; return () => {}; },
    sendSignal: (to, p) => { deliver(to, uid, JSON.parse(JSON.stringify(p))); return Promise.resolve(true); },
    voiceLiveSet: o => { roster[uid] = Object.assign({}, o, { uid, at: Date.now() }); publishRoster(); return Promise.resolve(true); },
    voiceLiveClear: () => { delete roster[uid]; publishRoster(); return Promise.resolve(); }
  };
  g.navigator.mediaDevices = {
    getUserMedia: () => Promise.resolve({
      id: "mic-" + uid,
      getAudioTracks: () => [{ kind: "audio", stop() {} }],
      getTracks: () => [{ kind: "audio", stop() {} }]
    })
  };
  vm.runInContext(SRC, g, { filename: "voice.js" });
  g.QVVoice.init({
    getPosition: () => ({ x: 0, z: 0 }),
    getDisplayName: () => uid,
    getUid: () => uid,
    getPeers: () => ({}),
    toast: m => g._toasts.push(m)
  });
  g.QVVoice.setMode("village");
  if (seat.onRoster) seat.onRoster(JSON.parse(JSON.stringify(roster)));
  people[uid] = g;
  return g;
}

/* ------------------------------------------------------------ checking */
const wait = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function ok(cond, msg) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
}
/* who `uid` can actually hear: connected, carrying a track, playing, not muted */
function hears(uid) {
  const s = people[uid].QVVoice.stats();
  return Object.keys(s.listeningTo).filter(u => {
    const r = s.listeningTo[u];
    return r.state === "connected" && r.track && r.playing && !r.muted;
  }).sort();
}
function everyoneHearsEveryone(label) {
  const talkers = Object.keys(roster).sort();
  let all = true;
  Object.keys(people).sort().forEach(u => {
    const want = talkers.filter(t => t !== u);
    const got = hears(u);
    const good = JSON.stringify(want) === JSON.stringify(got);
    if (!good) { all = false; console.log("       " + u + " hears [" + got + "], should hear [" + want + "]"); }
  });
  ok(all, label);
}
function noToast(uid, re, label) {
  ok(!people[uid]._toasts.some(t => re.test(t)), label);
}

(async function () {
  console.log("\n— five residents, all talking at once, nobody touching the page —");
  /* update() is never called in this file: it runs on animation frames,
     which a browser stops in a background tab. Everything below has to
     happen on voice.js's own timer. */
  ["A", "B", "C", "D", "E"].forEach(spawn);
  for (const u of ["A", "B", "C", "D", "E"]) await people[u].QVVoice.startSpeaking();
  await wait(600);
  everyoneHearsEveryone("every one of the five hears the other four");
  Object.keys(people).forEach(u => {
    const n = Object.keys(people[u].QVVoice.stats().sendingTo).length;
    if (n !== 4) console.log("       " + u + " is sending to " + n);
  });
  ok(Object.keys(people).every(u => Object.keys(people[u].QVVoice.stats().sendingTo).length === 4),
     "and every one of them is sending to the other four");

  console.log("\n— F arrives, and the first answer F sends to A goes missing —");
  let dropped = 0;
  tamper = (to, from, p) => (to === "A" && from === "F" && p.t === "answer" && !dropped++) ? false : 0;
  spawn("F");
  await wait(400);
  ok(dropped === 1, "the answer really was lost");
  ok(hears("F").indexOf("A") < 0, "F cannot hear A yet — the connection is stuck half-open");
  await wait(1200);
  tamper = null;
  ok(hears("F").join() === "A,B,C,D,E", "F gives up on the stuck connection, asks again, and hears all five");
  noToast("F", /could not connect/, "and nobody was told their network is broken — it is not");

  console.log("\n— G arrives, and B's first offer to G is held up past G's patience —");
  let held = 0;
  tamper = (to, from, p) => (to === "G" && from === "B" && p.t === "offer" && !held++) ? 420 : 0;
  spawn("G");
  await wait(1500);
  tamper = null;
  ok(held === 2, "the offer was late enough that G gave up and asked B again");
  ok(hears("G").join() === "A,B,C,D,E", "G still hears all five speakers, B included");
  const gB = people.G.QVVoice.stats().listeningTo.B;
  ok(gB && gB.state === "connected", "G's connection to B is up, not left failed by the late offer");
  noToast("B", /could not connect/, "B was not told the network had failed");
  noToast("G", /could not connect/, "and neither was G");

  console.log("\n— C's connection to D drops in the middle of a sentence —");
  const cd = people.C.QVVoice.stats().listeningTo.D;
  ok(cd && cd.state === "connected", "C is hearing D beforehand");
  /* the network path goes: D's end is torn down, C's end sits "disconnected" */
  const dToC = Object.values(allPcs).find(pc =>
    pc.connectionState === "connected" && pc._streams[0] && pc._streams[0].id === "mic-D" &&
    pc.peer && pc.peer.constructor === people.C.RTCPeerConnection);
  ok(!!dToC, "found D's connection to C");
  dToC.close();
  await wait(60);
  ok(people.C.QVVoice.stats().listeningTo.D.state === "disconnected", "C's end reports disconnected");
  await wait(900);
  ok(hears("C").indexOf("D") >= 0, "C dials D again by itself and hears D");
  everyoneHearsEveryone("and all seven residents still hear every speaker");

  console.log("\n— stale notes from an old handshake are not applied —");
  {
    const g = people.E;
    const before = g.QVVoice.stats().listeningTo.A.state;
    /* a late offer, and its candidate, for a request E never made */
    seats.E.onSignal("A", { t: "offer", d: JSON.stringify({ type: "offer", sdp: "o:9999", s: "0.stale" }) });
    seats.E.onSignal("A", { t: "ice-s", d: JSON.stringify({ candidate: "c:9999", s: "0.stale" }) });
    await wait(60);
    ok(g.QVVoice.stats().listeningTo.A.state === before && before === "connected",
       "E's live connection to A was not torn down for a stale offer");
    seats.A.onSignal("E", { t: "answer", d: JSON.stringify({ type: "answer", sdp: "a:1:1", s: "0.stale" }) });
    await wait(60);
    ok(people.A.QVVoice.stats().sendingTo.E === "connected", "A ignored a stale answer from E");
  }

  console.log("\n— what went through the database —");
  const kinds = {};
  log.forEach(m => { kinds[m.t] = (kinds[m.t] || 0) + 1; });
  console.log("  signal kinds:", JSON.stringify(kinds));
  ok(Object.keys(kinds).every(k => ["join", "offer", "answer", "ice-s", "ice-l"].includes(k)),
     "only handshake notes — no audio");

  console.log(failures ? "\n" + failures + " FAILED\n" : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
