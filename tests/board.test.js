/* The blackboard reader, without a browser: does pressing B put the right
   board's writing on the screen, in a form somebody can actually read? */
const fs = require("fs"), vm = require("vm"), path = require("path");
const dom = require("./dom.js");

const ROOT = process.argv[2] || ".";
const SRC = fs.readFileSync(path.join(ROOT, "js/board.js"), "utf8");

const g = {}; dom.install(g);
vm.createContext(g);
Object.assign(g, {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Math, Date, JSON, Object, Array, String, Number, Error, RegExp
});
g.XMLSerializer = function () { this.serializeToString = () => "<svg/>"; };
g.Image = function () { const i = {}; setTimeout(() => i.onerror && i.onerror(), 0); return i; };

/* the slice of the engine a board touches */
const texes = [];
g.THREE = {
  CanvasTexture: function () { const t = { needsUpdate: false, anisotropy: 0 }; texes.push(t); return t; },
  MeshBasicMaterial: function () { return {}; },
  DoubleSide: 2
};
g.QV = { panel: () => ({ visible: true, isMesh: true }) };
g.document.createElement = (tag) => {
  const el = dom.makeEl(tag);
  /* MathJax is fetched from a CDN the first time a board is painted. There
     is no CDN here, so let the fetch fail the way it would offline — the
     reader has to stay readable when it does. */
  if (tag === "script") setTimeout(() => el.onerror && el.onerror(), 0);
  if (tag === "canvas") {
    el.width = 0; el.height = 0;
    el.getContext = () => ({
      clearRect(){}, save(){}, restore(){}, drawImage(){}, strokeRect(){},
      fillText(){}, measureText: (s) => ({ width: String(s).length * 7 }),
      set font(v){}, get font(){ return ""; },
      set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){},
      set textBaseline(v){}, set textAlign(v){}, set shadowColor(v){},
      set shadowBlur(v){}, set globalAlpha(v){}
    });
  }
  return el;
};

const interactAdds = [];
g.QVInteract = { add: (o) => { interactAdds.push(o); return o; } };
g.QVRooms = { state: () => ({ roomId: "" }) };

["board-read","br-title","br-by","br-pic","br-picopen","br-picdl","br-text","br-write"]
  .forEach(id => g.mount(id));

vm.runInContext(SRC, g, { filename: "board.js" });
const B = g.QVBoard;

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) failures++; };

B.init({ position: () => ({ x: 0, z: 0 }), onOpen(){}, onClose(){} });

/* two boards, in two different rooms, twenty metres apart */
B.register({ id: "alpha", name: "Seminar Room Alpha", parent: null, w: 6, h: 3, wx: 0,  wz: 0 });
B.register({ id: "beta",  name: "Lecture Barn",       parent: null, w: 6, h: 3, wx: 40, wz: 0 });

(async function () {
  console.log("\n— which board does B open? —");
  ok(B.nearestReadable(1, 1).id === "alpha", "the one you are standing in front of");
  ok(B.nearestReadable(39, 0).id === "beta", "and the other one when you walk over to it");
  ok(B.nearestReadable(500, 500) === null, "nothing at all from across the village");

  g.QVRooms.state = () => ({ roomId: "beta" });
  ok(B.nearestReadable(1, 1).id === "beta",
     "inside a room, that room's board wins over a nearer one through the wall");
  g.QVRooms.state = () => ({ roomId: "" });

  console.log("\n— the button's own idea of what is nearby —");
  let at = B.readableAt(1, 1);
  ok(at && at.id === "alpha" && at.written === false, "a blank board is offered, marked blank");

  console.log("\n— reading what is written —");
  await B.write("alpha", "Two-level system\nThe Hamiltonian is $H = \\tfrac12 \\hbar\\omega\\sigma_z$ here.", "Ada");
  at = B.readableAt(1, 1);
  ok(at.written === true, "now it is marked as having something on it");

  ok(B.read("alpha") === true, "the reader opens");
  ok(B.isReading() === true, "and says so");
  ok(g.document.getElementById("board-read").hidden === false, "the panel is visible");
  ok(g.document.getElementById("br-title").textContent === "Seminar Room Alpha",
     "with the right board's name on it");
  ok(g.document.getElementById("br-by").textContent.indexOf("Ada") >= 0, "and who wrote it");

  const host = g.document.getElementById("br-text");
  const flat = JSON.stringify(host.children.map(p =>
    p.children.map(n => n.textContent).join("") || p.textContent));
  ok(host.children.length >= 2, "the two lines came out as two paragraphs");
  ok(flat.indexOf("Two-level system") >= 0, "the first line is there");
  ok(flat.indexOf("Hamiltonian") >= 0, "and the prose around the equation");
  ok(flat.indexOf("H =") >= 0, "with the equation's source readable even before MathJax lands");

  console.log("\n— the picture gets its own button —");
  ok(g.document.getElementById("br-picopen").hidden === true, "no picture, no button");
  B.closeRead();
  await B.write("alpha", "With a plot", "Ada", "data:image/png;base64,iVBOR");
  B.read("alpha");
  ok(g.document.getElementById("br-picopen").hidden === false, "a picture, a button");
  ok(g.document.getElementById("br-picdl").hidden === false, "and a way to save it");
  ok(g.document.getElementById("br-pic").hidden === false, "the picture itself is shown");

  console.log("\n— writing from the reader —");
  ok(g.document.getElementById("br-write").hidden === false,
     "standing at the board, 'Write on it' is offered");
  B.closeRead();
  B.init({ position: () => ({ x: 300, z: 300 }), onOpen(){}, onClose(){} });
  B.read("alpha");
  ok(g.document.getElementById("br-write").hidden === true,
     "reading from across the room, it is not");

  console.log("\n— closing —");
  B.closeRead();
  ok(B.isReading() === false && g.document.getElementById("board-read").hidden === true,
     "the panel goes away");

  console.log("\n— tapping the slate itself —");
  const surf = interactAdds.filter(i => i.id.indexOf("boardsurf-") === 0);
  ok(surf.length === 2, "both boards registered a clickable surface");
  ok(surf.every(i => i.pickR && i.r < 1),
     "clickable from a reading distance, but never the E prompt");
  surf[0].onUse();
  ok(B.isReading() === true, "clicking one opens it");
  B.closeRead();

  console.log(failures ? "\n" + failures + " FAILED\n" : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
