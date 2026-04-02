import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

export async function syncNpcMapMemories(params: {
  dgsm: DynamicGameStateManager;
  memoryManager: NpcMemoryManager;
  sessionId: string;
  moduleId: string;
  gameDay: number;
  gameTime: string;
  movedNpcIds: ReadonlySet<string>;
  actedNpcIds: ReadonlySet<string>;
}): Promise<void> {
  const {
    dgsm,
    memoryManager,
    sessionId,
    moduleId,
    gameDay,
    gameTime,
    movedNpcIds,
    actedNpcIds,
  } = params;

  // Moved NPCs: ensure their current location is on their map
  await Promise.all(
    [...movedNpcIds].map(async (npcId) => {
      const position = dgsm.getCharacterPosition(npcId);
      const location = position ? dgsm.resolveLocationId(position) : undefined;
      await memoryManager.ensureCurrentLocationInMap({
        npcId,
        sessionId,
        moduleId,
        gameDay,
        gameTime,
        location,
        dgsm,
      });
    })
  );

  // Only refresh map snapshots for NPCs who moved or acted this tick.
  // NPCs affected by impact events already got refreshed in impactPipeline.
  const changedNpcIds = new Set([...movedNpcIds, ...actedNpcIds]);
  if (changedNpcIds.size === 0) return;

  await Promise.all(
    [...changedNpcIds].map(async (npcId) => {
      const position = dgsm.getCharacterPosition(npcId);
      const location = position ? dgsm.resolveLocationId(position) : undefined;
      await memoryManager.refreshMapSnapshot({
        npcId,
        sessionId,
        moduleId,
        gameDay,
        gameTime,
        location,
        dgsm,
      });
    })
  );
}
