import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  applyCharacterDelta,
  resolveInteractionState,
} from "../handlers/interactionStateResolver.js";
import { arePositionsCoLocated } from "../shared/locationPresence.js";
import type {
  EngineTool,
  EngineToolResult,
  ExecutionContext,
} from "../types.js";

// ─── Delta type ──────────────────────────────────────────────────────

export interface CharacterInteractionDelta {
  status: "completed" | "failed";
  actorId: string;
  locationId: string;
  actorChanges: Record<string, unknown> | null;
  targetChanges: Record<string, Record<string, unknown>>;
  failureReason?: string;
}

// ─── EngineTool implementation ───────────────────────────────────────

export const characterInteractionOp: EngineTool<CharacterInteractionDelta> = {
  id: "character_interaction",

  description:
    "Interact with one or more characters (NPC or player). " +
    "Supports conversation, item exchange, persuasion, intimidation, " +
    "physical contact, escorting, or forcing someone to leave. " +
    "An LLM resolver determines state changes (HP, SAN, items, " +
    "position, conditions, appearance) for both actor and targets.",

  schema: {
    requiredParams: [
      {
        name: "actorId",
        type: "string",
        description: "Character performing the interaction",
      },
      {
        name: "action",
        type: "string",
        description: "Description of the interaction",
      },
      {
        name: "targetCharacterIds",
        type: "string[]",
        description: "Array of target character IDs",
      },
    ],
    optionalParams: [
      {
        name: "skill",
        type: "string",
        description:
          "Skill to roll for the interaction (triggers opposed rolls)",
      },
    ],
    example: {
      actorId: "npc_01",
      action: "Convince Dr. Morgan to follow me to the library",
      targetCharacterIds: ["npc_dr_morgan"],
      skill: "Persuade",
    },
  },

  async execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): Promise<EngineToolResult<CharacterInteractionDelta>> {
    const actorId = params.actorId as string;
    const action = params.action as string;
    const targetCharacterIds = params.targetCharacterIds as string[];
    const skill = params.skill as string | undefined;

    const state = dgsm.getState();
    const pos = dgsm.getCharacterPosition(actorId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";
    const npc = state.npcCharacters.find((n) => n.id === actorId);
    const npcSkills = npc?.skills ?? {};

    // 1. Check targets not empty
    if (!targetCharacterIds || targetCharacterIds.length === 0) {
      return {
        delta: {
          status: "failed",
          actorId,
          locationId,
          actorChanges: null,
          targetChanges: {},
          failureReason: "no_targets",
        },
        narrative: { outcome: "No targets specified" },
      };
    }

    // 2. Target presence check — all targets must be co-located
    for (const targetId of targetCharacterIds) {
      const targetPos = dgsm.getCharacterPosition(targetId);
      const targetLocation = targetPos
        ? dgsm.resolveLocationId(targetPos)
        : undefined;
      if (
        targetLocation &&
        (!arePositionsCoLocated(pos, targetPos, dgsm) ||
          dgsm.isCharacterHidden(targetId))
      ) {
        return {
          delta: {
            status: "failed",
            actorId,
            locationId,
            actorChanges: null,
            targetChanges: {},
            failureReason: "target_absent",
          },
          narrative: {
            outcome: `Target ${targetId} is not present at the location`,
          },
        };
      }
    }

    // 3. Scene + character penalties
    const scenePenalties = ctx.getScenePenalties(locationId, dgsm);
    const charPenalties = ctx.getCharacterPenalties(actorId, dgsm);
    const afterScene = ctx.applyPenalties(npcSkills, scenePenalties);
    const adjustedSkills = ctx.applyPenalties(afterScene, charPenalties);

    // 4. Skill roll (opposed rolls via pseudo-node)
    let skillRollResult: {
      successLevel: string;
      detail: string;
      perTargetResults?: Record<
        string,
        { successLevel: string; actorWon: boolean; detail: string }
      >;
    } | null = null;

    if (skill) {
      // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for existing resolveSkillRoll
      const pseudoNode = {
        characterId: actorId,
        skill,
        action,
        impact: 0,
        targetCharacterIds,
      } as any;

      const rollResult = ctx.resolveSkillRoll(
        pseudoNode,
        adjustedSkills,
        dgsm,
        (targetId, rawSkills) => {
          const targetScenePenalties = ctx.getScenePenalties(locationId, dgsm);
          const targetCharPenalties = ctx.getCharacterPenalties(targetId, dgsm);
          return ctx.applyPenalties(
            ctx.applyPenalties(rawSkills, targetScenePenalties),
            targetCharPenalties
          );
        }
      );

      if (rollResult.failed) {
        return {
          delta: {
            status: "failed",
            actorId,
            locationId,
            actorChanges: null,
            targetChanges: {},
            failureReason: "skill_roll_failed",
          },
          narrative: {
            outcome: rollResult.reason ?? "Skill check failed",
          },
        };
      }

      skillRollResult = {
        successLevel: rollResult.successLevel,
        detail: rollResult.detail ?? "",
        perTargetResults: rollResult.perTargetResults,
      };
    }

    // 5. LLM resolution via resolveInteractionState (when runtime available)
    if (ctx.runtime) {
      // biome-ignore lint/suspicious/noExplicitAny: bridge — pseudo-node for existing resolver
      const pseudoNode = {
        characterId: actorId,
        characterName: npc?.name ?? actorId,
        action,
        skill,
        targetCharacterIds,
        type: "character_interaction",
        impact: 0,
        startTime: "00:00",
        endTime: "00:05",
        executionMeta: { startedAt: "00:00", remainingMinutes: 5 },
      } as any;

      const interactionDelta = await resolveInteractionState(
        pseudoNode,
        dgsm,
        ctx.runtime,
        skillRollResult as any,
        [],
        locationId,
        ctx.language ?? "en"
      );

      // Build per-character memories
      const memories: Array<{ characterId: string; text: string }> = [];
      if (interactionDelta.actorChanges?.memory) {
        memories.push({
          characterId: actorId,
          text: interactionDelta.actorChanges.memory,
        });
      }
      for (const [targetId, changes] of Object.entries(
        interactionDelta.targetChanges
      )) {
        if (changes?.memory) {
          memories.push({ characterId: targetId, text: changes.memory });
        }
      }

      return {
        delta: {
          status: "completed",
          actorId,
          locationId,
          actorChanges: interactionDelta.actorChanges as Record<
            string,
            unknown
          >,
          targetChanges: interactionDelta.targetChanges as Record<
            string,
            Record<string, unknown>
          >,
        },
        narrative: {
          outcome: action,
          memories,
        },
      };
    }

    // 6. No runtime — return minimal completed delta
    return {
      delta: {
        status: "completed",
        actorId,
        locationId,
        actorChanges: null,
        targetChanges: {},
      },
      narrative: { outcome: action },
    };
  },

  applyDelta(
    dgsm: DynamicGameStateManager,
    delta: CharacterInteractionDelta
  ): void {
    if (delta.status !== "completed") return;

    const targetIds = Object.keys(delta.targetChanges);

    // Apply actor changes
    if (delta.actorChanges) {
      applyCharacterDelta(
        dgsm,
        delta.actorId,
        delta.actorChanges as any,
        targetIds.length > 0 ? targetIds : [delta.actorId]
      );
    }

    // Apply target changes
    for (const [targetId, changes] of Object.entries(delta.targetChanges)) {
      if (changes) {
        applyCharacterDelta(dgsm, targetId, changes as any, [delta.actorId]);
      }
    }
  },
};
