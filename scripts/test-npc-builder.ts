#!/usr/bin/env tsx

/**
 * Test the NPC Builder (two-step instantiation) using module data from
 * 鸦栖堡的冰封安魂曲 (The Frozen Requiem of Ravenscroft).
 * Writes generated NPCs as JSON to <moduleDir>/npc_test/
 *
 * Usage (from project root):
 *   pnpm exec tsx scripts/test-npc-builder.ts
 *
 * Requires: .env with MODEL_PROVIDER and API keys (e.g. GOOGLE_API_KEY).
 */

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { NPCBuilderAgent } from "../src/dynamicworldagent/world_builder/npcBuilderAgent.js";
import type {
  MacroSceneStructure,
  TruthEvent,
  KnowledgeHolder,
  RedHerring,
  MythosEvent,
} from "../src/dynamicworldagent/world_builder/types.js";

const MODULE_NAME = "鸦栖堡的冰封安魂曲 (The Frozen Requiem of Ravenscroft)";
const MODULE_DIR = path.join(process.cwd(), "data", "Mods", MODULE_NAME);
const OUTPUT_DIR = path.join(MODULE_DIR, "npc_test");

async function loadModuleData() {
  const [macroRaw, truthRaw, knowledgeRaw] = await Promise.all([
    fs.readFile(path.join(MODULE_DIR, "macro_scene.json"), "utf-8"),
    fs.readFile(path.join(MODULE_DIR, "truth_timeline.json"), "utf-8"),
    fs.readFile(path.join(MODULE_DIR, "knowledge_matrix.json"), "utf-8"),
  ]);

  const macroParsed = JSON.parse(macroRaw) as {
    macroScene?: MacroSceneStructure;
    mythosEvents?: MythosEvent[];
    endState?: unknown;
  };
  const truthParsed = JSON.parse(truthRaw) as { truthTimeline?: TruthEvent[] };
  const knowledgeParsed = JSON.parse(knowledgeRaw) as {
    knowledgeMatrix?: KnowledgeHolder[];
    redHerrings?: RedHerring[];
  };

  const macroScene =
    macroParsed.macroScene ?? (macroParsed as unknown as MacroSceneStructure);
  const mythosEvents = macroParsed.mythosEvents ?? [];
  const truthTimeline = truthParsed.truthTimeline ?? [];
  const knowledgeMatrix = knowledgeParsed.knowledgeMatrix ?? [];
  const redHerrings = knowledgeParsed.redHerrings ?? [];

  return {
    macroScene,
    mythosEvents,
    truthTimeline,
    knowledgeMatrix,
    redHerrings,
  };
}

async function main() {
  console.log(
    "\n🧪 [test-npc-builder] Testing NPC Builder with module:",
    MODULE_NAME
  );
  console.log("   Module dir:", MODULE_DIR);
  console.log("   Output dir:", OUTPUT_DIR);

  const hasKey = !!(process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY);
  if (!hasKey) {
    console.error("❌ Set GOOGLE_API_KEY or OPENAI_API_KEY in .env");
    process.exit(1);
  }

  console.log("\n   Loading macro_scene, truth_timeline, knowledge_matrix...");
  const {
    macroScene,
    mythosEvents,
    truthTimeline,
    knowledgeMatrix,
    redHerrings,
  } = await loadModuleData();
  console.log(
    `   Truth events: ${truthTimeline.length}, Knowledge holders: ${knowledgeMatrix.length}, Red herrings: ${redHerrings.length}`
  );

  const agent = new NPCBuilderAgent();
  const npcs = await agent.generateBatch(
    macroScene,
    truthTimeline,
    knowledgeMatrix,
    redHerrings,
    mythosEvents,
    (msg) => console.log("   ", msg)
  );

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const npcsPath = path.join(OUTPUT_DIR, "npcs.json");
  await fs.writeFile(npcsPath, JSON.stringify(npcs, null, 2), "utf-8");
  console.log(`\n✅ Wrote ${npcs.length} NPCs to ${npcsPath}`);

  for (const npc of npcs) {
    const f = path.join(OUTPUT_DIR, `${npc.id}.json`);
    await fs.writeFile(f, JSON.stringify(npc, null, 2), "utf-8");
  }
  if (npcs.length > 0) {
    console.log(
      `   Also wrote per-NPC files (e.g. ${npcs[0]!.id}.json) into ${OUTPUT_DIR}`
    );
  }
}

main().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
