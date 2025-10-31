// === FILE: index.js  (repo root) ===
// Firebase Functions v2 + Secret Manager + OpenAI (ESM)

import admin from "firebase-admin";
import OpenAI from "openai";
import { onCall } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";

admin.initializeApp();

// Global options (region, timeout, memory)
setGlobalOptions({
  region: "asia-south1",
  timeoutSeconds: 120,
  memoryMiB: 1024,
});

// Read OPENAI_API_KEY from Firebase Secret Manager
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// Callable: generate product image
export const generateProductImage = onCall({ secrets: [OPENAI_API_KEY] }, async (req) => {
  const prompt =
    (req.data && req.data.prompt) ||
    "Studio-grade product photo of a plain white t-shirt on mannequin, clean soft shadow, seamless background.";

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });

  // OpenAI supports only these sizes; choose portrait
  const result = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1536",
  });

  const b64 = result.data[0].b64_json;
  const buffer = Buffer.from(b64, "base64");

  const bucket = admin.storage().bucket(); // default bucket
  const filePath = `generated/${Date.now()}.png`;
  const file = bucket.file(filePath);

  await file.save(buffer, { contentType: "image/png" });

  const [url] = await file.getSignedUrl({
    action: "read",
    expires: "2099-09-03",
  });

  return { success: true, url, path: filePath };
});
