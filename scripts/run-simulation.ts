#!/usr/bin/env tsx
//
// scripts/run-simulation.ts
//
// Resumable simulation driver.
//
// - Fresh init injects the simulated NPC tiers (daily_sim + investigator_sim
//   per the module's __npc_injection_policy__; all NPCs if the module has no
//   policy) plus every scene/junction/road in the module.
// - Each invocation advances --ticks N ticks. The runner persists the full
//   runtime (game state + tick-engine queue) to the SimulationRuntime table
//   after every tick, so a crash mid-run loses at most the in-flight tick.
// - Re-running with the same --module/--session resumes exactly where the
//   previous invocation stopped. Use --fresh to discard the session and
//   rebuild from the latest module data on disk.
// - A per-invocation summary (status, final positions, events, LLM usage)
//   is written to logs/sim-<session>-<timestamp>.json.
//
// Usage:
//   pnpm tsx scripts/run-simulation.ts --module casssandra --fresh --ticks 10
//   pnpm tsx scripts/run-simulation.ts --module casssandra --ticks 20   # resume
//   pnpm tsx scripts/run-simulation.ts --module casssandra --status     # inspect only
//
// Requires DATABASE_URL and the *_API_KEY for MODEL_PROVIDER in .env.

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import type { TickEngine } from "../src/engine/core/tickEngine.js";
import { createDefaultDefinitions } from "../src/engine/registerDefaults.js";
import { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import { formatUsageReport, getUsageStats } from "../src/models/index.js";
import { ModelProviderName } from "../src/models/types.js";
import { EmbeddingClient } from "../src/rag/embedding.js";
import { seedNpcLongTermIntents } from "../src/roleSim/seedIntents.js";
import { SimulationRunner } from "../src/simulation/SimulationRunner.js";
import {
  deleteSimulationRuntime,
  loadSimulationRuntime,
} from "../src/simulation/runtimePersistence.js";
import type {
  SimulationConfig,
  SimulationEvent,
} from "../src/simulation/types.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { makeDateTime } from "../src/state/gameClock.js";
import { importModule } from "../src/state/moduleImporter.js";
import {
  type ModuleData,
  createSession,
  initRuntime,
  loadModule,
} from "../src/state/moduleLoader.js";
import { getPrismaClient } from "../src/shared/agents/memory/database/prismaClient.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  moduleName: string;
  moduleDir: string | null;
  sessionId: string;
  ticks: number;
  fresh: boolean;
  statusOnly: boolean;
  language: string;
}

function printHelp(): void {
  console.log(`Usage: pnpm tsx scripts/run-simulation.ts [options]

Options:
  --module <name>      Module under data/Mods (default: casssandra)
  --module-dir <path>  Explicit module directory (default: data/Mods/<module>)
  --session <id>       Session id (default: <module>_full_sim)
  --ticks <n>          Ticks to advance this invocation (default: 0)
  --fresh              Delete the session and rebuild from module data on disk
  --status             Print current runtime status and exit (no ticks)
  --lang <code>        Language for prompts/memory (default: en)
  --help               Show this help

Fresh init injects the daily_sim + investigator_sim tiers per the module's
npc_injection_policy (all NPCs if the module has none). State persists to the
DB after every tick; rerunning with the same session resumes automatically.`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    moduleName: "casssandra",
    moduleDir: null,
    sessionId: "",
    ticks: 0,
    fresh: false,
    statusOnly: false,
    language: "en",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--fresh") {
      options.fresh = true;
      continue;
    }
    if (arg === "--status") {
      options.statusOnly = true;
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined) throw new Error(`Missing value for ${arg}`);
    switch (arg) {
      case "--module":
        options.moduleName = next;
        i++;
        break;
      case "--module-dir":
        options.moduleDir = path.resolve(next);
        i++;
        break;
      case "--session":
        options.sessionId = next;
        i++;
        break;
      case "--ticks": {
        const n = Number(next);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`Invalid --ticks value: ${next}`);
        }
        options.ticks = n;
        i++;
        break;
      }
      case "--lang":
        options.language = next;
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.sessionId) options.sessionId = `${options.moduleName}_full_sim`;
  if (!options.moduleDir) {
    options.moduleDir = path.join(
      process.cwd(),
      "data",
      "Mods",
      options.moduleName
    );
  }
  return options;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveInitialTimeOfDay(moduleData: ModuleData): string {
  const setupData = moduleData.setup as Record<string, unknown> | null;
  const raw =
    typeof setupData?.initialGameTime === "string"
      ? setupData.initialGameTime.trim()
      : "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${match[1].padStart(2, "0")}:${match[2]}`;
    }
  }
  return "08:00";
}

