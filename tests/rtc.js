/* A two-browser WebRTC + signalling fake, good enough to prove who ends up
   hearing whom. Offers, answers and candidates are delivered through the
   same shape the Realtime Database uses. */
function makeWorld() {
  var world = { peers: {}, roster: {}, log: [] };

  world.join = function (uid, ctxGlobal) {
    world.peers[uid] = { uid: uid, g: ctxGlobal, onSignal: null, onRoster: null };
    return world.peers[uid];
  };

  world.deliver = function (to, from, payload) {
    var p = world.peers[to];
    world.log.push({ to: to, from: from, t: payload.t });
    if (!p || !p.onSignal) return;
    setTimeout(function () { p.onSignal(from, payload); }, 0);
  };

  world.publishRoster = function () {
    Object.keys(world.peers).forEach(function (u) {
      var p = world.peers[u];
      if (p.onRoster) p.onRoster(JSON.parse(JSON.stringify(world.roster)));
    });
  };

  return world;
}

/* One fake RTCPeerConnection pair per (speaker,listener). The speaker's
   addTrack feeds the listener's ontrack when the answer comes back. */
function installRtc(g, world, uid) {
  function PC() {
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.signalingState = "stable";
    this._tracks = [];
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.ontrack = null;
    PC.all.push(this);
  }
  PC.all = [];
  PC.prototype.addTrack = function (t, s) { this._tracks.push({ track: t, stream: s }); };
  PC.prototype.createOffer = function () {
    var self = this;
    return Promise.resolve({ type: "offer", sdp: "offer:" + uid + ":" + (++PC.n || (PC.n = 1)),
                             _streams: self._tracks.map(function (x) { return x.stream; }) });
  };
  PC.prototype.createAnswer = function () {
    return Promise.resolve({ type: "answer", sdp: "answer:" + uid });
  };
  PC.prototype.setLocalDescription = function (d) {
    this.localDescription = d;
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
    return Promise.resolve();
  };
  PC.prototype.setRemoteDescription = function (d) {
    this.remoteDescription = d;
    var self = this;
    if (d.type === "offer") {
      this.signalingState = "have-remote-offer";
      /* the listening end receives the speaker's stream */
      setTimeout(function () {
        self.connectionState = "connected";
        if (self.onconnectionstatechange) self.onconnectionstatechange();
        if (self.ontrack) self.ontrack({ streams: [d._streams && d._streams[0] || { id: "s" }] });
      }, 0);
    } else {
      this.signalingState = "stable";
      setTimeout(function () {
        self.connectionState = "connected";
        if (self.onconnectionstatechange) self.onconnectionstatechange();
      }, 0);
    }
    return Promise.resolve();
  };
  PC.prototype.addIceCandidate = function () { return Promise.resolve(); };
  PC.prototype.close = function () {
    this.connectionState = "closed";
  };
  g.RTCPeerConnection = PC;
  g.RTCSessionDescription = function (d) { return d; };
  g.RTCIceCandidate = function (d) { return d; };
  return PC;
}
module.exports = { makeWorld: makeWorld, installRtc: installRtc };
