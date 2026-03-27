/**
 * Dynamic Game State Loader
 * Delegates to moduleLoader three-step API: loadModule → createSession → initRuntime
 */

import fs from "fs";
import path from "path";
import { NpcMemoryManager } from "../memory/index.js";
import { ModelProviderName } from "../../models/types.js";
import { EmbeddingClient } from "../../rag/embedding.js";
import { resolveModuleIdByName } from "../../shared/agents/memory/database/moduleScope.js";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";
import { resolveEmailId } from "../../shared/agents/memory/database/userContext.js";
import type { DynamicGameState } from "./DynamicGameState.js";
import { DynamicGameStateManager } from "./DynamicGameState.js";
import { importModule } from "./moduleImporter.js";
import { createSession, initRuntime, loadModule } from "./moduleLoader.js";

/**
 * Initialize complete DynamicGameState with runtime data.
 * Wraps the three-step moduleLoader API for backward compatibility.
 */
export async function initializeCompleteDynamicGameState(
  _db: unknown,
  params: {
    sessionId: string;
    moduleName: string;
    emailId?: string;
  }
): Promise<DynamicGameState | null> {
  const prisma = getPrismaClient();
  const resolvedEmailId = params.emailId
    ? resolveEmailId(params.emailId)
    : undefined;

  // Re-import module from filesystem to ensure DB has latest data (idempotent)
  const moduleDir = path.join(process.cwd(), "data", "Mods", params.moduleName);
  if (fs.existsSync(moduleDir)) {
    await importModule({
      prisma,
      moduleDir,
      moduleName: params.moduleName,
      emailId: resolvedEmailId,
    });
  }

  // Resolve moduleId from name
  const moduleId = await resolveModuleIdByName(
    params.moduleName,
    resolvedEmailId
  );
  if (!moduleId) {
    console.warn(`[DynamicGameState] Module "${params.moduleName}" not found`);
    return null;
  }

  // Step 1: Load module data from DB
  const moduleData = await loadModule(prisma, moduleId);
  if (!moduleData) {
    console.warn(
      `[DynamicGameState] Failed to load module data for "${params.moduleName}"`
    );
    return null;
  }

  // Step 2: Create session + bootstrap NPC memory
  const embedClient = new EmbeddingClient(
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
      ModelProviderName.OPENAI
  );
  await createSession(prisma, {
    sessionId: params.sessionId,
    moduleId,
    moduleData,
    embedClient,
    emailId: resolvedEmailId,
  });

  // Parse initial game time from module setup data
  let gameDay = 1;
  let timeOfDay = "08:00";
  const setupData = moduleData.setup as Record<string, any> | null;
  if (setupData?.initialGameTime) {
    const parsed = parseInitialGameTime(setupData.initialGameTime);
    if (parsed) {
      if (parsed.gameDay) gameDay = parsed.gameDay;
      timeOfDay = parsed.timeOfDay;
    }
  }

  // Step 3: Build runtime state
  const state = initRuntime({
    sessionId: params.sessionId,
    moduleData,
    gameDay,
    timeOfDay,
  });

  const dgsm = new DynamicGameStateManager(state);
  const memoryManager = new NpcMemoryManager(prisma, embedClient);
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
              roadIds: [
                ...new Set([...(seed?.roadIds ?? []), position.roadId]),
              ],
            };
        }
      })();

      await memoryManager.ensureMapSnapshot({
        npcId: npc.id,
        sessionId: params.sessionId,
        moduleId,
        gameDay,
        gameTime: timeOfDay,
        location,
        dgsm,
        seed: seedWithCurrentLocation,
      });
      if (location) {
        await memoryManager.ensureCurrentLocationInMap({
          npcId: npc.id,
          sessionId: params.sessionId,
          moduleId,
          gameDay,
          gameTime: timeOfDay,
          location,
          dgsm,
        });
      }
    })
  );

  console.log(
    `[DynamicGameState] Initialized module "${params.moduleName}" — ${state.npcCharacters.length}/${moduleData.npcs.length} NPCs (policy filtered), ${moduleData.scenes.size} scenes`
  );
  return state;
}

/**
 * Parse initial game time from string format
 */
function parseInitialGameTime(
  value: string
): { gameDay?: number; timeOfDay: string } | null {
  const trimmed = value.trim();

  // Match format: "Day X, HH:MM" or "Day X HH:MM" (case insensitive, comma optional)
  const dayMatchWithComma = /^day\s+(\d+),\s*(\d{1,2}):(\d{2})$/i.exec(trimmed);
  if (dayMatchWithComma) {
    const gameDay = Number(dayMatchWithComma[1]);
    const hours = dayMatchWithComma[2];
    const minutes = dayMatchWithComma[3];
    const timeOfDay = `${hours.padStart(2, "0")}:${minutes}`;
    if (
      Number.isFinite(gameDay) &&
      gameDay > 0 &&
      isValidTimeOfDay(timeOfDay)
    ) {
      return { gameDay, timeOfDay };
    }
    return null;
  }

  // Match format: "Day X HH:MM" (without comma, case insensitive)
  const dayMatch = /^day\s+(\d+)\s+(\d{1,2}):(\d{2})$/i.exec(trimmed);
  if (dayMatch) {
    const gameDay = Number(dayMatch[1]);
    const hours = dayMatch[2];
    const minutes = dayMatch[3];
    const timeOfDay = `${hours.padStart(2, "0")}:${minutes}`;
    if (
      Number.isFinite(gameDay) &&
      gameDay > 0 &&
      isValidTimeOfDay(timeOfDay)
    ) {
      return { gameDay, timeOfDay };
    }
    return null;
  }

  // Match format: "HH:MM" only
  if (isValidTimeOfDay(trimmed)) {
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (timeMatch) {
      const hours = timeMatch[1].padStart(2, "0");
      const minutes = timeMatch[2];
      return { timeOfDay: `${hours}:${minutes}` };
    }
    return { timeOfDay: trimmed };
  }

  return null;
}

function isValidTimeOfDay(value: string): boolean {
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!timeMatch) return false;
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}
