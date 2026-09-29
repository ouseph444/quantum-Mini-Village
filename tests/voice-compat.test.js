/* The same voice, in browsers that are not the one it was written in.
 *
 * Every check here is a feature test standing in for a real engine:
 * Safari before 15.4 (no connectionState), iOS (a volume property that
 * accepts a write and ignores it), a page served over plain http, a project
 * with no Realtime Database to carry the handshake, and a keyboard that
 * does not spell "v" with a V. None of them should be silent about it, and
 * none of them should leave a microphone open.
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const dom = require("./dom.js"), rtc = require("./rtc.js");

const SRC = fs.readFileSync(path.join(process.argv[2] || ".", "js/voice.js"), "utf8");

let failures = 0;
function ok(cond, msg) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
}
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

/* One resident, with whatever this browser happens to be able to do. */
function spawn(opts) {
  opts = opts || {};
  const g = {}; dom.install(g);
  vm.createContext(g);
  g.console = { log(){}, warn(){}, error(){} };
  g.setTimeout = setTimeout; g.clearTimeout = clearTimeout;
  g.setInterval = setInterval; g.clearInterval = clearInterval;
  g.Promise = Promise; g.Math = Math; g.Date = Date; g.JSON = JSON;
  g.Object = Object; g.Array = Array; g.String = String; g.Number = Number;
  g.Error = Error; g.Uint8Array = Uint8Array;

  const world = rtc.makeWorld();
  const PC = rtc.installRtc(g, world, "me");
  if (opts.noWebrtc) { g.RTCPeerConnection = null; }
  if (opts.legacyStates) {
    /* Safari before 15.4: iceConnectionState only, and no connectionState
       property at all. */
    Object.defineProperty(PC.prototype, "connectionState", {
      configurable: true, get() { return undefined; }
    });
  }
  g.isSecureContext = opts.insecure ? false : true;
  g.location = { protocol: opts.insecure ? "http:" : "https:", hostname: "village.example" };

  if (opts.noVolume) {
    /* iOS: the write is accepted and thrown away. */
    const base = g.Audio;
    g.Audio = function () {
      const el = base();
      let v = 1;
      Object.defineProperty(el, "volume", { get: () => v, set: () => { v = 1; } });
      return el;
    };
  }

  const sent = [];
  g.QVNet = {
    hasRtdb: () => !opts.noRtdb,
    uid: () => "me",
    watchSignals: (cb) => { g._onSignal = cb; return () => {}; },
    watchVoiceLive: (cb) => { g._onRoster = cb; return () => {}; },
    sendSignal: (to, p) => { sent.push({ to, t: p.t }); return Promise.resolve(true); },
    voiceLiveSet: () => Promise.resolve(true),
    voiceLiveClear: () => Promise.resolve()
  };
  g.navigator.mediaDevices = opts.noGum ? null : {
    getUserMedia: (c) => {
      g._askedFor = c;
      if (opts.micError) {
        const e = new Error("no"); e.name = opts.micError;
        if (opts.recoverAfter && g._askedFor && c.audio === true) {
          /* the bare retry succeeds */
        } else return Promise.reject(e);
      }
      return Promise.resolve({
        id: "mic", getAudioTracks: () => [{ kind: "audio", stop() {} }],
        getTracks: () => [{ kind: "audio", stop() {} }]
      });
    }
  };
  if (opts.legacyGum) {
    g.navigator.mediaDevices = null;
    g.navigator.getUserMedia = (c, res) => res({
      id: "legacy-mic", getAudioTracks: () => [{ kind: "audio", stop() {} }],
      getTracks: () => [{ kind: "audio", stop() {} }]
    });
  }

  const toasts = [];
  const keyHandlers = {};
  g.window.addEventListener = g.addEventListener = (t, f) => { (keyHandlers[t] = keyHandlers[t] || []).push(f); };
  g.document.addEventListener = (t, f) => { (keyHandlers["doc:" + t] = keyHandlers["doc:" + t] || []).push(f); };
  g.document.activeElement = null;

  vm.runInContext(SRC, g, { filename: "voice.js" });
  g.QVVoice.init({
    getPosition: () => ({ x: 0, z: 0 }),
    getDisplayName: () => "Tester",
    getUid: () => "me",
    getPeers: () => ({}),
    toast: (m) => toasts.push(m)
  });
  g._sent = sent; g._toasts = toasts; g._fire = (t, e) => (keyHandlers[t] || []).forEach(f => f(e || {}));
  g._world = world; g._PC = PC;
  return g;
}

