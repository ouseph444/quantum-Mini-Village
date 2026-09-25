/* Do the rules actually keep a blocked resident out, and keep everybody
   else out of administration? Run against the Firebase emulators. */
import {
  initializeTestEnvironment, assertFails, assertSucceeds
} from "@firebase/rules-unit-testing";
import { ref, get, set, remove, update, serverTimestamp, query, orderByChild, equalTo } from "firebase/database";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

/* Read the project's real rule files, not a copy that can drift. */
const here = path.dirname(fileURLToPath(import.meta.url));
const rules = (p) => fs.readFileSync(path.resolve(here, p), "utf8");

let failures = 0, passes = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ok   " + name); passes++; }
  catch (e) { console.log("  FAIL " + name + "  — " + (e.message || e).split("\n")[0]); failures++; }
}

const env = await initializeTestEnvironment({
  projectId: "qv-rules-test",
  database: { rules: rules("../../database.rules.json"), host: "127.0.0.1", port: 9000 },
  firestore: { rules: rules("../../firestore.rules"), host: "127.0.0.1", port: 8080 }
});

/* Both rule languages read the sign-in provider out of the token:
   auth.provider in the Realtime Database, request.auth.token.firebase
   .sign_in_provider in Firestore. Both come from this. */
const pw = { firebase: { sign_in_provider: "password", identities: {} } };
const boss  = env.authenticatedContext("boss",  pw);
const ada   = env.authenticatedContext("ada",   pw);
const mallory = env.authenticatedContext("mal", pw);
const anon  = env.unauthenticatedContext();

/* Seed admins/ and blocked/ the way a console or a service account would. */
await env.withSecurityRulesDisabled(async (adminCtx) => {
  await set(ref(adminCtx.database(), "admins/boss"), true);
  await setDoc(doc(adminCtx.firestore(), "admins/boss"), { at: 1 });
});

const rt = (c) => c.database(), fsdb = (c) => c.firestore();
const presence = (n) => ({ n, x: 0, z: 0, at: Date.now() });

console.log("\n— Realtime Database: the ordinary village —");
await t("a signed-in resident writes their own presence",
  () => assertSucceeds(set(ref(rt(ada), "presence/ada"), presence("Ada"))));
await t("and reads the village",
  () => assertSucceeds(get(ref(rt(ada), "presence"))));
await t("a stranger with no account gets nothing",
  () => assertFails(get(ref(rt(anon), "presence"))));

console.log("\n— who may appoint an administrator —");
await t("not a resident",
  () => assertFails(set(ref(rt(ada), "admins/ada"), true)));
await t("not even an administrator",
  () => assertFails(set(ref(rt(boss), "admins/mal"), true)));
await t("anyone signed in may read the list (so the page knows)",
  () => assertSucceeds(get(ref(rt(ada), "admins/ada"))));

console.log("\n— who may block —");
await t("a resident may not block anybody",
  () => assertFails(set(ref(rt(ada), "blocked/mal"), { at: Date.now(), by: "ada" })));
await t("a resident may not block themselves free of an administrator",
  () => assertFails(remove(ref(rt(ada), "blocked/mal"))));
await t("an administrator may block",
  () => assertSucceeds(set(ref(rt(boss), "blocked/mal"),
        { at: Date.now(), by: "boss", byName: "Boss", why: "spam" })));
await t("a block must be signed by whoever made it",
  () => assertFails(set(ref(rt(boss), "blocked/ada"), { at: Date.now(), by: "someone-else" })));

console.log("\n— what a blocked resident can still do —");
await t("read their own block record, so they can be told why",
  () => assertSucceeds(get(ref(rt(mallory), "blocked/mal"))));
await t("...and nothing else: presence is refused",
  () => assertFails(set(ref(rt(mallory), "presence/mal"), presence("Mal"))));
await t("reading the village is refused",
  () => assertFails(get(ref(rt(mallory), "presence"))));
await t("speaking is refused",
  () => assertFails(set(ref(rt(mallory), "voiceLive/mal"),
        { n: "Mal", mode: "village", at: Date.now(), uid: "mal" })));
await t("even the voice handshake is refused",
  () => assertFails(set(ref(rt(mallory), "voiceSignal/ada/mal/k"), { t: "offer", d: "x" })));
await t("chat is refused",
  () => assertFails(set(ref(rt(mallory), "chat/x"), { n: "Mal", m: "hi", at: Date.now(), uid: "mal" })));
await t("they cannot read somebody else's block record",
  () => assertFails(get(ref(rt(mallory), "blocked/ada"))));
await t("and they cannot lift their own block",
  () => assertFails(remove(ref(rt(mallory), "blocked/mal"))));

console.log("\n— everyone else is unaffected —");
await t("Ada is still in the village",
  () => assertSucceeds(set(ref(rt(ada), "presence/ada"), presence("Ada"))));
await t("Ada can still speak",
  () => assertSucceeds(set(ref(rt(ada), "voiceLive/ada"),
        { n: "Ada", mode: "nearby", x: 1, z: 2, at: Date.now(), uid: "ada" })));

console.log("\n— an administrator tidying up after somebody —");
await t("an administrator may clear a live presence record",
  () => assertSucceeds(remove(ref(rt(boss), "presence/ada"))));
await t("...but may not write one in somebody else's name",
  () => assertFails(set(ref(rt(boss), "presence/ada"), presence("Not Ada"))));
await t("an administrator may clear a stale voice note",
  () => assertSucceeds(remove(ref(rt(boss), "voiceLive/ada"))));
await t("a resident still may not touch anybody else's",
  () => assertFails(remove(ref(rt(mallory), "presence/ada"))));

console.log("\n— lifting it —");
await t("an administrator unblocks",
  () => assertSucceeds(remove(ref(rt(boss), "blocked/mal"))));
await t("and they are back",
  () => assertSucceeds(set(ref(rt(mallory), "presence/mal"), presence("Mal"))));

console.log("\n— private messages —");
const dmMsg = (f, m) => ({ f, m: m || "hello", at: Date.now() });
await t("Ada writes into her thread with Boss",
  () => assertSucceeds(set(ref(rt(ada), "dm/ada~boss/m1"), dmMsg("ada"))));
await t("Boss reads it",
  () => assertSucceeds(get(ref(rt(boss), "dm/ada~boss"))));
await t("a third resident cannot read it",
  () => assertFails(get(ref(rt(mallory), "dm/ada~boss"))));
await t("nor write into it",
  () => assertFails(set(ref(rt(mallory), "dm/ada~boss/m2"), dmMsg("mal"))));
await t("nor read the whole dm tree",
  () => assertFails(get(ref(rt(mallory), "dm"))));
await t("a message cannot be signed as the other participant",
  () => assertFails(set(ref(rt(ada), "dm/ada~boss/m3"), dmMsg("boss"))));
await t("a sent message cannot be edited",
  () => assertFails(set(ref(rt(boss), "dm/ada~boss/m1"), dmMsg("boss", "changed"))));
await t("either participant may delete one",
  () => assertSucceeds(remove(ref(rt(boss), "dm/ada~boss/m1"))));
await t("Ada flags an unread message for Boss",
  () => assertSucceeds(set(ref(rt(ada), "dmInbox/boss/ada"), { n: "Ada", p: "hello", at: Date.now() })));
