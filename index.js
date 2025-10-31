// === FILE: index.js ===
// Firebase Functions v2 + Secret Manager + Firestore Trigger + Callable + OpenAI (ESM, Node 20)

import admin from "firebase-admin";
import OpenAI from "openai";
import { onCall } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";

admin.initializeApp();

setGlobalOptions({
  region: "asia-south1",
  timeoutSeconds: 120,
  memoryMiB: 1024,
});

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const db = admin.firestore();
const storage = admin.storage();

const PORTRAIT_SIZE = "1024x1536"; // supported: 1024x1024, 1024x1536, 1536x1024

const buildPrompt = (base) => {
  const t = (base?.title || "").trim();
  const custom = (base?.prompt || "").trim();
  if (custom) return custom;
  if (t) return `Studio-grade product photo of ${t}, seamless white background, soft shadow, no clutter, no watermark`;
  return "Studio-grade product photo of a plain item, seamless white background, soft shadow, no clutter, no watermark";
};

const generateAndStore = async ({ prompt, outPath }) => {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });

  const result = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: PORTRAIT_SIZE,
  });

  const b64 = result.data[0].b64_json;
  const buffer = Buffer.from(b64, "base64");

  const bucket = storage.bucket(); // default bucket (e.g., bestlogin-e1c74.appspot.com)
  const file = bucket.file(outPath);
  await file.save(buffer, { contentType: "image/png" });

  const [url] = await file.getSignedUrl({
    action: "read",
    expires: "2099-09-03",
  });

  return { url };
};

// ------------------------------
// Callable (manual) generator
// ------------------------------
export const generateProductImage = onCall({ secrets: [OPENAI_API_KEY] }, async (req) => {
  const prompt = buildPrompt(req.data || {});
  const outPath = `generated/${Date.now()}.png`;
  const { url } = await generateAndStore({ prompt, outPath });
  return { success: true, url, path: outPath };
});

// -----------------------------------------
// Firestore-triggered auto generator (idempotent, safe)
// Watches: staging_products/{docId}
// Runs only when photoStatus == "queued"
// -----------------------------------------
export const autoGenerateImage = onDocumentWritten(
  {
    document: "staging_products/{docId}",
    secrets: [OPENAI_API_KEY],
  },
  async (event) => {
    const afterSnap = event.data?.after;
    if (!afterSnap) return;

    const docRef = afterSnap.ref;

    // Transaction guard to avoid double-run in concurrent updates
    const proceed = await db.runTransaction(async (t) => {
      const cur = await t.get(docRef);
      const curData = cur.data() || {};
      if (curData.photoStatus !== "queued") return false;

      t.update(docRef, {
        photoStatus: "processing",
        processingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });

    if (!proceed) return;

    try {
      const data = afterSnap.data() || {};
      const prompt = buildPrompt(data);
      const outPath = `generated/${event.params.docId}.png`;

      const { url } = await generateAndStore({ prompt, outPath });

      await docRef.update({
        photoStatus: "done",
        generatedImageUrl: url,
        generatedImagePath: outPath,
        processingCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✅ Image generated for ${event.params.docId}`);
    } catch (err) {
      console.error("❌ Generation failed:", err);
      await docRef.update({
        photoStatus: "error",
        errorMessage: String(err?.message || err),
        errorCount: admin.firestore.FieldValue.increment(1),
        lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);
