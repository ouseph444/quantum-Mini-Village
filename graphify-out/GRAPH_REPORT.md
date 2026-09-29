# Graph Report - quantum-Mini-Village-main  (2026-09-26)

## Corpus Check
- 56 files · ~461,103 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 11 file(s) not represented in the graph (top: (none) 5, .ipynb 1, .rvf 1)

## Summary
- 1481 nodes · 3334 edges · 57 communities (53 shown, 4 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 140 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- events.js
- posters.js
- voice.js
- net.js
- admin.js
- board.js
- campus.js
- private.js
- transport.js
- app.js
- slides.js
- esc
- openBooking
- village.js
- restaurant.js
- rules.test.mjs
- api
- board.test.js
- Game Audio Principles
- voice-mesh.test.js
- Quantum Village
- Game Art Principles
- Web Browser Game Development
- slides.test.js
- 3D Game Development
- toast
- bindInput
- archives.js
- PC/Console Game Development
- Core Principles (All Platforms)
- wireNet
- 2D Game Development
- Game Design Principles
- VR/AR Development
- Multiplayer Game Development
- api
- ambient.js
- Mobile Game Development
- private-call.test.js
- voice-compat.test.js
- renderProfile
- renderMap
- voice.test.js
- index.js
- package.json
- activities.js
- bubbles.js
- rtc.js
- Administration
- 2. Wire up Firebase
- Live voice
- How the data is laid out
- Poster events: registration and numbered stands
- dom.js

## God Nodes (most connected - your core abstractions)
1. `esc()` - 57 edges
2. `wireNet()` - 41 edges
3. `api` - 32 edges
4. `toast()` - 30 edges
5. `start()` - 27 edges
6. `api` - 27 edges
7. `esc()` - 26 edges
8. `Quantum Village` - 24 edges
9. `openBooking()` - 22 edges
10. `openPanel()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `1. Live voice — `voice.test.js`` --references--> `offer()`  [INFERRED]
  tests/README.md → js/private.js
- `Deleting a login` --references--> `blockUser()`  [INFERRED]
  README.md → functions/index.js
- `Deleting a login` --references--> `unblockUser()`  [INFERRED]
  README.md → functions/index.js
- `Deleting a login` --references--> `deleteUser()`  [INFERRED]
  README.md → functions/index.js
- `Booking a hall, and the Village Notice Board` --references--> `expirePosterCompetitions()`  [INFERRED]
  README.md → functions/index.js

## Import Cycles
- None detected.

## Communities (57 total, 4 thin omitted)

### Community 0 - "events.js"
Cohesion: 0.06
Nodes (75): cap(), changed(), closeForm(), closeRequest(), dayOf(), downloadPdf(), dtPair(), el() (+67 more)

### Community 1 - "posters.js"
Cohesion: 0.06
Nodes (44): bindInteract(), claim(), closePin(), closeView(), dataToBlob(), decode(), drawTitle(), push() (+36 more)

### Community 2 - "voice.js"
Cohesion: 0.08
Nodes (51): attach(), audible(), audioHost(), bindUnlock(), closeInbound(), closeOutbound(), ctx(), drainIce() (+43 more)

### Community 3 - "net.js"
Cohesion: 0.06
Nodes (54): ackChat(), boot(), claim(), claimExpired(), claimFor(), claimOwner(), claimPath(), claimStale() (+46 more)

### Community 4 - "admin.js"
Cohesion: 0.10
Nodes (50): block(), clashes(), el(), esc(), fmtClock(), fmtDay(), hallBusyUntil(), api (+42 more)

### Community 5 - "board.js"
Cohesion: 0.07
Nodes (37): chalkFont(), claim(), close(), commit(), decodeImg(), drawPreview(), drawSeed(), el() (+29 more)

### Community 6 - "campus.js"
Cohesion: 0.09
Nodes (52): backWall(), bench(), blackboard(), bookcase(), put(), build(), buildBuildings(), buildPark() (+44 more)

### Community 7 - "private.js"
Cohesion: 0.12
Nodes (44): uid(), acceptCall(), addDmLine(), addDmNote(), callBlocked(), callEl(), clearTimer(), clockText() (+36 more)

### Community 8 - "transport.js"
Cohesion: 0.07
Nodes (47): animateJeep(), boardVehicle(), build(), buildCycleStation(), buildFleet(), buildFlights(), buildGraph(), addLine() (+39 more)

### Community 9 - "app.js"
Cohesion: 0.08
Nodes (43): addChat(), announceActivity(), bindExtraUi(), boot(), checkPlace(), checkTokens(), cleanReportText(), closeReport() (+35 more)

### Community 10 - "slides.js"
Cohesion: 0.11
Nodes (28): apply(), broadcast(), busyMsg(), claim(), decode(), el(), encode(), esc() (+20 more)

### Community 11 - "esc"
Cohesion: 0.14
Nodes (45): absUrl(), ask(), askFaculty(), bindCards(), bindGroups(), body(), canonCard(), collect() (+37 more)

### Community 12 - "openBooking"
Cohesion: 0.11
Nodes (40): autoOpenBoard(), boardActivity(), boardList(), bookingClash(), bookingOpen(), bookingSpan(), closeBooking(), compChanged() (+32 more)

### Community 13 - "village.js"
Cohesion: 0.13
Nodes (31): applyRatio(), barn(), blocker(), blush(), box(), buildGround(), buildRestaurant(), buildVillage() (+23 more)

### Community 14 - "restaurant.js"
Cohesion: 0.12
Nodes (20): advanceQueue(), buildNPCs(), buildOwner(), buildQueueLane(), buildServer(), createFoodDish(), freeSeat(), inLane() (+12 more)

### Community 15 - "rules.test.mjs"
Cohesion: 0.08
Nodes (23): ref_firebase, ref_firebase_rules_unit_testing, ref_url, ada, anon, approveB(), approvedAt, ask() (+15 more)

### Community 16 - "api"
Cohesion: 0.13
Nodes (7): currentRoomId(), api, myId(), net(), unwatchAll(), walkScripted(), watch()

### Community 17 - "board.test.js"
Cohesion: 0.07
Nodes (8): dom, fs, g, interactAdds, path, SRC, texes, vm

### Community 18 - "Game Audio Principles"
Cohesion: 0.08
Nodes (23): 1. Audio Category System, 2. Sound Design Decisions, 3. Music Integration, 4. Adaptive Audio Decisions, 5. 3D Audio Decisions, 6. Platform Considerations, 7. Mix Hierarchy, 8. Anti-Patterns (+15 more)

### Community 19 - "voice-mesh.test.js"
Cohesion: 0.12
Nodes (20): allPcs, deliver(), dom, everyoneHearsEveryone(), fs, hears(), installRtc(), log (+12 more)

### Community 20 - "Quantum Village"
Cohesion: 0.10
Nodes (21): expirePosterCompetitions(), 1. Put it on GitHub Pages, About the papers, Booking a hall, and the Village Notice Board, Controls, Extending it, Licence, Live activities (+13 more)

### Community 21 - "Game Art Principles"
Cohesion: 0.10
Nodes (20): 1. Art Style Selection, 2. Asset Pipeline Decisions, 2D Pipeline, 2D Resolution by Platform, 3. Color Theory Decisions, 3D Pipeline, 4. Animation Principles, 5. Resolution & Scale Decisions (+12 more)

### Community 22 - "Web Browser Game Development"
Cohesion: 0.10
Nodes (20): 1. Framework Selection, 2. WebGPU Adoption, 3. Performance Principles, 4. Asset Strategy, 5. PWA for Games, 6. Audio Handling, 7. Anti-Patterns, Benefits (+12 more)

### Community 23 - "slides.test.js"
Cohesion: 0.11
Nodes (14): t(), BOARD, dom, fs, PANEL_IDS, path, resident(), g (+6 more)

### Community 24 - "3D Game Development"
Cohesion: 0.10
Nodes (19): 1. Rendering Pipeline, 2. Shader Principles, 3. 3D Physics, 3D Game Development, 4. Camera Systems, 5. Lighting, 6. Level of Detail (LOD), 7. Anti-Patterns (+11 more)

### Community 25 - "toast"
Cohesion: 0.21
Nodes (20): arrivalSpot(), arrive(), closePanel(), endRide(), eventPlace(), ferry(), getOff(), goButtons() (+12 more)

### Community 26 - "bindInput"
Cohesion: 0.15
Nodes (19): bindInput(), closeCompRequest(), closePeerCard(), compRequestOpen(), fullNameGuess(), groundPoint(), measurePeerCardRoom(), onHallCardClick() (+11 more)

### Community 27 - "archives.js"
Cohesion: 0.16
Nodes (9): esc(), api, loadFrame(), blocked(), localRecords(), makeIcon(), pageTex(), renderReading() (+1 more)

### Community 28 - "PC/Console Game Development"
Cohesion: 0.11
Nodes (18): 1. Engine Selection, 2. Platform Features, 3. Controller Support, 4. Performance Optimization, 5. Engine-Specific Principles, 6. Anti-Patterns, Common Bottlenecks, Comparison (+10 more)

### Community 29 - "Core Principles (All Platforms)"
Cohesion: 0.11
Nodes (18): 1. The Game Loop, 2. Pattern Selection Matrix, 3. Input Abstraction, 4. Performance Budget (60 FPS = 16.67ms), 5. AI Selection by Complexity, 6. Collision Strategy, Anti-Patterns (Universal), Core Principles (All Platforms) (+10 more)

### Community 30 - "wireNet"
Cohesion: 0.16
Nodes (17): activeCompetition(), claimSurface(), competitionLive(), hallOfFrame(), holderOf(), loadInstitutes(), pickRecord(), queueSweep() (+9 more)

### Community 31 - "2D Game Development"
Cohesion: 0.11
Nodes (17): 1. Sprite Systems, 2. Tilemap Design, 2D Game Development, 3. 2D Physics, 4. Camera Systems, 5. Genre Patterns, 6. Anti-Patterns, Animation Principles (+9 more)

### Community 32 - "Game Design Principles"
Cohesion: 0.11
Nodes (17): 1. Core Loop Design, 2. Game Design Document (GDD), 3. Player Psychology, 4. Difficulty Balancing, 5. Progression Design, 6. Anti-Patterns, Balancing Strategies, Essential Sections (+9 more)

### Community 33 - "VR/AR Development"
Cohesion: 0.11
Nodes (17): 1. Platform Selection, 2. Comfort Principles, 3. Performance Requirements, 4. Interaction Principles, 5. Spatial Design, 6. Anti-Patterns, AR Platforms, Comfort Settings (+9 more)

### Community 34 - "Multiplayer Game Development"
Cohesion: 0.12
Nodes (16): 1. Architecture Selection, 2. Synchronization Principles, 3. Network Optimization, 4. Security Principles, 5. Matchmaking, 6. Anti-Patterns, Anti-Cheat, Bandwidth Reduction (+8 more)

### Community 35 - "api"
Cohesion: 0.17
Nodes (3): escape_(), api, show()

### Community 36 - "ambient.js"
Cohesion: 0.23
Nodes (15): blip(), build(), buildWalkers(), legSet(), legsIdle(), legsWalk(), makeAnimal(), makeBird() (+7 more)

### Community 37 - "Mobile Game Development"
Cohesion: 0.13
Nodes (14): 1. Platform Considerations, 2. Touch Input Principles, 3. Performance Targets, 4. App Store Requirements, 5. Monetization Models, 6. Anti-Patterns, Android (Google Play), Battery Optimization (+6 more)

### Community 38 - "private-call.test.js"
Cohesion: 0.13
Nodes (9): dom, fs, path, people, PRIVATE, rtc, vm, VOICE (+1 more)

### Community 39 - "voice-compat.test.js"
Cohesion: 0.15
Nodes (10): ref_fs, ref_vm, dom, fs, path, rtc, spawn(), g (+2 more)

### Community 40 - "renderProfile"
Cohesion: 0.31
Nodes (13): affiliation(), applyIdentity(), askWhoYouAre(), fmtOrcid(), orcidDigits(), orcidOk(), orcidUrl(), publishResident() (+5 more)

### Community 41 - "renderMap"
Cohesion: 0.24
Nodes (11): applyMap(), districtOf(), drawBigMap(), px(), py(), drawMini(), keyOf(), mapMatches() (+3 more)

### Community 42 - "voice.test.js"
Cohesion: 0.15
Nodes (9): ref_path, dom, fs, path, people, rtc, SRC, vm (+1 more)

### Community 43 - "index.js"
Cohesion: 0.32
Nodes (11): admin, blockUser(), clearPresence(), db, deleteUser(), fs, functions, requireAdmin() (+3 more)

### Community 44 - "package.json"
Cohesion: 0.17
Nodes (11): dependencies, firebase-admin, firebase-functions, description, engines, node, main, name (+3 more)

### Community 45 - "activities.js"
Cohesion: 0.36
Nodes (6): bindRows(), dismiss(), esc(), next(), paint(), rows()

### Community 46 - "bubbles.js"
Cohesion: 0.46
Nodes (7): drop(), make(), now(), paint(), roundedWithTail(), say(), wrap()

### Community 47 - "rtc.js"
Cohesion: 0.25
Nodes (3): installRtc(), makeWorld(), world

### Community 48 - "Administration"
Cohesion: 0.40
Nodes (5): Administration, Editing the Notice Board, Making yourself an administrator, What a block is, What is never in the browser

### Community 50 - "2. Wire up Firebase"
Cohesion: 0.50
Nodes (4): 2. Wire up Firebase, Deploy the rules, If you skip step 3, In the Firebase console

### Community 51 - "Live voice"
Cohesion: 0.50
Nodes (4): Browsers and devices, Hearing is not speaking, Live voice, Speaking

### Community 52 - "How the data is laid out"
Cohesion: 0.67
Nodes (3): How much this writes, How the data is laid out, presence()

### Community 53 - "Poster events: registration and numbered stands"
Cohesion: 0.67
Nodes (3): Poster events: registration and numbered stands, Requesting a poster event (residents), Why two residents can never share a stand

## Knowledge Gaps
- **232 isolated node(s):** `functions`, `admin`, `db`, `fs`, `name` (+227 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 419 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `me()` connect `events.js` to `app.js`, `esc`?**
  _High betweenness centrality (0.160) - this node is a cross-community bridge._
- **Why does `t()` connect `slides.test.js` to `events.js`, `voice.js`, `net.js`, `private.js`, `rules.test.mjs`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `file()` connect `rules.test.mjs` to `posters.js`, `slides.js`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `wireNet()` (e.g. with `closePanel()` and `goButtons()`) actually correct?**
  _`wireNet()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `start()` (e.g. with `displayName()` and `myUidNow()`) actually correct?**
  _`start()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `functions`, `admin`, `db` to the rest of the system?**
  _232 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `events.js` be split into smaller, more focused modules?**
  _Cohesion score 0.061893845882560396 - nodes in this community are weakly interconnected._