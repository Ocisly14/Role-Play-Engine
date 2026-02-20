import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import { buildBattleKeeperSystemPrompt } from "./battleKeeperTemplate.js";
import type { CombatActionAResult } from "./combatActionAgentA.js";

/**
 * Battle Keeper Agent - Generates combat-focused narrative
 */
export class BattleKeeperAgent {
  private parseNarrative(response: string): string {
    try {
      let jsonText = response.trim();
      const codeBlock = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlock) jsonText = codeBlock[1].trim();
      if (!jsonText.startsWith("{")) {
        const obj = jsonText.match(/\{[\s\S]*\}/);
        if (obj) jsonText = obj[0];
      }
      const parsed = JSON.parse(jsonText);
      return (parsed as any).narrative || "";
    } catch {
      // If JSON parsing fails, return the response as-is (may be plain text narrative)
      return response.trim();
    }
  }

  private buildContext(
    dgsm: DynamicGameStateManager,
    combatNpcIds: string[],
    actionResult: CombatActionAResult | null,
    extraContext?: string
  ): string {
    const state = dgsm.getState();
    const fullGameTime = dgsm.getFullGameTime();

    // Full scene info
    const scenario = state.currentScenario;
    const sceneBlock = scenario
      ? JSON.stringify(
          {
            name: scenario.name,
            location: scenario.location,
            description: scenario.description,
            objects: (scenario as any).objects ?? [],
            exits: (scenario as any).exits ?? [],
            atmosphere: (scenario as any).atmosphere ?? "",
          },
          null,
          2
        )
      : `{ "location": "Unknown" }`;

    // Full player profile
    const player = state.playerCharacter;
    const playerBlock = JSON.stringify(
      {
        name: player.name,
        status: player.status,
        attributes: player.attributes,
        skills: player.skills,
      },
      null,
      2
    );

    // Full combat NPC profiles
    const combatNpcs = state.npcCharacters
      .filter((npc) => combatNpcIds.includes(npc.id))
      .map((npc) => ({
        id: npc.id,
        name: npc.name,
        description: (npc as any).description ?? "",
        personality: npc.personality,
        status: npc.status,
        attributes: (npc as any).attributes ?? {},
        skills: (npc as any).skills ?? [],
        weapons: (npc as any).weapons ?? [],
      }));

    // Last 3 turns of conversation history
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
      `\n\n=== GAME TIME ===\n${fullGameTime}\n` +
      `\n=== CURRENT SCENE ===\n${sceneBlock}\n` +
      `\n=== PLAYER CHARACTER ===\n${playerBlock}\n` +
      `\n=== COMBAT NPCs ===\n${JSON.stringify(combatNpcs, null, 2)}\n` +
      `\n=== RECENT CONVERSATION (last 3 turns) ===\n${historyBlock}\n`;

    if (actionResult) {
      ctx += `\n=== COMBAT ACTION RESULTS (this round) ===\n${JSON.stringify(
        {
          actionLog: actionResult.actionLog,
          combatEnded: actionResult.combatEnded,
          combatEndReason: actionResult.combatEndReason,
        },
        null,
        2
      )}\n`;
    }

    if (extraContext) {
      ctx += `\n=== ADDITIONAL CONTEXT ===\n${extraContext}\n`;
    }

    return ctx;
  }

  async generateCombatNarrative(
    dgsm: DynamicGameStateManager,
    actionResult: CombatActionAResult,
    playerInput: string,
    language: "en" | "zh",
    onNarrativeDelta?: (delta: string) => void
  ): Promise<string> {
    const state = dgsm.getState();
    const combatState = state.combatState;
    const round = combatState?.round ?? 1;

    const systemPrompt = buildBattleKeeperSystemPrompt(round, playerInput, language);
    const context = this.buildContext(
      dgsm,
      combatState?.participantNpcIds ?? [],
      actionResult
    );
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
      onToken: onNarrativeDelta,
    });

    return this.parseNarrative(response);
  }

  async generateEntryNarrative(
    dgsm: DynamicGameStateManager,
    actionSummary: string,
    playerInput: string,
    language: "en" | "zh",
    onNarrativeDelta?: (delta: string) => void
  ): Promise<string> {
    const state = dgsm.getState();
    const combatState = state.combatState;

    const systemPrompt = buildBattleKeeperSystemPrompt(combatState?.round ?? 1, playerInput, language);
    const context = this.buildContext(
      dgsm,
      combatState?.participantNpcIds ?? [],
      null,
      `Initial combat context: ${actionSummary}`
    );
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
      onToken: onNarrativeDelta,
    });

    return this.parseNarrative(response);
  }

  async generateDefeatNarrative(
    dgsm: DynamicGameStateManager,
    actionResult: CombatActionAResult | null,
    playerInput: string,
    language: "en" | "zh"
  ): Promise<string> {
    const state = dgsm.getState();
    const combatState = state.combatState;

    const systemPrompt = buildBattleKeeperSystemPrompt(combatState?.round ?? 1, playerInput, language);
    const context = this.buildContext(
      dgsm,
      combatState?.participantNpcIds ?? [],
      actionResult
    );
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime: {},
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    return this.parseNarrative(response);
  }
}
