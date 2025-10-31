import { setGlobalOptions } from "firebase-functions/v2/options";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

setGlobalOptions({ region: "asia-south1", timeoutSeconds: 60, memory: "512MiB" });

initializeApp();
const db = getFirestore();
const storage = getStorage();

export const ping = onCall((request) => ({
  ok: true,
  uid: request.auth?.uid ?? null,
  ts: Date.now()
}));

export const hello = onRequest((req, res) => {
  res.status(200).send("OK");
});

export const whoami = onCall((request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required");
  return { uid: request.auth.uid };
});
