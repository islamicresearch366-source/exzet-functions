// FILE: functions/index.js
import { onCall } from "firebase-functions/v2/https";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import OpenAI from "openai";
import sharp from "sharp";

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY"); // set this secret before deploy

admin.initializeApp({
  storageBucket: "bestlogin-e1c74.firebasestorage.app",
});

const bucket = admin.storage().bucket();
const REGION = "asia-south1";
const DEFAULT_FOLDER = "generated";
const INCOMING_PREFIX = "incoming/";

/** helpers */
function parseSize(s = "1024x1536") {
  const m = String(s).toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!m) return { w: 1024, h: 1536 };
  return { w: Math.max(1, +m[1]), h: Math.max(1, +m[2]) };
}
function squareForModel(w, h) {
  // gpt-image-1 is most reliable with square sizes; render larger square then fit to requested size
  const side = Math.max(w, h, 1024);
  // cap commonly supported sides
  const allowed = [1024, 1536, 2048];
  const pick = allowed.reduce((a, b) =>
    Math.abs(b - side) < Math.abs(a - side) ? b : a
  );
  return `${pick}x${pick}`;
}
async function generateBufferFromPrompt(prompt, sizeStr, apiKey) {
  const { w, h } = parseSize(sizeStr || "1024x1536");
  const openai = new OpenAI({ apiKey });

  const squareSize = squareForModel(w, h);
  const res = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: squareSize, // model render
    response_format: "b64_json",
  });

  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image generation failed: empty response");
  const raw = Buffer.from(b64, "base64");

  // Fit to requested WxH without distortion (white background)
  const out = await sharp(raw)
    .resize({ width: w, height: h, fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  return { buffer: out, w, h };
}
async function saveBufferToStorage(buffer, destPath, contentType = "image/png") {
  const file = bucket.file(destPath);
  await file.save(buffer, { contentType, resumable: false });
  const [signedUrl] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  return { gsUri: `gs://${bucket.name}/${destPath}`, httpsUrl: signedUrl };
}

/** 1) Callable: generate image -> writes to /generated */
export const generateImage = onCall(
  { region: REGION, secrets: [OPENAI_API_KEY], cors: true },
  async (req) => {
    const prompt = (req.data?.prompt || "").trim();
    const size = (req.data?.size || "1024x1536").trim();
    const folder = (req.data?.folder || DEFAULT_FOLDER).replace(/^\/+|\/+$/g, "");
    const filename =
      (req.data?.filename || `img_${Date.now()}.png`).replace(/^\//, "");
    if (!prompt) throw new Error("prompt required");

    const { buffer } = await generateBufferFromPrompt(
      prompt,
      size,
      OPENAI_API_KEY.value()
    );

    const dest = `${folder}/${filename.endsWith(".png") ? filename : filename + ".png"}`;
    const out = await saveBufferToStorage(buffer, dest, "image/png");

    return {
      ok: true,
      ...out,
      size,
    };
  }
);

/** 2) Storage trigger: drop a prompt file under /incoming to auto-generate
 *  - incoming/{name}.txt  → file text = prompt
 *  - incoming/{name}.json → {"prompt":"...", "size":"1024x1536", "folder":"generated", "filename":"abc.png"}
 */
export const incomingPromptWorker = onObjectFinalized(
  {
    region: REGION,
    bucket: "bestlogin-e1c74.firebasestorage.app",
    secrets: [OPENAI_API_KEY],
    memory: "512MiB",
    cpu: 1,
  },
  async (event) => {
    const obj = event.data;
    const name = obj.name || "";
    const contentType = obj.contentType || "application/octet-stream";

    if (!name.startsWith(INCOMING_PREFIX)) return;
    try {
      const [bytes] = await bucket.file(name).download();
      let prompt = "";
      let size = "1024x1536";
      let folder = DEFAULT_FOLDER;
      let filename = `${name
        .replace(INCOMING_PREFIX, "")
        .replace(/\.[^/.]+$/, "")}_${Date.now()}.png`;

      if (contentType.includes("json")) {
        const j = JSON.parse(bytes.toString("utf8"));
        prompt = String(j.prompt || "").trim();
        if (j.size) size = String(j.size);
        if (j.folder) folder = String(j.folder).replace(/^\/+|\/+$/g, "");
        if (j.filename) filename = String(j.filename);
      } else {
        prompt = bytes.toString("utf8").trim();
      }
      if (!prompt) throw new Error("No prompt found in incoming file");

      const { buffer } = await generateBufferFromPrompt(
        prompt,
        size,
        OPENAI_API_KEY.value()
      );

      const dest = `${folder}/${filename.endsWith(".png") ? filename : filename + ".png"}`;
      const out = await saveBufferToStorage(buffer, dest, "image/png");

      logger.info("Generated image", { from: name, to: dest, size });
      // optional: cleanup the incoming file
      // await bucket.file(name).delete().catch(() => {});
      return out;
    } catch (e) {
      logger.error("incomingPromptWorker failed", { name, error: String(e) });
      throw e;
    }
  }
);
