#!/usr/bin/env tsx
//
// scripts/full-injection-run.ts
//
// FULL-INJECTION run: the whole town, one session, nothing pruned.
//
// The decision harness (`test-agent-decisions.ts`) stages a scene and then
// deliberately prunes `npcCharacters` to the staged cast — "NPCs outside the
// staged cast must not wander into the case" (decisionSim.ts). That keeps a
// case reproducible, and it also means the prompt blocks that scale with the
// roster have never been measured at full size: the Engine's `Characters`
// section has only ever carried one or two people.
//
// This script is the other half. It boots the module exactly as the server
// does — production `importModule` / `createSession` / `SimulationRunner` —
// with every character present, and ticks the real pipeline. What it produces
// is not a verdict but a measurement: per-tick model spend by call site, and
// (with LLM_TRACE_DIR set) every prompt on disk at its real size.
//
// RESUMABLE. The runner persists the world, the tick-engine state and the
// perception stream after every tick, so an interrupted run resumes from the
// last completed tick: re-invoke with the same session id and it picks up
// where it stopped. Ctrl-C stops after the tick in flight rather than in the
// middle of one.
//
// STOPS ON REPEATED ERRORS. Every console warning and error is normalised to
// a signature (ids and numbers stripped); when one signature repeats
// across --max-repeat ticks, or two ticks in a row fail outright, the run stops and
// says which. A run that is failing the same way ten times is not gathering
// data, it is spending money.
//
// Usage:
//   pnpm tsx scripts/full-injection-run.ts --ticks 10
//   pnpm tsx scripts/full-injection-run.ts --ticks 10 --resume
//   pnpm tsx scripts/full-injection-run.ts --fresh --ticks 3
//   LLM_TRACE_DIR=logs/prompts-full pnpm tsx scripts/full-injection-run.ts --ticks 10
//
//   Flags: --ticks <n> (default 10) --session <id> --module <name>
//          --lang <zh|en> --start <HH:MM> --fresh --max-repeat <n>
//
// Cost: every call is real. A tick wakes every idle character plus everyone
// who perceived anything, and each of those pays a render and a decision — so
// a full town costs far more per tick than a staged case. Start small.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { NpcMemoryManager } from "../src/memory/NpcMemoryManager.js";
import {
  type UsageAggregate,
  formatUsageReport,
  getUsageStats,
  resetUsageStats,
} from "../src/models/index.js";
import { ModelProviderName } from "../src/models/types.js";
import { EmbeddingClient } from "../src/rag/embedding.js";
import { getPrismaClient } from "../src/shared/agents/memory/database/prismaClient.js";
import { SimulationRunner } from "../src/simulation/SimulationRunner.js";
import { loadSimulationRuntime } from "../src/simulation/runtimePersistence.js";
import type { SimulationConfig } from "../src/simulation/types.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { makeDateTime } from "../src/state/gameClock.js";
import { importModule } from "../src/state/moduleImporter.js";
import {
  createSession,
  initRuntime,
  loadModule,
} from "../src/state/moduleLoader.js";

// =========================================================================
// CLI
// =========================================================================

import { ErrorWatch, type TickDiagnostics } from "./lib/errorWatch.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const MODULE_NAME = flag("module") ?? "grayhaven";
const MODULE_DIR = path.join(process.cwd(), "testmods", MODULE_NAME);
const LANG = flag("lang") ?? "zh";
const TICKS = Number(flag("ticks") ?? 10);
const START_TIME = flag("start") ?? "19:00";
const FRESH = has("fresh");
/** One id per module by default, so a bare re-run resumes rather than
 *  starting a second town alongside the first. */
const SESSION_ID = flag("session") ?? `full_injection__${MODULE_NAME}`;
const MAX_REPEAT = Number(flag("max-repeat") ?? 3);

const LOG_DIR = path.join(process.cwd(), "logs");
const PROGRESS_FILE = path.join(
  LOG_DIR,
  `full-injection-${SESSION_ID}.progress.json`
);
const REPORT_FILE = path.join(LOG_DIR, `full-injection-${SESSION_ID}.json`);

// =========================================================================
// Error watch
// =========================================================================

// =========================================================================
// Session: fresh or resumed
// =========================================================================

interface Prepared {
  runner: SimulationRunner;
  resumedAtTick: number;
  npcCount: number;
}

