/* Slides in the seminar halls, without a browser and without Firebase.
 *
 * The claim being tested is the one the halls exist for: a presenter turns
 * a page and everybody else in the hall is looking at that page. So this
 * runs two residents in two separate JavaScript contexts — the same shape
 * as the voice test — with a fake `slides` tree wired between them that
 * behaves the way net.js's watchLatest does: one record per hall per author,
 * newest write wins.
 *
 *   node tests/slides.test.js .
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const dom = require("./dom.js");

const ROOT = process.argv[2] || ".";
const BOARD  = fs.readFileSync(path.join(ROOT, "js/board.js"), "utf8");
const SLIDES = fs.readFileSync(path.join(ROOT, "js/slides.js"), "utf8");

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) failures++; };
const wait = () => new Promise(r => setTimeout(r, 0));
/* Uploading a page is a chain of promises deep enough that one turn of the
   microtask queue is not enough; settle properly instead of guessing. */
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await wait(); };

const PANEL_IDS = [
  "slides", "sl-card", "sl-close", "sl-title", "sl-sub", "sl-view", "sl-file",
  "sl-filelabel", "sl-note", "sl-prev", "sl-next", "sl-end", "sl-page", "sl-hint",
  "slidebar", "sb-prev", "sb-next", "sb-end", "sb-open", "slides-btn",
  "board-read", "br-title", "br-by", "br-pic", "br-picopen", "br-picdl",
  "br-text", "br-write"
];

const PAGES = 4;

/* ------------------------------------------------------------ a resident */
function resident(uid, name) {
  const g = {};
  dom.install(g);
  vm.createContext(g);
  Object.assign(g, {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, Date, JSON, Object, Array, String, Number, Error, RegExp
  });
  g.XMLSerializer = function () { this.serializeToString = () => "<svg/>"; };
  /* Every picture decodes, so paintSlide takes its real path rather than
     its fallback. */
  g.Image = function () {
    const i = { naturalWidth: 800, naturalHeight: 600 };
    Object.defineProperty(i, "src", {
      set(v) { this._src = v; setTimeout(() => i.onload && i.onload(), 0); },
      get() { return this._src; }
    });
    return i;
  };
  g.FileReader = function () {
    this.readAsArrayBuffer = function () {
      setTimeout(() => { this.result = new ArrayBuffer(8); this.onload && this.onload(); }, 0);
    };
    this.readAsDataURL = function () {
      setTimeout(() => { this.result = "data:image/png;base64,AAA"; this.onload && this.onload(); }, 0);
    };
  };

  const texes = [];
  g.THREE = {
    CanvasTexture: function () { const t = { needsUpdate: false, anisotropy: 0 }; texes.push(t); return t; },
    MeshBasicMaterial: function () { return {}; },
    DoubleSide: 2
  };
  g.QV = { panel: () => ({ visible: true, isMesh: true }) };

  g.document.createElement = (tag) => {
    const el = dom.makeEl(tag);
    if (tag === "script") setTimeout(() => el.onerror && el.onerror(), 0);
    if (tag === "canvas") {
      el.width = 0; el.height = 0;
      const ctx = {
        clearRect(){}, save(){}, restore(){}, strokeRect(){},
        /* A page is rendered to one canvas and then re-drawn onto a second
           one to be encoded, so the marker has to survive the copy the way
           the pixels would. */
        drawImage(src) { if (src && src._ctx && src._ctx.__page != null) this.__page = src._ctx.__page; },
        fillRect(){}, fillText(){}, measureText: (s) => ({ width: String(s).length * 7 }),
        set font(v){}, get font(){ return ""; },
        set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){},
        set textBaseline(v){}, set textAlign(v){}, set shadowColor(v){},
        set shadowBlur(v){}, set globalAlpha(v){}
      };
      el._ctx = ctx;
      el.getContext = () => ctx;
      /* The fake PDF stamps the page number on the context as it renders,
         so a data URL here is distinguishable per page — which is the whole
         thing the test needs to be able to see. */
      el.toDataURL = () => "data:image/jpeg;base64,PAGE" + (ctx.__page == null ? "x" : ctx.__page);
    }
    return el;
  };

  g.QVInteract = { add: (o) => o };
  g.QVRooms = { state: () => ({ roomId: g.__room }) };
  g.__room = "";

  /* PDF.js, as far as slides.js is concerned. */
  g.QVPosters = {
    pdfjs: () => Promise.resolve({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: PAGES,
          getPage: (n) => Promise.resolve({
            getViewport: (o) => ({ width: 800 * (o.scale || 1), height: 600 * (o.scale || 1) }),
            render: (o) => { o.canvasContext.__page = n; return { promise: Promise.resolve() }; }
          }),
          destroy() {}
        })
      })
    })
  };

  PANEL_IDS.forEach(id => g.mount(id));

  vm.runInContext(BOARD, g, { filename: "board.js" });
  vm.runInContext(SLIDES, g, { filename: "slides.js" });

  const B = g.QVBoard, S = g.QVSlides;
  B.init({ position: () => ({ x: 0, z: 0 }), onOpen(){}, onClose(){} });
  /* the hall's blackboard, as campus.js registers it */
  B.register({ id: "seminar-hall-a", name: "Seminar Hall Alpha", parent: null,
               w: 39.2, h: 13.3, wx: 0, wz: 0 });
  S.registerHall({ id: "seminar-hall-a", name: "Seminar Hall Alpha",
                   board: "seminar-hall-a", x: -680, z: -390 });

  const toasts = [];
  S.init({
    name: () => name,
    uid: () => uid,
    roomId: () => g.__room,
    toast: (m) => toasts.push(m),
    onOpen(){}, onClose(){}
  });

  return { g, B, S, uid, name, toasts, el: (id) => g.document.getElementById(id),
           enter: (r) => { g.__room = r; } };
}

