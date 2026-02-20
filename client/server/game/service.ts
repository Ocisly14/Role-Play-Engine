import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../src/shared/agents/memory/database/index.js";

/**
 * Initialize game state for world-builder modules (uses initial_snapshot flag)
 */
export async function initializeWorldBuilderGameState(
  db: CoCDatabase | CoCDatabaseAdapter,
  characterId: string | undefined,
  sessionId: string,
  modName?: string,
  emailId?: string
): Promise<{ dynamicGameState: DynamicGameState; moduleIntroduction: any }> {
  if (!modName) {
    throw new Error(
      "Module name is required for WorldBuilder game state initialization"
    );
  }

  // Use the new complete initialization function that includes runtime data
  const { initializeCompleteDynamicGameState } = await import(
    "../../../src/dynamicworldagent/state/DynamicGameStateLoader.js"
  );
  const dynamicGameState = await initializeCompleteDynamicGameState(db, {
    sessionId,
    moduleName: modName,
    characterId,
    emailId: emailId,
  });

  if (!dynamicGameState) {
    throw new Error(
      `Failed to initialize DynamicGameState for module "${modName}"`
    );
  }

  // Load module introduction from module digest
  let moduleIntroduction: any = null;
  if (dynamicGameState.moduleDigest) {
    moduleIntroduction = {
      introduction: dynamicGameState.moduleDigest.introduction,
      moduleNotes: dynamicGameState.moduleDigest.moduleNotes || "",
    };
  }

  return { dynamicGameState, moduleIntroduction };
}