await t("Boss sees who wrote",
  () => assertSucceeds(get(ref(rt(boss), "dmInbox/boss"))));
await t("nobody else can see who is writing to Boss",
  () => assertFails(get(ref(rt(mallory), "dmInbox/boss"))));
await t("nobody can plant a flag in somebody else's name",
  () => assertFails(set(ref(rt(mallory), "dmInbox/boss/ada"), { n: "Ada", at: Date.now() })));
await t("Boss clears it once read",
  () => assertSucceeds(remove(ref(rt(boss), "dmInbox/boss/ada"))));

console.log("\n— slides on a seminar hall's blackboard —");
const page = (o) => Object.assign(
  { s: "data:image/jpeg;base64,AAAA", i: 1, n: 12, by: "Ada", u: "ada", at: Date.now() }, o);
await t("a page cannot go up before the board is claimed",
  () => assertFails(set(ref(rt(ada), "slides/seminar-hall-a/ada"), page())));
await t("a resident claims the hall's board",
  () => assertSucceeds(set(ref(rt(ada), "pins/boards/seminar-hall-a"), { u: "ada", n: "Ada", at: Date.now() })));
await t("and puts a page up under their own uid",
  () => assertSucceeds(set(ref(rt(ada), "slides/seminar-hall-a/ada"), page())));
await t("somebody else cannot present on a board Ada holds",
  () => assertFails(set(ref(rt(mallory), "slides/seminar-hall-a/mal"), page({ by: "Mal", u: "mal" }))));
await t("and the whole hall may read it",
  () => assertSucceeds(get(ref(rt(boss), "slides/seminar-hall-a"))));
await t("nobody may present in somebody else's name",
  () => assertFails(set(ref(rt(mallory), "slides/seminar-hall-a/ada"), page({ by: "Mal" }))));
await t("...nor sign their own record as somebody else",
  () => assertFails(set(ref(rt(mallory), "slides/seminar-hall-a/mal"), page({ u: "ada" }))));
await t("a page must say which page of how many it is",
  () => assertFails(set(ref(rt(ada), "slides/seminar-hall-a/ada"),
        { s: "data:,", by: "Ada", u: "ada", at: Date.now() })));
await t("and the whole deck may not be smuggled in beside it",
  () => assertFails(set(ref(rt(ada), "slides/seminar-hall-a/ada"),
        page({ pages: ["one", "two"] }))));
await t("a presenter takes their own deck down",
  () => assertSucceeds(remove(ref(rt(ada), "slides/seminar-hall-a/ada"))));
await t("and gives the board back",
  () => assertSucceeds(remove(ref(rt(ada), "pins/boards/seminar-hall-a"))));

console.log("\n— one document per poster stand or board —");
const claim = (u, n) => ({ u, n, at: Date.now() });
const poster = () => ({ s: "data:image/jpeg;base64,AAAA", t: "Title", n: "Ada", at: Date.now() });
await t("a poster cannot go up on a stand nobody has claimed",
  () => assertFails(set(ref(rt(ada), "posters/poster-hall-1/ada"), poster())));
await t("Ada claims a free stand",
  () => assertSucceeds(set(ref(rt(ada), "pins/posters/poster-hall-1"), claim("ada", "Ada"))));
await t("and pins her poster to it",
  () => assertSucceeds(set(ref(rt(ada), "posters/poster-hall-1/ada"), poster())));
await t("Mal cannot claim the stand Ada holds",
  () => assertFails(set(ref(rt(mallory), "pins/posters/poster-hall-1"), claim("mal", "Mal"))));
await t("...nor take Ada's claim away",
  () => assertFails(remove(ref(rt(mallory), "pins/posters/poster-hall-1"))));
await t("...nor pin beside it under his own uid",
  () => assertFails(set(ref(rt(mallory), "posters/poster-hall-1/mal"), poster())));
await t("...nor claim in Ada's name to get round it",
  () => assertFails(set(ref(rt(mallory), "pins/posters/poster-hall-2"), claim("ada", "Ada"))));
await t("a claim can only be for a poster stand or a board",
  () => assertFails(set(ref(rt(ada), "pins/elsewhere/x"), claim("ada", "Ada"))));
await t("Ada takes her poster down",
  () => assertSucceeds(remove(ref(rt(ada), "posters/poster-hall-1/ada"))));
await t("and releases the stand",
  () => assertSucceeds(remove(ref(rt(ada), "pins/posters/poster-hall-1"))));
await t("now Mal may claim it",
  () => assertSucceeds(set(ref(rt(mallory), "pins/posters/poster-hall-1"), claim("mal", "Mal"))));
await t("and pin his poster",
  () => assertSucceeds(set(ref(rt(mallory), "posters/poster-hall-1/mal"), poster())));
await t("an administrator may clear a claim, for moderation",
  () => assertSucceeds(remove(ref(rt(boss), "pins/posters/poster-hall-1"))));

const chalk = (o) => Object.assign({ s: "$E=mc^2$", p: "", n: "Mal", at: Date.now() }, o);
await env.withSecurityRulesDisabled(async (adminCtx) => {
  await set(ref(adminCtx.database(), "pins/boards/lecture-1"), claim("ada", "Ada"));
});
await t("anybody may chalk on a board somebody else holds",
  () => assertSucceeds(set(ref(rt(mallory), "boards/lecture-1/mal"), chalk())));
await t("but not pin a picture to it",
  () => assertFails(set(ref(rt(mallory), "boards/lecture-1/mal"), chalk({ p: "data:image/jpeg;base64,AAAA" }))));
await t("the holder may",
  () => assertSucceeds(set(ref(rt(ada), "boards/lecture-1/ada"), chalk({ n: "Ada", p: "data:image/jpeg;base64,AAAA" }))));

console.log("\n— poster competitions: asking —");
const DAY = 24 * 3600000;
const request = (o) => Object.assign({ userId: "ada", userName: "Ada", hallId: "poster-hall",
  title: "Best open-systems poster", requestedAt: serverTimestamp(), status: "pending" }, o);
await t("a resident asks for a competition in their own name",
  () => assertSucceeds(set(ref(rt(ada), "posterCompetitionRequests/r1"), request({ description: "Anyone", preferredStart: Date.now() }))));
await t("...but not in somebody else's",
  () => assertFails(set(ref(rt(mallory), "posterCompetitionRequests/r2"), request())));
await t("...and not already approved",
  () => assertFails(set(ref(rt(ada), "posterCompetitionRequests/r3"), request({ status: "approved" }))));
await t("...and not with an expiry of their own",
  () => assertFails(set(ref(rt(ada), "posterCompetitionRequests/r3"), request({ approvedAt: Date.now(), expiresAt: Date.now() + 9 * DAY }))));
await t("...and only for a poster hall",
  () => assertFails(set(ref(rt(ada), "posterCompetitionRequests/r3"), request({ hallId: "lecture-1" }))));
await t("the requester cannot approve their own request",
  () => assertFails(set(ref(rt(ada), "posterCompetitionRequests/r1/status"), "approved")));
await t("...nor stamp it approved",
  () => assertFails(set(ref(rt(ada), "posterCompetitionRequests/r1/approvedAt"), Date.now())));
await t("anyone signed in can see what is pending",
  () => assertSucceeds(get(ref(rt(mallory), "posterCompetitionRequests"))));

