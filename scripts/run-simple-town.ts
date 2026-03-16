/**
 * Run simple_town module simulation, with resume support.
 *
 * Usage:
 *   npx tsx scripts/run-simple-town.ts              # fresh start or resume
 *   npx tsx scripts/run-simple-town.ts --fresh      # force fresh start
 *   npx tsx scripts/run-simple-town.ts --days 3     # run for 3 days
 */

import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { NPCPlanningAgent } from "../src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import { createExecutionContext } from "../src/dynamicworldagent/engine/executionContext.js";
import { createDefaultRegistry } from "../src/dynamicworldagent/engine/registerDefaults.js";
import { NpcMemoryManager } from "../src/dynamicworldagent/memory/NpcMemoryManager.js";
import { SimulationRunner } from "../src/dynamicworldagent/simulation/SimulationRunner.js";
import { DynamicGameStateManager } from "../src/dynamicworldagent/state/DynamicGameState.js";
import { importModule } from "../src/dynamicworldagent/state/moduleImporter.js";
import {
  createSession,
  initRuntime,
  loadModule,
} from "../src/dynamicworldagent/state/moduleLoader.js";
import { ModelProviderName } from "../src/models/types.js";
import { EmbeddingClient } from "../src/rag/embedding.js";

const MODULE_NAME = "simple_town";
const SESSION_ID = `simple_town_sim`;
const LANGUAGE = "en";

/** Resolve a location ID to a human-readable scene name */
function resolveSceneName(
  dgsm: DynamicGameStateManager,
  locationId: string
): string {
  // Try sub-scene first
  const scene = dgsm.getScene(locationId);
  if (scene?.name) return scene.name;
  // Try scenario outlines (macro locations like SCN_1, SCN_4)
  const outline = dgsm
    .getState()
    .scenarioOutlines.find((o) => o.id === locationId);
  if (outline?.name) return outline.name;
  return locationId;
}

// Parse CLI args
const args = process.argv.slice(2);
const forceFresh = args.includes("--fresh");
const daysArg = args.indexOf("--days");
const maxDays = daysArg >= 0 ? Number(args[daysArg + 1]) || 1 : 1;

