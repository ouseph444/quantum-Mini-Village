/* Three residents, one microphone at a time, and nobody pressing anything
   they should not have to. */
const fs = require("fs"), vm = require("vm"), path = require("path");
const dom = require("./dom.js"), rtc = require("./rtc.js");

const SRC = fs.readFileSync(path.join(process.argv[2] || ".", "js/voice.js"), "utf8");
const world = rtc.makeWorld();
const people = {};

function spawn(uid, name) {
  const g = {}; dom.install(g);
  vm.createContext(g);
  g.console = console;
  g.setTimeout = setTimeout; g.clearTimeout = clearTimeout;
  g.setInterval = setInterval; g.clearInterval = clearInterval;
  g.Promise = Promise; g.Math = Math; g.Date = Date; g.JSON = JSON;
  g.Object = Object; g.Array = Array; g.String = String; g.Number = Number;
  g.Error = Error; g.URL = g.URL;
  rtc.installRtc(g, world, uid);

  const seat = world.join(uid, g);
  g.QVNet = {
    hasRtdb: () => true,
    uid: () => uid,
    watchSignals: (cb) => { seat.onSignal = cb; return () => {}; },
    watchVoiceLive: (cb) => { seat.onRoster = cb; return () => {}; },
    sendSignal: (to, payload) => { world.deliver(to, uid, JSON.parse(JSON.stringify(payload))); return Promise.resolve(true); },
    voiceLiveSet: (o) => {
      world.roster[uid] = Object.assign({}, o, { uid, at: Date.now() });
      world.publishRoster(); return Promise.resolve(true);
    },
    voiceLiveClear: () => { delete world.roster[uid]; world.publishRoster(); return Promise.resolve(); }
  };

  /* a microphone that exists but has not been asked for */
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
    getDisplayName: () => name,
    getUid: () => uid,
    getPeers: () => ({}),
    toast: () => {}
  });
  people[uid] = g;
  return g;
}

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function ok(cond, msg) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
}

(async function () {
  const A = spawn("A", "Ada"), B = spawn("B", "Bohr"), C = spawn("C", "Curie");
  console.log("\n— A speaks; B and C have never touched a microphone —");
  await A.QVVoice.startSpeaking();
  await tick(120);
  A.QVVoice.update(); B.QVVoice.update(); C.QVVoice.update();
  await tick(120);

  let b = B.QVVoice.stats(), c = C.QVVoice.stats();
  ok(b.speaking === false, "B's own microphone is still off");
  ok(c.speaking === false, "C's own microphone is still off");
  ok(!!b.listeningTo.A, "B opened a connection to A without being asked to");
  ok(!!c.listeningTo.A, "C opened a connection to A without being asked to");
  ok(b.listeningTo.A && b.listeningTo.A.track, "B has A's audio track");
  ok(b.listeningTo.A && b.listeningTo.A.playing, "B is playing A");
  ok(b.listeningTo.A && b.listeningTo.A.muted === false, "B's element is not muted");
  ok(b.listeningTo.A && b.listeningTo.A.volume > 0, "B's element has volume");
  ok(b.audio.context === "none", "B never built an AudioContext to listen");

  console.log("\n— B speaks too; both are talking at once —");
  await B.QVVoice.startSpeaking();
  await tick(150);
  A.QVVoice.update(); B.QVVoice.update(); C.QVVoice.update();
  await tick(150);
  let a2 = A.QVVoice.stats(); c = C.QVVoice.stats();
  ok(!!a2.listeningTo.B, "A hears B");
  ok(Object.keys(c.listeningTo).sort().join() === "A,B", "C hears both A and B");
  ok(c.listeningTo.A.playing && c.listeningTo.B.playing, "both of C's elements are playing");
  ok(c.listeningTo.A.muted === false && c.listeningTo.B.muted === false,
     "neither speaker's element was replaced or silenced by the other");
  ok(C.QVVoice.isSpeaking() === false, "C still has not opened a microphone");

  console.log("\n— C mutes the village, then unmutes it —");
  C.QVVoice.setListening(false);
  c = C.QVVoice.stats();
  ok(c.listeningTo.A.muted && c.listeningTo.B.muted, "muting silences every speaker");
  ok(c.listening === false, "C reports itself as not listening");
  /* and it did not touch anybody else */
  ok(A.QVVoice.stats().listeningTo.B.muted === false, "A is unaffected by C muting");
  C.QVVoice.setListening(true);
  await tick(30);
  c = C.QVVoice.stats();
  ok(!c.listeningTo.A.muted && !c.listeningTo.B.muted, "unmuting brings them both back");

  console.log("\n— A stops; B keeps talking —");
  await A.QVVoice.stopSpeaking();
  await tick(120);
  C.QVVoice.update();
  await tick(120);
  c = C.QVVoice.stats();
  ok(!c.listeningTo.A, "C let go of A");
  ok(!!c.listeningTo.B && c.listeningTo.B.playing, "C still hears B");
  ok(C.document.body.children.filter(e => e.tagName === "AUDIO").length === 1,
     "C is holding exactly one audio element, not a leaked pile");

  console.log("\n— what actually went through the database —");
  const kinds = {};
  world.log.forEach(m => { kinds[m.t] = (kinds[m.t] || 0) + 1; });
  console.log("  signal kinds:", JSON.stringify(kinds));
  ok(Object.keys(kinds).every(k => ["join", "offer", "answer", "ice-s", "ice-l"].includes(k)),
     "only handshake notes were written — no audio, no recordings");

  console.log("\n— B leaves without warning —");
  delete world.roster.B;
  world.publishRoster();
  await tick(60);
  C.QVVoice.update();
  await tick(60);
  c = C.QVVoice.stats();
  ok(Object.keys(c.listeningTo).length === 0, "C cleaned up after B");
  ok(C.document.body.children.filter(e => e.tagName === "AUDIO").length === 0,
     "and removed the element from the page");

  console.log(failures ? "\n" + failures + " FAILED\n" : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