const approval = (id, hall, by, title = "Best open-systems poster") => ({
  [`posterCompetitionRequests/${id}/status`]: "approved",
  [`posterCompetitionRequests/${id}/approvedAt`]: serverTimestamp(),
  [`posterCompetitionRequests/${id}/decidedAt`]: serverTimestamp(),
  [`posterCompetitionRequests/${id}/decidedBy`]: by,
  [`posterCompetitions/${id}`]: { requestId: id, hallId: hall, title,
    organiserId: "ada", organiserName: "Ada", status: "active", approvedAt: serverTimestamp() },
  [`posterHallCompetition/${hall}`]: { id, approvedAt: serverTimestamp() }
});

console.log("\n— poster competitions: approving —");
await t("a resident cannot approve",
  () => assertFails(update(ref(rt(mallory)), approval("r1", "poster-hall", "mal"))));
await t("an administrator cannot mark it approved without creating the competition",
  () => assertFails(update(ref(rt(boss)), { "posterCompetitionRequests/r1/status": "approved",
        "posterCompetitionRequests/r1/approvedAt": serverTimestamp() })));
await t("an administrator cannot create a competition that differs from the request",
  () => assertFails(update(ref(rt(boss)), approval("r1", "poster-hall", "boss", "Something else"))));
await t("an administrator approves: request, competition and hall in one write",
  () => assertSucceeds(update(ref(rt(boss)), approval("r1", "poster-hall", "boss"))));
const approvedAt = (await get(ref(rt(boss), "posterCompetitions/r1/approvedAt"))).val();
await t("the expiry can only be approvedAt + 24 h — a longer one is refused",
  () => assertFails(set(ref(rt(ada), "posterCompetitions/r1/expiresAt"), approvedAt + 2 * DAY)));
await t("the right one may be filled in by anybody",
  () => assertSucceeds(set(ref(rt(mallory), "posterCompetitions/r1/expiresAt"), approvedAt + DAY)));
await t("...and then never changed",
  () => assertFails(set(ref(rt(boss), "posterCompetitions/r1/expiresAt"), approvedAt + 2 * DAY)));
await t("and the request's",
  () => assertSucceeds(set(ref(rt(mallory), "posterCompetitionRequests/r1/expiresAt"), approvedAt + DAY)));
await t("the hall's expiry too",
  () => assertSucceeds(set(ref(rt(ada), "posterHallCompetition/poster-hall/expiresAt"), approvedAt + DAY)));
await t("a resident cannot end a running competition",
  () => assertFails(set(ref(rt(mallory), "posterCompetitions/r1/status"), "expired")));
await t("...nor restamp it to keep it going",
  () => assertFails(set(ref(rt(ada), "posterCompetitions/r1/approvedAt"), serverTimestamp())));
await t("...nor take the hall",
  () => assertFails(set(ref(rt(ada), "posterHallCompetition/poster-hall"), { id: "r1", approvedAt: serverTimestamp() })));

await t("a second request for the same hall",
  () => assertSucceeds(set(ref(rt(ada), "posterCompetitionRequests/r4"), request({ title: "Another" }))));
await t("cannot be approved while the first competition runs",
  () => assertFails(update(ref(rt(boss)), approval("r4", "poster-hall", "boss", "Another"))));
await t("but it can be rejected",
  () => assertSucceeds(update(ref(rt(boss)), { "posterCompetitionRequests/r4/status": "rejected",
        "posterCompetitionRequests/r4/decidedAt": serverTimestamp(), "posterCompetitionRequests/r4/decidedBy": "boss" })));
await t("and a rejected request creates no competition",
  async () => { if ((await get(ref(rt(boss), "posterCompetitions/r4"))).exists()) throw new Error("competition exists"); });
await t("a decided request cannot be decided again",
  () => assertFails(set(ref(rt(boss), "posterCompetitionRequests/r4/status"), "approved")));

console.log("\n— poster competitions: posters —");
const cposter = (o) => Object.assign(poster(), { competitionId: "r1", hallId: "poster-hall", expiresAt: approvedAt + DAY }, o);
const cclaim = (u, n, o) => Object.assign(claim(u, n), { competitionId: "r1", expiresAt: approvedAt + DAY }, o);
await t("a stand is claimed for the competition",
  () => assertSucceeds(set(ref(rt(ada), "pins/posters/poster-hall-n1"), cclaim("ada", "Ada"))));
await t("...but not with a stretched expiry",
  () => assertFails(set(ref(rt(mallory), "pins/posters/poster-hall-n2"), cclaim("mal", "Mal", { expiresAt: approvedAt + 3 * DAY }))));
await t("...and not in another hall",
  () => assertFails(set(ref(rt(mallory), "pins/posters/poster-hall-2-A1f"), cclaim("mal", "Mal"))));
await t("a competition poster goes up",
  () => assertSucceeds(set(ref(rt(ada), "posters/poster-hall-n1/ada"), cposter())));
await t("...not with an expiry of its own",
  () => assertFails(set(ref(rt(ada), "posters/poster-hall-n1/ada"), cposter({ expiresAt: approvedAt + 5 * DAY }))));
await t("...not claiming to be in the other hall",
  () => assertFails(set(ref(rt(ada), "posters/poster-hall-n1/ada"), cposter({ hallId: "poster-hall-2" }))));
await t("...not without all three competition fields",
  () => assertFails(set(ref(rt(ada), "posters/poster-hall-n1/ada"), Object.assign(poster(), { competitionId: "r1" }))));
await t("nobody else may take it down",
  () => assertFails(remove(ref(rt(mallory), "posters/poster-hall-n1/ada"))));
await t("a new ordinary poster cannot go up in a hall running a competition",
  async () => {
    await assertSucceeds(set(ref(rt(mallory), "pins/posters/poster-hall-n3"), claim("mal", "Mal")));
    await assertFails(set(ref(rt(mallory), "posters/poster-hall-n3/mal"), poster()));
  });
await t("ordinary posters in the other hall are untouched",
  async () => {
    await assertSucceeds(set(ref(rt(mallory), "pins/posters/poster-hall-2-A2f"), claim("mal", "Mal")));
    await assertSucceeds(set(ref(rt(mallory), "posters/poster-hall-2-A2f/mal"), poster()));
  });
await t("...and cannot be turned into competition posters",
  () => assertFails(set(ref(rt(mallory), "posters/poster-hall-2-A2f/mal"),
        cposter({ hallId: "poster-hall-2" }))));
await env.withSecurityRulesDisabled(async (adminCtx) => {
  await set(ref(adminCtx.database(), "pins/posters/poster-hall-s5"), claim("mal", "Mal"));
  await set(ref(adminCtx.database(), "posters/poster-hall-s5/mal"), poster());
});
await t("an ordinary poster from before the competition cannot be converted in place",
  () => assertFails(set(ref(rt(mallory), "posters/poster-hall-s5/mal"), cposter())));
await t("...but it keeps working as an ordinary poster",
  () => assertSucceeds(set(ref(rt(mallory), "posters/poster-hall-s5/mal"), poster())));

console.log("\n— poster competitions: expiry —");
/* The emulator's clock cannot be wound forward, so seed a competition that
   was approved just over a day ago, the way the database would hold it. */
