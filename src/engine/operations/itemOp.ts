import type { ObjectStateDelta } from "../../npc/planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { applyObjectDelta } from "../tools/itemStateResolver.js";
import { itemTool } from "../tools/itemTool.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";

export interface ItemDelta {
  actorId: string;
  locationId: string;
  objectDelta: ObjectStateDelta | null;
  failureReason?: string;
}

export const itemOp: EngineTool<ItemDelta> = {
  id: "item",

  description:
    "Item manipulation sub-system. Handles picking up, moving, modifying, destroying, disassembling, combining, and inspecting items in the scene or actor inventory.",

  schema: {
    requiredParams: [
      {
        name: "actorId",
        type: "string",
        description: "Character performing the item action",
      },
      {
        name: "action",
        type: "string",
        description: "Description of the item action",
      },
      {
        name: "itemId",
        type: "string",
        description: "Exact item ID being targeted",
      },
    ],
    optionalParams: [
      {
        name: "skill",
        type: "string",
        description:
          "Skill required for difficult actions (e.g. Locksmith, Mechanical Repair)",
      },
    ],
    example: {
      actorId: "npc_01",
      action: "Pick up the petty cash box",
      itemId: "petty_cash_box",
    },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): Promise<EngineToolResult<ItemDelta>> {
    const actorId = params.actorId as string;
    const action = params.action as string;
    const itemId = params.itemId as string;

    const pos = dgsm.getCharacterPosition(actorId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";

    // Build pseudo-node for the existing itemTool bridge
    const pseudoNode = {
      nodeId: "op",
      characterId: actorId,
      characterName: actorId,
      startTime: ctx.currentTime ?? "00:00",
      endTime: ctx.currentTime ?? "00:00",
      action,
      type: "action",
      impact: 0,
      status: "in_progress",
      executionMeta: { remainingMinutes: 1 },
      objectInteractionPayload: { itemId },
    };

    // Pre-check: item must exist
    const preCheck = itemTool.preCheck(
      // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for existing preCheck
      pseudoNode as any,
      { itemId },
      dgsm
    );
    if (!preCheck.passed) {
      return {
        delta: {
          actorId,
          locationId,
          objectDelta: null,
          failureReason: preCheck.failureDetail ?? "object_not_found",
        },
        narrative: {
          outcome: preCheck.failureDetail ?? `${itemId} not found`,
        },
      };
    }

    // If runtime is available, delegate to the LLM resolver
    if (ctx.runtime) {
      const state = dgsm.getState();
      const npc = state.npcCharacters.find((n) => n.id === actorId);
      const npcSkills = npc?.skills ?? {};

      const scenePenalties = ctx.getScenePenalties(locationId, dgsm);
      const charPenalties = ctx.getCharacterPenalties(actorId, dgsm);
      const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
      const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

      // Skill roll (only when node specifies a skill)
      let skillRollResult: {
        successLevel: import("../../planning/types.js").SuccessLevel;
        detail: string;
      } | null = null;

      if (params.skill) {
        // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for resolveSkillRoll
        const rollNode = { ...pseudoNode, skill: params.skill } as any;
        const roll = ctx.resolveSkillRoll(rollNode, adjustedSkills, dgsm);
        skillRollResult = {
          successLevel: roll.successLevel,
          detail: roll.detail ?? "",
        };
      }

      const resolutionContext = {
        executionStatus: "completed" as const,
        startedAt: pseudoNode.startTime,
        resolvedAt: pseudoNode.endTime,
        elapsedMinutes: 1,
        plannedMinutes: 1,
      };

      const resolved = await itemTool.resolve(
        // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for existing resolve
        pseudoNode as any,
        { itemId },
        dgsm,
        ctx.runtime,
        skillRollResult,
        locationId,
        ctx.language ?? "en",
        resolutionContext,
        {
          memoryManager: ctx.memoryManager,
          sessionId: undefined,
          registry: undefined,
          featureNotes: [],
        }
      );

      return {
        delta: {
          actorId,
          locationId,
          objectDelta: resolved.delta,
        },
        narrative: {
          outcome: resolved.outcomeDescription,
        },
      };
    }

    // No runtime — return basic delta with null objectDelta
    return {
      delta: {
        actorId,
        locationId,
        objectDelta: null,
      },
      narrative: {
        outcome: action,
      },
    };
  },

  applyDelta(dgsm: DynamicGameStateManager, delta: ItemDelta): void {
    if (delta.objectDelta) {
      applyObjectDelta(
        dgsm,
        delta.actorId,
        delta.objectDelta,
        delta.locationId
      );
    }
  },
};
