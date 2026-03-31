import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext, NodeHandler } from "../../types.js";
import { recoverActionExecution } from "../autoActionRecovery.js";
import type { NPCPlanningAgent } from "../../../planning/NPCPlanningAgent.js";
import type { NpcMemoryManager } from "../../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type {
  CharacterAction,
  PlanNode,
} from "../../../planning/types.js";

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "node-1",
    characterId: "npc-1",
    characterName: "Alice",
    startTime: "08:00",
    endTime: "08:10",
    action: "Fetch the brass key",
    location: "office",
    type: "object_interaction",
    impact: 1,
    status: "pending",
    objectInteractionPayload: {
      itemId: "brass_key",
    },
    executionMeta: {
      remainingMinutes: 0,
    },
    ...overrides,
  } as PlanNode;
}

function makeFailedAction(
  overrides: Partial<CharacterAction> = {}
): CharacterAction {
  return {
    characterId: "npc-1",
    characterName: "Alice",
    gameTime: "08:10",
    action: "Fetch the brass key",
    location: "office",
    type: "object_interaction",
    impact: 1,
    status: "failed",
    outcome: "brass_key not found",
    failureReason: "object_not_found",
    ...overrides,
  };
}

describe("recoverActionExecution", () => {
  it("does not mark object-not-found recovery as movement arrival", async () => {
    const officeScene = {
      id: "office",
      parentLocationId: "building_1",
      items: [],
    };
    const storageScene = {
      id: "storage",
      parentLocationId: "building_1",
      items: [{ id: "brass_key", name: "Brass Key" }],
    };

    const setCharacterPosition = vi.fn();
    const dgsm = {
      getScene: vi.fn((locationId: string) =>
        locationId === "office" ? officeScene : storageScene
      ),
      getState: vi.fn(() => ({
        scenes: new Map([
          ["office", officeScene],
          ["storage", storageScene],
        ]),
      })),
      setCharacterPosition,
    } as unknown as DynamicGameStateManager;

    const shifted = vi.fn();
    const npcPlanningAgent = {
      shiftPendingNodesByDelta: shifted,
    } as unknown as NPCPlanningAgent;

    const recoveredAction: CharacterAction = {
      ...makeFailedAction(),
      status: "completed",
      failureReason: undefined,
      location: "storage",
      outcome: "Picked up the brass key",
    };
    const handler = {
      execute: vi.fn().mockResolvedValue(recoveredAction),
    } as unknown as NodeHandler;

    const memoryAdd = vi.fn();
    const movedNpcIds = new Set<string>();

    const result = await recoverActionExecution({
      node: makeNode(),
      action: makeFailedAction(),
      handler,
      dgsm,
      ctx: {} as ExecutionContext,
      npcPlanningAgent,
      sessionId: "session-1",
      moduleId: "module-1",
      gameDay: 1,
      tickStartTime: "08:10",
      language: "en",
      movedNpcIds,
      memoryManager: {
        add: memoryAdd,
      } as unknown as NpcMemoryManager,
    });

    expect(result.node.location).toBe("storage");
    expect(result.action).toEqual(recoveredAction);
    expect(setCharacterPosition).toHaveBeenCalledWith("npc-1", {
      type: "scene",
      sceneId: "storage",
    });
    expect(shifted).toHaveBeenCalledWith("session-1", "npc-1", 1, "08:10", -1);
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(memoryAdd).toHaveBeenCalledTimes(1);
    expect(movedNpcIds.has("npc-1")).toBe(false);
  });
});
