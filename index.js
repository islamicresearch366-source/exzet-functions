// FILE: functions/index.js
import * as functions from "firebase-functions";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

initializeApp({ credential: applicationDefault() });

const db = getFirestore();
const storage = getStorage();
const REGION = "asia-south1";

/**
 * Helpers
 */
async function ensureSignedUrl(bucketName, filePath, // returns {exists, url}
  expires = "2099-12-31T23:59:59Z") {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(filePath);
  const [exists] = await file.exists();
  if (!exists) return { exists: false, url: "" };
  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "read",
    expires,
  });
  return { exists: true, url };
}

async function getDoc(docPath) {
  const snap = await db.doc(docPath).get();
  if (!snap.exists) throw new functions.https.HttpsError("not-found", `Doc ${docPath} not found`);
  return { id: snap.id, ref: snap.ref, data: snap.data() };
}

/**
 * Core worker: read doc, verify file exists, (re)generate signed URL if needed, update doc.
 */
async function checkAndFix(docPath) {
  const { ref, data } = await getDoc(docPath);

  const rawBucket = data.rawImageBucket || storage.bucket().name; // fallback to default bucket
  const genPath = data.generatedImagePath || "";
  if (!genPath) {
    return {
      ok: false,
      reason: "generatedImagePath_missing",
      photoStatus: data.photoStatus || "",
      generatedImageUrl: data.generatedImageUrl || "",
      rawImageBucket: rawBucket,
      generatedImagePath: genPath,
    };
  }

  const { exists, url } = await ensureSignedUrl(rawBucket, genPath);
  if (!exists) {
    return {
      ok: false,
      reason: "generated_file_not_found_in_bucket",
      photoStatus: data.photoStatus || "",
      generatedImageUrl: data.generatedImageUrl || "",
      rawImageBucket: rawBucket,
      generatedImagePath: genPath,
    };
  }

  // If URL is empty or not V4 (no Signature), refresh it.
  const needsRefresh =
    !data.generatedImageUrl ||
    typeof data.generatedImageUrl !== "string" ||
    !data.generatedImageUrl.includes("Signature=");

  const newUrl = needsRefresh ? url : data.generatedImageUrl;

  if (needsRefresh) {
    await ref.update({
      generatedImageUrl: newUrl,
      processingCompletedAt: data.processingCompletedAt || Timestamp.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // Optionally normalize photoStatus
  if (data.photoStatus !== "done") {
    await ref.update({
      photoStatus: "done",
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return {
    ok: true,
    reason: "ok",
    photoStatus: "done",
    generatedImageUrl: newUrl,
    rawImageBucket: rawBucket,
    generatedImagePath: genPath,
  };
}

/**
 * Callable: getPhotoStatus
 * data: { docPath: "staging_products/ABC123" }
 */
export const getPhotoStatus = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const docPath = String(data?.docPath || "");
    if (!docPath) throw new functions.https.HttpsError("invalid-argument", "docPath required");
    const { ref, data: d } = await getDoc(docPath);
    const exists = !!(d.generatedImagePath);
    return {
      ok: true,
      docPath,
      existsGeneratedPath: exists,
      photoStatus: d.photoStatus || "",
      generatedImageUrl: d.generatedImageUrl || "",
      rawImageBucket: d.rawImageBucket || storage.bucket().name,
      generatedImagePath: d.generatedImagePath || "",
    };
  });

/**
 * Callable: refreshGeneratedUrl
 * data: { docPath: "staging_products/ABC123" }
 */
export const refreshGeneratedUrl = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const docPath = String(data?.docPath || "");
    if (!docPath) throw new functions.https.HttpsError("invalid-argument", "docPath required");
    return await checkAndFix(docPath);
  });

/**
 * HTTP (onRequest) versions for quick/manual testing without SDK.
 * GET  /getPhotoStatusHttp?docPath=staging_products/ABC123
 * POST /refreshGeneratedUrlHttp  { "docPath": "staging_products/ABC123" }
 */
export const getPhotoStatusHttp = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    try {
      const docPath = (req.method === "GET" ? req.query.docPath : req.body?.docPath) || "";
      if (!docPath) return res.status(400).json({ ok: false, error: "docPath required" });
      const { data: d } = await getDoc(String(docPath));
      return res.json({
        ok: true,
        docPath,
        existsGeneratedPath: !!d.generatedImagePath,
        photoStatus: d.photoStatus || "",
        generatedImageUrl: d.generatedImageUrl || "",
        rawImageBucket: d.rawImageBucket || storage.bucket().name,
        generatedImagePath: d.generatedImagePath || "",
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

export const refreshGeneratedUrlHttp = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    try {
      const docPath = (req.method === "GET" ? req.query.docPath : req.body?.docPath) || "";
      if (!docPath) return res.status(400).json({ ok: false, error: "docPath required" });
      const out = await checkAndFix(String(docPath));
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
