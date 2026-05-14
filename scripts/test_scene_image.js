import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_PATH = path.resolve(
  __dirname,
  "../data/Mods/The Kanto Phantom Pilgrimage (关东幽冥巡礼)/The Kanto Phantom Pilgrimage (关东幽冥巡礼)_Scenarios/Yamanote_Line_Loop.json"
);

const OUTPUT_DIR = path.resolve(__dirname, "../data/generated");

function extFromMime(mimeType) {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

function sanitizeSnapshot(snapshot) {
  return {
    ...snapshot,
    clues: [],
    keeperNotes: undefined,
  };
}

function buildSceneImagePrompt(snapshot) {
  const snapshotJson = JSON.stringify(snapshot, null, 2);
  return `
# Scene Illustration Prompt

Create a cinematic, atmospheric scene illustration for a Lovecraftian mystery.

## Source of Truth (CRITICAL)
Use the full target scene snapshot below as the ONLY source of factual details. Do not invent locations, props, or characters that are not implied by the snapshot.

## Target Scene Snapshot (full JSON)
\`\`\`json
${snapshotJson}
\`\`\`

## Visual Requirements
- The image must reflect the location, environment, characters, conditions, and notable elements implied by the snapshot.
- Style: realistic lighting, moody, grounded, high detail, wide establishing shot.
- Do not include text, captions, watermarks, or UI elements.
`.trim();
}

async function generateGeminiImage(prompt) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY.");
  }

  const model = process.env.GOOGLE_IMAGE_MODEL || "gemini-2.5-flash-image";
  const endpoint =
    process.env.GOOGLE_API_ENDPOINT ||
    "https://generativelanguage.googleapis.com";
  const aspectRatio = process.env.GOOGLE_IMAGE_ASPECT_RATIO || "16:9";
  const url = `${endpoint}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gemini image generation failed: ${response.status} ${errorText}`
    );
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(
    (part) => part?.inlineData?.data || part?.inline_data?.data
  );

  if (!imagePart) {
    throw new Error("Gemini image generation returned no image data");
  }

  const inlineData = imagePart.inlineData || imagePart.inline_data;
  const base64Data = inlineData?.data;
  const mimeType = inlineData?.mimeType || inlineData?.mime_type || "image/png";

  if (!base64Data) {
    throw new Error("Gemini image generation returned empty image data");
  }

  return {
    mimeType,
    base64Data,
  };
}

async function main() {
  if (!process.env.GOOGLE_API_KEY) {
    console.error("Missing GOOGLE_API_KEY. Aborting image generation.");
    process.exit(1);
  }

  const raw = await fs.readFile(INPUT_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const snapshot = parsed?.[0]?.snapshot;

  if (!snapshot) {
    throw new Error("No snapshot found in input file.");
  }

  console.log(`Generating image for snapshot: ${snapshot.name}`);

  const sanitizedSnapshot = sanitizeSnapshot(snapshot);
  const prompt = buildSceneImagePrompt(sanitizedSnapshot);
  const { mimeType, base64Data } = await generateGeminiImage(prompt);
  const ext = extFromMime(mimeType);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `yamanote_line_loop_scene.${ext}`);
  const buffer = Buffer.from(base64Data, "base64");
  await fs.writeFile(outputPath, buffer);

  console.log(`✅ Image written to ${outputPath}`);
}

main().catch((error) => {
  console.error("❌ Scene image generation failed:", error);
  process.exit(1);
});