const old = Date.now() - DAY - 60000;
await env.withSecurityRulesDisabled(async (adminCtx) => {
  const d = adminCtx.database();
  await set(ref(d, "posterCompetitionRequests/old"), { userId: "ada", userName: "Ada", hallId: "poster-hall-2",
    title: "Yesterday", requestedAt: old - 1000, status: "approved", approvedAt: old, expiresAt: old + DAY });
  await set(ref(d, "posterCompetitions/old"), { requestId: "old", hallId: "poster-hall-2", title: "Yesterday",
    organiserId: "ada", organiserName: "Ada", status: "active", approvedAt: old, expiresAt: old + DAY });
  await set(ref(d, "posterHallCompetition/poster-hall-2"), { id: "old", approvedAt: old, expiresAt: old + DAY });
  await set(ref(d, "pins/posters/poster-hall-2-B1f"), Object.assign(claim("ada", "Ada"), { competitionId: "old", expiresAt: old + DAY }));
  await set(ref(d, "posters/poster-hall-2-B1f/ada"), Object.assign(poster(), { competitionId: "old", hallId: "poster-hall-2", expiresAt: old + DAY }));
});
await t("nothing more may be pinned under an expired competition",
  () => assertFails(set(ref(rt(ada), "posters/poster-hall-2-B1f/ada"),
        Object.assign(poster(), { competitionId: "old", hallId: "poster-hall-2", expiresAt: old + DAY }))));
await t("...and its expiry cannot be pushed back",
  () => assertFails(set(ref(rt(ada), "posterCompetitions/old/approvedAt"), Date.now())));
await t("anybody may sweep an expired competition poster",
  () => assertSucceeds(remove(ref(rt(mallory), "posters/poster-hall-2-B1f/ada"))));
await t("...and take over its stand",
  () => assertSucceeds(set(ref(rt(mallory), "pins/posters/poster-hall-2-B1f"), claim("mal", "Mal"))));
await t("...and mark the competition expired",
  () => assertSucceeds(set(ref(rt(mallory), "posterCompetitions/old/status"), "expired")));
await t("...but not reopen it",
  () => assertFails(set(ref(rt(mallory), "posterCompetitions/old/status"), "active")));
await t("...and free the hall",
  () => assertSucceeds(remove(ref(rt(mallory), "posterHallCompetition/poster-hall-2"))));
await t("the hall is back to ordinary posters",
  () => assertSucceeds(set(ref(rt(mallory), "posters/poster-hall-2-B1f/mal"), poster())));
await t("a running competition's hall may not be freed by a resident",
  () => assertFails(remove(ref(rt(mallory), "posterHallCompetition/poster-hall"))));

console.log("\n— poster competitions: withdrawing —");
await t("a requester may withdraw a pending request",
  async () => {
    await assertSucceeds(set(ref(rt(mallory), "posterCompetitionRequests/m1"), request({ userId: "mal", userName: "Mal" })));
    await assertSucceeds(remove(ref(rt(mallory), "posterCompetitionRequests/m1")));
  });
await t("...but not somebody else's",
  () => assertFails(remove(ref(rt(mallory), "posterCompetitionRequests/r1"))));

console.log("\n— reports and feedback —");
const report = (o) => Object.assign({ reportId: "x", userId: "ada", userName: "Ada", reportType: "bug",
  message: "The map will not open on my phone.\nSteps: tap M.", location: "The Poster Hall", createdAt: serverTimestamp(), status: "new" }, o);
const file = (ctx, id, o, uid = "ada") => update(ref(rt(ctx)), {
  [`reports/${id}`]: report(Object.assign({ reportId: id, userId: uid }, o)),
  [`reportThrottle/${uid}`]: serverTimestamp() });
await t("a resident files a report",
  () => assertSucceeds(file(ada, "rep1")));
await t("the whole message is kept, line breaks and all",
  async () => { const v = (await get(ref(rt(boss), "reports/rep1/message"))).val();
    if (v !== "The map will not open on my phone.\nSteps: tap M.") throw new Error("changed: " + v); });
await t("a second report within thirty seconds is refused",
  () => assertFails(file(ada, "rep2")));
await t("...and the throttle cannot be reset by deleting it",
  () => assertFails(remove(ref(rt(ada), "reportThrottle/ada"))));
await t("...nor skipped by leaving it out",
  () => assertFails(set(ref(rt(mallory), "reports/rep3"), report({ reportId: "rep3", userId: "mal", userName: "Mal" }))));
await t("nobody may file in somebody else's name",
  () => assertFails(file(mallory, "rep4", { userName: "Mal" }, "ada")));
await t("a report cannot arrive already resolved",
  () => assertFails(file(mallory, "rep4", { userName: "Mal", status: "resolved" }, "mal")));
await t("a report must be a known type",
  () => assertFails(file(mallory, "rep4", { userName: "Mal", reportType: "<script>" }, "mal")));
await t("a message over 5000 characters is refused, not cut",
  () => assertFails(file(mallory, "rep4", { userName: "Mal", message: "x".repeat(5001) }, "mal")));
await t("extra fields cannot be smuggled in",
  () => assertFails(file(mallory, "rep4", { userName: "Mal", payload: "x" }, "mal")));
await t("5000 characters is fine",
  () => assertSucceeds(file(mallory, "rep4", { userName: "Mal", message: "y".repeat(5000) }, "mal")));
await t("residents cannot read reports — not even their own",
  () => assertFails(get(ref(rt(ada), "reports"))));
await t("...nor one by one",
  () => assertFails(get(ref(rt(ada), "reports/rep1"))));
await t("the author cannot change the status",
  () => assertFails(set(ref(rt(ada), "reports/rep1/status"), "resolved")));
await t("...nor edit the message after sending it",
  () => assertFails(set(ref(rt(ada), "reports/rep1/message"), "never mind")));
await t("...nor delete it",
  () => assertFails(remove(ref(rt(ada), "reports/rep1"))));
await t("somebody else cannot touch it either",
  () => assertFails(set(ref(rt(mallory), "reports/rep1/status"), "dismissed")));
await t("an administrator reads every report",
  () => assertSucceeds(get(ref(rt(boss), "reports"))));
await t("and moves one to reviewing",
  () => assertSucceeds(update(ref(rt(boss)), { "reports/rep1/status": "reviewing",
        "reports/rep1/statusAt": serverTimestamp(), "reports/rep1/statusBy": "boss" })));
await t("but only to a known status",
  () => assertFails(set(ref(rt(boss), "reports/rep1/status"), "archived-forever")));
await t("even an administrator cannot rewrite what was reported",
  () => assertFails(set(ref(rt(boss), "reports/rep1/message"), "edited")));
await t("an administrator may delete a report",
  () => assertSucceeds(remove(ref(rt(boss), "reports/rep4"))));

console.log("\n— hall bookings —");
const Q = 900000, HOUR = 3600000;
const t0 = Math.ceil((Date.now() + DAY) / Q) * Q;          /* tomorrow, on a quarter hour */
const booking = (id, uid, o) => Object.assign({ bookingId: id, userId: uid, name: "Dr Ada", institution: "Uni of Melbourne",
  position: "Research Fellow", topic: "Quantum ML for particle physics", abstract: "A short introduction.",
  hallId: "seminar-hall-a", hallType: "seminar", eventType: "seminar", date: "2026-10-05", startTime: "14:00", endTime: "15:00",
  tz: "Australia/Melbourne", startAt: t0, endAt: t0 + HOUR, status: "pending", createdAt: serverTimestamp() }, o);
