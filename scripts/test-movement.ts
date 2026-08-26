#!/usr/bin/env tsx
//
// scripts/test-movement.ts
//
// Focused end-to-end test of the movement chain, in two parts:
//
//   Part A — engine only (NO LLM calls): drives the real TickEngine +
//     movement subsystem over the real module topology with a stubbed
//     interpreter, verifying:
//       A1. cross-town movement to a valid location id actually moves the NPC
//       A2. same-building sub-scene movement (shortcut path) works
//       A3. an unresolvable destination (display name instead of id) fails
//           AND writes the "tried to head for" memory.event feedback
//
//   Part B — real interpreter (a few MEDIUM LLM calls): verifies the LLM
//     picks a legal location id from the Known Locations list for English,
//     Chinese, and vague movement narratives.
//
// Run: pnpm tsx scripts/test-movement.ts [--module casssandra] [--skip-llm]

import "dotenv/config";

import path from "node:path";
import type { TickReport } from "../src/engine/core/types.js";
import { createTickEngine } from "../src/engine/core/tickEngine.js";
import {
  collectKnownLocations,
  interpretAction,
} from "../src/engine/interpreter/gameInterpreter.js";
import {
  createDefaultDefinitions,
  createDefaultSubsystemRegistry,
} from "../src/engine/registerDefaults.js";
import type { InterpretedStep } from "../src/engine/types.js";
import { DynamicGameStateManager } from "../src/state/DynamicGameState.js";
import { makeDateTime } from "../src/state/gameClock.js";
import { importModule } from "../src/state/moduleImporter.js";
import { initRuntime, loadModule } from "../src/state/moduleLoader.js";
import { getPrismaClient } from "../src/shared/agents/memory/database/prismaClient.js";

const args = process.argv.slice(2);
const moduleName = args.includes("--module")
  ? args[args.indexOf("--module") + 1]
  : "casssandra";
