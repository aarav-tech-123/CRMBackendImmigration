import fs from "fs";
import admin from "firebase-admin";

// Credentials come from the environment — never commit the service-account file.
//   FIREBASE_SERVICE_ACCOUNT_PATH = path to the JSON key file
//   (or) FIREBASE_SERVICE_ACCOUNT_JSON = the JSON itself, e.g. for hosts without files
let messagingInstance;
let initTried = false;

export const getMessaging = () => {
  if (initTried) return messagingInstance || null;
  initTried = true;

  try {
    let credentialJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!credentialJson && process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      credentialJson = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
    }
    if (!credentialJson) {
      console.warn("[push] Firebase credentials not configured — push notifications disabled.");
      return null;
    }
    const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credentialJson)) });
    messagingInstance = admin.messaging(app);
  } catch (err) {
    console.error("[push] Firebase init failed — push notifications disabled:", err.message);
    messagingInstance = null;
  }
  return messagingInstance || null;
};
