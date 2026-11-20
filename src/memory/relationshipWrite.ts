import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import {
  descriptionIdentifier,
  knownAs,
} from "../state/perceivableDirectory.js";
import type { NpcMemoryManager } from "./NpcMemoryManager.js";

export interface RelationshipWriteDeps {
  dgsm: DynamicGameStateManager;
  memory: NpcMemoryManager;
  npcId: string;
  sessionId: string;
  moduleId: string;
  gameDateTime: string;
  location?: string;
}

/** A rename on its own updates the graph and preserves the current note.
 *  When a note is supplied, store it before updating the one-way graph. */
export async function writeRelationship(
  deps: RelationshipWriteDeps,
  input: {
    targetRealId: string;
    content?: string;
    knownAs?: string;
    targetLabel?: string;
  }
): Promise<void> {
  const { dgsm, npcId, memory, sessionId, moduleId, gameDateTime, location } =
    deps;
  const targetId = input.targetRealId;
  const profile = dgsm.getNpcProfile(targetId);
  if (!profile) throw new Error("relationship target not found");
  const content = input.content;
  const note = content?.trim();
  if (content !== undefined && note) {
    await memory.add({
      npcId,
      sessionId,
      moduleId,
      type: "relationship",
      content,
      gameDateTime,
      ...(location ? { location } : {}),
      metadata: {
        targetId,
        targetName:
          knownAs(dgsm, npcId, targetId) ??
          input.targetLabel ??
          descriptionIdentifier(profile),
      },
    });
  }
  dgsm.updateRelationship(
    npcId,
    targetId,
    0,
    note || dgsm.getRelationship(npcId, targetId)?.note || "",
    input.knownAs?.trim() || undefined
  );
}
