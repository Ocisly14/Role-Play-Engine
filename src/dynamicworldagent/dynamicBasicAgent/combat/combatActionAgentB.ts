import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { PendingNpcAction } from "../../state/DynamicGameState.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import { buildCombatActionBSystemPrompt } from "./combatActionAgentBTemplate.js";
import { withCombatSkillDefaults } from "./combatSkillDefaults.js";
import type { CombatActionAResult } from "./combatActionAgentA.js";

export interface CombatActionBResult {
  narrative: string;
  pendingNpcActions: PendingNpcAction[];
  combatEnded: boolean;
  combatEndReason: string;
  defeatedNpcs: Array<{
    npcId: string;
    npcName: string;
  }>;
}

/**
 * Combat Action Agent B - Generates NPC attack narratives (no dice, just intent)
 */
export class CombatActionAgentB {
  private normalizeDefeatedNpcs(raw: unknown): Array<{
    npcId: string;
    npcName: string;
  }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const npcId = (item as Record<string, unknown>).npcId;
        const npcName = (item as Record<string, unknown>).npcName;
        if (typeof npcId !== "string" || typeof npcName !== "string") {
          return null;
        }
        const trimmedId = npcId.trim();
        const trimmedName = npcName.trim();
        if (!trimmedId || !trimmedName) return null;
        return { npcId: trimmedId, npcName: trimmedName };
      })
      .filter(
        (item): item is { npcId: string; npcName: string } => item !== null
      );
  }

  private parseResponse(response: string): CombatActionBResult | null {
    try {
      let jsonText = response.trim();
      const codeBlock = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlock) jsonText = codeBlock[1].trim();
      if (!jsonText.startsWith("{")) {
        const obj = jsonText.match(/\{[\s\S]*\}/);
        if (obj) jsonText = obj[0];
      }
      const parsed = JSON.parse(jsonText) as Partial<CombatActionBResult>;
      return {
        narrative: typeof parsed.narrative === "string" ? parsed.narrative : "",
        pendingNpcActions: Array.isArray(parsed.pendingNpcActions)
          ? parsed.pendingNpcActions
          : [],
        combatEnded: parsed.combatEnded === true,
        combatEndReason:
          typeof parsed.combatEndReason === "string" ? parsed.combatEndReason : "",
        defeatedNpcs: this.normalizeDefeatedNpcs(parsed.defeatedNpcs),
      };
    } catch {
      return null;
    }
  }

  private buildContext(
    dgsm: DynamicGameStateManager,
    combatNpcIds: string[],
    combatAResult?: CombatActionAResult | null
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

    let ctx =
      `\n\n=== CURRENT GAME TIME ===\n${fullGameTime}\n=== END GAME TIME ===\n` +
      `\nCurrent Scene: ${state.currentScenario?.location || "Unknown"}\n` +
      `Scene Description: ${state.currentScenario?.description || ""}\n` +
      `\nPlayer Character:\n${JSON.stringify(playerContext, null, 2)}\n` +
      `\nCombat NPCs:\n${JSON.stringify(combatNpcs, null, 2)}\n` +
      `\n=== RECENT CONVERSATION (last 3 turns) ===\n${historyBlock}`;

    if (combatAResult) {
      ctx += `\n\n=== THIS ROUND ACTION RESULT (from Agent A) ===\n${JSON.stringify(
        {
          diceUsed: combatAResult.diceUsed,
          actionLog: combatAResult.actionLog,
          hpDeltas: {
            player: combatAResult.stateUpdate?.playerCharacter?.status?.hp ?? 0,
            npcs: (combatAResult.stateUpdate?.npcCharacters ?? []).map((npc) => ({
              id: npc.id,
              name: npc.name,
              hpDelta: npc.status?.hp ?? 0,
            })),
          },
          timeElapsedMinutes: combatAResult.timeElapsedMinutes,
        },
        null,
        2
      )}\n=== END ACTION RESULT ===`;
    } else {
      // 进入战斗首轮：注入普通 action agent 的结果作为战斗开始的上下文
      const entryActionResults = state.temporaryInfo.actionResults || [];
      if (entryActionResults.length > 0) {
        ctx += `\n\n=== ENTRY CONTEXT (how combat began this turn) ===\n${JSON.stringify(
          entryActionResults.map((r) => ({
            character: r.character,
            result: r.result,
            diceRolls: r.diceRolls || [],
            timeConsumption: r.timeConsumption,
          })),
          null,
          2
        )}\n=== END ENTRY CONTEXT ===`;
      }
    }

    return ctx;
  }

  async generateNpcActions(
    dgsm: DynamicGameStateManager,
    playerInput: string,
    keeperNarrative: string,
    language: "en" | "zh",
    combatAResult?: CombatActionAResult | null
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
    const context = this.buildContext(dgsm, combatState.participantNpcIds, combatAResult);
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    return this.parseResponse(response);
  }
}