(async function () {

  console.log("\n— a project with no Realtime Database to carry the handshake —");
  {
    const g = spawn({ noRtdb: true });
    ok(g.QVVoice.unavailable() !== "", "voice says it is unavailable rather than looking fine");
    ok(/Realtime Database/.test(g.QVVoice.unavailable()), "and says which piece is missing");
    const started = await g.QVVoice.startSpeaking();
    ok(started === false, "pressing Talk does not open a microphone that nobody can hear");
    ok(g._askedFor === undefined, "so the browser is never even asked for one");
    ok(g._toasts.length === 1 && /not available/.test(g._toasts[0]), "and the resident is told why");
    ok(g.QVVoice.stats().available === false, "stats() reports it too");
  }

  console.log("\n— a browser with no WebRTC at all —");
  {
    const g = spawn({ noWebrtc: true });
    ok(g.QVVoice.unavailable() !== "", "voice stands itself down instead of throwing on the first speaker");
    ok(await g.QVVoice.startSpeaking() === false, "and Talk refuses politely");
  }

  console.log("\n— the page is on plain http —");
  {
    const g = spawn({ insecure: true });
    ok(await g.QVVoice.startSpeaking() === false, "no microphone is requested on an insecure origin");
    ok(/https/.test(g._toasts.join(" ")), "and the reason named is the address, not a permission");
    ok(g.QVVoice.stats().secureOrigin === false, "stats() agrees");
  }

  console.log("\n— the callback getUserMedia older web views still ship —");
  {
    const g = spawn({ legacyGum: true });
    ok(await g.QVVoice.startSpeaking() === true, "the microphone opens through the legacy call");
    ok(g.QVVoice.isSpeaking() === true, "and the village is told somebody is speaking");
    await g.QVVoice.stopSpeaking();
  }

  console.log("\n— a device that refuses the constraints but has a microphone —");
  {
    const g = spawn({ micError: "OverconstrainedError", recoverAfter: true });
    const started = await g.QVVoice.startSpeaking();
    ok(started === true, "the bare {audio:true} retry gets in");
    ok(g._askedFor.audio === true, "and that is what was asked for the second time");
    await g.QVVoice.stopSpeaking();
  }

  console.log("\n— no microphone on the machine at all —");
  {
    const g = spawn({ micError: "NotFoundError" });
    ok(await g.QVVoice.startSpeaking() === false, "Talk comes back off");
    ok(/No microphone found/.test(g._toasts.join(" ")),
       "and says so, rather than sending them to an address bar button that is not there");
    ok(g.QVVoice.isSpeaking() === false, "the button does not stay lit");
  }

  console.log("\n— a microphone another application is holding —");
  {
    const g = spawn({ micError: "NotReadableError" });
    await g.QVVoice.startSpeaking();
    ok(/holding the microphone/.test(g._toasts.join(" ")), "the village names the real problem");
  }

  console.log("\n— Safari before 15.4: iceConnectionState and nothing else —");
  {
    const g = spawn({ legacyStates: true });
    await g.QVVoice.startSpeaking();
    /* somebody asks to hear us, so we build them a connection */
    g._onSignal("them", { t: "join", d: "1." + Date.now() });
    await tick(60);
    const pc = g._PC.all[g._PC.all.length - 1];
    ok(!!pc, "a connection was opened");
    ok(pc.connectionState === undefined, "and this browser has no connectionState to read");
    ok(typeof pc.oniceconnectionstatechange === "function",
       "so voice listened on the event this browser does have");
    pc.iceConnectionState = "failed";
    pc.oniceconnectionstatechange();
    await tick(60);
    ok(g._toasts.join(" ").indexOf("could not connect") >= 0,
       "a failure is still noticed and still reported");
    await g.QVVoice.stopSpeaking();
  }

  console.log("\n— iOS: a volume property that accepts the write and ignores it —");
  {
    const g = spawn({ noVolume: true });
    ok(g.QVVoice.stats().audio.volumeControl === false, "the village works out that it cannot fade");
    g._onRoster({ far: { uid: "far", mode: "nearby", n: "Far", x: 300, z: 0, at: Date.now() },
                  near: { uid: "near", mode: "nearby", n: "Near", x: 1, z: 0, at: Date.now() } });
    await tick(30);
    g._onSignal("near", { t: "offer", d: JSON.stringify({ type: "offer", sdp: "x", _streams: [{ id: "s" }] }) });
    await tick(60);
    g.QVVoice.update();
    const near = g.QVVoice.stats().listeningTo.near;
    ok(near && near.muted === false, "somebody standing beside you is audible");

    /* and now walk away from them */
    g._onRoster({ near: { uid: "near", mode: "nearby", n: "Near", x: 69, z: 0, at: Date.now() } });
    await tick(30);
    g.QVVoice.update();
    const gone = g.QVVoice.stats().listeningTo.near;
    ok(gone && gone.muted === true,
       "and from the far edge of earshot they are muted, not played at full volume");
  }

  console.log("\n— a keyboard that does not spell v with a V —");
  {
    const g = spawn({});
    g.QVVoice.bindHotkey();
    g._fire("keydown", { code: "KeyV", key: "м", repeat: false });
    await tick(40);
    ok(g.QVVoice.isSpeaking() === true, "a Cyrillic layout can still hold V to talk");
    g._fire("keyup", { code: "KeyV", key: "м" });
    await tick(40);
    ok(g.QVVoice.isSpeaking() === false, "and letting go still stops");
  }

  console.log("\n— V held down while the resident switches to another window —");
  {
    const g = spawn({});
    g.QVVoice.bindHotkey();
    g._fire("keydown", { code: "KeyV", key: "v", repeat: false });
    await tick(40);
    ok(g.QVVoice.isSpeaking() === true, "the microphone is open");
    g._fire("blur");
    await tick(40);
    ok(g.QVVoice.isSpeaking() === false,
       "losing the window closes it — a keyup delivered somewhere else must not latch it open");
  }

  console.log("\n— a modifier means a browser command, not a word —");
  {
    const g = spawn({});
    g.QVVoice.bindHotkey();
    g._fire("keydown", { code: "KeyV", key: "v", metaKey: true, repeat: false });
    await tick(40);
    ok(g.QVVoice.isSpeaking() === false, "Cmd-V pastes and does not open the microphone");
  }

  console.log("\n— leaving the page —");
  {
    const g = spawn({});
    await g.QVVoice.startSpeaking();
    ok(g.QVVoice.isSpeaking() === true, "speaking");
    g._fire("pagehide");
    await tick(40);
    ok(g.QVVoice.isSpeaking() === false,
       "pagehide lets go of the microphone — iOS never fires beforeunload");
  }

  console.log(failures ? "\n" + failures + " failed\n" : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
