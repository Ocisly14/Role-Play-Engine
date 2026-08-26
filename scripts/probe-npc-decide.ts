#!/usr/bin/env tsx
//
// scripts/probe-npc-decide.ts
//
// Diagnostic probe: run ONE real decide() pass for a single NPC against the
// persisted runtime of a session, tracing every agent iteration (tool choice
// + arguments). Answers "what does this NPC actually decide when asked?"
// without running a full tick for the whole cast.
//
// Run: pnpm tsx scripts/probe-npc-decide.ts --npc "Shandra Hernandez" \
//        [--session casssandra_full_sim]

import "dotenv/config";

import { createTickEngine } from "../src/engine/core/tickEngine.js";
import {
  collectKnownLocations,
  interpretAction,
} from "../src/engine/interpreter/gameInterpreter.js";
import {
  createDefaultDefinitions,
  createDefaultSubsystemRegistry,
} from "../src/engine/registerDefaults.js";
import { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import { ModelProviderName } from "../src/models/types.js";
import { EmbeddingClient } from "../src/rag/embedding.js";
import { LLMRoleSimAgent } from "../src/roleSim/llmAgent.js";
import { NpcActionController } from "../src/roleSim/npcActionController.js";
import { loadSimulationRuntime } from "../src/simulation/runtimePersistence.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { getPrismaClient } from "../src/shared/agents/memory/database/prismaClient.js";

const args = process.argv.slice(2);
const npcId = args.includes("--npc")
  ? args[args.indexOf("--npc") + 1]
  : "Shandra Hernandez";
const sessionId = args.includes("--session")
  ? args[args.indexOf("--session") + 1]
  : "casssandra_full_sim";

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const runtime = await loadSimulationRuntime(prisma, sessionId);
  if (!runtime) throw new Error(`No runtime for session ${sessionId}`);

  const gameState = DynamicGameStateManager.deserialize(runtime.gameState);
  const dgsm = new DynamicGameStateManager(gameState);
  const state = dgsm.getState();
  console.log(
    `[probe] session=${sessionId} tick=${runtime.tick} time=${state.gameDateTime}`
  );

  const pos = dgsm.getCharacterPosition(npcId);
  console.log(
    `[probe] npc=${npcId} alive=${dgsm.isNpcAlive(npcId)} ` +
      `position=${pos ? dgsm.resolveLocationId(pos) : "(none)"}`
  );

  const provider =
    (process.env.MODEL_PROVIDER as ModelProviderName) ??
    ModelProviderName.ANTHROPIC;
  const memory = new NpcMemoryManager(
    prisma,
    new EmbeddingClient(provider),
    runtime.language
  );

  const definitions = createDefaultDefinitions();
  const definitionList = definitions.getAll();
  const topology = dgsm.getTopology();
  const knownLocations = collectKnownLocations({
    scenarioOutlines: state.scenarioOutlines,
    scenes: state.scenes,
    junctions: topology.junctions,
    roads: topology.roads,
  });

  const engine = createTickEngine({
    dgsm,
    subsystemRegistry: createDefaultSubsystemRegistry(),
    scriptedEvents: [],
    interpretAction: async (input, directory) => {
      const result = await interpretAction(
        input.actionText,
        definitionList,
        runtime.language,
        directory,
        knownLocations
      );
      return { steps: result.steps };
    },
    resolve: async () => ({
      outcome: { stateChanges: [], elapsedMinutes: 1 },
      plannedDuration: 1,
    }),
    getActorDex: () => 50,
    tickDurationMinutes: 1,
    lang: runtime.language,
  });

  const moduleId = runtime.config.moduleId;
  let iteration = 0;
  const agent = new LLMRoleSimAgent({
    memory,
    dgsm,
    sessionId,
    moduleId,
    language: runtime.language,
    onIteration: (ev) => {
      iteration += 1;
      console.log(
        `\n[agent iteration ${iteration}] tool=${ev.parsed?.tool ?? "(none)"}`
      );
      if (ev.parsed) {
        console.log(`  args: ${JSON.stringify(ev.parsed).slice(0, 400)}`);
      }
      if (ev.responseText?.trim()) {
        console.log(
          `  text: ${ev.responseText.replace(/\n/g, " ").slice(0, 200)}`
        );
      }
    },
  });

  const controller = new NpcActionController({
    engine,
    agent,
    memory,
    dgsm,
    sessionId,
    moduleId,
    language: runtime.language,
  });

  console.log("\n[probe] running one decide() pass...\n");
  await controller.decide(npcId);

  const queue = engine.getActorQueue(npcId);
  console.log(`\n[probe] resulting queue for ${npcId}: ${queue.length} step(s)`);
  for (const s of queue) {
    console.log(
      `  - ${s.definitionId} (${s.status}) "${(s.actionText ?? "").slice(0, 100)}"`
    );
  }
  if (queue.length === 0) {
    console.log(
      "  (empty — the agent chose an instant/continue path, no action submitted)"
    );
  }
}

main()
  .then(async () => {
    await getPrismaClient().$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[probe] FAILED:", err);
    try {
      await getPrismaClient().$disconnect();
    } catch {}
    process.exit(1);
  });
