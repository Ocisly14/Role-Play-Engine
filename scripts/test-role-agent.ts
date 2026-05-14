#!/usr/bin/env tsx
//
// scripts/test-role-agent.ts
//
// FULL END-TO-END test for the roleSim layer through the real engine
// pipeline. This is the integration script — every layer between agent and
// engine runs production code, with the only stub being the memory store
// (Prisma + embeddings would otherwise require a live DB).
//
// Real components driven:
//   - DynamicGameStateManager
//   - createTickEngine (queue, applier, scriptedRunner, all 8 subsystems)
//   - NpcActionController (subscribes to tickCompleted; per-NPC perception
//     ring buffer; LLM render → agent decide → engine.submitAction)
//   - LLMRoleSimAgent loop (instant tools + terminal tools)
//   - PerceivableDirectory + parseActionText (citation contract)
//   - interpretAction (LLM definition matcher)
//   - resolveState (LLM action resolver per ActionDefinition)
//   - All 8 default subsystems (weather/sun/stamina/itemDamage/fire/movement/
//     conditionExpiry x2)
//
// Stubbed:
//   - NpcMemoryManager: in-memory; query() does substring match against a
//     long-term seed so recallMemory can hit a few canned beliefs.
//
// Drives N ticks via engine.tick() and observes via tickCompleted events.
// Each tick can cost up to 4-5 LLM calls per active NPC (renderer + agent
// loop iterations + interpreter + resolver), so 3 ticks × 2 NPCs ≈ 25-40
// LLM calls. Expect ~3-6 minutes wall time.
//
// Run: pnpm tsx scripts/test-role-agent.ts
// Requires the relevant *_API_KEY in .env for the configured MODEL_PROVIDER.

import "dotenv/config";

import { mkdirSync, createWriteStream } from "node:fs";
import { resolve as pathResolve } from "node:path";

// === Engine ===
import { createTickEngine } from "../src/engine/core/tickEngine.js";
import {
  createDefaultDefinitions,
  createDefaultSubsystemRegistry,
} from "../src/engine/registerDefaults.js";
import { interpretAction } from "../src/engine/interpreter/gameInterpreter.js";
import { resolveState } from "../src/engine/resolver/stateResolver.js";
import { buildStateContext } from "../src/engine/resolver/stateContextBuilder.js";
import type {
  ActionStep,
  PlannedOutcome,
  TickReport,
} from "../src/engine/core/types.js";

// === RoleSim (real controller + agent) ===
import { LLMRoleSimAgent } from "../src/roleSim/llmAgent.js";
import { NpcActionController } from "../src/roleSim/npcActionController.js";

// === State ===
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../src/state/DynamicGameState.js";
import { buildTopology } from "../src/state/topologyTypes.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
} from "../src/state/types.js";
import type { CharacterPosition } from "../src/state/topologyTypes.js";