async function prepare(): Promise<Prepared> {
  const prisma = getPrismaClient();
  const embedClient = new EmbeddingClient(
    (process.env.MODEL_PROVIDER as ModelProviderName) ??
      ModelProviderName.OPENAI
  );
  const memoryManager = new NpcMemoryManager(prisma, embedClient, LANG);

  if (FRESH) {
    // Checked first rather than caught: Prisma logs a `prisma:error` block of
    // its own before rejecting a delete that matched nothing, and a run that
    // opens with a red error it then swallows reads like a failure.
    const present = await prisma.session.findUnique({
      where: { sessionId: SESSION_ID },
      select: { sessionId: true },
    });
    if (present) {
      // The session row cascades to runtime, memories and events.
      await prisma.session.delete({ where: { sessionId: SESSION_ID } });
      console.log(`[full-injection] dropped session ${SESSION_ID}`);
    }
  }

  const existing = FRESH
    ? null
    : await loadSimulationRuntime(prisma, SESSION_ID);

  const moduleId = await importModule({
    prisma,
    moduleDir: MODULE_DIR,
    moduleName: MODULE_NAME,
  });

  const config: SimulationConfig = {
    sessionId: SESSION_ID,
    moduleId,
    mode: "paused",
  };

  if (existing) {
    const persistedTickEngineState = (
      existing.gameState as Record<string, unknown>
    )._tickEngine as never;
    const dgsm = new DynamicGameStateManager(
      DynamicGameStateManager.deserialize(existing.gameState)
    );
    const runner = new SimulationRunner({
      config: (existing.config as SimulationConfig) ?? config,
      dgsm,
      language: LANG,
      memoryManager,
      prisma,
    });
    runner.setModuleName(MODULE_NAME);
    runner.hydrateFromRuntime({
      // Forced paused: `step()` is a no-op in any other state, and a run that
      // was killed mid-tick left the row saying whatever it was doing then.
      state: "paused",
      ticksExecuted: existing.tick,
      ...(persistedTickEngineState ? { persistedTickEngineState } : {}),
    });
    console.log(
      `[full-injection] resuming ${SESSION_ID} at tick ${existing.tick} (${dgsm.getGameDateTime()})`
    );
    return {
      runner,
      resumedAtTick: existing.tick,
      npcCount: dgsm.getState().npcCharacters.length,
    };
  }

  const moduleData = await loadModule(prisma, moduleId, {
    modsDir: path.dirname(MODULE_DIR),
  });
  if (!moduleData?.setup?.startDate) {
    throw new Error(`Module ${MODULE_NAME} not loadable or missing startDate`);
  }
  const state = initRuntime({
    moduleData,
    gameDateTime: makeDateTime(moduleData.setup.startDate, START_TIME),
  });
  const dgsm = new DynamicGameStateManager(state);

  // Production session creation: this is what seeds every character's
  // module-authored memories, geography included.
  await createSession(prisma, {
    sessionId: SESSION_ID,
    moduleId,
    moduleData,
    embedClient,
    language: LANG,
  });

  const runner = new SimulationRunner({
    config,
    dgsm,
    language: LANG,
    memoryManager,
    prisma,
  });
  runner.setModuleName(MODULE_NAME);
  await runner.saveRuntime();

  console.log(
    `[full-injection] created ${SESSION_ID} — ${state.npcCharacters.length} characters, ${state.scenes.size} scenes, starting ${dgsm.getGameDateTime()}`
  );
  return {
    runner,
    resumedAtTick: 0,
    npcCount: state.npcCharacters.length,
  };
}

// =========================================================================
// Run
// =========================================================================

function usageDelta(
  before: UsageAggregate[],
  after: UsageAggregate[]
): Array<{ operation: string; calls: number; prompt: number }> {
  const key = (u: UsageAggregate) => u.operation;
  const prior = new Map(before.map((u) => [key(u), u]));
  const out: Array<{ operation: string; calls: number; prompt: number }> = [];
  for (const now of after) {
    const was = prior.get(key(now));
    const calls = now.calls - (was?.calls ?? 0);
    if (calls <= 0) continue;
    const prompt =
      now.input_tokens +
      now.cache_read_tokens +
      now.cache_creation_tokens -
      ((was?.input_tokens ?? 0) +
        (was?.cache_read_tokens ?? 0) +
        (was?.cache_creation_tokens ?? 0));
    out.push({ operation: now.operation, calls, prompt });
  }
  return out.sort((a, b) => b.prompt - a.prompt);
}