/** Seed each NPC's map memory with its known map + current location, matching
 *  DynamicGameStateLoader's bootstrap (which this script bypasses in order to
 *  disable the injection policy). */
async function seedNpcMapMemory(params: {
  dgsm: DynamicGameStateManager;
  memoryManager: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  gameDateTime: string;
}): Promise<void> {
  const { dgsm, memoryManager, sessionId, moduleId, gameDateTime } = params;
  const state = dgsm.getState();
  await Promise.all(
    state.npcCharacters.map(async (npc) => {
      const position = dgsm.getCharacterPosition(npc.id);
      const location = position ? dgsm.resolveLocationId(position) : undefined;
      const seed = npc.knownMapSeed;
      const seedWithCurrentLocation = (() => {
        if (!position) return seed;
        switch (position.type) {
          case "scene":
            return {
              ...seed,
              sceneIds: [
                ...new Set([...(seed?.sceneIds ?? []), position.sceneId]),
              ],
            };
          case "junction":
            return {
              ...seed,
              junctionIds: [
                ...new Set([...(seed?.junctionIds ?? []), position.junctionId]),
              ],
            };
          case "road":
            return {
              ...seed,
              roadIds: [...new Set([...(seed?.roadIds ?? []), position.roadId])],
            };
        }
      })();

      await memoryManager.ensureMapSnapshot({
        npcId: npc.id,
        sessionId,
        moduleId,
        gameDateTime,
        location,
        dgsm,
        seed: seedWithCurrentLocation,
      });
      if (location) {
        await memoryManager.ensureCurrentLocationInMap({
          npcId: npc.id,
          sessionId,
          moduleId,
          gameDateTime,
          location,
          dgsm,
        });
      }
    })
  );
}

function buildRunner(params: {
  dgsm: DynamicGameStateManager;
  memoryManager: NpcMemoryManager;
  config: SimulationConfig;
  language: string;
}): SimulationRunner {
  const prisma = getPrismaClient();
  return new SimulationRunner({
    config: params.config,
    dgsm: params.dgsm,
    definitions: createDefaultDefinitions(),
    language: params.language,
    memoryManager: params.memoryManager,
    prisma,
  });
}

function describePositions(dgsm: DynamicGameStateManager): Record<
  string,
  { name: string; location: string | null }