/* ------------------------------------------------- the fake slides tree
 * net.js files each record under slides/<room>/<uid> and hands watchers
 * whichever author wrote last. Both of those matter here, so both are
 * reproduced rather than assumed. */
function wire(clients) {
  const tree = {};                       /* room -> uid -> payload */
  const sent = [];
  let clock = 1000;

  function push() {
    const latest = {};
    Object.keys(tree).forEach(room => {
      let best = null;
      Object.keys(tree[room]).forEach(u => {
        const v = tree[room][u];
        if (v && (!best || (v.at || 0) > (best.at || 0))) best = v;
      });
      if (best) latest[room] = best;
    });
    clients.forEach(c => {
      Object.keys(latest).forEach(room => c.S.receive(room, latest[room]));
      Object.keys(tree).forEach(room => {
        if (!latest[room]) c.S.receive(room, null);
      });
    });
  }

  clients.forEach(c => {
    c.S.onChange = function (room, payload) {
      tree[room] = tree[room] || {};
      if (payload) {
        payload.at = ++clock;            /* a monotonic clock, like a server's */
        tree[room][c.uid] = payload;
        sent.push({ room, uid: c.uid, payload });
      } else {
        delete tree[room][c.uid];
      }
      push();
    };
  });
  return { tree, sent };
}