async function main(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  resetUsageStats();

  const { runner, resumedAtTick, npcCount } = await prepare();

  const watch = new ErrorWatch(MAX_REPEAT);
  watch.install();

  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(
      "\n[full-injection] stopping after the tick in flight — re-run to resume"
    );
  };
  process.on("SIGINT", onSigint);

  const startedAt = Date.now();
  const ticks: Array<{
    tick: number;
    gameDateTime: string;
    ms: number;
    calls: Array<{ operation: string; calls: number; prompt: number }>;
    diagnostics: TickDiagnostics;
  }> = [];
  let stopReason: string | null = null;

  try {
    for (let i = 0; i < TICKS; i++) {
      const before = getUsageStats();
      const t0 = Date.now();
      watch.beginTick(runner.getStatus().ticksExecuted + 1);
      await runner.step(1);
      const observed = watch.endTick();
      stopReason = observed.stopReason;
      const ms = Date.now() - t0;
      const status = runner.getStatus();
      const calls = usageDelta(before, getUsageStats());

      ticks.push({
        tick: status.ticksExecuted,
        gameDateTime: status.currentDateTime,
        ms,
        calls,
        diagnostics: observed.diagnostics,
      });
      const callLine =
        calls.length > 0
          ? calls
              .map((c) => `${c.operation} ×${c.calls} (${c.prompt} tok)`)
              .join(" · ")
          : "no model calls";
      console.log(
        `[full-injection] tick ${status.ticksExecuted} · ${status.currentDateTime} · ${(ms / 1000).toFixed(1)}s · ${callLine}`
      );

      // Written every tick so a watcher — or the next invocation — can see how
      // far this got without parsing stdout.
      writeFileSync(
        PROGRESS_FILE,
        `${JSON.stringify(
          {
            sessionId: SESSION_ID,
            module: MODULE_NAME,
            npcCount,
            resumedAtTick,
            ticksRequested: TICKS,
            ticksDoneThisRun: i + 1,
            tick: status.ticksExecuted,
            gameDateTime: status.currentDateTime,
            elapsedMs: Date.now() - startedAt,
            updatedAt: new Date().toISOString(),
            errors: watch.top(),
            diagnostics: observed.diagnostics,
            stopReason,
          },
          null,
          2
        )}\n`
      );

      if (stopReason) break;
      if (interrupted) {
        stopReason = "interrupted";
        break;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    watch.uninstall();
  }

  const usage = getUsageStats();
  console.log(`\n--- LLM 花费 ---\n${formatUsageReport(usage, "  ")}`);

  const errors = watch.top();
  if (errors.length > 0) {
    console.log("\n--- 重复出现的告警/错误 ---");
    for (const e of errors)
      console.log(`  ${e.count} rows / ${e.tickCount} ticks  ${e.sample}`);
  }
  // Three separate figures on purpose: "how many ticks failed", "how many
  // corrections were spent" and "how many actions were named by errors" are
  // different questions, and one run was stopped by mistaking the third for
  // the first.
  const diagnostics = watch.summary();
  console.log(
    `\n--- 裁定诊断 ---\n  ticks: ${diagnostics.ticks} · failed ticks: ${diagnostics.failedTicks.length}${diagnostics.failedTicks.length ? ` (${diagnostics.failedTicks.join(", ")})` : ""} · correction attempts: ${diagnostics.correctionAttempts} · actions named by errors: ${diagnostics.affectedActions}`
  );

  writeFileSync(
    REPORT_FILE,
    `${JSON.stringify(
      {
        sessionId: SESSION_ID,
        module: MODULE_NAME,
        lang: LANG,
        npcCount,
        resumedAtTick,
        ticksRequested: TICKS,
        finishedAtTick: runner.getStatus().ticksExecuted,
        stopReason,
        elapsedMs: Date.now() - startedAt,
        ticks,
        usage,
        errors,
        diagnostics,
      },
      null,
      2
    )}\n`
  );
  console.log(`\n[full-injection] report → ${REPORT_FILE}`);

  if (stopReason && stopReason !== "interrupted") {
    console.error(`[full-injection] STOPPED: ${stopReason}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("[full-injection] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