const skipLlm = args.includes("--skip-llm");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const prisma = getPrismaClient();

  // ---- Load module + build runtime state (no session, no memory) ----------
  const moduleDir = path.join(process.cwd(), "data", "Mods", moduleName);
  const moduleId = await importModule({ prisma, moduleDir, moduleName });
  const moduleData = await loadModule(prisma, moduleId);
  if (!moduleData?.setup?.startDate) {
    throw new Error(`Module ${moduleName} not loadable or missing startDate`);
  }
  const state = initRuntime({
    sessionId: "movement_test",
    moduleData,
    gameDateTime: makeDateTime(moduleData.setup.startDate, "08:00"),
  });
  const dgsm = new DynamicGameStateManager(state);
  const topology = dgsm.getTopology();
  const knownLocations = collectKnownLocations({
    scenarioOutlines: state.scenarioOutlines,
    scenes: state.scenes,
    junctions: topology.junctions,
    roads: topology.roads,
  });
  const knownIds = new Set(knownLocations.map((l) => l.id));
  console.log(
    `[setup] module=${moduleName} npcs=${state.npcCharacters.length} ` +
      `knownLocations=${knownLocations.length}`
  );

  // ---- Part A: engine-level movement (stubbed interpreter, no LLM) --------
  console.log("\n=== Part A: movement subsystem over real topology ===");

  let nextSteps: InterpretedStep[] = [];
  const reports: TickReport[] = [];
  const engine = createTickEngine({
    dgsm,
    subsystemRegistry: createDefaultSubsystemRegistry(),
    scriptedEvents: [],
    interpretAction: async () => ({ steps: nextSteps }),
    resolve: async () => ({
      outcome: { stateChanges: [], elapsedMinutes: 1 },
      plannedDuration: 1,
    }),
    getActorDex: () => 50,
    tickDurationMinutes: 1,
    lang: "en",
  });
  engine.on("tickCompleted", (r) => {
    reports.push(r);
  });

  const npc = state.npcCharacters[0];
  const startPos = dgsm.getCharacterPosition(npc.id);
  const startLoc = startPos ? dgsm.resolveLocationId(startPos) : "?";
  console.log(`[A] actor=${npc.name} start=${startLoc}`);

  const locOf = () => {
    const p = dgsm.getCharacterPosition(npc.id);
    return p ? dgsm.resolveLocationId(p) : "?";
  };

  const submitMovement = async (destination: string, text: string) => {
    nextSteps = [
      {
        definitionId: "movement",
        impact: 0,
        engine: "code",
        codeSubsystem: "movement",
        overlayFields: { destination },
        actionText: text,
      },
    ];
    return engine.submitAction({
      characterId: npc.id,
      actionText: text,
      sceneId: locOf(),
    });
  };

  const tickUntil = async (
    done: () => boolean,
    maxTicks: number
  ): Promise<number> => {
    let last = locOf();
    for (let i = 1; i <= maxTicks; i++) {
      await engine.tick();
      const now = locOf();
      if (now !== last) {
        console.log(`    tick ${i}: ${last} → ${now}`);
        last = now;
      }
      if (done()) return i;
    }
    return -1;
  };

  // A1: cross-town move to a different building's entry scene.
  const currentScene = startPos?.type === "scene" ? startPos.sceneId : "";
  const currentParent = state.scenes.get(currentScene)?.parentLocationId;
  const targetOutline = (state.scenarioOutlines ?? []).find(
    (o) => o.entrySceneId && o.id !== currentParent
  );
  if (!targetOutline?.entrySceneId) throw new Error("no cross-town target");
  console.log(
    `[A1] cross-town: ${startLoc} → ${targetOutline.id} (${targetOutline.name})`
  );
  await submitMovement(
    targetOutline.id,
    `I head over to ${targetOutline.name}.`
  );
  const reachedIn = await tickUntil(() => {
    const p = dgsm.getCharacterPosition(npc.id);
    return (
      p?.type === "scene" &&
      (p.sceneId === targetOutline.entrySceneId ||
        state.scenes.get(p.sceneId)?.parentLocationId === targetOutline.id)
    );
  }, 300);
  check(
    "A1 cross-town movement reaches destination",
    reachedIn > 0,
    reachedIn > 0
      ? `arrived at ${locOf()} in ${reachedIn} tick(s)`
      : `never arrived; still at ${locOf()}`
  );

  // A2: same-building sub-scene shortcut.
  const hereParent = (() => {
    const p = dgsm.getCharacterPosition(npc.id);
    return p?.type === "scene"
      ? state.scenes.get(p.sceneId)?.parentLocationId
      : undefined;
  })();
  const sibling = [...state.scenes.entries()].find(
    ([id, s]) =>
      s.parentLocationId === hereParent &&
      hereParent &&
      hereParent !== "OUTDOOR" &&
      id !== (dgsm.getCharacterPosition(npc.id) as { sceneId?: string }).sceneId
  );
  if (sibling) {
    console.log(`[A2] same-building: ${locOf()} → ${sibling[0]}`);
    await submitMovement(sibling[0], `I walk into the next room.`);
    const t = await tickUntil(
      () =>
        (dgsm.getCharacterPosition(npc.id) as { sceneId?: string }).sceneId ===
        sibling[0],
      10
    );
    check(
      "A2 same-building sub-scene move",
      t > 0,
      t > 0 ? `arrived in ${t} tick(s)` : `still at ${locOf()}`
    );
  } else {
    console.log("[A2] skipped — current building has no sibling sub-scene");
  }

  // A3: unresolvable destination (display name instead of id).
  const before = locOf();
  reports.length = 0;
  console.log(`[A3] bad destination: "Reindeer Bar" (display name, not an id)`);
  await submitMovement("Reindeer Bar", "I head for the Reindeer Bar.");
  await engine.tick();
  await engine.tick();
  const after = locOf();
  const failMemory = reports
    .flatMap((r) => r.stateChanges)
    .find(
      (c) =>
        c.kind === "memory.event" &&
        c.characterId === npc.id &&
        c.content.includes("tried to head for")
    );
  check("A3 bad destination does not move the NPC", after === before);
  check(
    "A3 failure writes 'tried to head for' memory.event",
    !!failMemory,
    failMemory ? `"${(failMemory as { content: string }).content}"` : "no memory emitted"
  );

  // ---- Part B: real interpreter picks ids from Known Locations ------------
  if (!skipLlm) {
    console.log("\n=== Part B: interpreter destination selection (real LLM) ===");
    const definitions = createDefaultDefinitions().getAll();
    const emptyDirectory = {
      characters: new Set<string>(),
      items: new Set<string>(),
      scenes: new Set<string>(),
    };
    const bar = knownLocations.find((l) =>
      /reindeer|驯鹿/i.test(l.name)
    );
    const cases: { label: string; narrative: string; expectId?: string }[] = [
      {
        label: "English informal name",
        narrative:
          "I step out onto the street and head straight for the Reindeer Bar to start my rounds.",
        expectId: bar?.id,
      },
      {
        label: "Chinese narrative",
        narrative: "我拉紧外套，出门朝驯鹿酒吧走去。",
        expectId: bar?.id,
      },
      {
        label: "vague destination",
        narrative: "I wander off toward the busier part of town.",
      },
    ];
    for (const c of cases) {
      const result = await interpretAction(
        c.narrative,
        definitions,
        c.narrative.match(/[一-鿿]/) ? "zh" : "en",
        emptyDirectory,
        knownLocations
      );
      const moves = result.steps.filter((s) => s.codeSubsystem === "movement");
      const dests = moves.map(
        (s) => (s.overlayFields as { destination?: string })?.destination ?? ""
      );
      const legal = dests.every((d) => knownIds.has(d));
      const detail = `steps=[${result.steps.map((s) => s.definitionId).join(",")}] dest=[${dests.join(",")}]`;
      if (c.expectId) {
        const hitExpected =
          moves.length > 0 && dests.some((d) => d === c.expectId);
        const acceptable = hitExpected || (moves.length > 0 && legal);
        check(
          `B "${c.label}" → movement with legal id${hitExpected ? " (exact match)" : ""}`,
          acceptable,
          detail
        );
      } else {
        // Vague: either a legal id or no movement step at all.
        check(
          `B "${c.label}" → legal id or no movement step`,
          moves.length === 0 || legal,
          detail
        );
      }
    }
  } else {
    console.log("\n[B] skipped (--skip-llm)");
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .then(async () => {
    await getPrismaClient().$disconnect();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error("[test-movement] FAILED:", err);
    try {
      await getPrismaClient().$disconnect();
    } catch {}
    process.exit(1);
  });
