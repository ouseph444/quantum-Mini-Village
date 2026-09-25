/* Quantum Village — the privileged half of administration.
 *
 * Why this exists
 * ---------------
 * Blocking somebody is done in the database, and the security rules enforce
 * it completely: a blocked uid is refused every read and every write in both
 * database.rules.json and firestore.rules. That part needs no server at all.
 *
 * What it cannot do is touch the Firebase Authentication account itself.
 * Disabling a login so that it can no longer even mint a token, and deleting
 * one outright, are Admin SDK operations, and the Admin SDK bypasses every
 * security rule there is. A service-account credential must therefore never
 * appear in a browser — not in a config file, not behind a build flag, not
 * "just for the admin build". It lives here, on Google's servers, where the
 * only thing a client can do is ask.
 *
 * Who may ask
 * -----------
 * Every callable below re-checks the caller against admins/<uid> in the
 * Realtime Database *on the server*, with the Admin SDK, before doing
 * anything. The page's own idea of who is an administrator is not consulted
 * and could not be trusted if it were. admins/ is unwritable from any
 * browser (".write": false), so the only way in is the Firebase console or a
 * server that already holds a service account.
 *
 * Deploying
 * ---------
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * These are 1st-gen callables in the default region (us-central1). If you
 * deploy to another region, set window.QV_FUNCTIONS_REGION in
 * js/firebase-config.js to match.
 *
 * Not deploying is a supported choice. Without these, Block still bars
 * somebody from the whole village and Delete still erases their profile,
 * their score and their presence and bars them for good — the login row in
 * the Authentication tab is all that survives, and you can remove that by
 * hand from the console.
 */
"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.database();
const fs = admin.firestore();

/* The one question that matters, asked of the database rather than of the
   caller. An expired or forged claim cannot get past this, because the uid
   comes out of a token Firebase verified before we were invoked. */
async function requireAdmin(context) {
  const uid = context.auth && context.auth.uid;
  if (!uid) {
    throw new functions.https.HttpsError("unauthenticated", "Sign in first.");
  }
  const snap = await db.ref(`admins/${uid}`).get();
  if (snap.val() !== true) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "This account is not an administrator."
    );
  }
  return uid;
}

function targetUid(data) {
  const uid = data && typeof data.uid === "string" ? data.uid.trim() : "";
  if (!uid || uid.length > 128) {
    throw new functions.https.HttpsError("invalid-argument", "No user given.");
  }
  return uid;
}

/* Block: write the record the rules read, and disable the login so the
   account cannot even obtain a token. Both, because either alone leaves a
   gap — the record without the disable lets them keep a live session's
   token until it expires, and the disable without the record is invisible
   to the rules. */
exports.blockUser = functions.https.onCall(async (data, context) => {
  const by = await requireAdmin(context);
  const uid = targetUid(data);
  if (uid === by) {
    throw new functions.https.HttpsError("failed-precondition", "You cannot block yourself.");
  }
  const why = String((data && data.why) || "").slice(0, 140);
  const record = { at: Date.now(), by, why };

  await db.ref(`blocked/${uid}`).set(record);
  await fs.doc(`blocked/${uid}`).set(record);
  /* Existing sessions keep a valid ID token for up to an hour. Revoking the
     refresh token stops them renewing it, and the database rules refuse them
     in the meantime, so the gap is closed from both ends. */
  await admin.auth().updateUser(uid, { disabled: true });
  await admin.auth().revokeRefreshTokens(uid);
  await clearPresence(uid);

  return { ok: true, disabled: true };
});

exports.unblockUser = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const uid = targetUid(data);

  await db.ref(`blocked/${uid}`).remove();
  await fs.doc(`blocked/${uid}`).delete().catch(() => {});
  await admin.auth().updateUser(uid, { disabled: false }).catch(() => {});

  return { ok: true };
});

/* Delete: the account and everything the village holds about it. There is no
   undo, which is why it is a separate call from blocking. */
exports.deleteUser = functions.https.onCall(async (data, context) => {
  const by = await requireAdmin(context);
  const uid = targetUid(data);
  if (uid === by) {
    throw new functions.https.HttpsError("failed-precondition", "You cannot delete yourself.");
  }

  await admin.auth().deleteUser(uid).catch((e) => {
    /* Already gone is a success, not a failure. */
    if (e.code !== "auth/user-not-found") throw e;
  });
  await clearPresence(uid);
  await db.ref(`blocked/${uid}`).remove().catch(() => {});
  await fs.doc(`blocked/${uid}`).delete().catch(() => {});
  await fs.doc(`residents/${uid}`).delete().catch(() => {});
  await fs.doc(`scores/${uid}`).delete().catch(() => {});

  return { ok: true };
});

