import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import { buildBattleKeeperSystemPrompt } from "./battleKeeperTemplate.js";
import type { CombatActionAResult } from "./combatActionAgentA.js";
import { withCombatSkillDefaults } from "./combatSkillDefaults.js";
import type { ActionResult } from "../../../shared/state/index.js";

/**
 * Battle Keeper Agent - Generates combat-focused narrative
 * Uses MultiplayerDynamicGameStateManager directly (no adapter shim).
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
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    combatNpcIds: string[],
    actionResult: CombatActionAResult | null,
    extraContext?: string
  ): string {
    const state = manager.getSceneRoomState(sceneRoomId);
    const fullGameTime = manager.getSceneRoomFullGameTime(sceneRoomId);

    // Full scene info
    const scenario = state.currentScenario;
    const sceneBlock = scenario
      ? JSON.stringify(
          {
            name: scenario.name,
            location: scenario.location,
            description: scenario.description,
            objects: scenario.objects ?? [],
            exits: scenario.exits ?? [],
            atmosphere: scenario.atmosphere ?? "",
          },
          null,
          2
        )
      : `{ "location": "Unknown" }`;

    // Build player characters context (all players in sceneRoom)
    const allPlayers: any[] = state.playerCharacters ?? [];
    const playerCharactersBlock = allPlayers.map((player: any) => ({
      id: player.id,
      name: player.name,
      status: player.status,
      attributes: player.attributes,
      skills: withCombatSkillDefaults(player.skills, player.attributes),
    }));

    // Fallback: single-player path
    if (playerCharactersBlock.length === 0 && state.playerCharacter) {
      const player = state.playerCharacter;
      playerCharactersBlock.push({
        id: player.id,
        name: player.name,
        status: player.status,
        attributes: player.attributes,
        skills: withCombatSkillDefaults(player.skills, player.attributes),
      });
    }

    // Full combat NPC profiles
    const combatNpcs = state.npcCharacters
      .filter((npc: any) => combatNpcIds.includes(npc.id))
      .map((npc: any) => ({
        id: npc.id,
        name: npc.name,
        description: npc.description ?? "",
        personality: npc.personality,
        status: npc.status,
        attributes: npc.attributes ?? {},
        skills: withCombatSkillDefaults(
          npc.skills,
          npc.attributes
        ),
        weapons: npc.weapons ?? [],
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
              (t: any) =>
                `[Turn ${t.turnNumber}]\nPlayer: ${t.characterInput}\nKeeper: ${t.keeperNarrative ?? "(no narrative)"}`
            )
            .join("\n\n")
        : "(no prior turns)";

    let ctx =
      `\n\n=== GAME TIME ===\n${fullGameTime}\n` +
      `\n=== CURRENT SCENE ===\n${sceneBlock}\n` +
      `\n=== PLAYER CHARACTERS ===\n${JSON.stringify(playerCharactersBlock, null, 2)}\n` +
      `\n=== COMBAT NPCs ===\n${JSON.stringify(combatNpcs, null, 2)}\n` +
      `\n=== RECENT CONVERSATION (last 3 turns) ===\n${historyBlock}\n`;

    if (actionResult) {
      ctx += `\n=== COMBAT ACTION RESULTS (this round) ===\n${JSON.stringify(
        {
          diceUsed: actionResult.diceUsed,
          actionLog: actionResult.actionLog,
          stateUpdate: actionResult.stateUpdate,
          timeElapsedMinutes: actionResult.timeElapsedMinutes,
          combatEnded: actionResult.combatEnded,
          combatEndReason: actionResult.combatEndReason,
        },
        null,
        2
      )}\n`;

      ctx += `\n=== OUTCOME CONSTRAINTS (MUST FOLLOW) ===\n${JSON.stringify(
        this.buildCombatOutcomeConstraints(actionResult),
        null,
        2
      )}\n`;
    }

    if (extraContext) {
      ctx += `\n=== ADDITIONAL CONTEXT ===\n${extraContext}\n`;
    }

    return ctx;
  }

  private buildCombatOutcomeConstraints(
    actionResult: CombatActionAResult
  ): Record<string, unknown> {
    const diceOutcomes = (actionResult.diceUsed || []).map((entry) => {
      const actorMatch = String(entry).match(/^([^:]+):/);
      const levelMatches = String(entry).match(
        /\b(critical|extreme|hard|regular|failure|fumble)\b/gi
      );
      const outcome = levelMatches
        ? levelMatches[levelMatches.length - 1]!.toLowerCase()
        : "unknown";
      return {
        actor: actorMatch?.[1]?.trim() || "Unknown",
        outcome,
        raw: entry,
      };
    });

    const npcHpDeltas = (actionResult.stateUpdate?.npcCharacters || []).map(
      (npc) => ({
        id: npc.id,
        name: npc.name,
        hpDelta: npc.status?.hp ?? 0,
      })
    );

    const playerHpDeltas = (
      actionResult.stateUpdate?.playerCharacters || []
    ).map((pc) => ({
      id: pc.id,
      name: pc.name,
      hpDelta: pc.status?.hp ?? 0,
    }));

    return {
      diceOutcomes,
      actionSuccessLevels: (actionResult.actionLog || []).map((entry) => ({
        characterId: entry.characterId,
        successLevel: entry.successLevel || "unknown",
        summary: entry.summary,
      })),
      hpDeltas: {
        players: playerHpDeltas,
        npcs: npcHpDeltas,
      },
      rules: [
        "If outcome is failure/fumble, narrate failed action rather than successful effect.",
        "Only narrate concrete injury when hpDelta is negative for that character.",
        "Do not invent additional damage not present in hpDeltas.",
      ],
    };
  }

  private formatEntryActionContext(actionResults: ActionResult[]): string {
    const compactResults = (actionResults || []).map((result) => ({
      character: result.character,
      result: result.result,
      location: result.location,
      gameTime: result.gameTime,
      timeElapsedMinutes: result.timeElapsedMinutes || 0,
      timeConsumption: result.timeConsumption,
      diceRolls: result.diceRolls || [],
    }));

    return JSON.stringify(
      {
        actionResults: compactResults,
        rules: [
          "Treat diceRolls as resolved outcomes.",
          "If roll text contains '= failure' or '= fumble', describe failed attempt.",
          "Do not narrate injury unless state updates/logs support actual damage.",
        ],
      },
      null,
      2
    );
  }

  async generateCombatNarrative(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    actionResult: CombatActionAResult,
    playerInput: string,
    language: "en" | "zh",
    onNarrativeDelta?: (delta: string) => void
  ): Promise<string> {
    const state = manager.getSceneRoomState(sceneRoomId);
    const combatState = state.combatState;
    const round = combatState?.round ?? 1;

    const systemPrompt = buildBattleKeeperSystemPrompt(round, playerInput, language);
    const context = this.buildContext(
      manager,
      sceneRoomId,
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
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    actionResults: ActionResult[],
    playerInput: string,
    language: "en" | "zh",
    onNarrativeDelta?: (delta: string) => void
  ): Promise<string> {
    const state = manager.getSceneRoomState(sceneRoomId);
    const combatState = state.combatState;

    const systemPrompt = buildBattleKeeperSystemPrompt(combatState?.round ?? 1, playerInput, language);
    const context = this.buildContext(
      manager,
      sceneRoomId,
      combatState?.participantNpcIds ?? [],
      null,
      `Initial combat context: ${this.formatEntryActionContext(actionResults)}`
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
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    actionResult: CombatActionAResult | null,
    playerInput: string,
    language: "en" | "zh"
  ): Promise<string> {
    const state = manager.getSceneRoomState(sceneRoomId);
    const combatState = state.combatState;

    const systemPrompt = buildBattleKeeperSystemPrompt(combatState?.round ?? 1, playerInput, language);
    const context = this.buildContext(
      manager,
      sceneRoomId,
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