> {
  const out: Record<string, { name: string; location: string | null }> = {};
  for (const npc of dgsm.getState().npcCharacters) {
    const position = dgsm.getCharacterPosition(npc.id);
    out[npc.id] = {
      name: npc.name,
      location: position ? dgsm.resolveLocationId(position) : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prisma = getPrismaClient();
  const provider =
    (process.env.MODEL_PROVIDER as ModelProviderName) ??
    ModelProviderName.ANTHROPIC;
  const embedClient = new EmbeddingClient(provider);
  const memoryManager = new NpcMemoryManager(
    prisma,
    embedClient,
    options.language
  );

  console.log(
    `[run-simulation] module=${options.moduleName} session=${options.sessionId} ` +
      `ticks=${options.ticks} fresh=${options.fresh} provider=${provider}`
  );

  if (options.fresh) {
    try {
      await deleteSimulationRuntime(prisma, options.sessionId);
      console.log(`[run-simulation] Deleted existing session ${options.sessionId}`);
    } catch {
      // No prior session — nothing to delete.
    }
  }

  let runner: SimulationRunner;
  const existing = options.fresh
    ? null
    : await loadSimulationRuntime(prisma, options.sessionId);

  if (existing) {
    // ---- Resume path -----------------------------------------------------
    console.log(
      `[run-simulation] Resuming session at tick ${existing.tick}, ` +
        `gameDateTime=${existing.gameState.gameDateTime}`
    );
    const persistedTickEngineState = (
      existing.gameState as Record<string, unknown>
    )._tickEngine as ReturnType<TickEngine["serialize"]> | undefined;
    const gameState = DynamicGameStateManager.deserialize(existing.gameState);
    const dgsm = new DynamicGameStateManager(gameState);
    runner = buildRunner({
      dgsm,
      memoryManager,
      config: existing.config,
      language: existing.language || options.language,
    });
    runner.hydrateFromRuntime({
      state: existing.simulationState,
      ticksExecuted: existing.tick,
      stopReason: existing.stopReason,
      persistedTickEngineState,
    });
    runner.setModuleName(existing.moduleName ?? options.moduleName);
  } else {
    // ---- Fresh init path -------------------------------------------------
    if (!options.moduleDir || !fs.existsSync(options.moduleDir)) {
      throw new Error(`Module directory not found: ${options.moduleDir}`);
    }
    console.log(`[run-simulation] Importing module from ${options.moduleDir}`);
    const moduleId = await importModule({
      prisma,
      moduleDir: options.moduleDir,
      moduleName: options.moduleName,
    });

    const moduleData = await loadModule(prisma, moduleId);
    if (!moduleData) throw new Error(`Failed to load module ${moduleId}`);
    if (!moduleData.setup?.startDate) {
      throw new Error(
        `Module "${moduleId}" missing ModuleSetup.startDate (YYYY-MM-DD).`
      );
    }

    // Injection follows the module's npc_injection_policy defaults:
    // daily_sim + investigator_sim tiers only (see filterNpcsByPolicy).
    // Modules without a policy inject every NPC.

    await createSession(prisma, {
      sessionId: options.sessionId,
      moduleId,
      moduleData,
      embedClient,
    });

    const gameDateTime = makeDateTime(
      moduleData.setup.startDate,
      resolveInitialTimeOfDay(moduleData)
    );
    const state = initRuntime({
      sessionId: options.sessionId,
      moduleData,
      gameDateTime,
    });
    const dgsm = new DynamicGameStateManager(state);

    await seedNpcMapMemory({
      dgsm,
      memoryManager,
      sessionId: options.sessionId,
      moduleId,
      gameDateTime,
    });
    await seedNpcLongTermIntents({
      npcs: state.npcCharacters,
      sessionId: options.sessionId,
      moduleId,
      memoryManager,
      gameDateTime,
    });

    runner = buildRunner({
      dgsm,
      memoryManager,
      config: {
        sessionId: options.sessionId,
        moduleId,
        mode: "paused",
      },
      language: options.language,
    });
    runner.setModuleName(options.moduleName);
    await runner.saveRuntime();
    console.log(
      `[run-simulation] Initialized fresh session — ` +
        `${state.npcCharacters.length} NPCs, ${moduleData.scenes.size} scenes, ` +
        `start=${gameDateTime}`
    );
  }

  const before = runner.getStatus();
  if (options.statusOnly || options.ticks === 0) {
    console.log(
      `[run-simulation] Status: state=${before.state} tick=${before.ticksExecuted} ` +
        `gameDateTime=${before.currentDateTime}`
    );
    if (options.ticks === 0) {
      console.log("[run-simulation] No --ticks given; nothing to advance.");
    }
    return;
  }

  if (before.state !== "paused") {
    throw new Error(
      `Session is "${before.state}" — step() requires a paused session. ` +
        `(stopped/completed sessions cannot be resumed; use --fresh)`
    );
  }

  // Collect this invocation's events for the run summary. The runner also
  // persists every event to the SimulationEvent table itself.
  const runEvents: SimulationEvent[] = [];
  runner.setBroadcastCallback((events) => {
    runEvents.push(...events);
  });

  console.log(`[run-simulation] Advancing ${options.ticks} tick(s)...`);
  const startedAt = Date.now();
  await runner.step(options.ticks);
  // step() persists after each tick; save once more so the final paused state
  // (including the tick-engine queue) is what lands in the DB.
  await runner.saveRuntime();
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);

  const after = runner.getStatus();
  console.log(
    `\n[run-simulation] Done in ${elapsedS}s — tick ${before.ticksExecuted} → ` +
      `${after.ticksExecuted}, gameDateTime=${after.currentDateTime}, ` +
      `state=${after.state}`
  );

  const positions = describePositions(runner.getDgsm());
  for (const [id, info] of Object.entries(positions)) {
    console.log(`  ${info.name} (${id}) → ${info.location ?? "(unknown)"}`);
  }
  console.log(`\n--- LLM token usage / prompt cache ---\n${formatUsageReport()}`);

  const logsDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = path.join(
    logsDir,
    `sim-${options.sessionId}-${stamp}.json`
  );
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        module: options.moduleName,
        sessionId: options.sessionId,
        provider,
        ticksRequested: options.ticks,
        tickBefore: before.ticksExecuted,
        tickAfter: after.ticksExecuted,
        gameDateTime: after.currentDateTime,
        state: after.state,
        elapsedSeconds: Number(elapsedS),
        positions,
        events: runEvents,
        llmUsage: getUsageStats(),
      },
      null,
      2
    )
  );
  console.log(`\n(wrote run summary → ${summaryPath})`);
  console.log(
    `[run-simulation] Session persisted. Resume with:\n` +
      `  pnpm tsx scripts/run-simulation.ts --module ${options.moduleName} ` +
      `--session ${options.sessionId} --ticks <n>`
  );
}

main()
  .then(async () => {
    await getPrismaClient().$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[run-simulation] FAILED:", error);
    try {
      await getPrismaClient().$disconnect();
    } catch {
      // ignore
    }
    process.exit(1);
  });
