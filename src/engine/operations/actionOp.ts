import type {
  SceneStateDelta,
  SuccessLevel,
} from "../../npc/planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  applyActionSceneDelta,
  resolveActionState,
} from "../handlers/actionStateResolver.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";

export interface ActionDelta {
  status: "completed" | "failed";
  actorId: string;
  locationId: string;
  sceneDelta: SceneStateDelta | null;
  successLevel?: SuccessLevel;
  rollDetail?: string;
  failureReason?: string;
}

export const actionOp: EngineTool<ActionDelta> = {
  id: "action",

  description:
    "A current-location action performed in the actor's present scene. " +
    "Use for self-directed behavior and environment-facing actions that do not primarily target a specific item or character. " +
    "Examples: resting, waiting, searching the room, listening at the door, barring an exit, hiding in place. " +
    "If skill is set, a skill roll determines success; otherwise the action auto-succeeds.",

  schema: {
    requiredParams: [
      {
        name: "actorId",
        type: "string",
        description: "Character performing the action",
      },
      {
        name: "action",
        type: "string",
        description: "Description of the action to perform",
      },
    ],
    optionalParams: [
      {
        name: "skill",
        type: "string",
        description:
          "Skill for the action; triggers a skill roll. Omit for auto-success.",
      },
    ],
    example: {
      actorId: "npc_01",
      action:
        "Search the study carefully for signs that someone opened the desk",
    },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): Promise<EngineToolResult<ActionDelta>> {
    const actorId = params.actorId as string;
    const action = params.action as string;
    const skill = params.skill as string | undefined;

    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(actorId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";
    const npc = state.npcCharacters.find((n) => n.id === actorId);
    const npcSkills = npc?.skills ?? {};

    // Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(locationId, dgsm);
    const charPenalties = ctx.getCharacterPenalties(actorId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    // Skill roll if skill specified
    if (skill) {
      // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for existing resolveSkillRoll
      const pseudoNode = {
        characterId: actorId,
        skill,
        action,
        impact: 0,
      } as any;
      const rollResult = ctx.resolveSkillRoll(pseudoNode, adjustedSkills, dgsm);
      if (rollResult.failed) {
        const skillRollResult = {
          successLevel: rollResult.successLevel,
          detail: rollResult.reason ?? "Skill check failed",
        };

        // Attempt LLM resolution even on failure (resolver handles failed status)
        let sceneDelta: SceneStateDelta | null = null;
        if (ctx.runtime) {
          sceneDelta = await resolveActionState(
            pseudoNode,
            dgsm,
            ctx.runtime,
            skillRollResult,
            locationId,
            ctx.language ?? "en"
          );
        }

        return {
          delta: {
            status: "failed",
            actorId,
            locationId,
            sceneDelta,
            successLevel: rollResult.successLevel,
            rollDetail: rollResult.reason,
            failureReason: "skill_roll_failed",
          },
          narrative: {
            outcome: rollResult.reason ?? "Skill check failed",
          },
        };
      }

      // Skill roll succeeded — resolve via LLM if available
      const skillRollResult = {
        successLevel: rollResult.successLevel,
        detail: rollResult.detail ?? "Skill check passed",
      };

      let sceneDelta: SceneStateDelta | null = null;
      if (ctx.runtime) {
        sceneDelta = await resolveActionState(
          pseudoNode,
          dgsm,
          ctx.runtime,
          skillRollResult,
          locationId,
          ctx.language ?? "en"
        );
      }

      return {
        delta: {
          status: "completed",
          actorId,
          locationId,
          sceneDelta,
          successLevel: rollResult.successLevel,
          rollDetail: rollResult.detail,
        },
        narrative: {
          outcome: `${action} — ${rollResult.successLevel} success`,
          memories: sceneDelta?.memory
            ? [{ characterId: actorId, text: sceneDelta.memory }]
            : undefined,
        },
      };
    }

    // No skill — auto-success
    // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for resolveActionState
    const pseudoNode = {
      characterId: actorId,
      action,
      impact: 0,
    } as any;

    let sceneDelta: SceneStateDelta | null = null;
    if (ctx.runtime) {
      sceneDelta = await resolveActionState(
        pseudoNode,
        dgsm,
        ctx.runtime,
        null,
        locationId,
        ctx.language ?? "en"
      );
    }

    return {
      delta: {
        status: "completed",
        actorId,
        locationId,
        sceneDelta,
      },
      narrative: {
        outcome: action,
        memories: sceneDelta?.memory
          ? [{ characterId: actorId, text: sceneDelta.memory }]
          : undefined,
      },
    };
  },

  applyDelta(dgsm: DynamicGameStateManager, delta: ActionDelta): void {
    if (delta.sceneDelta) {
      applyActionSceneDelta(
        dgsm,
        delta.sceneDelta,
        delta.locationId,
        delta.actorId
      );
    }
  },
};