const ask = (ctx, id, uid, o) => update(ref(rt(ctx)), {
  [`hallBookings/${id}`]: booking(id, uid, o), [`bookingsByUser/${uid}/${id}`]: true, [`bookingThrottle/${uid}`]: serverTimestamp() });
const slots = (hall, id, from, to) => { const o = {}; for (let x = from; x < to; x += Q) o[`hallSlots/${hall}/${x}`] = { b: id, t: x }; return o; };
const notice = (id, b, o) => Object.assign({ noticeId: "b-" + id, bookingId: id, eventType: b.eventType, name: b.name,
  institution: b.institution, position: b.position, topic: b.topic, abstract: b.abstract, hallId: b.hallId,
  hallName: "Seminar Hall Alpha", date: b.date, startTime: b.startTime, endTime: b.endTime, tz: b.tz,
  startAt: b.startAt, endAt: b.endAt, status: "active", createdAt: serverTimestamp() }, o);
const approveB = (id, b, extra = {}) => Object.assign({
  [`hallBookings/${id}/status`]: "approved", [`hallBookings/${id}/approvedAt`]: serverTimestamp(),
  [`hallBookings/${id}/decidedAt`]: serverTimestamp(), [`hallBookings/${id}/decidedBy`]: "boss",
  [`hallBookings/${id}/noticeId`]: "b-" + id, [`villageNotices/b-${id}`]: notice(id, b) },
  slots(b.hallId, id, b.startAt, b.endAt), extra);

await t("a resident asks to book a hall",
  () => assertSucceeds(ask(ada, "bk1", "ada")));
await t("a second request inside thirty seconds is refused",
  () => assertFails(ask(ada, "bk2", "ada", { startAt: t0 + 4 * HOUR, endAt: t0 + 5 * HOUR })));
await t("another resident may ask for an overlapping time — requests do not conflict",
  () => assertSucceeds(ask(mallory, "bk3", "mal", { name: "Mal", startAt: t0 + HOUR / 2, endAt: t0 + HOUR * 1.5 })));
await t("a request cannot be in somebody else's name",
  () => assertFails(ask(boss, "bk4", "ada")));
await env.withSecurityRulesDisabled(async (c) => { await remove(ref(c.database(), "bookingThrottle")); });
await t("...nor already approved",
  () => assertFails(ask(mallory, "bk4", "mal", { status: "approved" })));
await t("...nor in the past",
  () => assertFails(ask(mallory, "bk4", "mal", { startAt: t0 - 2 * DAY, endAt: t0 - 2 * DAY + HOUR })));
await t("...nor off the quarter hour",
  () => assertFails(ask(mallory, "bk4", "mal", { startAt: t0 + 60000, endAt: t0 + HOUR })));
await t("...nor longer than twelve hours",
  () => assertFails(ask(mallory, "bk4", "mal", { endAt: t0 + 13 * HOUR })));
await t("...nor ending before it starts",
  () => assertFails(ask(mallory, "bk4", "mal", { endAt: t0 - Q })));
await t("...nor for a hall that is not bookable",
  () => assertFails(ask(mallory, "bk4", "mal", { hallId: "cafe", hallType: "seminar" })));
await t("...nor calling a poster hall a seminar hall",
  () => assertFails(ask(mallory, "bk4", "mal", { hallId: "poster-hall" })));
await t("...nor as a poster competition (those have their own request)",
  () => assertFails(ask(mallory, "bk4", "mal", { eventType: "poster_competition" })));
await t("a resident reads their own request",
  () => assertSucceeds(get(ref(rt(ada), "hallBookings/bk1"))));
await t("...but not somebody else's",
  () => assertFails(get(ref(rt(mallory), "hallBookings/bk1"))));
await t("...nor the list of all of them",
  () => assertFails(get(ref(rt(ada), "hallBookings"))));
await t("...nor anybody else's index",
  () => assertFails(get(ref(rt(mallory), "bookingsByUser/ada"))));
await t("the requester cannot approve their own booking",
  () => assertFails(update(ref(rt(ada)), approveB("bk1", booking("bk1", "ada")))));
await t("...nor move it to another time",
  () => assertFails(set(ref(rt(ada), "hallBookings/bk1/startAt"), t0 + DAY)));
await t("nobody but an administrator may put up a notice",
  () => assertFails(set(ref(rt(ada), "villageNotices/b-bk1"), notice("bk1", booking("bk1", "ada")))));
await t("...or take a slot",
  () => assertFails(update(ref(rt(ada)), slots("seminar-hall-a", "bk1", t0, t0 + HOUR))));
await t("an administrator cannot approve without taking the slots",
  () => assertFails(update(ref(rt(boss)), Object.fromEntries(Object.entries(approveB("bk1", booking("bk1", "ada")))
        .filter(([k]) => !k.startsWith("hallSlots"))))));
await t("...nor without the notice",
  () => assertFails(update(ref(rt(boss)), Object.fromEntries(Object.entries(approveB("bk1", booking("bk1", "ada")))
        .filter(([k]) => !k.startsWith("villageNotices"))))));
await t("...nor with a notice at a different time",
  () => assertFails(update(ref(rt(boss)), Object.assign(approveB("bk1", booking("bk1", "ada")),
        { "villageNotices/b-bk1": notice("bk1", booking("bk1", "ada"), { startAt: t0 + Q }) }))));
await t("an administrator approves: booking, slots and notice in one write",
  () => assertSucceeds(update(ref(rt(boss)), approveB("bk1", booking("bk1", "ada")))));
await t("an overlapping booking can no longer be approved",
  () => assertFails(update(ref(rt(boss)), approveB("bk3", booking("bk3", "mal", { name: "Mal", startAt: t0 + HOUR / 2, endAt: t0 + HOUR * 1.5 })))));
await t("...even by leaving the shared slot out",
  () => assertFails(update(ref(rt(boss)), Object.fromEntries(Object.entries(approveB("bk3",
        booking("bk3", "mal", { name: "Mal", startAt: t0 + HOUR / 2, endAt: t0 + HOUR * 1.5 })))
        .filter(([k]) => k !== `hallSlots/seminar-hall-a/${t0 + HOUR / 2}`)))));
await t("everybody signed in reads the notice board",
  () => assertSucceeds(get(ref(rt(mallory), "villageNotices"))));
await t("...and which slots are taken",
  () => assertSucceeds(get(ref(rt(mallory), "hallSlots/seminar-hall-a"))));
await t("the organiser cannot change an approved booking's hall or time",
  () => assertFails(set(ref(rt(ada), "hallBookings/bk1/hallId"), "seminar-hall-b")));
await t("...nor withdraw it once approved",
  () => assertFails(remove(ref(rt(ada), "hallBookings/bk1"))));
await t("nobody may stretch an event's time on the board",
  () => assertFails(set(ref(rt(ada), "villageNotices/b-bk1/endAt"), t0 + 9 * HOUR)));
await t("...nor archive it before it has happened",
  () => assertFails(set(ref(rt(mallory), "villageNotices/b-bk1/status"), "archived")));
