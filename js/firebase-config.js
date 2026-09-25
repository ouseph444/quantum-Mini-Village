/* Quantum Village — Firebase web config.
 *
 * These values are public by design. Every browser that opens the village
 * downloads them, and they appear in any network tab. They are not secrets;
 * firestore.rules and database.rules.json are what protect the data.
 * A service-account key is a different thing entirely and never goes here.
 *
 * From: Firebase console → Project settings → General → Your apps → Web.
 * Project: quantum-village-1d2d5
 */
window.QV_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCaw9TaE21sSQ4Wgx4I23uOsBMyY91Dmqw",
  authDomain: "quantum-village-1d2d5.firebaseapp.com",
  projectId: "quantum-village-1d2d5",
  storageBucket: "quantum-village-1d2d5.firebasestorage.app",
  messagingSenderId: "583048602214",
  appId: "1:583048602214:web:366fb8347b86dd552a03a7",

  /* Realtime Database — presence, chat and seat claims live here, because
     they change several times a second. asia-southeast1 (Singapore), so the
     hostname is .firebasedatabase.app and not the us-central1
     .firebaseio.com form. Remove this line and the village falls back to
     Firestore for the live layer, at one update every two and a half
     seconds instead of four a second. */
  databaseURL: "https://quantum-village-1d2d5-default-rtdb.asia-southeast1.firebasedatabase.app"

  /* measurementId (G-E36VYG7MKG) is left out on purpose: it is only read by
     the Analytics SDK, which the village never loads. */
};

/* Voice relay (optional).
 *
 * Live voice is browser-to-browser, so the two ends have to find a path
 * between them. The STUN servers built into js/voice.js manage that on most
 * home connections. A lot of office and mobile networks hand out addresses
 * that no amount of STUN can get through, and there the connection fails:
 * the speaker's microphone light comes on, the listener sees "is speaking…",
 * and nothing is heard. A TURN server relays the audio for those networks.
 *
 * Fill this in with a TURN service of your own and voice works everywhere.
 * The credentials are downloaded by every visitor, so use a service that
 * issues short-lived ones rather than a permanent password.
 *
 *   window.QV_ICE_SERVERS = [
 *     { urls: ["stun:stun.l.google.com:19302"] },
 *     { urls: ["turn:turn.example.org:3478?transport=udp"],
 *       username: "...", credential: "..." }
 *   ];
 */
