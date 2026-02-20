import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { PendingNpcAction } from "../../state/DynamicGameState.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import { buildCombatActionBSystemPrompt } from "./combatActionAgentBTemplate.js";
import { withCombatSkillDefaults } from "./combatSkillDefaults.js";

export interface CombatActionBResult {
  narrative: string;
  pendingNpcActions: PendingNpcAction[];
  combatEnded: boolean;
  combatEndReason: string;
}

/**
 * Combat Action Agent B - Generates NPC attack narratives (no dice, just intent)
 */
export class CombatActionAgentB {
  private parseResponse(response: string): CombatActionBResult | null {
    try {
      let jsonText = response.trim();
      const codeBlock = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlock) jsonText = codeBlock[1].trim();
      if (!jsonText.startsWith("{")) {
        const obj = jsonText.match(/\{[\s\S]*\}/);
        if (obj) jsonText = obj[0];
      }
      return JSON.parse(jsonText) as CombatActionBResult;
    } catch {
      return null;
    }
  }

  private buildContext(
    dgsm: DynamicGameStateManager,
    combatNpcIds: string[]
  ): string {
    const state = dgsm.getState();
    const fullGameTime = dgsm.getFullGameTime();

    const combatNpcs = state.npcCharacters
      .filter((npc) => combatNpcIds.includes(npc.id))
      .map((npc) => ({
        id: npc.id,
        name: npc.name,
        attributes: npc.attributes,
        status: npc.status,
        skills: withCombatSkillDefaults(npc.skills, npc.attributes),
        inventory: npc.inventory || [],
        weapons: (npc as any).weapons || [],
        personality: npc.personality,
        recentActionLog: (npc.actionLog || []).slice(-5),
      }));

    const player = state.playerCharacter;
    const playerContext = {
      id: player.id,
      name: player.name,
      attributes: player.attributes,
      status: player.status,
      skills: withCombatSkillDefaults(player.skills, player.attributes),
      inventory: player.inventory || [],
      weapons: (player as any).weapons || [],
      recentActionLog: (player.actionLog || []).slice(-5),
    };

    const conversationHistory = (
      (state.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) ?? []
    ).slice(-3);

    const historyBlock =
      conversationHistory.length > 0
        ? conversationHistory
            .map(
              (t) =>
                `[Turn ${t.turnNumber}]\nPlayer: ${t.characterInput}\nKeeper: ${t.keeperNarrative ?? "(no narrative)"}`
            )
            .join("\n\n")
        : "(no prior turns)";

    return (
      `\n\n=== CURRENT GAME TIME ===\n${fullGameTime}\n=== END GAME TIME ===\n` +
      `\nCurrent Scene: ${state.currentScenario?.location || "Unknown"}\n` +
      `Scene Description: ${state.currentScenario?.description || ""}\n` +
      `\nPlayer Character:\n${JSON.stringify(playerContext, null, 2)}\n` +
      `\nCombat NPCs:\n${JSON.stringify(combatNpcs, null, 2)}\n` +
      `\n=== RECENT CONVERSATION (last 3 turns) ===\n${historyBlock}`
    );
  }

  async generateNpcActions(
    dgsm: DynamicGameStateManager,
    playerInput: string,
    keeperNarrative: string,
    language: "en" | "zh"
  ): Promise<CombatActionBResult | null> {
    const state = dgsm.getState();
    const combatState = state.combatState;
    if (!combatState) return null;

    const systemPrompt = buildCombatActionBSystemPrompt(
      combatState.round,
      playerInput,
      keeperNarrative,
      language
    );
    const context = this.buildContext(dgsm, combatState.participantNpcIds);
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    return this.parseResponse(response);
  }
}
