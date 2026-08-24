#!/usr/bin/env tsx

/**
 * Run Cassandra module simulation init test, following the same lifecycle as
 * scripts/run-simple-town.ts:
 *   import module -> load module -> create/resume session -> init runtime
 *   -> seed intents -> optionally generate day-1 schedules -> save paused runtime
 *
 * Usage:
 *   npx tsx scripts/run-cassandra.ts
 *   npx tsx scripts/run-cassandra.ts --fresh
 *   npx tsx scripts/run-cassandra.ts --ticks 1
 *   npx tsx scripts/run-cassandra.ts --module-dir testmods/casssandra --fresh
 */

import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createExecutionContext } from "../src/engine/executionContext.js";
import { createDefaultDefinitions } from "../src/engine/registerDefaults.js";
import { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import { getModelSettings } from "../src/models/index.js";
import { ModelClass, ModelProviderName } from "../src/models/types.js";
import { NPCPlanningAgent } from "../src/planning/NPCPlanningAgent.js";
import { EmbeddingClient } from "../src/rag/embedding.js";
import { SimulationRunner } from "../src/simulation/SimulationRunner.js";
import type { SimulationState, StopReason } from "../src/simulation/types.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { importModule } from "../src/state/moduleImporter.js";
import {
  type ModuleData,
  createSession,
  initRuntime,
  loadModule,
} from "../src/state/moduleLoader.js";
import type { DynamicNPCProfile } from "../src/state/types.js";

const MODULE_NAME = "casssandra";
const SESSION_ID = "casssandra_module_runtime";
const LANGUAGE = "en";
const DEFAULT_MODULE_DIR = path.join(
  process.cwd(),
  "data",
  "Mods",
  MODULE_NAME
);

interface Options {
  moduleDir: string;
  forceFresh: boolean;
  days: number;
  ticks: number;
  useSmallModel: boolean;
}

interface NpcProfileIssue {
  npcLabel: string;
  problems: string[];
}

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/run-cassandra.ts [options]

Options:
  --fresh              Delete prior runtime session and start from latest module data
  --days <n>           Run simulation for n in-game days from current day
  --ticks <n>          Step simulation n ticks after init/resume. Default: 0
  --module-dir <path>  Module directory to import. Default: data/Mods/casssandra
  --use-small-model    Override this script's medium-generation calls to use the provider's small model
  --help               Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    moduleDir: DEFAULT_MODULE_DIR,
    forceFresh: false,
    days: 0,
    ticks: 0,
    useSmallModel: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--fresh") {
      options.forceFresh = true;
      continue;
    }
    if (arg === "--use-small-model") {
      options.useSmallModel = true;
      continue;
    }

    const next = argv[i + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--days":
        options.days = Number(next);
        if (!Number.isInteger(options.days) || options.days < 0) {
          throw new Error(`Invalid --days value: ${next}`);
        }
        i++;
        break;
      case "--ticks":
        options.ticks = Number(next);
        if (!Number.isInteger(options.ticks) || options.ticks < 0) {
          throw new Error(`Invalid --ticks value: ${next}`);
        }
        i++;
        break;
      case "--module-dir":
        options.moduleDir = path.resolve(next);
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function getModelEnvVarNames(
  provider: ModelProviderName
): { small: string; medium: string } | null {
  switch (provider) {
    case ModelProviderName.OPENAI:
      return {
        small: "SMALL_OPENAI_MODEL",
        medium: "MEDIUM_OPENAI_MODEL",
      };
    case ModelProviderName.ANTHROPIC:
      return {
        small: "SMALL_ANTHROPIC_MODEL",
        medium: "MEDIUM_ANTHROPIC_MODEL",
      };
    case ModelProviderName.GOOGLE:
      return {
        small: "SMALL_GOOGLE_MODEL",
        medium: "MEDIUM_GOOGLE_MODEL",
      };
    default:
      return null;
  }
}

function applySmallModelOverride(provider: ModelProviderName): void {
  const envVars = getModelEnvVarNames(provider);
  if (!envVars) {
    throw new Error(`Unsupported provider for model override: ${provider}`);
  }

  const smallModelName = process.env[envVars.small];
  if (!smallModelName) {
    throw new Error(
      `Cannot override to small model because ${envVars.small} is not set`
    );
  }

  process.env[envVars.medium] = smallModelName;
}

function resolveNodeName(
  dgsm: DynamicGameStateManager,
  locationId: string
): string {
  const scene = dgsm.getScene(locationId);
  if (scene?.name) return scene.name;

  const outline = dgsm
    .getState()
    .scenarioOutlines.find((entry) => entry.id === locationId);
  return outline?.name ?? locationId;
}

function parseInitialTime(raw: unknown): {
  gameDay: number;
  timeOfDay: string;
} {
  if (typeof raw !== "string") {
    return { gameDay: 1, timeOfDay: "08:00" };
  }

  const match = /day\s+(\d+),?\s*(\d{1,2}):(\d{2})/i.exec(raw);
  if (!match) {
    return { gameDay: 1, timeOfDay: "08:00" };
  }

  return {
    gameDay: Number(match[1]),
    timeOfDay: `${match[2].padStart(2, "0")}:${match[3]}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSimulationState(value: unknown): SimulationState {
  if (
    value === "running" ||
    value === "paused" ||
    value === "stopped" ||
    value === "completed"
  ) {
    return value;
  }

  throw new Error(`Invalid persisted simulationState: ${String(value)}`);
}

function parseStopReason(value: unknown): StopReason | undefined {
  if (
    value === undefined ||
    value === null ||
    value === "manual" ||
    value === "max_days" ||
    value === "event_triggered"
  ) {
    return value ?? undefined;
  }

  throw new Error(`Invalid persisted stopReason: ${String(value)}`);
}

function validateNpcProfiles(npcs: DynamicNPCProfile[]): NpcProfileIssue[] {
  const issues: NpcProfileIssue[] = [];
  const seenIds = new Set<string>();

  for (const npc of npcs) {
    const problems: string[] = [];
    const npcLabel =
      typeof npc.name === "string" && npc.name.trim().length > 0
        ? npc.name
        : "<unnamed npc>";

    if (typeof npc.id !== "string" || npc.id.trim().length === 0) {
      problems.push("missing id");
    } else if (seenIds.has(npc.id)) {
      problems.push(`duplicate id "${npc.id}"`);
    } else {
      seenIds.add(npc.id);
    }

    if (typeof npc.name !== "string" || npc.name.trim().length === 0) {
      problems.push("missing name");
    }

    if (
      typeof npc.longTermIntent !== "string" ||
      npc.longTermIntent.trim().length === 0
    ) {
      problems.push("missing longTermIntent");
    }

    if (!npc.status || typeof npc.status !== "object") {
      problems.push("missing status");
    }

    if (!npc.attributes || typeof npc.attributes !== "object") {
      problems.push("missing attributes");
    }

    if (!npc.skills || typeof npc.skills !== "object") {
      problems.push("missing skills");
    }

    if (!Array.isArray(npc.inventory)) {
      problems.push("inventory is not an array");
    }

    if (!Array.isArray(npc.relationships)) {
      problems.push("relationships is not an array");
    }

    if (problems.length > 0) {
      issues.push({ npcLabel, problems });
    }
  }

  return issues;
}

function assertModuleDataIsUsable(moduleData: ModuleData): void {
  const npcIssues = validateNpcProfiles(moduleData.npcs);

  console.log("═══ Module Validation ═══");
  console.log(
    `npcs=${moduleData.npcs.length} scenes=${moduleData.scenes.size} junctions=${moduleData.junctions.size} roads=${moduleData.roads.size} outlines=${moduleData.scenarioOutlines.length} npcIssues=${npcIssues.length}`
  );

  if (npcIssues.length === 0) {
    return;
  }

  for (const issue of npcIssues) {
    console.log(`- ${issue.npcLabel}: ${issue.problems.join(", ")}`);
  }

  throw new Error(
    `Module "${MODULE_NAME}" contains ${npcIssues.length} invalid NPC profiles`
  );
}

async function cleanupSession(prisma: PrismaClient): Promise<void> {
  await prisma.simulationRuntime.deleteMany({
    where: { sessionId: SESSION_ID },
  });
  await prisma.simulationEvent.deleteMany({
    where: { sessionId: SESSION_ID },
  });
  await prisma.npcMemory.deleteMany({
    where: { sessionId: SESSION_ID },
  });
  await prisma.npcDailyPlan.deleteMany({
    where: { sessionId: SESSION_ID },
  });
  await prisma.npcLongTermIntent.deleteMany({
    where: { sessionId: SESSION_ID },
  });
  await prisma.session.deleteMany({
    where: { sessionId: SESSION_ID },
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider =
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.GOOGLE;

  if (options.useSmallModel) {
    applySmallModelOverride(provider);
  }

  const mediumModel = getModelSettings(provider, ModelClass.MEDIUM)?.name;
  console.log(
    `═══ Model Selection ═══\nprovider=${provider} effectiveMediumModel=${mediumModel ?? "unknown"} useSmallModel=${options.useSmallModel}`
  );

  const prisma = new PrismaClient();
  const embedClient = new EmbeddingClient(provider);

  try {
    console.log("═══ Importing Cassandra Module ═══");
    console.log(`moduleDir=${options.moduleDir}`);

    const moduleId = await importModule({
      prisma,
      moduleDir: options.moduleDir,
      moduleName: MODULE_NAME,
    });

    const moduleData = await loadModule(prisma, moduleId);
    if (!moduleData) {
      throw new Error(`Failed to load module "${MODULE_NAME}" after import`);
    }

    assertModuleDataIsUsable(moduleData);

    const existingRuntime = options.forceFresh
      ? null
      : await prisma.simulationRuntime.findUnique({
          where: { sessionId: SESSION_ID },
        });

    const definitions = createDefaultDefinitions();
    const ctx = createExecutionContext();
    const memoryManager = new NpcMemoryManager(prisma, embedClient, LANGUAGE);
    const npcPlanningAgent = new NPCPlanningAgent(prisma, {}, memoryManager);

    let dgsm: DynamicGameStateManager;
    let initializedFreshRuntime = false;
    let startDay = 1;

    if (existingRuntime && !options.forceFresh) {
      console.log("═══ Resuming Existing Runtime Session ═══");
      if (!isRecord(existingRuntime.gameState)) {
        throw new Error("Persisted gameState is not an object");
      }

      dgsm = new DynamicGameStateManager(
        DynamicGameStateManager.deserialize(existingRuntime.gameState)
      );
      startDay = dgsm.getState().gameDay;
      console.log(
        `day=${startDay} time=${dgsm.getState().timeOfDay} tick=${existingRuntime.tick}`
      );
    } else {
      if (options.forceFresh) {
        await cleanupSession(prisma);
        console.log("═══ Cleaned Previous Runtime Session ═══");
      }

      console.log("═══ Creating Fresh Runtime Session ═══");
      await createSession(prisma, {
        sessionId: SESSION_ID,
        moduleId,
        moduleData,
        embedClient,
      });

      const { gameDay, timeOfDay } = parseInitialTime(
        (moduleData.setup as Record<string, unknown> | null)?.initialGameTime
      );
      dgsm = new DynamicGameStateManager(
        initRuntime({
          sessionId: SESSION_ID,
          moduleData,
          gameDay,
          timeOfDay,
        })
      );
      startDay = gameDay;
      initializedFreshRuntime = true;

      console.log("═══ Seeding NPC Intents ═══");
      await npcPlanningAgent.seedLongTermIntents(dgsm, SESSION_ID, moduleId);
      console.log(`initialized day=${gameDay} time=${timeOfDay}`);
    }

    const state = dgsm.getState();
    const validNodeIds = new Set([
      ...Array.from(state.scenes.keys()),
      ...Array.from(state.junctions.keys()),
      ...Array.from(state.roads.keys()),
    ]);
    const badOutlineEntries = state.scenarioOutlines.filter(
      (entry) => entry.entrySceneId && !validNodeIds.has(entry.entrySceneId)
    );
    const badNpcPositions = state.npcCharacters.filter((npc) => {
      const position = state.characterPositions[npc.id];
      if (!position) return true;
      if (position.type === "scene") {
        return !state.scenes.has(position.sceneId);
      }
      if (position.type === "junction") {
        return !state.junctions.has(position.junctionId);
      }
      return !state.roads.has(position.roadId);
    });

    console.log("═══ Runtime Validation ═══");
    console.log(
      `topology=${state.topology ? "ok" : "missing"} badOutlineEntries=${badOutlineEntries.length} badNpcPositions=${badNpcPositions.length}`
    );

    if (badOutlineEntries.length > 0) {
      console.log(
        `bad outlines: ${badOutlineEntries.map((entry) => `${entry.id}->${entry.entrySceneId}`).join(", ")}`
      );
    }
    if (badNpcPositions.length > 0) {
      console.log(
        `bad NPC positions: ${badNpcPositions.map((npc) => npc.name).join(", ")}`
      );
    }
    if (
      !state.topology ||
      badOutlineEntries.length > 0 ||
      badNpcPositions.length > 0
    ) {
      throw new Error("Cassandra runtime validation failed");
    }

    console.log("═══ Sample NPC Spawn Points ═══");
    for (const npc of state.npcCharacters.slice(0, 10)) {
      const position = state.characterPositions[npc.id];
      const nodeId =
        position?.type === "scene"
          ? position.sceneId
          : position?.type === "junction"
            ? position.junctionId
            : (position?.roadId ?? "unknown");
      console.log(`- ${npc.name}: ${resolveNodeName(dgsm, nodeId)}`);
    }

    if (initializedFreshRuntime && (options.ticks > 0 || options.days > 0)) {
      console.log(`═══ Generating Day ${startDay} Schedules ═══`);
      await npcPlanningAgent.generateDailySchedule(
        dgsm,
        SESSION_ID,
        moduleId,
        startDay,
        LANGUAGE,
        definitions
      );
    }

    const runner = new SimulationRunner({
      config: {
        sessionId: SESSION_ID,
        moduleId,
        mode: "paused",
        maxDays: options.days > 0 ? startDay + options.days - 1 : startDay,
      },
      dgsm,
      npcPlanningAgent,
      definitions,
      ctx,
      language: LANGUAGE,
      memoryManager,
      prisma,
    });
    runner.setModuleName(MODULE_NAME);

    if (existingRuntime && !options.forceFresh) {
      runner.hydrateFromRuntime({
        state: parseSimulationState(existingRuntime.simulationState),
        ticksExecuted: existingRuntime.tick,
        stopReason: parseStopReason(existingRuntime.stopReason),
      });
    }

    await runner.saveRuntime();
    console.log("═══ Paused Runtime Saved ═══");

    if (options.days > 0) {
      const endDay = startDay + options.days - 1;
      const minutesPerDay = 24 * 60;
      const maxTicks = minutesPerDay * options.days;
      console.log(
        `═══ Running Simulation — Day ${startDay}${options.days > 1 ? ` to ${endDay}` : ""} ═══`
      );

      for (let tick = 0; tick < maxTicks; tick++) {
        const currentDay = dgsm.getState().gameDay;
        if (currentDay > endDay) {
          break;
        }

        await runner.step(1);

        if (tick % 60 === 0) {
          await runner.saveRuntime();
        }
      }

      await runner.saveRuntime();
    } else if (options.ticks > 0) {
      console.log(`═══ Stepping ${options.ticks} Tick(s) ═══`);
      await runner.step(options.ticks);
      await runner.saveRuntime();
    }

    const status = runner.getStatus();
    console.log("═══ Final Status ═══");
    console.log(
      `state=${status.state} day=${status.currentDay} time=${status.currentTime} ticks=${status.ticksExecuted}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
