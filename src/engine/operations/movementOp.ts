import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import { resolveTargetPosition } from "../handlers/movementHandler.js";
import { findTopologyPath } from "../shared/pathfinding.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";

export interface MovementDelta {
  status: "completed" | "failed";
  actorId: string;
  newPosition: CharacterPosition | null;
  outcome: string;
  successLevel?: string;
  rollDetail?: string;
  failureReason?: string;
}

export const movementOp: EngineTool<MovementDelta> = {
  id: "movement",

  description:
    "Move a character to a different location via topology pathfinding or skill-based creative movement.",

  schema: {
    requiredParams: [
      {
        name: "actorId",
        type: "string",
        description: "Character performing the movement",
      },
      {
        name: "action",
        type: "string",
        description: "Description of the movement",
      },
      {
        name: "destination",
        type: "string",
        description: "Target location ID",
      },
    ],
    optionalParams: [
      {
        name: "skill",
        type: "string",
        description: "Skill for creative movement (bypasses pathfinding)",
      },
    ],
    example: {
      actorId: "npc_01",
      action: "Walk to the harbor",
      destination: "harbor_docks",
    },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): Promise<EngineToolResult<MovementDelta>> {
    const actorId = params.actorId as string;
    const destination = params.destination as string;
    const skill = params.skill as string | undefined;

    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(actorId);
    const npc = state.npcCharacters.find((n) => n.id === actorId);
    const npcSkills = npc?.skills ?? {};

    if (!destination) {
      return {
        delta: {
          status: "failed",
          actorId,
          newPosition: null,
          outcome: "No destination specified",
          failureReason: "location_blocked",
        },
        narrative: { outcome: "No destination specified" },
      };
    }

    const scenePenalties = ctx.getScenePenalties(destination, dgsm);
    const charPenalties = ctx.getCharacterPenalties(actorId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    const topology = dgsm.getTopology();

    // Creative movement with skill check
    if (skill) {
      // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for existing resolveSkillRoll
      const pseudoNode = {
        characterId: actorId,
        skill,
        action: params.action,
        impact: 0,
      } as any;
      const rollResult = ctx.resolveSkillRoll(pseudoNode, adjustedSkills, dgsm);
      if (rollResult.failed) {
        return {
          delta: {
            status: "failed",
            actorId,
            newPosition: null,
            outcome: rollResult.reason ?? "Skill check failed",
            successLevel: rollResult.successLevel,
            rollDetail: rollResult.reason,
            failureReason: "skill_roll_failed",
          },
          narrative: { outcome: rollResult.reason ?? "Skill check failed" },
        };
      }

      const targetPos = resolveTargetPosition(destination, topology, dgsm);
      return {
        delta: {
          status: "completed",
          actorId,
          newPosition: targetPos ?? null,
          outcome: `Moved to ${destination}`,
          successLevel: rollResult.successLevel,
          rollDetail: rollResult.detail,
        },
        narrative: { outcome: `Moved to ${destination}` },
      };
    }

    // Topology-based movement
    const currentPos = dgsm.getCharacterPosition(actorId);
    const targetPos = resolveTargetPosition(destination, topology, dgsm);
    if (currentPos && targetPos) {
      const topologyPath = findTopologyPath(
        currentPos,
        targetPos,
        topology,
        state.blockedConnections,
        dgsm
      );

      if (!topologyPath) {
        return {
          delta: {
            status: "failed",
            actorId,
            newPosition: null,
            outcome: "No path available",
            failureReason: "location_blocked",
          },
          narrative: { outcome: "No path available" },
        };
      }

      return {
        delta: {
          status: "completed",
          actorId,
          newPosition: targetPos,
          outcome: `Moved to ${destination}`,
        },
        narrative: { outcome: `Moved to ${destination}` },
      };
    }

    return {
      delta: {
        status: "failed",
        actorId,
        newPosition: null,
        outcome: "Cannot resolve positions",
        failureReason: "location_blocked",
      },
      narrative: { outcome: "Cannot resolve positions" },
    };
  },

  applyDelta(dgsm: DynamicGameStateManager, delta: MovementDelta): void {
    if (delta.status === "completed" && delta.newPosition) {
      dgsm.setCharacterPosition(delta.actorId, delta.newPosition);
    }
  },
};
