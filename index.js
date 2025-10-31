// ===== Firebase Functions Imports (ESM Modular) =====
import { defineSecret } from "firebase-functions/params";
import { onCall } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { setGlobalOptions, logger } from "firebase-functions/v2";

// ===== Firebase Admin Imports (ESM Modular) =====
// FIX: এটি "TypeError: admin.initializeApp is not a function" সমস্যার সমাধান করে
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getFirestore } from "firebase-admin/firestore";

// ===== Other Node.js Imports =====
import OpenAI from "openai";
import { randomUUID } from "crypto"; // ডাউনলোড টোকেন তৈরির জন্য

// --- 1. Initialization ---
// FIX: 'admin.' প্রিফিক্স ছাড়াই সরাসরি কল করা হচ্ছে
initializeApp();
const storage = getStorage();
const db = getFirestore();

// --- 2. Secrets & Global Options ---
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

setGlobalOptions({
  region: "asia-south1", // NOTE: আপনার অনুরোধ অনুযায়ী লোকেশন সেট করা হলো
  secrets: [OPENAI_API_KEY],
  memory: "512MiB", // v2 স্টাইলে মেমোরি
  timeoutSeconds: 120,
});

const openAI = () => new OpenAI({ apiKey: OPENAI_API_KEY.value() });

// --- 3. Helper Functions ---

/** Bucket-এর নাম .appspot.com ফরম্যাটে রূপান্তর করে */
const normBucket = (n) => (n || "").replace(".firebasestorage.app", ".appspot.com");

/** একটি URL থেকে ডেটা এনে Base64-এ রূপান্তর করে */
const fetchToB64 = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString("base64");
};

/** OpenAI কল করে ছবি তৈরি করে এবং Base64 রিটার্ন করে */
const genB64 = async ({ prompt }) => {
  const client = openAI();
  const res = await client.images.generate({
    model: "dall-e-3", // FIX: DALL-E 3 ব্যবহার করা হচ্ছে (লম্বা ছবির জন্য)
    prompt,
    size: "1024x1792", // NOTE: আপনার 1024x1536 এর নিকটতম সমর্থিত সাইজ
    response_format: "b64_json", // FIX: b64_json ফরম্যাট নিশ্চিত করা হচ্ছে
    n: 1, // একটি ছবি তৈরি করা হবে
  });
  
  const item = res?.data?.[0] || {};
  if (item.b64_json) return item.b64_json;
  
  // যদি API কোনো কারণে URL রিটার্ন করে (ফলব্যাক)
  if (item.url) {
    logger.warn("OpenAI returned a URL, fetching to B64...");
    return await fetchToB64(item.url);
  }
  
  throw new Error("No image b64_json returned from OpenAI");
};

// --- 4. Callable Function (Manual Test) ---
export const generateStagingPhoto = onCall(async (req) => {
  try {
    const prompt =
      (req?.data?.prompt || "").trim() ||
      "Studio-grade e-commerce product photo on clean white seamless background, soft realistic shadow";
    
    const b64 = await genB64({ prompt });
    return { b64 };
  } catch (e) {
    const msg = e?.error?.message || e?.message || String(e);
    logger.error("generateStagingPhoto error", msg);
    return { error: msg };
  }
});

// --- 5. Firestore Trigger (Automatic Generation) ---
export const onStagingCreateGeneratePhoto = onDocumentCreated(
  "staging_products/{docId}",
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.info("No snapshot data on event, exiting.");
      return;
    }
    
    const data = snap.data() || {};
    const docRef = snap.ref; // DocumentReference

    // --- A. Bucket এবং Path সেট করা ---
    // FIX: 'rawImageBucket' না থাকলে ডিফল্ট bucket ব্যবহার করা
    const rawBucketName = normBucket(data.rawImageBucket) || storage.bucket().name; 
    const rawPath = data.rawImagePath;
    
    if (!rawPath) {
      logger.error("Document missing 'rawImagePath', aborting.");
      await docRef.update({
        photoStatus: "error",
        photoError: "missing_raw_path",
        photoUpdatedAt: new Date().toISOString(),
      });
      return;
    }

    const bucket = storage.bucket(rawBucketName);
    const file = bucket.file(rawPath);

    // --- B. কাঁচা ছবির জন্য একটি URL তৈরি করা ---
    let refUrl;
    try {
      // 1st চেষ্টা: Download Token (কোনো বিশেষ পারমিশন প্রয়োজন নেই)
      const [meta] = await file.getMetadata();
      const token = meta?.metadata?.firebaseStorageDownloadTokens;
      
      if (token) {
        const obj = encodeURIComponent(rawPath);
        refUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${obj}?alt=media&token=${token}`;
        logger.info(`Using download token URL for ${docRef.id}`);
      } else {
        // 2nd চেষ্টা: Signed URL (এর জন্য 'Service Account Token Creator' রোল প্রয়োজন)
        logger.warn(`No download token for ${docRef.id}, trying getSignedUrl...`);
        const [signedUrl] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 15 * 60 * 1000, // ১৫ মিনিট
        });
        refUrl = signedUrl;
        logger.info(`Using signed URL for ${docRef.id}`);
      }
    } catch (e) {
      // FIX: এই catch ব্লক "bucket does not exist" বা "signBlob" error ধরবে
      const msg = e?.message || String(e);
      logger.error(`build refUrl failed for ${docRef.id}: ${msg}`);
      await docRef.update({
        photoStatus: "error",
        photoError: `build refUrl failed: ${msg}`,
        photoUpdatedAt: new Date().toISOString(),
      });
      return;
    }

    // --- C. OpenAI কল করা এবং নতুন ছবি সেভ করা ---
    try {
      const prompt = `E-commerce studio photo, clean white background, centered product, realistic soft shadow. Use this image as a reference: ${refUrl}`;
      
      await docRef.update({ photoStatus: "generating" }); // স্ট্যাটাস "generating"-এ আপডেট করা
      
      const b64 = await genB64({ prompt });
      const outPath = `generated/${event.params.docId}.png`;
      
      // নতুন ছবিটি স্টোরেজে সেভ করা
      await bucket.file(outPath).save(Buffer.from(b64, "base64"), {
        contentType: "image/png",
        metadata: {
          metadata: {
            firebaseStorageDownloadTokens: randomUUID(), // নতুন ছবির জন্য টোকেন যোগ করা
          }
        }
      });

      // --- D. Firestore-এ চূড়ান্ত আপডেট (সাফল্য) ---
      await docRef.update({
        generatedImagePath: outPath,
        generatedImageBucket: bucket.name, // কোন bucket ব্যবহৃত হলো তা সেভ করা
        photoStatus: "ready",
        photoError: null,
        photoUpdatedAt: new Date().toISOString(),
      });
      logger.info(`Successfully generated image for ${docRef.id}`);
      
    } catch (e) {
      // --- E. Firestore-এ চূড়ান্ত আপডেট (ব্যর্থতা) ---
      // FIX: এই catch ব্লক OpenAI-এর error ধরবে (যেমন: ভুল API key, কোটা শেষ)
      const msg = e?.error?.message || e?.message || String(e);
      logger.error(`onStagingCreateGeneratePhoto failed for ${docRef.id}: ${msg}`);
      await docRef.update({
        photoStatus: "error",
        photoError: msg, 
        photoUpdatedAt: new Date().toISOString(),
      });
    }
  }
);