async function main() {
  const prisma = new PrismaClient();
  const provider =
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.GOOGLE;
  const embedClient = new EmbeddingClient(provider);

  try {
    // ─── Step 1: Import module ───
    console.log("═══ Importing module ═══");
    const moduleDir = path.join(process.cwd(), "data", "Mods", MODULE_NAME);
    const moduleId = await importModule({
      prisma,
      moduleDir,
      moduleName: MODULE_NAME,
    });

    // ─── Step 2: Load module data ───
    const moduleData = await loadModule(prisma, moduleId);
    if (!moduleData) throw new Error("Failed to load module");
    console.log(
      `NPCs: ${moduleData.npcs.map((n) => n.name).join(", ")} | Scenes: ${moduleData.scenes.size}`
    );

    // ─── Step 3: Check for existing runtime (resume support) ───
    const existingRuntime = forceFresh
      ? null
      : await prisma.simulationRuntime.findUnique({
          where: { sessionId: SESSION_ID },
        });

    const registry = createDefaultRegistry();
    const ctx = createExecutionContext(registry);
    const memoryManager = new NpcMemoryManager(prisma, embedClient);
    const npcPlanningAgent = new NPCPlanningAgent(prisma, {}, memoryManager);

    let dgsm: DynamicGameStateManager;
    let startDay: number;

    if (existingRuntime && !forceFresh) {
      // ─── Resume from saved state ───
      console.log(
        `\n═══ Resuming from saved state (tick ${existingRuntime.tick}) ═══`
      );
      const savedState = existingRuntime.gameState as any;
      const restoredState = DynamicGameStateManager.deserialize(savedState);
      dgsm = new DynamicGameStateManager(restoredState);
      startDay = dgsm.getState().gameDay;
      console.log(
        `  Day ${startDay}, Time ${dgsm.getState().timeOfDay}, Ticks: ${existingRuntime.tick}`
      );
    } else {
      // ─── Fresh start ───
      if (forceFresh) {
        // Clean up old session data
        await prisma.simulationRuntime.deleteMany({
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
        await prisma.simulationEvent.deleteMany({
          where: { sessionId: SESSION_ID },
        });
        await prisma.session.deleteMany({
          where: { sessionId: SESSION_ID },
        });
        console.log("  Cleaned up previous session data.");
      }

      console.log("\n═══ Creating session ═══");
      await createSession(prisma, {
        sessionId: SESSION_ID,
        moduleId,
        moduleData,
        embedClient,
      });

      const setupData = moduleData.setup as Record<string, any> | null;
      let gameDay = 1;
      let timeOfDay = "07:00";
      if (setupData?.initialGameTime) {
        const match = /day\s+(\d+),?\s*(\d{1,2}):(\d{2})/i.exec(
          setupData.initialGameTime
        );
        if (match) {
          gameDay = Number(match[1]);
          timeOfDay = `${match[2].padStart(2, "0")}:${match[3]}`;
        }
      }

      const state = initRuntime({
        sessionId: SESSION_ID,
        moduleData,
        gameDay,
        timeOfDay,
      });
      dgsm = new DynamicGameStateManager(state);
      startDay = gameDay;

      // Seed intents
      console.log("\n═══ Seeding NPC intents ═══");
      await npcPlanningAgent.seedLongTermIntents(dgsm, SESSION_ID, moduleId);
      for (const npc of moduleData.npcs) {
        const intent = await npcPlanningAgent.getLongTermIntent(
          SESSION_ID,
          npc.id
        );
        console.log(`  ${npc.name}: ${intent.slice(0, 80)}...`);
      }

      // Generate first day schedule
      console.log(`\n═══ Generating Day ${gameDay} schedules ═══`);
      await npcPlanningAgent.generateDailySchedule(
        dgsm,
        SESSION_ID,
        moduleId,
        gameDay,
        LANGUAGE,
        registry
      );
      printSchedules(dgsm, npcPlanningAgent, moduleData.npcs, gameDay);
    }

    // ─── Step 4: Create SimulationRunner ───
    const runner = new SimulationRunner({
      config: {
        sessionId: SESSION_ID,
        moduleId,
        mode: "paused",
        maxDays,
      },
      dgsm,
      npcPlanningAgent,
      registry,
      ctx,
      language: LANGUAGE,
      memoryManager,
      prisma,
    });

    if (existingRuntime) {
      runner.hydrateFromRuntime({
        state: existingRuntime.simulationState as any,
        ticksExecuted: existingRuntime.tick,
        stopReason: existingRuntime.stopReason as any,
      });
    }

    // Tick log for JSON output
    const tickLog: Array<{
      tick: number;
      gameDay: number;
      gameTime: string;
      type: string;
      actor: string;
      location: string;
      action?: string;
      outcome?: string;
      skill?: string;
      status: string;
      reason?: string;
    }> = [];

    // Intercept [Planning] log lines to capture revise/schedule events in tickLog
    const origLog = console.log;
    console.log = (...args: any[]) => {
      const msg = args[0];
      if (typeof msg !== "string") {
        origLog(...args);
        return;
      }
      const gs = dgsm.getState();
      // ⚡ Revising plans for NpcName: reason...
      const reviseMatch = msg.match(
        /\[Planning\] ⚡ Revising plans for (.+?): (.+)/
      );
      if (reviseMatch) {
        const actor = reviseMatch[1];
        const reason = reviseMatch[2].replace(/^"|"$/g, "");
        origLog(`  [${gs.timeOfDay}] ↻ ${actor}: revise plans — ${reason}`);
        tickLog.push({
          tick: runner.getStatus().ticksExecuted,
          gameDay: gs.gameDay,
          gameTime: gs.timeOfDay,
          type: "plan_revised",
          actor,
          location: "",
          action: "revisePlans",
          reason,
          status: "revised",
        });
        return;
      }
      // 🔄 Revising schedule for NpcName: reason...
      const schedMatch = msg.match(
        /\[Planning\] 🔄 Revising schedule for (.+?): (.+)/
      );
      if (schedMatch) {
        const actor = schedMatch[1];
        const reason = schedMatch[2].replace(/^"|"$/g, "");
        origLog(`  [${gs.timeOfDay}] ↺ ${actor}: revise schedule — ${reason}`);
        tickLog.push({
          tick: runner.getStatus().ticksExecuted,
          gameDay: gs.gameDay,
          gameTime: gs.timeOfDay,
          type: "schedule_revised",
          actor,
          location: "",
          action: "reviseSchedule",
          reason,
          status: "revised",
        });
        return;
      }

      origLog(...args);
    };

    // Wire event listener
    runner.events.on("simulation_event", (event: any) => {
      const sceneName = resolveSceneName(dgsm, event.location);
      const data = event.data ?? {};

      if (event.type === "action_executed") {
        console.log(
          `  [${event.gameTime}] ✓ ${data.characterName ?? event.actorNpcId} @ ${sceneName}: ${data.action ?? ""}`
        );
        tickLog.push({
          tick: event.tick,
          gameDay: event.gameDay,
          gameTime: event.gameTime,
          type: data.type ?? "action",
          actor: data.characterName ?? event.actorNpcId,
          location: sceneName,
          action: data.action,
          outcome: data.outcome,
          skill: data.skill,
          status: "success",
        });
      } else if (event.type === "action_failed") {
        console.log(
          `  [${event.gameTime}] ✗ ${data.characterName ?? event.actorNpcId} @ ${sceneName}: ${data.action ?? ""}`
        );
        if (data.outcome) {
          console.log(`           → ${data.outcome}`);
        }
        tickLog.push({
          tick: event.tick,
          gameDay: event.gameDay,
          gameTime: event.gameTime,
          type: data.type ?? "action",
          actor: data.characterName ?? event.actorNpcId,
          location: sceneName,
          action: data.action,
          outcome: data.outcome,
          skill: data.skill,
          status: "failed",
        });
      } else if (event.type === "npc_moved") {
        const toScene = resolveSceneName(dgsm, data.toLocation as string);
        console.log(
          `  [${event.gameTime}] 🚶 ${data.characterName ?? event.actorNpcId}: moved to ${toScene}`
        );
        tickLog.push({
          tick: event.tick,
          gameDay: event.gameDay,
          gameTime: event.gameTime,
          type: "movement",
          actor: data.characterName ?? event.actorNpcId,
          location: toScene,
          action: `moved to ${toScene}`,
          status: "success",
        });
      } else if (event.type === "day_transition") {
        console.log(`\n═══ Day ${event.gameDay} ═══\n`);
      }
    });

    // ─── Step 5: Run simulation ───
    const endDay = startDay + maxDays - 1;
    console.log(
      `\n═══ Running simulation — Day ${startDay}${maxDays > 1 ? ` to ${endDay}` : ""} ═══\n`
    );

    const TICKS_PER_DAY = 192;
    const MAX_TICKS = TICKS_PER_DAY * maxDays;
    let interrupted = false;

    process.on("SIGINT", () => {
      if (interrupted) process.exit(1); // second Ctrl+C = force quit
      console.log(
        "\n⏸ Ctrl+C received — saving and exiting after current tick..."
      );
      interrupted = true;
    });

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      if (interrupted) break;
      const gs = dgsm.getState();
      if (gs.gameDay > endDay) break;

      await runner.step(1);

      // Save runtime every 12 ticks (every hour of game time)
      if (tick % 12 === 0) {
        await runner.saveRuntime();
      }
    }

    // Final save
    await runner.saveRuntime();

    // Write tick log to JSON (always, even on interrupt)
    const logPath = path.join(process.cwd(), "data", "simulation-log.json");
    fs.writeFileSync(logPath, JSON.stringify(tickLog, null, 2));
    console.log = origLog; // restore before summaries
    console.log(
      `═══ Tick log written to ${logPath} (${tickLog.length} entries) ═══`
    );

    if (interrupted) {
      console.log("═══ Simulation interrupted. Run again to continue. ═══");
      return;
    }

    // ─── Step 6: Day-end summaries ───
    for (let day = startDay; day <= endDay; day++) {
      console.log(`\n═══ Day ${day} Summary ═══\n`);

      for (const npc of moduleData.npcs) {
        await (npcPlanningAgent as any).summarizeDayMemory(
          dgsm,
          SESSION_ID,
          npc.id,
          day,
          LANGUAGE
        );

        const dayMemories = await memoryManager.getAllForDay(
          npc.id,
          SESSION_ID,
          day
        );

        console.log(`── ${npc.name} ──`);
        console.log(`  Memories today: ${dayMemories.length}`);

        const events = dayMemories.filter((m) => m.type === "event");
        if (events.length > 0) {
          console.log("  Events:");
          for (const e of events.slice(0, 10)) {
            console.log(`    • ${e.content.slice(0, 120)}`);
          }
          if (events.length > 10) {
            console.log(`    ... and ${events.length - 10} more`);
          }
        }

        const summaries = dayMemories.filter((m) => m.type === "summary");
        if (summaries.length > 0) {
          console.log("  Summary:");
          for (const s of summaries) {
            console.log(`    ★ ${s.content}`);
          }
        }

        const newKnowledge = dayMemories.filter(
          (m) => m.type === "information" || m.type === "secret"
        );
        if (newKnowledge.length > 0) {
          console.log("  Knowledge/Secrets:");
          for (const k of newKnowledge) {
            console.log(`    🔑 [${k.type}] ${k.content.slice(0, 120)}`);
          }
        }

        console.log();
      }
    }

    // Overwrite log with final version (includes summaries period)
    fs.writeFileSync(logPath, JSON.stringify(tickLog, null, 2));

    // Final save after summaries
    await runner.saveRuntime();
    console.log("═══ Simulation saved. Run again to continue. ═══");
  } finally {
    await prisma.$disconnect();
  }
}

async function printSchedules(
  dgsm: DynamicGameStateManager,
  agent: NPCPlanningAgent,
  npcs: any[],
  gameDay: number
) {
  for (const npc of npcs) {
    const plan = await agent.getDailyPlan(SESSION_ID, npc.id, gameDay);
    const schedule = (plan?.schedule as any[]) ?? [];
    console.log(`\n  ${npc.name}'s schedule:`);
    for (const entry of schedule) {
      console.log(
        `    → [${resolveSceneName(dgsm, entry.location)}] ${entry.activity}`
      );
    }
  }
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
