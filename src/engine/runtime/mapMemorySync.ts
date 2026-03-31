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
}): Promise<void> {
  const {
    dgsm,
    memoryManager,
    sessionId,
    moduleId,
    gameDay,
    gameTime,
    movedNpcIds,
  } = params;
  const state = dgsm.getState();

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

  await Promise.all(
    state.npcCharacters.map(async (npc) => {
      const npcId = npc.id;
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
