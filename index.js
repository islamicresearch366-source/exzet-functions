// === FILE: functions/index.js ===
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import OpenAI from "openai";
import fetch from "node-fetch";

admin.initializeApp();
const db = admin.firestore();
const storage = admin.storage();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔹 Generate product image from prompt
export const generateProductImage = functions
  .region("asia-south1")
  .https.onCall(async (data, context) => {
    try {
      const prompt = data.prompt || "Studio photo of a plain white t-shirt on mannequin";
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1536",
      });

      const imageBase64 = response.data[0].b64_json;
      const buffer = Buffer.from(imageBase64, "base64");

      const filePath = `generated/${Date.now()}.png`;
      const file = storage.bucket().file(filePath);
      await file.save(buffer, { contentType: "image/png" });

      const [url] = await file.getSignedUrl({
        action: "read",
        expires: "03-09-2099",
      });

      return { success: true, url };
    } catch (error) {
      console.error("Image generation error:", error);
      return { success: false, error: error.message };
    }
  });