// === Memory (stubbed) ===
import type { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import type { NpcMemory, NpcMemoryType } from "@prisma/client";

// =========================================================================
// 0. TEE LOG — mirror all console output into logs/role-agent-test-<ts>.log
// =========================================================================

const LOG_DIR = pathResolve(process.cwd(), "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = pathResolve(
  LOG_DIR,
  `role-agent-test-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
);
const logStream = createWriteStream(LOG_PATH, { flags: "a" });

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a, null, 2);
  } catch {
    return String(a);
  }
}
function tee(orig: (...args: unknown[]) => void, label: string) {
  return (...args: unknown[]) => {
    orig(...args);
    const line = args.map(formatArg).join(" ");
    logStream.write(`${label}${stripAnsi(line)}\n`);
  };
}
console.log = tee(console.log.bind(console), "");
console.warn = tee(console.warn.bind(console), "[warn] ");
console.error = tee(console.error.bind(console), "[err]  ");

process.on("exit", () => logStream.end());

console.log(`(logging to ${LOG_PATH})`);

// =========================================================================
// 1. WORLD: one scene + two NPCs (Marsh + Hollins)
// =========================================================================

const scene: DynamicScene = {
  id: "scene_study",
  name: "Dr. Marsh's Study",
  description:
    "A wood-panelled study in a townhouse. A fire burns in the hearth. " +
    "Bookshelves line the walls; a desk near the window holds papers and " +
    "an unopened letter. Through the window, gas-lamps glow in the fog.",
  parentLocationId: "loc_marsh_house",
  items: [
    {
      id: "item_letter",
      name: "unopened letter",
      description: "A cream envelope on the desk, sealed with red wax.",
    },
  ],
  conditions: [],
  connections: [],
  indoor: true,
};

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
    STR: 50, CON: 60, SIZ: 60, DEX: 55, APP: 55, INT: 80, POW: 65, EDU: 90,
  },
  status: {
    hp: 11, maxHp: 12, san: 55, maxSan: 65, fatigue: 2, maxFatigue: 10,
    luck: 60, conditions: [],
  },
  inventory: [],
  skills: { Library_Use: 75, Archaeology: 70, Spot_Hidden: 50 },
  relationships: [],
};

// `id: npc_<slug>` matches real module convention; per Approach A the id is a
// system-level handle that may leak the canonical name, while in-character
// info-hiding is enforced at the renderer layer (UNKNOWN characters render
// by description in the narrative).
const visitor: DynamicNPCProfile = {
  id: "npc_hollins",
  name: "Professor Hollins",
  age: 52,
  gender: "male",
  occupation: "Comparative Religion scholar",
  appearance: "Tall, pale, with a long black overcoat and an ivory-handled cane.",
  personality:
    "Ingratiating in public; uncompromising in private. Talkative when he " +
    "wants something.",
  longTermIntent:
    "Press Marsh to let me see the Beirut crates tonight before he locks them up.",
  attributes: {
    STR: 40, CON: 55, SIZ: 70, DEX: 50, APP: 60, INT: 80, POW: 70, EDU: 85,
  },
  status: {
    hp: 12, maxHp: 12, san: 60, maxSan: 70, fatigue: 0, maxFatigue: 10,
    luck: 50, conditions: [],
  },
  inventory: [],
  skills: { Persuade: 60, Psychology: 55 },
  relationships: [],
};

const initialState = initialDynamicGameState({
  sessionId: "test-session",
  moduleName: "test-module",
  gameDateTime: "1923-10-15T20:30:00",
});
initialState.scenes.set(scene.id, scene);
initialState.npcCharacters.push(npc, visitor);
initialState.npcStats[npc.id] = { hp: npc.status.hp, san: npc.status.san };
initialState.npcStats[visitor.id] = {
  hp: visitor.status.hp,
  san: visitor.status.san,
};
initialState.npcResidences[npc.id] = npc.residence!;
initialState.characterPositions[npc.id] = {
  type: "scene",
  sceneId: scene.id,
} satisfies CharacterPosition;
// Both NPCs in the same scene from the start so they perceive each other.
initialState.characterPositions[visitor.id] = {
  type: "scene",
  sceneId: scene.id,
} satisfies CharacterPosition;
// Empty topology — no roads/junctions; movement subsystem will see no
// pathing data but neither NPC needs to move.
initialState.topology = buildTopology(new Map(), new Map());

const dgsm = new DynamicGameStateManager(initialState);

// =========================================================================
// 2. STUB MEMORY MANAGER
// =========================================================================
// Substring-match query so recallMemory can find seed entries. The two seed
// memories are Marsh-specific and intentionally NOT in his "today's memories"
// section so the only path to surface them is recallMemory.

interface SeedEntry {
  npcId: string;
  type: NpcMemoryType;
  content: string;
  gameDateTime: string;
}

const seedMemories: SeedEntry[] = [
  {
    npcId: npc.id,
    type: "belief",
    content:
      "Professor Hollins of King's College has been quietly inquiring after " +
      "the Beirut shipment. He must not examine the artefacts before I publish.",
    gameDateTime: "1923-10-09T22:00:00",
  },
  {
    npcId: npc.id,
    type: "secret",
    content:
      "Dr. Whitcomb's death at the dig site was not the fever the consulate " +
      "reported. The cuneiform tablet was missing from his tent that morning.",
    gameDateTime: "1923-07-04T03:15:00",
  },
];

const writtenMemories: SeedEntry[] = [];

function toFakeNpcMemory(seed: SeedEntry, idx: number): NpcMemory {
  return {
    id: `stub-${idx}`,
    npcId: seed.npcId,
    sessionId: "test-session",
    moduleId: "test-module",
    type: seed.type,
    content: seed.content,
    gameDateTime: seed.gameDateTime,
    location: null,
    metadata: null,
    baseImportance: 0.7,
    accessCount: 0,
    lastAccessedAt: new Date(),
    createdAt: new Date(),
    embedding: null,
  } as unknown as NpcMemory;
}

const stubMemory: Pick<
  NpcMemoryManager,
  | "add"
  | "query"
  | "getMapSnapshot"
  | "findLatestByType"
  | "getForDateByTypes"
> = {
  async add(params) {
    const entry: SeedEntry = {
      npcId: params.npcId,
      type: params.type,
      content: params.content,
      gameDateTime: params.gameDateTime,
    };
    writtenMemories.push(entry);
    console.log(
      `   [memory.add] npc=${params.npcId} type=${params.type} content="${params.content.slice(0, 70)}${params.content.length > 70 ? "…" : ""}"`
    );
    return toFakeNpcMemory(entry, writtenMemories.length + 1000);
  },
  async query(params) {
    const all = [...seedMemories, ...writtenMemories].filter(
      (m) => m.npcId === params.npcId
    );
    const q = (params.query ?? "").toLowerCase().trim();
    const types = params.filters?.types;
    const matches = all
      .filter((m) => !types || types.includes(m.type))
      .filter((m) => {
        if (!q) return true;
        const haystack = `${m.content} ${m.type}`.toLowerCase();
        return q
          .split(/\s+/)
          .filter((w) => w.length >= 3)
          .some((w) => haystack.includes(w));
      })
      .slice(0, params.limit ?? 10);
    return matches.map((m, i) => ({
      ...toFakeNpcMemory(m, i),
      score: 0.7,
    })) as unknown as Awaited<ReturnType<NpcMemoryManager["query"]>>;
  },
  async getMapSnapshot() {
    return null;
  },
  async findLatestByType() {
    return null;
  },
  async getForDateByTypes(npcId, _sessionId, _gameDate, types) {
    return [...seedMemories, ...writtenMemories]
      .filter((m) => m.npcId === npcId && types.includes(m.type))
      .map((m, i) => toFakeNpcMemory(m, i));
  },
};

// =========================================================================
// 3. REAL ENGINE WIRING
// =========================================================================

const subsystemRegistry = createDefaultSubsystemRegistry();
const definitions = createDefaultDefinitions();
const definitionList = definitions.getAll();
console.log(
  `(loaded ${definitionList.length} action definitions, ${subsystemRegistry.getAll().length} subsystems)`
);

const engine = createTickEngine({
  dgsm,
  subsystemRegistry,
  scriptedEvents: [],
  interpretAction: async (input, directory) => {
    const result = await interpretAction(
      input.actionText,
      definitionList,
      "en",
      directory
    );
    return { steps: result.steps };
  },
  resolve: async (
    step: ActionStep,
    ctx: unknown
  ): Promise<{ outcome: PlannedOutcome; plannedDuration: number }> => {
    const definition = definitions.get(step.definitionId);
    if (!definition) {
      return {
        outcome: { stateChanges: [], elapsedMinutes: 0 },
        plannedDuration: 0,
      };
    }
    const stateContext = buildStateContext(
      definition,
      {
        characterId: step.characterId,
        referencedEntities: step.referencedEntities,
      },
      dgsm,
      step.executionSceneId
    );
    const resolution = await resolveState({
      action: step.actionText,
      definition,
      outcomeSection: definition.content,
      stateContext,
      language: "en",
    });
    void ctx; // orchestrator passes its own FeatureReadContext; not needed here
    const stateChanges = Array.isArray(resolution.stateChanges)
      ? (resolution.stateChanges as PlannedOutcome["stateChanges"])
      : [];
    const elapsedMinutes =
      typeof resolution.elapsedMinutes === "number"
        ? resolution.elapsedMinutes
        : 0;
    const narrative =
      typeof resolution.narrative === "string"
        ? resolution.narrative
        : undefined;
    return {
      outcome: { stateChanges, elapsedMinutes, narrative },
      plannedDuration: elapsedMinutes,
    };
  },
  getActorDex: (id) => dgsm.getNpcProfile(id)?.attributes?.DEX ?? 50,
  tickDurationMinutes: 1,
  lang: "en",
});

const agent = new LLMRoleSimAgent({
  memory: stubMemory as unknown as NpcMemoryManager,
  dgsm,
  sessionId: "test-session",
  moduleId: "test-module",
  language: "en",
});

const controller = new NpcActionController({
  engine,
  agent,
  memory: stubMemory as unknown as NpcMemoryManager,
  dgsm,
  sessionId: "test-session",
  moduleId: "test-module",
  language: "en",
});

// =========================================================================
// 4. OBSERVERS — log everything that flows out of the engine
// =========================================================================

let tickCount = 0;
engine.on("tickCompleted", (report: TickReport) => {
  tickCount += 1;
  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `=== Tick ${tickCount} completed @ ${dgsm.getGameDateTime()} ===`
  );
  console.log("=".repeat(72));
  console.log(
    `commits: ${report.commits.length}, interruptions: ${report.interruptions.length}, ` +
      `cancellations: ${report.cancellations.length}, featureEvents: ${report.featureEvents.length}`
  );
  for (const a of report.commits) {
    console.log(`  ✓ COMMITTED      ${a.characterId}: ${a.actionText}`);
  }
  for (const i of report.interruptions) {
    console.log(
      `  ⚠ INTERRUPTED    ${i.action.characterId}: ${i.action.actionText}` +
        `   (reason: ${i.reason.description})`
    );
  }
  for (const c of report.cancellations) {
    console.log(`  ✗ CANCELLED      ${c.characterId}: ${c.actionText}`);
  }
  for (const e of report.featureEvents) {
    const tag = `(${e.type}, impact=${e.impact}${e.characterId ? `, actor=${e.characterId}` : ""})`;
    console.log(`  · EVENT ${tag}  ${e.description}`);
  }
});

// =========================================================================
// 5. DRIVE — bootstrap + N ticks
// =========================================================================

async function main() {
  console.log("\n=== test-role-agent (FULL E2E) ===");
  console.log(`NPCs: ${npc.name} (${npc.id}) + ${visitor.name} (${visitor.id})`);
  console.log(`Scene: ${scene.name} (${scene.id})`);
  console.log(
    `Provider: ${process.env.MODEL_PROVIDER ?? "(unset — generator falls back)"}`
  );

  const t0 = Date.now();

  console.log("\n--- Bootstrap (initial decide pass for all alive NPCs) ---");
  try {
    await controller.bootstrap();
  } catch (err) {
    console.error("Bootstrap threw:", err);
    process.exitCode = 1;
    return;
  }

  const N_TICKS = 3;
  for (let i = 0; i < N_TICKS; i++) {
    console.log(`\n--- Driving tick ${i + 1}/${N_TICKS} ---`);
    try {
      await engine.tick();
    } catch (err) {
      console.error(`engine.tick() threw on tick ${i + 1}:`, err);
      process.exitCode = 1;
      return;
    }
  }

  const ms = Date.now() - t0;
  console.log(`\n=== Done in ${(ms / 1000).toFixed(1)}s ===`);
  console.log(`Ticks observed: ${tickCount}`);
  console.log(`Final game time: ${dgsm.getGameDateTime()}`);
  console.log(`Memory writes during run: ${writtenMemories.length}`);
  for (const m of writtenMemories) {
    console.log(`  - npc=${m.npcId} (${m.type}) ${m.content.slice(0, 100)}`);
  }
}

main();
