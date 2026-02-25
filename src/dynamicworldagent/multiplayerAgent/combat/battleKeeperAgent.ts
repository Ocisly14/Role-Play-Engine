import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { DynamicGameStateManager } from "../../state/index.js";
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import { buildBattleKeeperSystemPrompt } from "./battleKeeperTemplate.js";
import type { CombatActionAResult } from "./combatActionAgentA.js";
import { withCombatSkillDefaults } from "./combatSkillDefaults.js";
import type { ActionResult } from "../../../shared/state/index.js";

/**
 * Battle Keeper Agent - Generates combat-focused narrative
 */
export class BattleKeeperAgent {
  /**
   * Multiplayer native wrapper.
   * Current implementation uses the first player in the sceneRoom as the "active" playerCharacter view.
   */
  async generateEntryNarrativeForSceneRoom(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    actionResults: ActionResult[],
    playerInput: string,
    language: "en" | "zh",
    onNarrativeDelta?: (delta: string) => void
  ): Promise<string> {
    const adapter = this.buildManagerAdapter(manager, sceneRoomId);
    return this.generateEntryNarrative(
      adapter,
      actionResults,
      playerInput,
      language,
      onNarrativeDelta
    );
  }

  private buildManagerAdapter(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): DynamicGameStateManager {
    const getView = (): any => {
      const s = manager.getState();
      const scr = manager.getSceneRoom(sceneRoomId);
      const playerIds = scr?.memberPlayerIds ?? [];
      const firstPlayer = s.players[playerIds[0]];
      const profile: any = firstPlayer?.profile ?? null;
      if (profile) {
        if (!profile.id) profile.id = firstPlayer?.characterId ?? profile.id;
        if (!profile.name) profile.name = firstPlayer?.characterName ?? profile.name;
      }
      return {
        ...s,
        currentScenario: scr?.currentScenario ?? null,
        temporaryInfo: scr?.temporaryInfo ?? {
          rules: [],
          contextualData: {},
          actionResults: [],
          actionResultsDetailed: [],
          currentActionAnalysis: null,
          npcResponseAnalyses: [],
          sceneChangeRequest: null,
          previousScenario: null,
        },
        turnsInCurrentScene: scr?.turnsInCurrentScene ?? 0,
        playerCharacter: profile,
        staminaState: firstPlayer?.staminaState ?? {
          minutesSinceLastRest: 0,
          fatigueActive: false,
        },
      };
    };

    return {
      getState: getView,
      getFullGameTime: () => manager.getFullGameTime(),
      isFatigued: () => {
        const scr = manager.getSceneRoom(sceneRoomId);
        const activePlayerId = scr?.memberPlayerIds?.[0];
        return activePlayerId ? manager.isFatigued(activePlayerId) : false;
      },
      setContextualData: (key: string, value: unknown) =>
        manager.setContextualData(sceneRoomId, key, value),
      getContextualData: (key: string) => manager.getContextualData(sceneRoomId, key),
    } as unknown as DynamicGameStateManager;
  }

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
        skills: withCombatSkillDefaults(player.skills, player.attributes),
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
        skills: withCombatSkillDefaults(
          (npc as any).skills,
          (npc as any).attributes
        ),
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

    return {
      diceOutcomes,
      actionSuccessLevels: (actionResult.actionLog || []).map((entry) => ({
        characterId: entry.characterId,
        successLevel: entry.successLevel || "unknown",
        summary: entry.summary,
      })),
      hpDeltas: {
        player: actionResult.stateUpdate?.playerCharacter?.status?.hp ?? 0,
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
    actionResults: ActionResult[],
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
