import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NPC_DIR = path.resolve(
  __dirname,
  "../data/Mods/casssandra/Cassandra's_npc"
);
const OUTPUT_DIR = path.resolve(
  __dirname,
  "../data/Mods/casssandra/npc"
);

const STYLE_PREFIX = `Style: 16-bit pixel art character portrait, half-body bust shot, Octopath Traveler / Square Enix HD-2D aesthetic, detailed pixel shading, warm cinematic lighting, slightly tilted three-quarter view, dark moody background with subtle atmospheric particles, retro JRPG character select screen feel.`;

const CONCURRENCY = 3;

interface NpcProfile {
  id: string;
  name: string;
  occupation?: string;
  age?: number;
  gender?: string;
  appearance?: string;
  personality?: string;
  background?: string;
}

function extFromMime(mimeType: string): string {
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

async function generateGeminiImage(
  prompt: string,
  aspectRatio = "1:1"
): Promise<{ mimeType: string; base64Data: string }> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_API_KEY");

  const model = process.env.GOOGLE_IMAGE_MODEL || "gemini-2.5-flash-image";
  const endpoint =
    process.env.GOOGLE_API_ENDPOINT ||
    "https://generativelanguage.googleapis.com";
  const url = `${endpoint}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
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
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(
    (part: any) => part?.inlineData?.data || part?.inline_data?.data
  );

  if (!imagePart) throw new Error("No image data in response");

  const inlineData = imagePart.inlineData || imagePart.inline_data;
  const base64Data = inlineData?.data;
  const mimeType =
    inlineData?.mimeType || inlineData?.mime_type || "image/png";

  if (!base64Data) throw new Error("Empty image data in response");

  return { mimeType, base64Data };
}

function buildPrompt(npc: NpcProfile): string {
  const lines = [STYLE_PREFIX, "", `Character: ${npc.name}`];

  if (npc.occupation) lines.push(`Occupation: ${npc.occupation}`);
  if (npc.age) lines.push(`Age: ${npc.age}`);
  if (npc.gender) lines.push(`Gender: ${npc.gender}`);
  if (npc.appearance) lines.push(`Appearance: ${npc.appearance}`);
  if (npc.personality) lines.push(`Personality: ${npc.personality}`);
  if (npc.background) lines.push(`Background context: ${npc.background}`);

  lines.push(
    "",
    "Generate a pixel art half-body portrait of this character. Show from chest up. The character should face slightly to the side. Include a decorative pixel art frame or border around the portrait."
  );

  return lines.join("\n");
}

async function scanNpcs(): Promise<NpcProfile[]> {
  const files = await fs.readdir(NPC_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

  const npcs: NpcProfile[] = [];
  for (const file of jsonFiles) {
    const raw = await fs.readFile(path.join(NPC_DIR, file), "utf-8");
    const json = JSON.parse(raw);
    npcs.push({
      id: json.id || path.parse(file).name,
      name: json.name || path.parse(file).name,
      occupation: json.occupation,
      age: json.age,
      gender: json.gender,
      appearance: json.appearance,
      personality: json.personality,
      background: json.background,
    });
  }
  return npcs;
}

async function main() {
  if (!process.env.GOOGLE_API_KEY) {
    console.error("Missing GOOGLE_API_KEY. Set it in .env");
    process.exit(1);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  console.log("Scanning NPCs...");
  const npcs = await scanNpcs();
  console.log(`Found ${npcs.length} NPCs\n`);

  // Filter out already-generated portraits
  const toGenerate: Array<{ npc: NpcProfile; index: number }> = [];
  const skipped: string[] = [];

  for (let i = 0; i < npcs.length; i++) {
    const npc = npcs[i];
    const existingFiles = existsSync(OUTPUT_DIR)
      ? await fs.readdir(OUTPUT_DIR)
      : [];
    const alreadyExists = existingFiles.some(
      (f) => path.parse(f).name === npc.id
    );

    if (alreadyExists) {
      console.log(`[${i + 1}/${npcs.length}] SKIP ${npc.name} — already exists`);
      skipped.push(npc.name);
    } else {
      toGenerate.push({ npc, index: i });
    }
  }

  console.log(
    `\nNeed to generate: ${toGenerate.length} portraits (concurrency: ${CONCURRENCY})\n`
  );

  const succeeded: string[] = [...skipped];
  const failed: Array<{ name: string; error: string }> = [];

  for (let batch = 0; batch < toGenerate.length; batch += CONCURRENCY) {
    const chunk = toGenerate.slice(batch, batch + CONCURRENCY);
    const batchNum = Math.floor(batch / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(toGenerate.length / CONCURRENCY);
    console.log(
      `--- Batch ${batchNum}/${totalBatches} (${chunk.length} portraits) ---`
    );

    const results = await Promise.allSettled(
      chunk.map(async ({ npc, index }) => {
        console.log(
          `[${index + 1}/${npcs.length}] Generating ${npc.name}...`
        );
        const prompt = buildPrompt(npc);
        const { mimeType, base64Data } = await generateGeminiImage(prompt);
        const ext = extFromMime(mimeType);
        const outputPath = path.join(OUTPUT_DIR, `${npc.id}.${ext}`);

        const buffer = Buffer.from(base64Data, "base64");
        await fs.writeFile(outputPath, buffer);

        console.log(`  -> Saved ${npc.id}.${ext}`);
        return npc.name;
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const { npc } = chunk[j];
      if (result.status === "fulfilled") {
        succeeded.push(result.value);
      } else {
        const msg = result.reason?.message || String(result.reason);
        console.error(`  -> FAILED ${npc.name}: ${msg}`);
        failed.push({ name: npc.name, error: msg });
      }
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Total: ${npcs.length}`);
  console.log(`Succeeded: ${succeeded.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const { name, error } of failed) {
      console.log(`  - ${name}: ${error}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
