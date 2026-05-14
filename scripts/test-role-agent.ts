#!/usr/bin/env tsx
//
// scripts/test-role-agent.ts
//
// Smoke test for src/roleSim/llmAgent.ts in isolation. Builds a minimal
// DynamicGameStateManager with one scene + one NPC, stubs the memory layer
// (so no Prisma / no embeddings), then drives a single decideNext() call
// and prints the decision. Uses the real LLM via models/generateText.
//
// Run:  pnpm tsx scripts/test-role-agent.ts
//
// Requires the relevant *_API_KEY for the configured MODEL_PROVIDER in .env.

import "dotenv/config";

import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../src/state/DynamicGameState.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
} from "../src/state/types.js";
import type { CharacterPosition } from "../src/state/topologyTypes.js";

import type { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import { LLMRoleSimAgent } from "../src/roleSim/llmAgent.js";
import type { RoleSimContext } from "../src/roleSim/agent.js";

// --- 1. Build a minimal scene ----------------------------------------------

const scene: DynamicScene = {
  id: "scene_study",
  name: "Dr. Marsh's Study",
  description:
    "A wood-panelled study in a townhouse. A fire burns in the hearth. " +
    "Bookshelves line the walls; a desk near the window holds papers and " +
    "an unopened letter. Through the window, gas-lamps glow in the fog.",
  parentLocationId: "loc_marsh_house",
  items: [],
  conditions: [],
  connections: [],
  indoor: true,
};

// --- 2. Build a minimal NPC profile ----------------------------------------

const npc: DynamicNPCProfile = {
  id: "npc_marsh",
  name: "Dr. Henry Marsh",
  age: 47,
  gender: "male",
  occupation: "Archaeologist",
  appearance:
    "Lean, slightly stooped, grey at the temples; reading-glasses on a chain.",
  personality:
    "Curious, methodical, privately anxious. Slow to act on hearsay; " +
    "sharp once interested.",
  background:
    "Years of dig-site work in the Levant; recently returned to England " +
    "with crates of artefacts from a controversial expedition.",
  backstory:
    "An old colleague died abroad under circumstances Marsh has not " +
    "publicly explained.",
  residence: "loc_marsh_house",
  longTermIntent:
    "Catalogue the new artefacts before any rival scholar can examine them.",
  attributes: {
    STR: 50,
    CON: 60,
    SIZ: 60,
    DEX: 55,
    APP: 55,
    INT: 80,
    POW: 65,
    EDU: 90,
  },
  status: {
    hp: 11,
    maxHp: 12,
    san: 55,
    maxSan: 65,
    fatigue: 2,
    maxFatigue: 10,
    luck: 60,
    conditions: [],
  },
  inventory: [],
  skills: { Library_Use: 75, Archaeology: 70, Spot_Hidden: 50 },
  relationships: [],
};

// --- 3. Build the DGSM around scene + NPC ----------------------------------

const initialState = initialDynamicGameState({
  sessionId: "test-session",
  moduleName: "test-module",
  gameDateTime: "1923-10-15T20:30:00",
});
initialState.scenes.set(scene.id, scene);
initialState.npcCharacters.push(npc);
initialState.npcStats[npc.id] = { hp: npc.status.hp, san: npc.status.san };
initialState.npcResidences[npc.id] = npc.residence!;
const position: CharacterPosition = { type: "scene", sceneId: scene.id };
initialState.characterPositions[npc.id] = position;

const dgsm = new DynamicGameStateManager(initialState);

// --- 4. Stub NpcMemoryManager (no Prisma, no embeddings) -------------------
//
// LLMRoleSimAgent only touches memory through the instant-tool dispatcher
// (writeMemory/recallMemory/getMapSnapshot). A no-op stub is enough for a
// single-shot smoke test: writes are echoed back, recall returns nothing,
// map snapshot is empty.

const stubMemory: Pick<
  NpcMemoryManager,
  "add" | "query" | "getMapSnapshot" | "findLatestByType"
> = {
  async add(params) {
    console.log(
      `   [memory.add stub] type=${params.type} npc=${params.npcId} ` +
        `content="${params.content?.slice(0, 60) ?? ""}"`
    );
    return {
      id: "stub",
      npcId: params.npcId,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      type: params.type,
      content: params.content,
      gameDateTime: params.gameDateTime,
      location: params.location ?? null,
      metadata: params.metadata ?? null,
      baseImportance: 0.5,
      accessCount: 0,
      lastAccessedAt: new Date(),
      createdAt: new Date(),
      embedding: null,
    } as Awaited<ReturnType<NpcMemoryManager["add"]>>;
  },
  async query() {
    return [];
  },
  async getMapSnapshot() {
    return null;
  },
  async findLatestByType() {
    return null;
  },
};

// --- 5. Build the agent + a perception-rich RoleSimContext -----------------

const agent = new LLMRoleSimAgent({
  memory: stubMemory as unknown as NpcMemoryManager,
  dgsm,
  sessionId: "test-session",
  moduleId: "test-module",
  language: "en",
});

const ctx: RoleSimContext = {
  npcId: npc.id,
  currentTime: initialState.gameDateTime,
  npcProfile: npc,
  currentScene: scene.id,
  recentMemory: [
    {
      type: "event",
      content:
        "This morning, the dock-master sent word that the last crate from " +
        "the Beirut shipment was unloaded and is in the back room.",
      gameDateTime: "1923-10-15T09:00:00",
    },
    {
      type: "belief",
      content:
        "Professor Hollins from King's College has been asking around about " +
        "my finds. He should not see them before I publish.",
      gameDateTime: "1923-10-14T18:00:00",
    },
  ],
  longTermIntent: npc.longTermIntent,
  perception: {
    narrative:
      "You are at your desk in [Dr. Marsh's Study], pen in hand over a " +
      "half-finished catalogue entry. A heavy three-rap knock comes from " +
      "the front door downstairs. You hear [Mrs. Allen]'s footsteps in the " +
      "hall as she goes to answer it. The clock on the mantel reads " +
      "twenty past eight.",
  },
};

// --- 6. Drive one decision -------------------------------------------------

console.log("=== test-role-agent ===");
console.log(`NPC : ${npc.name} (${npc.id})`);
console.log(`Time: ${ctx.currentTime}`);
console.log(`Scene: ${scene.name}`);
console.log(
  `Provider: ${process.env.MODEL_PROVIDER ?? "(unset — generator falls back)"}\n`
);
console.log("Calling agent.decideNext() ...\n");

async function main() {
  const t0 = Date.now();
  try {
    const decision = await agent.decideNext(ctx);
    const ms = Date.now() - t0;
    console.log(`\n--- Decision (after ${ms} ms) ---`);
    console.log(JSON.stringify(decision, null, 2));
  } catch (err) {
    console.error("\n--- decideNext THREW ---");
    console.error(err);
    process.exitCode = 1;
  }
}

main();