await t("even an administrator cannot move a notice's time",
  () => assertFails(set(ref(rt(boss), "villageNotices/b-bk1/startAt"), t0 + DAY)));
await t("an administrator cancels: booking, notice, and the slots freed",
  () => assertSucceeds(update(ref(rt(boss)), Object.assign({
        "hallBookings/bk1/status": "cancelled", "hallBookings/bk1/cancelledAt": serverTimestamp(),
        "villageNotices/b-bk1/status": "cancelled" },
        Object.fromEntries(Object.keys(slots("seminar-hall-a", "bk1", t0, t0 + HOUR)).map((k) => [k, null]))))));
await t("and the overlapping booking can now be approved",
  () => assertSucceeds(update(ref(rt(boss)), approveB("bk3", booking("bk3", "mal", { name: "Mal", startAt: t0 + HOUR / 2, endAt: t0 + HOUR * 1.5 })))));
await t("a rejected booking creates nothing",
  async () => {
    await env.withSecurityRulesDisabled(async (c) => { await remove(ref(c.database(), "bookingThrottle")); });
    await assertSucceeds(ask(ada, "bk5", "ada", { startAt: t0 + 3 * HOUR, endAt: t0 + 4 * HOUR }));
    await assertSucceeds(update(ref(rt(boss)), { "hallBookings/bk5/status": "rejected",
      "hallBookings/bk5/decidedAt": serverTimestamp(), "hallBookings/bk5/decidedBy": "boss" }));
    if ((await get(ref(rt(boss), "villageNotices/b-bk5"))).exists()) throw new Error("notice exists");
  });
await t("a requester may withdraw a pending request",
  async () => {
    await env.withSecurityRulesDisabled(async (c) => { await remove(ref(c.database(), "bookingThrottle")); });
    await assertSucceeds(ask(ada, "bk6", "ada", { startAt: t0 + 6 * HOUR, endAt: t0 + 7 * HOUR }));
    await assertSucceeds(update(ref(rt(ada)), { "hallBookings/bk6": null, "bookingsByUser/ada/bk6": null }));
  });

console.log("\n— the notice board after the event —");
await env.withSecurityRulesDisabled(async (c) => {
  await set(ref(c.database(), "villageNotices/b-old"), { noticeId: "b-old", bookingId: "old", eventType: "workshop",
    name: "Dr Old", topic: "Yesterday", hallId: "seminar-hall-b", startAt: Date.now() - DAY, endAt: Date.now() - DAY + HOUR,
    status: "active", createdAt: Date.now() - 2 * DAY });
});
await t("anybody may archive an event that is over",
  () => assertSucceeds(set(ref(rt(mallory), "villageNotices/b-old/status"), "archived")));
await t("...but not rewrite it",
  () => assertFails(set(ref(rt(mallory), "villageNotices/b-old/topic"), "Something else")));
await t("...nor delete it",
  () => assertFails(remove(ref(rt(mallory), "villageNotices/b-old"))));

console.log("\n— a poster competition on the notice board —");
await t("a competition request carries the organiser's details",
  () => assertSucceeds(set(ref(rt(ada), "posterCompetitionRequests/c1"), request({ hallId: "poster-hall-2", title: "Grand poster prize",
        fullName: "Dr Ada Lovelace", institution: "Uni of Melbourne", position: "Research Fellow", description: "All welcome" }))));
await t("approving it puts it on the notice board in the same write",
  () => assertSucceeds(update(ref(rt(boss)), Object.assign(approval("c1", "poster-hall-2", "boss", "Grand poster prize"), {
        "villageNotices/c-c1": { noticeId: "c-c1", competitionId: "c1", eventType: "poster_competition", name: "Dr Ada Lovelace",
          institution: "Uni of Melbourne", position: "Research Fellow", topic: "Grand poster prize", abstract: "All welcome",
          hallId: "poster-hall-2", hallName: "The Grand Poster Hall", startAt: serverTimestamp(), status: "active",
          createdAt: serverTimestamp() } }))));
const cAt = (await get(ref(rt(boss), "posterCompetitions/c1/approvedAt"))).val();
await t("its end is exactly 24 hours after approval",
  () => assertFails(set(ref(rt(mallory), "villageNotices/c-c1/endAt"), cAt + 2 * DAY)));
await t("...which anybody may fill in",
  () => assertSucceeds(set(ref(rt(mallory), "villageNotices/c-c1/endAt"), cAt + DAY)));

console.log("\n— ending a competition early —");
await t("nobody but the organiser or an administrator may end it",
  () => assertFails(update(ref(rt(mallory)), { "posterCompetitions/r1/status": "expired",
        "posterCompetitions/r1/endedAt": serverTimestamp(), "posterCompetitions/r1/endedBy": "mal" })));
await t("...nor let its hall go",
  () => assertFails(remove(ref(rt(mallory), "posterHallCompetition/poster-hall"))));
await t("...and an ended competition's posters are not sweepable while it runs",
  () => assertFails(remove(ref(rt(mallory), "posters/poster-hall-n1/ada"))));
await t("the organiser ends it: stopped, and the hall let go, in one write",
  () => assertSucceeds(update(ref(rt(ada)), { "posterCompetitions/r1/status": "expired",
        "posterCompetitions/r1/endedAt": serverTimestamp(), "posterCompetitions/r1/endedBy": "ada",
        "posterHallCompetition/poster-hall": null })));
await t("it cannot be restarted",
  () => assertFails(set(ref(rt(ada), "posterCompetitions/r1/status"), "active")));
await t("anybody may now sweep its posters",
  () => assertSucceeds(remove(ref(rt(mallory), "posters/poster-hall-n1/ada"))));
await t("...and its stands",
  () => assertSucceeds(remove(ref(rt(mallory), "pins/posters/poster-hall-n1"))));
await t("nobody may pin under it any more",
  async () => {
    await assertFails(set(ref(rt(ada), "pins/posters/poster-hall-n2"), cclaim("ada", "Ada")));
  });
await t("the organiser ends a competition that is on the notice board, archiving its notice",
  () => assertSucceeds(update(ref(rt(ada)), { "posterCompetitions/c1/status": "expired",
        "posterCompetitions/c1/endedAt": serverTimestamp(), "posterCompetitions/c1/endedBy": "ada",
        "posterHallCompetition/poster-hall-2": null, "villageNotices/c-c1/status": "archived" })));
await t("a resident may not delete a notice",
  () => assertFails(remove(ref(rt(mallory), "villageNotices/c-c1"))));
await t("an administrator may delete any notice",
  () => assertSucceeds(remove(ref(rt(boss), "villageNotices/c-c1"))));
await t("...and wipe the board, notice by notice (as the panel does)",
  async () => {
    const all = (await get(ref(rt(boss), "villageNotices"))).val() || {};
    for (const k of Object.keys(all)) await assertSucceeds(remove(ref(rt(boss), "villageNotices/" + k)));
    if ((await get(ref(rt(boss), "villageNotices"))).exists()) throw new Error("board not empty");
  });