/* ------------------------------------------------------------------ run */
(async function () {
  const ana = resident("uid-ana", "Ana");
  const ben = resident("uid-ben", "Ben");
  const net = wire([ana, ben]);

  ana.enter("seminar-hall-a");
  ben.enter("seminar-hall-a");

  console.log("\n— a deck goes up —");
  ana.S.open("seminar-hall-a");
  ben.S.open("seminar-hall-a");

  await ana.S.present("seminar-hall-a", { name: "talk.pdf", type: "application/pdf", size: 900 });
  await settle();

  const aDeck = ana.S.deck("seminar-hall-a");
  ok(!!aDeck && aDeck.mine, "the presenter has the deck");
  ok(aDeck.pages === PAGES, "all " + PAGES + " pages of the PDF were opened, not just the first");
  ok(aDeck.page === 1, "and it opened on page 1");

  const aSlide = ana.B.slideOf("seminar-hall-a");
  ok(!!aSlide && /PAGE1$/.test(aSlide.url), "page 1 is on the presenter's blackboard");
  ok(aSlide.pages === PAGES && aSlide.page === 1, "the slate knows which page of how many");

  const bSlide = ben.B.slideOf("seminar-hall-a");
  ok(!!bSlide && /PAGE1$/.test(bSlide.url), "and on everybody else's blackboard in the hall");
  ok(bSlide.by === "Ana", "with the presenter's name on it");
  ok(!ben.S.deck("seminar-hall-a").mine, "the room is watching, not presenting");

  console.log("\n— turning the page —");
  await ana.S.next("seminar-hall-a");
  await settle();
  ok(/PAGE2$/.test(ana.B.slideOf("seminar-hall-a").url), "the presenter is on page 2");
  ok(/PAGE2$/.test(ben.B.slideOf("seminar-hall-a").url), "and so is the rest of the hall");
  ok(ben.S.deck("seminar-hall-a").page === 2, "the room's page number moved with it");

  await ana.S.next("seminar-hall-a");
  await ana.S.next("seminar-hall-a");
  await settle();
  ok(/PAGE4$/.test(ben.B.slideOf("seminar-hall-a").url), "four pages in, the hall is still with her");

  const before = ana.S.deck("seminar-hall-a").page;
  await ana.S.next("seminar-hall-a");
  await settle();
  ok(ana.S.deck("seminar-hall-a").page === before, "Next does nothing on the last page");

  await ana.S.prev("seminar-hall-a");
  await settle();
  ok(/PAGE3$/.test(ben.B.slideOf("seminar-hall-a").url), "Previous takes the hall back a page too");

  console.log("\n— only the page travels, never the deck —");
  ok(net.sent.length >= 5, "every page turn was one write");
  ok(net.sent.every(w => typeof w.payload.s === "string" && w.payload.s.length < 200000),
     "each write carries one page and nothing else");
  ok(net.sent.every(w => w.payload.n === PAGES && w.payload.i >= 1 && w.payload.i <= PAGES),
     "and says which page of how many it is");
  ok(net.sent.every(w => w.payload.u === "uid-ana"), "filed under the presenter who wrote it");

  console.log("\n— the controls belong to the presenter —");
  ok(ana.el("sl-next").hidden === false, "the presenter is offered Next");
  ok(ben.el("sl-next").hidden === true, "the room is not");
  ok(ben.el("sl-end").hidden === true, "nor a way to take somebody else's deck down");
  ok(ben.el("sl-page").textContent === ana.el("sl-page").textContent,
     "but both panels show the same page: " + ben.el("sl-page").textContent);
  ok(await ben.S.next("seminar-hall-a") === false, "and Next does nothing from the room");
  await settle();
  ok(/PAGE3$/.test(ana.B.slideOf("seminar-hall-a").url), "the presenter's page did not move");

  console.log("\n— chalk under a deck —");
  await ana.B.write("seminar-hall-a", "the action of the free field", "Ana");
  await settle();
  ok(/PAGE3$/.test(ana.B.slideOf("seminar-hall-a").url), "a deck covers the chalk rather than losing it");

  console.log("\n— taking it down —");
  ana.S.end("seminar-hall-a");
  await settle();
  ok(ana.B.slideOf("seminar-hall-a") === null, "the presenter's slate is clear");
  ok(ben.B.slideOf("seminar-hall-a") === null, "and so is everybody else's");
  ok(ana.B.get("seminar-hall-a").src === "the action of the free field",
     "and the chalk that was underneath is back");
  ok(!ana.S.deck("seminar-hall-a") && !ben.S.deck("seminar-hall-a"), "no deck is left anywhere");

  console.log("\n— somebody else tries to take the screen —");
  await ana.S.present("seminar-hall-a", { name: "ana.pdf", type: "application/pdf", size: 900 });
  await settle();
  let refused = null;
  await ben.S.present("seminar-hall-a", { name: "ben.pdf", type: "application/pdf", size: 900 })
    .catch(e => { refused = e; });
  await settle();
  ok(refused && /Ana is using the board/.test(refused.message),
     "Ben is refused, and told by name who has the board");
  ok(ana.S.deck("seminar-hall-a") && ana.S.deck("seminar-hall-a").mine, "Ana keeps the screen");
  ok(!ben.S.deck("seminar-hall-a").mine, "and Ben is still only watching");
  ben.S.open("seminar-hall-a");
  ok(/Ana is using this board/.test(ben.el("sl-filelabel").textContent),
     "Ben's panel says whose the board is");
  ok(ben.el("sl-file").disabled === true, "and will not take a file");
  ben.S.close();

  console.log("\n— free again once it comes down —");
  ana.S.end("seminar-hall-a");
  await settle();
  ben.S.open("seminar-hall-a");
  ok(ben.el("sl-file").disabled === false, "the picker opens up for Ben");
  ben.S.close();
  await ben.S.present("seminar-hall-a", { name: "ben.pdf", type: "application/pdf", size: 900 });
  await settle();
  ok(ben.S.deck("seminar-hall-a").mine, "and Ben's deck goes up");
  ok(ana.S.presenting() === null, "only one resident is presenting in the hall");
  ben.S.end("seminar-hall-a");
  await settle();

  console.log("\n— two people press at the same instant —");
  /* The server's claim: a transaction, so exactly one of two simultaneous
     claims commits. Modelled here as a single owner slot. */
  const claims = {};
  const released = [];
  [ana, ben].forEach(c => c.S.init({
    name: () => c.name, uid: () => c.uid, roomId: () => c.g.__room,
    toast: (m) => c.toasts.push(m), onOpen(){}, onClose(){},
    holder: (room) => claims[room] ? { u: claims[room], n: claims[room] === ana.uid ? "Ana" : "Ben" } : null,
    claim: (room) => new Promise(r => setTimeout(() => {
      if (claims[room] && claims[room] !== c.uid) {
        r({ ok: false, holder: { u: claims[room], n: claims[room] === ana.uid ? "Ana" : "Ben" } });
      } else { claims[room] = c.uid; r({ ok: true }); }
    }, 0)),
    release: (room) => { released.push(c.uid); if (claims[room] === c.uid) delete claims[room]; }
  }));
  const results = await Promise.allSettled([
    ana.S.present("seminar-hall-a", { name: "ana.pdf", type: "application/pdf", size: 900 }),
    ben.S.present("seminar-hall-a", { name: "ben.pdf", type: "application/pdf", size: 900 })
  ]);
  await settle();
  ok(results.filter(r => r.status === "fulfilled").length === 1, "exactly one of them gets the board");
  const loser = results[0].status === "rejected" ? results[0] : results[1];
  ok(/is using the board/.test(loser.reason && loser.reason.message), "the other is told who got it");
  ok([ana, ben].filter(c => c.S.presenting() === "seminar-hall-a").length === 1,
     "and only one deck is up");
  const winner = ana.S.presenting() ? ana : ben;
  winner.S.end("seminar-hall-a");
  await settle();

  console.log("\n— a presenter who lost the board while offline —");
  /* Ana dropped off, her claim lapsed and Ben claimed the board; when she
     comes back the tree shows his page, not hers. She stands down. */
  delete claims["seminar-hall-a"];
  await ana.S.present("seminar-hall-a", { name: "ana.pdf", type: "application/pdf", size: 900 });
  await settle();
  claims["seminar-hall-a"] = ben.uid;
  ana.S.receive("seminar-hall-a", { s: "data:image/jpeg;base64,BEN", i: 1, n: 1, by: "Ben", u: ben.uid, at: 1e9 });
  await settle();
  ok(ana.S.presenting() === null, "Ana stands down rather than fighting for it");
  ok(ana.toasts.some(t => /Ben/.test(t) && /offline/.test(t)), "and is told, by name, what happened");

  console.log("\n— a presenter who leaves —");
  /* An onDisconnect fires: the record goes, and net.js reports the removal. */
  ben.S.onChange("seminar-hall-a", null);
  await settle();
  ok(ana.B.slideOf("seminar-hall-a") === null, "the hall's board clears itself");

  console.log("\n— the rail —");
  ana.enter("");
  ana.S.close();
  ana.S.updateHud();
  ok(ana.el("slides-btn").hidden === true, "no Slides button outside a hall");
  ana.enter("seminar-hall-a");
  ana.S.updateHud();
  ok(ana.el("slides-btn").hidden === false, "and one inside it");

  console.log(failures ? "\n" + failures + " failed" : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
