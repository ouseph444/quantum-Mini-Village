# Tests

Five suites, none of which need a Firebase project, a microphone, a second
laptop or a second browser.

---

## 1. Live voice — `voice.test.js`

Three residents in three separate JavaScript contexts, with a fake WebRTC
stack and a fake signalling database wired between them. It is the
multi-user test that otherwise needs three machines:

* A speaks; **B and C hear her without ever touching a microphone**, and
  without an `AudioContext` ever being created;
* B speaks too, and both are heard at once — neither one's element is
  replaced or silenced by the other;
* C mutes the village and unmutes it, and nobody else's audio changes;
* A stops, B keeps talking, and C is left holding exactly one audio element;
* only `join`, `offer`, `answer` and ICE notes ever reach the database —
  **no audio, ever**;
* B's tab disappears and C cleans up after it.

```bash
node tests/voice.test.js .
```

### A crowded village — `voice-mesh.test.js`

Seven residents and a stricter WebRTC fake: a connection comes up only when
the speaker applies the answer to *that* listener's offer. The test then does
what a real network does once more than two people are talking:

* five people talk at once and **each hears the other four**, with the page
  never drawn (as in a background tab);
* a newcomer's answer is **lost**, and the half-open connection is thrown
  away and redialled instead of staying silent forever;
* an offer arrives **after the listener gave up on it**, and it is dropped
  instead of breaking the connection that replaced it;
* a connection **drops mid-sentence** and the listener redials by itself;
* stale offers, answers and candidates from an old handshake are ignored.

```bash
node tests/voice-mesh.test.js .
```

## 2. Voice in other browsers — `voice-compat.test.js`

The same voice module, stood up in engines that are not the one it was
written in. Each case is a feature test standing in for a real browser, and
nothing in it reads a user agent:

* **iOS**, whose `volume` property accepts the write and ignores it — the
  village works that out for itself and carries distance by muting instead,
  so somebody at the far edge of earshot is quiet rather than deafening;
* **Safari before 15.4**, which has no `connectionState` — a connection that
  fails is still noticed, on the event that browser does have;
* **plain http**, and a browser with no WebRTC at all — both said plainly
  before a microphone is opened rather than after;
* **a project with no Realtime Database** — the microphone button stays shut
  instead of opening a microphone nobody could ever hear;
* **no microphone**, and **a microphone another application is holding** —
  named as what they are, not as a permission;
* **a device that refuses the constraints**, which gets one bare retry;
* **the callback `getUserMedia`** older web views still ship;
* **a Cyrillic keyboard**, which still has a V key even though it does not
  type one;
* **V held down while the window goes away**, and **leaving the page on
  iOS**, both of which must let go of the microphone.

```bash
node tests/voice-compat.test.js .
```

## Private calls — `private-call.test.js`

Four residents, the same WebRTC and signalling fakes. One calls another and
the call is rung, accepted and connected over a single peer connection;
a third resident calling in is told the line is busy; mute, hang-up,
decline, a blocked microphone at the far end, calling somebody offline and
a call cancelled before it is answered all end the way they should. It also
checks that only `c-` notes go on the wire, and that nobody can open the
village microphone while a private call is up.

```bash
node tests/private-call.test.js .
```

## 3. The blackboard reader — `board.test.js`

Which board **B** opens when there are several, that the writing comes out
as readable prose with the equations still legible while MathJax is being
fetched, that a pinned picture gets its own button, that "Write on it" is
offered only when you are close enough to reach the chalk, and that tapping
the slate opens it.

```bash
node tests/board.test.js .
```

## 4. Slides in the seminar halls — `slides.test.js`

Two residents in two separate JavaScript contexts, with a fake `slides` tree
wired between them that behaves the way `net.js`'s `watchLatest` does — one
record per hall per author, newest write wins. It is the multi-user test the
halls exist for:

* a multi-page PDF goes up on the hall's blackboard, **all** its pages
  opened rather than just the first;
* the presenter turns a page and **the other resident's board turns with
  it**, forwards and backwards, page by page;
* only one page ever crosses the wire — never the document — and each
  write says which page of how many it is and who wrote it;
* the room gets the picture but not the controls, and pressing Next from the
  room moves nobody's page;
* a deck covers the chalk underneath rather than wiping it, and the chalk
  comes back when the deck comes down;
* while somebody is presenting, **nobody else can put a deck up** — they are
  told by name who has the board, and the picker stays shut until it is free;
* of two people who press at the same instant, **exactly one** gets the board;
* a presenter who lost the board while offline is told and stands down
  instead of fighting over the page number;
* a presenter whose connection drops leaves a clear board behind.

```bash
node tests/slides.test.js .
```

All three run in a few hundred milliseconds and print a line per assertion.

---

## 5. Security rules — `rules/rules.test.mjs`

Assertions against the Firebase emulators, using the project's
real `database.rules.json` and `firestore.rules` rather than a copy. It is
the test that says whether a block is actually a block:

* a resident cannot appoint an administrator, and **neither can an
  administrator** — `admins/` is unwritable from any browser;
* only an administrator may block, and only in their own name;
* a blocked account may read its own block record and *nothing else*: no
  presence, no chat, no voice, not even the WebRTC handshake, in either
  database;
* a blocked account cannot lift its own block;
* **one document per poster stand or board**: a poster, a slide or a board
  picture is refused unless you hold that surface's claim, nobody can take
  or clear somebody else's claim, and the surface is free again once its
  holder lets go (chalk stays open to everyone);
* **poster competitions**: a resident may ask only in their own name and
  only as `pending`; only an administrator may approve or reject, approval
  must create the competition and take the hall in the same write, a second
  competition cannot start in a busy hall, and no expiry other than
  `approvedAt + 24 h` is ever accepted. Competition posters are refused with
  a stretched expiry, in the wrong hall, or as a conversion of an ordinary
  poster; ordinary posters are refused in a hall that is running one. Once a
  competition is over nothing more may be pinned under it and anybody may
  sweep its posters, its stands, its hall and its status;
* **reports**: anybody signed in may file one in their own name, once every
  thirty seconds, as `new`, with the whole message kept (over 5000
  characters is refused, not cut); nobody but an administrator may read
  them, change their status or delete them, and nobody may edit what was
  reported;
* **hall bookings and the Notice Board**: requests only in your own name,
  for the future, on the quarter hour, at most twelve hours, for a bookable
  hall, once every thirty seconds. Nobody may read somebody else's request.
  Approval must take the slots and create the notice in the same write, an
  overlapping booking cannot be approved (not even by leaving the shared
  slot out), and cancelling frees the slots for it. Only an administrator
  may put anything on the board, nobody may move an event's time, and once
  an event is over anybody may archive it and do nothing else;
* everybody else is entirely unaffected.

Needs a JDK 21 or newer (the emulators are Java) and the packages below.

```bash
cd tests/rules
npm install --no-save @firebase/rules-unit-testing firebase firebase-tools
npx firebase emulators:exec --only database,firestore --project qv-rules-test \
    "node rules.test.mjs"
```

---

## What these do not cover

A real microphone, a real NAT, and how a real phone feels in the hand.
Those need the manual pass in the README.
