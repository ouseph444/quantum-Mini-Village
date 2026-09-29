/* Private one-to-one calls, alongside the village mesh, between three
   residents in three separate JavaScript contexts. Same fakes as the voice
   suites: no Firebase, no microphone, no second machine. */
const fs = require("fs"), vm = require("vm"), path = require("path");
const dom = require("./dom.js"), rtc = require("./rtc.js");

const root = process.argv[2] || ".";
const VOICE = fs.readFileSync(path.join(root, "js/voice.js"), "utf8");
const PRIVATE = fs.readFileSync(path.join(root, "js/private.js"), "utf8");
const world = rtc.makeWorld();
const people = {};

function spawn(uid, name, opts) {
  opts = opts || {};
  const g = {}; dom.install(g);
  vm.createContext(g);
  Object.assign(g, { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math,
                     Date, JSON, Object, Array, String, Number, Error });
  g.document.querySelector = () => null;
  rtc.installRtc(g, world, uid);

  const seat = world.join(uid, g);
  const cbs = [];
  seat.onSignal = (from, msg) => cbs.forEach(f => f(from, msg));
  g.toasts = [];
  g.QVNet = {
    hasRtdb: () => true,
    uid: () => uid,
    dmAvailable: () => true,
    dmInboxWatch: () => () => {},
    watchSignals: (cb) => { cbs.push(cb); return () => {}; },
    watchVoiceLive: (cb) => { seat.onRoster = cb; return () => {}; },
    sendSignal: (to, payload) => {
      payload.at = Date.now();
      world.deliver(to, uid, JSON.parse(JSON.stringify(payload)));
      return Promise.resolve(true);
    },
    voiceLiveSet: (o) => { world.roster[uid] = Object.assign({}, o, { uid, at: Date.now() }); world.publishRoster(); return Promise.resolve(true); },
    voiceLiveClear: () => { delete world.roster[uid]; world.publishRoster(); return Promise.resolve(); }
  };
  g.micOpen = 0;
  g.navigator.mediaDevices = {
    getUserMedia: () => opts.denyMic
      ? Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }))
      : Promise.resolve((() => {
          g.micOpen++;
          const track = { kind: "audio", enabled: true, stop() { if (!this.stopped) { this.stopped = true; g.micOpen--; } } };
          return { id: "mic-" + uid, getAudioTracks: () => [track], getTracks: () => [track] };
        })())
  };
  g.online = {};
  vm.runInContext(VOICE, g, { filename: "voice.js" });
  vm.runInContext(PRIVATE, g, { filename: "private.js" });
  g.QVVoice.init({ getPosition: () => ({ x: 0, z: 0 }), getDisplayName: () => name, getUid: () => uid,
                   getPeers: () => ({}), toast: (h) => g.toasts.push(h) });
  g.QVPrivate.init({ toast: (h) => g.toasts.push(h), myName: () => name,
                     peerName: (u) => people[u] ? people[u].name : "",
                     isOnline: (u) => g.online[u] !== false && !!people[u] });
  people[uid] = { g, name };
  return g;
}

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function ok(cond, msg) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
}
const state = (g) => { const s = g.QVPrivate.callState(); return s ? s.state : null; };
const lastToast = (g) => g.toasts[g.toasts.length - 1] || "";
const btn = (g, action) => {
  /* the call bar is rebuilt as HTML; its handler reads data-call */
  const bar = g.document.body.children.find(c => c.id === "pv-call");
  bar.dispatch("click", { target: { closest: () => ({ dataset: { call: action } }) } });
};

(async () => {
  const A = spawn("aaa", "Ada"), B = spawn("bbb", "Bohr"), C = spawn("ccc", "Curie");

  console.log("\nA calls B");
  A.QVPrivate.startCall("bbb", "Bohr");
  await tick();
  ok(state(A) === "outgoing", "A is ringing B");
  ok(state(B) === "incoming", "B is shown an incoming call");
  ok(state(C) === null, "C knows nothing about it");
  ok(world.log.every(l => l.to !== "ccc"), "no note of the call reaches C");

  console.log("\nB accepts");
  btn(B, "accept");
  await tick(120);
  ok(state(A) === "active" && state(B) === "active", "both ends are connected");
  const pcsA = A.RTCPeerConnection.all.filter(p => p.connectionState === "connected");
  ok(pcsA.length === 1, "one peer connection, carrying both directions");
  ok(A.micOpen === 1 && B.micOpen === 1, "each has exactly one microphone open");
  ok(world.log.filter(l => l.t.indexOf("c-") !== 0).length === 0, "only private-call notes went on the wire");

  console.log("\nthe village is kept out of it");
  const r = await A.QVVoice.startSpeaking();
  ok(r === false && !A.QVVoice.isSpeaking(), "A cannot open the village microphone during the call");
  ok(Object.keys(world.roster).length === 0, "nobody appears on the village voice roster");

  console.log("\nC calls B, who is busy");
  C.QVPrivate.startCall("bbb", "Bohr");
  await tick(80);
  ok(state(C) === null && /another call/.test(lastToast(C)), "C is told B is on another call");
  ok(state(B) === "active", "B's call with A is untouched");

  console.log("\nmute");
  btn(A, "mute");
  ok(A.QVPrivate.callState().muted === true, "A is muted");
  btn(A, "mute");
  ok(A.QVPrivate.callState().muted === false, "A is unmuted");

  console.log("\nA hangs up");
  btn(A, "end");
  await tick(60);
  ok(state(A) === null && state(B) === null, "the call is over at both ends");
  ok(/ended/.test(lastToast(B)), "B is told A ended it");
  ok(A.micOpen === 0 && B.micOpen === 0, "both microphones are released");

  console.log("\nC calls A, A declines");
  C.QVPrivate.startCall("aaa", "Ada");
  await tick();
  btn(A, "decline");
  await tick();
  ok(state(C) === null && /declined/.test(lastToast(C)), "C is told A declined");
  ok(C.micOpen === 0, "C's microphone is released");

  console.log("\nC calls D, whose microphone is blocked");
  const D = spawn("ddd", "Dirac", { denyMic: true });
  C.QVPrivate.startCall("ddd", "Dirac");
  await tick();
  btn(D, "accept");
  await tick(60);
  ok(state(D) === null && /blocked/.test(lastToast(D)), "D is told how to unblock the microphone");
  ok(state(C) === null && /microphone/.test(lastToast(C)), "C is told D could not open theirs");

  console.log("\ncalling somebody offline");
  A.online.bbb = false;
  A.QVPrivate.startCall("bbb", "Bohr");
  await tick();
  ok(state(A) === null && /offline/.test(lastToast(A)), "A is told B is offline and nothing rings");
  A.online.bbb = true;

  console.log("\nB cancels before A answers");
  B.QVPrivate.startCall("aaa", "Ada");
  await tick();
  btn(B, "end");
  await tick();
  ok(state(A) === null && /Missed/.test(lastToast(A)), "A sees a missed call");

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