console.log("\n— poster events: registration, numbered stands, capacity —");
{
  const bob = env.authenticatedContext("bob", pw), cat = env.authenticatedContext("cat", pw);
  const dan = env.authenticatedContext("dan", pw);
  const E = "ev1", soon = Date.now() + 3600000;
  const ev = (o) => Object.assign({ title: "Winter poster session", description: "", startAt: soon, endAt: soon + 7200000,
    cap1: 2, cap2: 1, status: "open", allowComp: true, needsApproval: false, createdAt: serverTimestamp(), createdBy: "boss" }, o);
  const reg = (uid, hall, num, o) => Object.assign({ uid, name: uid, institution: "Uni", position: "PhD", affiliation: "",
    title: "A poster", abstract: "", mode: "presentation", hallId: hall, num, status: "registered", createdAt: serverTimestamp() }, o);
  const join = (ctx, uid, hall, num, o) => update(ref(rt(ctx)), {
    [`posterRegs/${E}/${uid}`]: reg(uid, hall, num, o), [`posterSlots/${E}/${hall}/${num}`]: uid });

  await t("a resident cannot create a poster event",
    () => assertFails(set(ref(rt(ada), `posterEvents/${E}`), ev())));
  await t("an administrator can",
    () => assertSucceeds(set(ref(rt(boss), `posterEvents/${E}`), ev())));
  await t("but not with more stands than a hall has",
    () => assertFails(set(ref(rt(boss), `posterEvents/ev-big`), ev({ cap1: 13 }))));
  await t("a resident registers and takes Poster 1 in Hall 1",
    () => assertSucceeds(join(ada, "ada", "poster-hall", 1)));
  await t("somebody else cannot take the same number",
    () => assertFails(join(bob, "bob", "poster-hall", 1)));
  await t("they take the next one",
    () => assertSucceeds(join(bob, "bob", "poster-hall", 2)));
  await t("a number past the hall's capacity is refused",
    () => assertFails(join(cat, "cat", "poster-hall", 3)));
  await t("a slot alone, without a registration naming it, is refused",
    () => assertFails(set(ref(rt(cat), `posterSlots/${E}/poster-hall-2/1`), "cat")));
  await t("a registration without its slot is refused",
    () => assertFails(set(ref(rt(cat), `posterRegs/${E}/cat`), reg("cat", "poster-hall-2", 1))));
  await t("a registration pointing at somebody else's slot is refused",
    () => assertFails(set(ref(rt(cat), `posterRegs/${E}/cat`), reg("cat", "poster-hall", 1))));
  await t("nobody registers in somebody else's name",
    () => assertFails(join(cat, "dan", "poster-hall-2", 1)));
  await t("a resident may not approve themselves",
    () => assertFails(join(cat, "cat", "poster-hall-2", 1, { status: "approved" })));
  await t("the other hall is numbered independently: Hall 2, Poster 1",
    () => assertSucceeds(join(cat, "cat", "poster-hall-2", 1, { mode: "competition" })));
  await t("with every stand taken, nobody else gets in",
    () => assertFails(join(dan, "dan", "poster-hall-2", 2)));
  await t("registering twice cannot take a second stand",
    () => assertFails(update(ref(rt(ada)), { [`posterSlots/${E}/poster-hall-2/2`]: "ada" })));
  await t("a participant edits their own wording",
    () => assertSucceeds(update(ref(rt(ada), `posterRegs/${E}/ada`), { title: "A better title", affiliation: "Theory group" })));
  await t("but not their number",
    () => assertFails(update(ref(rt(ada)), { [`posterRegs/${E}/ada/num`]: 2 })));
  await t("nor somebody else's registration",
    () => assertFails(update(ref(rt(ada), `posterRegs/${E}/bob`), { title: "Hijacked" })));
  await t("nor somebody else's slot",
    () => assertFails(remove(ref(rt(ada), `posterSlots/${E}/poster-hall/2`))));
  await t("cancelling without freeing the slot is refused",
    () => assertFails(remove(ref(rt(bob), `posterRegs/${E}/bob`))));
  await t("cancelling frees the slot in the same write",
    () => assertSucceeds(update(ref(rt(bob)), { [`posterRegs/${E}/bob`]: null, [`posterSlots/${E}/poster-hall/2`]: null })));
  await t("and the freed number can be taken again, nobody else's moving",
    () => assertSucceeds(join(dan, "dan", "poster-hall", 2)));
  await t("a participant pins their poster to their own stand",
    () => assertSucceeds(set(ref(rt(ada), `posterRegPosters/${E}/ada`), { s: "data:image/jpeg;base64,AAAA", t: "x", at: serverTimestamp() })));
  await t("but not to somebody else's",
    () => assertFails(set(ref(rt(ada), `posterRegPosters/${E}/dan`), { s: "data:image/jpeg;base64,AAAA", at: serverTimestamp() })));
  await t("nor take somebody else's down",
    () => assertFails(remove(ref(rt(dan), `posterRegPosters/${E}/ada`))));
  await t("an administrator can take a poster down",
    () => assertSucceeds(remove(ref(rt(boss), `posterRegPosters/${E}/ada`))));
  await t("an administrator approves a registration",
    () => assertSucceeds(update(ref(rt(boss), `posterRegs/${E}/ada`), { status: "approved" })));
  await t("an administrator moves a participant between halls",
    () => assertSucceeds(update(ref(rt(boss)), { [`posterSlots/${E}/poster-hall/2`]: null,
      [`posterSlots/${E}/poster-hall-2/1`]: null, [`posterRegs/${E}/cat`]: null })
      .then(() => update(ref(rt(boss)), { [`posterSlots/${E}/poster-hall/2`]: null, [`posterSlots/${E}/poster-hall-2/1`]: "dan",
        [`posterRegs/${E}/dan/hallId`]: "poster-hall-2", [`posterRegs/${E}/dan/num`]: 1 }))));
  await t("closing registration stops new registrations",
    () => assertSucceeds(update(ref(rt(boss), `posterEvents/${E}`), { status: "closed" }))
      .then(() => assertFails(join(bob, "bob", "poster-hall", 2))));
  await t("reopened, but past the deadline, is still closed",
    () => assertSucceeds(update(ref(rt(boss), `posterEvents/${E}`), { status: "open", deadline: Date.now() - 1000 }))
      .then(() => assertFails(join(bob, "bob", "poster-hall", 2))));
  await t("a blocked resident cannot read registrations, nor register",
    () => assertSucceeds(set(ref(rt(boss), "blocked/mal"), { at: serverTimestamp(), by: "boss", why: "x" }))
      .then(() => assertFails(get(ref(rt(mallory), `posterRegs/${E}`))))
      .then(() => assertFails(join(mallory, "mal", "poster-hall-2", 2)))
      .then(() => assertSucceeds(remove(ref(rt(boss), "blocked/mal")))));
  await t("a like is one per resident: their own uid, nobody else's",
    () => assertSucceeds(set(ref(rt(bob), `posterLikes/r-${E}-ada/bob`), true))
      .then(() => assertFails(set(ref(rt(bob), `posterLikes/r-${E}-ada/cat`), true))));
  await t("and can be taken back",
    () => assertSucceeds(remove(ref(rt(bob), `posterLikes/r-${E}-ada/bob`))));
  await t("an administrator deletes the whole event",
    () => assertSucceeds(update(ref(rt(boss)), { [`posterEvents/${E}`]: null, [`posterRegs/${E}`]: null,
      [`posterSlots/${E}`]: null, [`posterRegPosters/${E}`]: null })));
  await t("a resident cannot",
    () => assertFails(update(ref(rt(ada)), { [`posterRegs/${E}`]: null })));
}