/* Everything filed under one uid in the live tree. Chalk and posters are
   filed under the board instead and carry disconnect hooks, so they leave
   with the tab. */
async function clearPresence(uid) {
  await Promise.all(
    ["presence", "voiceLive", "voiceSignal", "activities"].map((top) =>
      db.ref(`${top}/${uid}`).remove().catch(() => {})
    )
  );
}

/* Poster competitions and the Notice Board: the scheduled half of expiry.
 *
 * A competition ends at approvedAt + 24 h by the database's clock, and the
 * security rules enforce that on their own — after it, nothing more may be
 * pinned under the competition and every browser hides its posters. What
 * the rules cannot do is delete anything by themselves, so without this the
 * last posters of a competition wait for the next visitor to a poster hall
 * to sweep them (which the page does). With it, they go within a few
 * minutes whether or not anybody visits.
 *
 * Scheduled functions need the Blaze plan (Cloud Scheduler). Not deploying
 * this is a supported choice: expiry still happens, it is just tidied up by
 * visitors instead. */
const COMPETITION_MS = 24 * 3600000;

exports.expirePosterCompetitions = functions.pubsub
  .schedule("every 5 minutes")
  .onRun(async () => {
    const now = Date.now();
    const snap = await db.ref("posterCompetitions").orderByChild("status").equalTo("active").get();
    const over = [];
    snap.forEach((c) => {
      const v = c.val() || {};
      if (typeof v.approvedAt === "number" && v.approvedAt + COMPETITION_MS <= now) {
        over.push({ id: c.key, hallId: v.hallId, expiresAt: v.approvedAt + COMPETITION_MS });
      }
    });

    /* Posters and claims are swept by their own expiresAt rather than by
       competition, so a competition that was marked expired by a visitor
       before its posters were cleared is still cleaned up here. */
    const updates = {};
    const pins = (await db.ref("pins/posters").get()).val() || {};
    Object.keys(pins).forEach((frame) => {
      const p = pins[frame];
      if (p && typeof p.expiresAt === "number" && p.expiresAt <= now) updates[`pins/posters/${frame}`] = null;
    });
    /* posters/ holds whole pictures, so it is read in full only in the run
       that finds a competition over; otherwise just the stands whose
       competition claim has lapsed are looked at. */
    const posters = {};
    if (over.length) {
      Object.assign(posters, (await db.ref("posters").get()).val() || {});
    } else {
      for (const frame of Object.keys(pins)) {
        if (updates[`pins/posters/${frame}`] === null) {
          posters[frame] = (await db.ref(`posters/${frame}`).get()).val() || {};
        }
      }
    }
    Object.keys(posters).forEach((frame) => {
      Object.keys(posters[frame] || {}).forEach((uid) => {
        const p = posters[frame][uid];
        if (p && typeof p.expiresAt === "number" && p.expiresAt <= now) {
          updates[`posters/${frame}/${uid}`] = null;
        }
      });
    });

    for (const c of over) {
      updates[`posterCompetitions/${c.id}/status`] = "expired";
      updates[`posterCompetitions/${c.id}/expiresAt`] = c.expiresAt;
      const lock = (await db.ref(`posterHallCompetition/${c.hallId}`).get()).val();
      if (lock && lock.id === c.id) updates[`posterHallCompetition/${c.hallId}`] = null;
    }

    /* Events on the Village Notice Board that have ended move from
       Upcoming to Past. Browsers do this too; this catches the ones
       nobody was around to see end. */
    const live = await db.ref("villageNotices").orderByChild("status").equalTo("active").get();
    live.forEach((n) => {
      const v = n.val() || {};
      const end = typeof v.endAt === "number" ? v.endAt
        : (v.competitionId && typeof v.startAt === "number" ? v.startAt + COMPETITION_MS : null);
      if (end != null && end <= now) updates[`villageNotices/${n.key}/status`] = "archived";
    });

    if (Object.keys(updates).length) await db.ref().update(updates);
    return null;
  });
