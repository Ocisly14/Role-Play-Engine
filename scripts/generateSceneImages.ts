import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS_DIR = path.resolve(
  __dirname,
  "../data/Mods/casssandra/Cassandra_Scenarios"
);
const SCENE_DIR = path.resolve(__dirname, "../data/Mods/casssandra/scene");
const MAP_CONFIG_PATH = path.join(SCENE_DIR, "map_config.json");

const STYLE_PREFIX = `Style: 16-bit pixel art sprites and objects, 3D depth with tilt-shift bokeh effect, volumetric lighting, soft god rays, atmospheric particles, warm cinematic color grading, miniature diorama perspective, isometric view, detailed environmental storytelling, Octopath Traveler style, square enix HD-2D aesthetic`;

const CONCURRENCY = 5;

interface SubScene {
  id: string; // e.g. "SCN_1_SUB_2"
  name: string; // e.g. "停尸间"
  parentId: string; // e.g. "SCN_1"
  filePath: string;
  json: Record<string, unknown>;
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
  aspectRatio = "4:3"
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

function buildPrompt(scene: SubScene): string {
  const sceneJson = JSON.stringify(scene.json, null, 2);
  return `${STYLE_PREFIX}

Scene: ${scene.name}

${sceneJson}`;
}

function getRelativeImagePath(scene: SubScene, ext: string): string {
  return `${scene.parentId}/${scene.name}.${ext}`;
}

async function scanSubScenes(): Promise<SubScene[]> {
  const files = await fs.readdir(SCENARIOS_DIR);
  const subSceneFiles = files
    .filter((f) => /^SCN_\d+_SUB_\d+\.json$/.test(f))
    .sort((a, b) => {
      const [, aScn, aSub] = a.match(/SCN_(\d+)_SUB_(\d+)/) || [];
      const [, bScn, bSub] = b.match(/SCN_(\d+)_SUB_(\d+)/) || [];
      return (
        Number(aScn) - Number(bScn) || Number(aSub) - Number(bSub)
      );
    });

  const scenes: SubScene[] = [];
  for (const file of subSceneFiles) {
    const filePath = path.join(SCENARIOS_DIR, file);
    const raw = await fs.readFile(filePath, "utf-8");
    const json = JSON.parse(raw);
    const id = json.id || file.replace(".json", "");
    const parentMatch = id.match(/^(SCN_\d+)_SUB_/);
    scenes.push({
      id,
      name: json.name || id,
      parentId: parentMatch ? parentMatch[1] : id,
      filePath,
      json,
    });
  }
  return scenes;
}

async function updateMapConfig(
  generatedScenes: Array<{ scene: SubScene; relativePath: string }>
): Promise<void> {
  const raw = await fs.readFile(MAP_CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);

  if (!config.scenes) config.scenes = {};

  const defaultNpcAreas = [
    { x: 50, y: 50, width: 200, height: 120 },
  ];

  for (const { scene, relativePath } of generatedScenes) {
    const existing = config.scenes[scene.id];
    if (existing) {
      existing.background = relativePath;
    } else {
      config.scenes[scene.id] = {
        background: relativePath,
        npcAreas: defaultNpcAreas,
      };
    }
  }

  await fs.writeFile(MAP_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nUpdated ${MAP_CONFIG_PATH}`);
}

async function main() {
  if (!process.env.GOOGLE_API_KEY) {
    console.error("Missing GOOGLE_API_KEY. Set it in .env");
    process.exit(1);
  }

  console.log("Scanning sub-scenes...");
  const scenes = await scanSubScenes();
  console.log(`Found ${scenes.length} sub-scenes\n`);

  const succeeded: Array<{ scene: SubScene; relativePath: string }> = [];
  const failed: Array<{ scene: SubScene; error: string }> = [];

  // Separate scenes into already-existing and to-generate
  const toGenerate: Array<{ scene: SubScene; index: number }> = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const parentDir = path.join(SCENE_DIR, scene.parentId);
    let alreadyExists = false;
    if (existsSync(parentDir)) {
      const existing = await fs.readdir(parentDir);
      alreadyExists = existing.some(
        (f) => path.parse(f).name === scene.name
      );
    }

    if (alreadyExists) {
      console.log(
        `[${i + 1}/${scenes.length}] SKIP ${scene.id} (${scene.name}) — already exists`
      );
      const existing = (await fs.readdir(parentDir)).find(
        (f) => path.parse(f).name === scene.name
      )!;
      succeeded.push({
        scene,
        relativePath: `${scene.parentId}/${existing}`,
      });
    } else {
      toGenerate.push({ scene, index: i });
    }
  }

  console.log(`\nNeed to generate: ${toGenerate.length} images (concurrency: ${CONCURRENCY})\n`);

  // Process in parallel batches of CONCURRENCY
  for (let batch = 0; batch < toGenerate.length; batch += CONCURRENCY) {
    const chunk = toGenerate.slice(batch, batch + CONCURRENCY);
    const batchNum = Math.floor(batch / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(toGenerate.length / CONCURRENCY);
    console.log(`--- Batch ${batchNum}/${totalBatches} (${chunk.length} scenes) ---`);

    const results = await Promise.allSettled(
      chunk.map(async ({ scene, index }) => {
        console.log(
          `[${index + 1}/${scenes.length}] Generating ${scene.id} (${scene.name})...`
        );
        const prompt = buildPrompt(scene);
        const { mimeType, base64Data } = await generateGeminiImage(prompt);
        const ext = extFromMime(mimeType);
        const relativePath = getRelativeImagePath(scene, ext);
        const outputPath = path.join(SCENE_DIR, relativePath);

        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const buffer = Buffer.from(base64Data, "base64");
        await fs.writeFile(outputPath, buffer);

        console.log(`  -> Saved ${relativePath}`);
        return { scene, relativePath };
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const { scene } = chunk[j];
      if (result.status === "fulfilled") {
        succeeded.push(result.value);
      } else {
        const msg = result.reason?.message || String(result.reason);
        console.error(`  -> FAILED ${scene.id} (${scene.name}): ${msg}`);
        failed.push({ scene, error: msg });
      }
    }
  }

  // Update map_config.json with all scenes (existing + newly generated)
  if (succeeded.length > 0) {
    await updateMapConfig(succeeded);
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Total: ${scenes.length}`);
  console.log(`Succeeded: ${succeeded.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log("\nFailed scenes:");
    for (const { scene, error } of failed) {
      console.log(`  - ${scene.id} (${scene.name}): ${error}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