console.log("\n— requests to organise a poster event —");
{
  const eve = env.authenticatedContext("eve", pw), fay = env.authenticatedContext("fay", pw);
  const soon = Date.now() + 86400000;
  const rq = (uid, o) => Object.assign({ userId: uid, name: "Eve", institution: "Uni", email: "eve@example.com", position: "Postdoc",
    title: "Autumn posters", topic: "Open systems", description: "A session.", startAt: soon, endAt: soon + 7200000,
    venue: "poster-hall", responsibilities: "Chair it.", comp: true, status: "pending", createdAt: serverTimestamp() }, o);
  const send = (ctx, uid, id, o, pdf) => update(ref(rt(ctx)), Object.assign({ [`posterEventRequests/${id}`]: rq(uid, o),
    [`posterEventReqThrottle/${uid}`]: serverTimestamp() }, pdf ? { [`posterEventRequestPdfs/${id}`]: { d: "data:application/pdf;base64,JVBERi0=", at: serverTimestamp() } } : {}));

  await t("a resident sends a request, with its PDF, in one write",
    () => assertSucceeds(send(eve, "eve", "q1", {}, true)));
  await t("a second one inside thirty seconds is refused",
    () => assertFails(send(eve, "eve", "q2", {})));
  await t("nobody files one in somebody else's name",
    () => assertFails(send(fay, "eve", "q3", {})));
  await t("a request cannot arrive already approved",
    () => assertFails(send(fay, "fay", "q4", { status: "approved" })));
  await t("an email address is required",
    () => assertFails(send(fay, "fay", "q5", { email: "not-an-address" })));
  await t("an event in the past cannot be requested",
    () => assertFails(send(fay, "fay", "q6", { startAt: Date.now() - 1000, endAt: Date.now() + 1000 })));
  await t("the requester reads their own requests (by query)",
    () => assertSucceeds(get(query(ref(rt(eve), "posterEventRequests"), orderByChild("userId"), equalTo("eve")))));
  await t("and their PDF",
    () => assertSucceeds(get(ref(rt(eve), "posterEventRequestPdfs/q1"))));
  await t("another resident cannot list requests",
    () => assertFails(get(ref(rt(fay), "posterEventRequests"))));
  await t("nor read this one, nor its PDF",
    () => assertFails(get(ref(rt(fay), "posterEventRequests/q1"))).then(() => assertFails(get(ref(rt(fay), "posterEventRequestPdfs/q1")))));
  await t("nor query for somebody else's",
    () => assertFails(get(query(ref(rt(fay), "posterEventRequests"), orderByChild("userId"), equalTo("eve")))));
  await t("a PDF cannot be attached to somebody else's request",
    () => assertFails(set(ref(rt(fay), "posterEventRequestPdfs/q1"), { d: "data:application/pdf;base64,AA==", at: serverTimestamp() })));
  await t("the requester cannot approve their own request",
    () => assertFails(update(ref(rt(eve), "posterEventRequests/q1"), { status: "approved" })));
  await t("nor edit it once sent",
    () => assertFails(update(ref(rt(eve), "posterEventRequests/q1"), { title: "Changed" })));
  await t("an administrator reads every request",
    () => assertSucceeds(get(ref(rt(boss), "posterEventRequests"))));
  await t("approving without creating the event is refused",
    () => assertFails(update(ref(rt(boss), "posterEventRequests/q1"), { status: "approved", eventId: "nope" })));
  await t("approving publishes the event and marks the request in one write",
    () => assertSucceeds(update(ref(rt(boss)), {
      "posterEvents/evq1": { title: "Autumn posters", startAt: soon, endAt: soon + 7200000, cap1: 12, cap2: 0, status: "open",
        allowComp: true, needsApproval: false, createdAt: serverTimestamp(), createdBy: "boss", requestId: "q1", organiserId: "eve",
        orgName: "Eve", orgInst: "Uni", orgPos: "Postdoc", topic: "Open systems", venue: "Room 3", abstract: "" },
      "posterEventRequests/q1/status": "approved", "posterEventRequests/q1/eventId": "evq1",
      "posterEventRequests/q1/decidedAt": serverTimestamp(), "posterEventRequests/q1/decidedBy": "boss" })));
  await t("an approved request cannot be withdrawn by its requester",
    () => assertFails(update(ref(rt(eve)), { "posterEventRequests/q1": null, "posterEventRequestPdfs/q1": null })));
  await t("a pending one can, PDF and all",
    () => assertSucceeds(send(fay, "fay", "q7", {}, true))
      .then(() => assertSucceeds(update(ref(rt(fay)), { "posterEventRequests/q7": null, "posterEventRequestPdfs/q7": null }))));
  await t("an administrator rejects with a note",
    () => assertSucceeds(env.withSecurityRulesDisabled((c) => set(ref(c.database(), "posterEventReqThrottle/fay"), 0)))
      .then(() => assertSucceeds(send(fay, "fay", "q8", {})))
      .then(() => assertSucceeds(update(ref(rt(boss), "posterEventRequests/q8"), { status: "rejected", note: "Clashes with another event",
        decidedAt: serverTimestamp(), decidedBy: "boss" }))));
  await t("and deletes a request and its PDF",
    () => assertSucceeds(update(ref(rt(boss)), { "posterEventRequests/q1": null, "posterEventRequestPdfs/q1": null })));
}

console.log("\n— Firestore —");
await env.withSecurityRulesDisabled(async (adminCtx) => {
  await setDoc(doc(adminCtx.firestore(), "blocked/mal"), { at: Date.now(), by: "boss", why: "spam" });
  await setDoc(doc(adminCtx.firestore(), "residents/mal"), { name: "Mal" });
  await setDoc(doc(adminCtx.firestore(), "residents/ada"), { name: "Ada" });
});
await t("a resident reads profiles",
  () => assertSucceeds(getDoc(doc(fsdb(ada), "residents/ada"))));
await t("a blocked resident reads nothing",
  () => assertFails(getDoc(doc(fsdb(mallory), "residents/ada"))));
await t("a blocked resident writes nothing",
  () => assertFails(setDoc(doc(fsdb(mallory), "residents/mal"), { name: "Mal" })));
await t("a blocked resident may still read why",
  () => assertSucceeds(getDoc(doc(fsdb(mallory), "blocked/mal"))));
await t("nobody may write the admins collection",
  () => assertFails(setDoc(doc(fsdb(boss), "admins/mal"), { at: 1 })));
await t("a resident may not delete somebody else's profile",
  () => assertFails(deleteDoc(doc(fsdb(ada), "residents/mal"))));
await t("an administrator may",
  () => assertSucceeds(deleteDoc(doc(fsdb(boss), "residents/mal"))));
await t("an administrator may block in Firestore too",
  () => assertSucceeds(setDoc(doc(fsdb(boss), "blocked/ada"), { at: Date.now(), by: "boss", why: "x" })));
await t("but not sign it as somebody else",
  () => assertFails(setDoc(doc(fsdb(boss), "blocked/ada"), { at: Date.now(), by: "ada" })));

await env.cleanup();
console.log("\n" + passes + " passed, " + failures + " failed\n");
process.exit(failures ? 1 : 0);
