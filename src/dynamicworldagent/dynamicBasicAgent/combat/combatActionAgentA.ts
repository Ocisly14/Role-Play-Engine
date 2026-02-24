import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { PendingNpcAction } from "../../state/DynamicGameState.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import { buildCombatActionASystemPrompt } from "./combatActionAgentATemplate.js";
import { withCombatSkillDefaults } from "./combatSkillDefaults.js";

export interface CombatActionAResult {
  diceUsed: string[];
  actionLog: Array<{
    characterId: string;
    summary: string;
    successLevel?: string;
    time: string;
    location: string;
  }>;
  stateUpdate: {
    playerCharacter?: { status?: { hp?: number; conditions?: string[] } };
    npcCharacters?: Array<{
      id: string;
      name: string;
      status?: { hp?: number; conditions?: string[] };
    }>;
  };
  timeElapsedMinutes: number;
  combatEnded: boolean;
  combatEndReason: string;
  defeatedNpcs: Array<{
    npcId: string;
    npcName: string;
  }>;
}

/**
 * Combat Action Agent A - Resolves player attack or player defense against NPC attacks
 */
export class CombatActionAgentA {
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

  private preRollDice(): Record<string, number[]> {
    const roll = (sides: number, count: number): number[] =>
      Array.from(
        { length: count },
        () => Math.floor(Math.random() * sides) + 1
      );

    const d6_pairs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const pair = roll(6, 2);
      d6_pairs.push(pair[0] + pair[1]);
    }

    return {
      "1d100": roll(100, 10),
      "1d100_opposed": roll(100, 5),
      "1d20": roll(20, 5),
      "1d10": roll(10, 5),
      "1d8": roll(8, 5),
      "1d6": roll(6, 5),
      "2d6": d6_pairs,
      "1d4": roll(4, 5),
      "1d3": roll(3, 5),
    };
  }

  private parseResponse(response: string): CombatActionAResult | null {
    try {
      let jsonText = response.trim();
      const codeBlock = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlock) jsonText = codeBlock[1].trim();
      if (!jsonText.startsWith("{")) {
        const obj = jsonText.match(/\{[\s\S]*\}/);
        if (obj) jsonText = obj[0];
      }
      const parsed = JSON.parse(jsonText) as Partial<CombatActionAResult>;
      return {
        diceUsed: Array.isArray(parsed.diceUsed) ? parsed.diceUsed : [],
        actionLog: Array.isArray(parsed.actionLog) ? parsed.actionLog : [],
        stateUpdate:
          parsed.stateUpdate && typeof parsed.stateUpdate === "object"
            ? parsed.stateUpdate
            : {},
        timeElapsedMinutes:
          typeof parsed.timeElapsedMinutes === "number"
            ? parsed.timeElapsedMinutes
            : 1,
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

    // Last 3 turns of conversation history (populated by Memory Agent before combat routing)
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

    let ctx = `\n\n=== CURRENT GAME TIME ===\n${fullGameTime}\n=== END GAME TIME ===\n`;
    ctx += `\n\nCurrent Scene: ${state.currentScenario?.location || "Unknown"}\n`;
    ctx += `Scene Description: ${state.currentScenario?.description || ""}\n`;
    ctx += `\n\nPlayer Character:\n${JSON.stringify(playerContext, null, 2)}`;
    ctx += `\n\nCombat NPCs:\n${JSON.stringify(combatNpcs, null, 2)}`;
    ctx += `\n\nCombat Round: ${state.combatState?.round ?? 1}`;
    ctx += `\n\n=== RECENT CONVERSATION (last 3 turns) ===\n${historyBlock}`;

    return ctx;
  }

  async resolvePlayerAttack(
    dgsm: DynamicGameStateManager,
    playerInput: string,
    selectedSkill: string | null,
    language: "en" | "zh"
  ): Promise<CombatActionAResult | null> {
    const state = dgsm.getState();
    const combatState = state.combatState;
    if (!combatState) return null;

    const preRolledDice = this.preRollDice();

    const systemPrompt = buildCombatActionASystemPrompt(
      "attack",
      preRolledDice,
      null,
      selectedSkill,
      playerInput,
      combatState.round,
      language,
      dgsm.isFatigued()
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

  async resolvePlayerDefense(
    dgsm: DynamicGameStateManager,
    playerInput: string,
    selectedSkill: string | null,
    pendingNpcActions: PendingNpcAction[],
    language: "en" | "zh"
  ): Promise<CombatActionAResult | null> {
    const state = dgsm.getState();
    const combatState = state.combatState;
    if (!combatState) return null;

    const preRolledDice = this.preRollDice();

    const systemPrompt = buildCombatActionASystemPrompt(
      "defend",
      preRolledDice,
      pendingNpcActions,
      selectedSkill,
      playerInput,
      combatState.round,
      language,
      dgsm.isFatigued()
    );

    const context = this.buildContext(dgsm, combatState.participantNpcIds);
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.SMALL,
    });

    return this.parseResponse(response);
  }

  /**
   * Apply combat action result to game state
   */
  applyResult(
    dgsm: DynamicGameStateManager,
    result: CombatActionAResult
  ): void {
    if (result.stateUpdate) {
      dgsm.applyActionUpdate(result.stateUpdate);
    }

    const state = dgsm.getState();
    const fullTime = dgsm.getFullGameTime();
    const location = state.currentScenario?.location || "Unknown";

    // Add actionLog entries to characters
    for (const entry of result.actionLog || []) {
      const {
        characterId,
        summary,
        successLevel,
        time,
        location: entryLocation,
      } = entry;
      const logTime = time || fullTime;
      const logLocation = entryLocation || location;

      if (characterId === state.playerCharacter.id) {
        const player = state.playerCharacter;
        if (!player.actionLog) player.actionLog = [];
        player.actionLog.push({
          time: logTime,
          location: logLocation,
          summary,
          successLevel: successLevel as any,
        });
      } else {
        const npc = state.npcCharacters.find((n) => n.id === characterId);
        if (npc) {
          if (!npc.actionLog) npc.actionLog = [];
          npc.actionLog.push({
            time: logTime,
            location: logLocation,
            summary,
            successLevel: successLevel as any,
          });
        }
      }
    }

    // Advance game time for combat rounds (1 minute each round)
    if (result.timeElapsedMinutes > 0) {
      dgsm.updateGameTime(result.timeElapsedMinutes);
    }
  }
}
