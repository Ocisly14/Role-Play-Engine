import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../../models/index.js";
import type {
  ActionLogEntry,
  NPCClue,
} from "../../../shared/agents/models/gameTypes.js";
import type { ScenarioClue } from "../../../shared/agents/models/scenarioTypes.js";
import type {
  ActionAnalysis,
  ActionResult,
  DiscoveredClue,
} from "../../../shared/state/index.js";
import { composeTemplateWithImages, type MultiplayerSceneScopedState } from "../../../template.js";
import type { HeartbeatActivatedNarrative } from "../../state/index.js";
import type {
  MultiplayerDynamicGameStateManager,
  MultiplayerDynamicGameState,
  MultiplayerSceneRoomState,
} from "../../multiplayerState/MultiplayerDynamicGameState.js";
import type {
  DynamicCharacterProfile,
  DynamicNPCProfile,
  DynamicScenarioSnapshot,
  ScenarioOutline,
} from "../../world_builder/types.js";
import { getEpilogueTemplate, getKeeperTemplate } from "./keeperTemplate.js";

interface KeeperRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): KeeperRuntime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

interface TargetClueAccess {
  bestSuccessLevel: string; // "regular" | "hard" | "extreme" | "critical" | "none"
  hasFumble: boolean;
  playerNames: string[];
}

interface PerTargetClueAccessMap {
  targets: Map<string, TargetClueAccess>; // key = NPC name or "scenario"
  hasFumble: boolean;
}

/**
 * Keeper Agent - Game master for narrative generation and storytelling
 */
export class KeeperAgent {
  private static readonly SUCCESS_RANK: Record<string, number> = {
    fumble: 0,
    failure: 0,
    regular: 1,
    hard: 2,
    extreme: 3,
    critical: 4,
  };

  /**
   * Derive per-target clue access levels from this turn's detailed action results.
   * Each NPC / scenario target gets an independent best success level.
   */
  private derivePerTargetClueAccess(
    detailedResultsRaw: Array<Record<string, unknown>>
  ): PerTargetClueAccessMap {
    const targets = new Map<string, TargetClueAccess>();
    let globalFumble = false;

    const getOrCreate = (key: string): TargetClueAccess => {
      if (!targets.has(key))
        targets.set(key, {
          bestSuccessLevel: "none",
          hasFumble: false,
          playerNames: [],
        });
      return targets.get(key)!;
    };

    const rankOf = (level: string): number =>
      KeeperAgent.SUCCESS_RANK[level.toLowerCase()] ?? 0;

    const rankToLabel = (rank: number): string => {
      if (rank >= 4) return "critical";
      if (rank >= 3) return "extreme";
      if (rank >= 2) return "hard";
      if (rank >= 1) return "regular";
      return "none";
    };

    for (const detail of detailedResultsRaw) {
      const playerName =
        typeof detail.character === "string" ? detail.character : "Unknown";

      // Collect player's own success levels
      const playerLevels: string[] = [];
      if (Array.isArray(detail.actionLog)) {
        for (const log of detail.actionLog as any[]) {
          const level = log?.successLevel;
          if (typeof level === "string") playerLevels.push(level.toLowerCase());
        }
      }
      if (playerLevels.includes("fumble")) globalFumble = true;

      const playerBestRank = playerLevels.reduce(
        (best, l) => Math.max(best, rankOf(l)),
        0
      );

      // All actions contribute to "scenario" target
      const scenarioTarget = getOrCreate("scenario");
      if (playerBestRank > rankOf(scenarioTarget.bestSuccessLevel)) {
        scenarioTarget.bestSuccessLevel = rankToLabel(playerBestRank);
      }
      if (playerLevels.includes("fumble")) scenarioTarget.hasFumble = true;
      if (!scenarioTarget.playerNames.includes(playerName))
        scenarioTarget.playerNames.push(playerName);

      // NPC interactions contribute to per-NPC targets
      if (Array.isArray(detail.npcResponses)) {
        for (const resp of detail.npcResponses as any[]) {
          const npcName = resp?.npcName || resp?.name || resp?.npcId;
          if (!npcName) continue;
          const npcTarget = getOrCreate(npcName);
          if (playerBestRank > rankOf(npcTarget.bestSuccessLevel)) {
            npcTarget.bestSuccessLevel = rankToLabel(playerBestRank);
          }
          if (playerLevels.includes("fumble")) npcTarget.hasFumble = true;
          if (!npcTarget.playerNames.includes(playerName))
            npcTarget.playerNames.push(playerName);
        }
      }
    }

    return { targets, hasFumble: globalFumble };
  }

  private filterScenarioCluesForKeeper(
    clues: ScenarioClue[] | undefined,
    allowRegularPlus: boolean
  ): ScenarioClue[] {
    if (!Array.isArray(clues)) return [];
    return clues
      .filter((clue) => {
        if (!clue) return false;
        if (clue.damaged) return false;
        if (clue.discovered) return false; // Discovered → served via RAG
        if (clue.difficulty === "automatic") return true;
        return allowRegularPlus;
      })
      .map((clue) => ({ ...clue }));
  }

  private filterNpcCluesForKeeper(
    clues: NPCClue[] | undefined,
    allowRegularPlus: boolean
  ): NPCClue[] {
    if (!Array.isArray(clues)) return [];
    return clues
      .filter((clue) => {
        if (!clue) return false;
        if (clue.revealed) return false; // Revealed → served via RAG
        return allowRegularPlus;
      })
      .map((clue) => ({ ...clue }));
  }

  /**
   * Generate narrative description with clue revelation based on current game state and user query.
   */
  async generateNarrative(
    characterInput: string,
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    language: "en" | "zh" = "zh",
    options?: { onNarrativeDelta?: (delta: string) => void }
  ): Promise<{ narrative: string; clueRevelations: any }> {
    const runtime = createRuntime();
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId)!;
    const tempInfo = sceneRoom.temporaryInfo;

    // Merge fast + slow group action results
    const mergedActionResults = [
      ...(tempInfo.actionResults ?? []),
      ...(tempInfo.slowGroupActionResults ?? []),
    ];
    const mergedDetailedResults = [
      ...(tempInfo.actionResultsDetailed ?? []),
      ...(tempInfo.slowGroupActionResultsDetailed ?? []),
    ];

    // Build NPC clue overlay: union of all active players' revealed IDs
    const playerIds = sceneRoom.memberPlayerIds;
    const roomRevealedClueIds = new Set<string>();
    for (const pid of playerIds) {
      const ps = state.players[pid];
      if (!ps) continue;
      for (const id of ps.revealedNpcClueIds ?? []) roomRevealedClueIds.add(id);
    }

    const npcCharactersWithRoomState = state.npcCharacters.map((npc: any) => ({
      ...npc,
      clues: (npc.clues || []).map((clue: any) => ({
        ...clue,
        revealed: clue.revealed || roomRevealedClueIds.has(`${npc.id}:${clue.id}`),
      })),
    }));

    // Filter out diceRolls/location from action results
    const allActionResults: Omit<ActionResult, "diceRolls" | "location">[] =
      mergedActionResults.map(({ diceRolls, location, ...result }) => result);

    // Build detailed results for template
    const allActionResultsDetailed =
      mergedDetailedResults.length > 0
        ? mergedDetailedResults.map((detail, index) => {
            const character =
              typeof detail.character === "string"
                ? detail.character
                : `Action ${index}`;
            return {
              character,
              actionResultJson: this.safeStringify(detail),
            };
          })
        : null;

    const clueAccessMap = this.derivePerTargetClueAccess(
      mergedDetailedResults as Array<Record<string, unknown>>
    );

    // Global gate: true if ANY target has a success
    const allowRegularPlus = [...clueAccessMap.targets.values()].some(
      (t) => t.bestSuccessLevel !== "none"
    );

    // Scenario info
    const currentScenario = sceneRoom.currentScenario;
    const completeScenarioInfo = this.extractCompleteScenarioInfo(
      currentScenario,
      state.scenarioOutlines,
      allowRegularPlus
    );

    // Action analysis from tempInfo
    const actionAnalysis = tempInfo.currentActionAnalysis;
    const actionTargetName = actionAnalysis?.target?.name || null;
    const actionTargetIntent = actionAnalysis?.target?.intent?.trim()
      ? actionAnalysis.target.intent.trim()
      : null;
    const hasActionTargetInfo = Boolean(actionTargetName || actionTargetIntent);
    const interactionPartnerName = actionTargetName;

    // All player names for NPC extraction
    const allPlayerNames = playerIds
      .map((id) => state.players[id]?.characterName)
      .filter(Boolean) as string[];
    const currentLocation = currentScenario?.location || null;

    // Extract NPCs related to action results
    const actionRelatedNpcs = this.extractActionRelatedNpcs(
      npcCharactersWithRoomState,
      allPlayerNames,
      currentLocation,
      actionAnalysis,
      allActionResults,
      interactionPartnerName,
      allowRegularPlus
    );

    // Scene transition detection
    const sceneChangeRequest = tempInfo.sceneChangeRequest;
    const isTransition = sceneChangeRequest?.shouldChange === true;
    const previousScenarioInfo = isTransition
      ? this.extractPreviousScenarioInfo(tempInfo.previousScenario, state.scenarioOutlines)
      : null;

    // Conversation history
    const conversationHistory =
      (tempInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) || [];

    // Relevant history from RAG
    const relevantHistory =
      (tempInfo.contextualData?.relevantHistory as Array<{
        type: string;
        content: string;
        score: number;
        metadata: Record<string, any>;
      }>) || [];

    // Retrieved clue context from RAG (populated by memory agent)
    const retrievedClueContext =
      (tempInfo.contextualData?.retrievedClueContext as Array<{
        content: string;
        score: number;
        metadata: Record<string, unknown> | null;
        sourceKey: string;
      }>) ?? [];

    // Heartbeat activated narratives
    const heartbeatActivatedNarrativesRaw =
      (tempInfo.contextualData?.heartbeatActivatedNarratives as HeartbeatActivatedNarrative[]) || [];
    const heartbeatActivatedNarratives = heartbeatActivatedNarrativesRaw.filter(
      (item) =>
        !!item &&
        typeof item.heartbeatId === "string" &&
        item.heartbeatId.trim().length > 0 &&
        typeof item.sourceTurnId === "string" &&
        item.sourceTurnId.trim().length > 0 &&
        typeof item.sourceTurnNarrative === "string" &&
        item.sourceTurnNarrative.trim().length > 0 &&
        (item.status === "due" || item.status === "overdue")
    );
    const hasHeartbeatActivatedNarratives = heartbeatActivatedNarratives.length > 0;

    // Worldline scene update
    const worldlineSceneUpdate =
      (tempInfo.contextualData?.worldlineSceneUpdate as {
        previousSnapshot?: unknown;
        updatedSnapshot?: unknown;
        suddenActionLogs?: Array<{
          id: string;
          name?: string;
          actionLog?: ActionLogEntry[];
        }>;
        reactionNpcActionLogUpdates?: Array<{
          id: string;
          name?: string;
          actionLog?: ActionLogEntry[];
        }>;
      } | null) || null;
    const hasWorldlineSceneUpdate = Boolean(
      worldlineSceneUpdate?.previousSnapshot &&
        worldlineSceneUpdate?.updatedSnapshot
    );

    // Sudden action logs
    const suddenActionLogsRaw =
      (tempInfo.contextualData?.suddenActionLogs as Array<{
        id: string;
        name?: string;
        actionLog?: ActionLogEntry[];
      }>) || [];
    const suddenActionLogsTurnInScene = Number(
      tempInfo.contextualData?.suddenActionLogsTurnInScene
    );
    const hasFreshSuddenActionLogs =
      suddenActionLogsTurnInScene === sceneRoom.turnsInCurrentScene;
    const suddenActionLogs = hasFreshSuddenActionLogs
      ? suddenActionLogsRaw
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            actionLog: (entry.actionLog || []).filter(
              (log) => !!log?.location && !!log?.summary
            ),
          }))
          .filter((entry) => entry.id && entry.actionLog.length > 0)
      : [];
    const hasSuddenActionLogs = suddenActionLogs.length > 0;

    const clearSuddenActionLogsContext = () => {
      manager.setContextualData(sceneRoomId, "suddenActionLogs", []);
      manager.setContextualData(sceneRoomId, "suddenActionLogsGameTime", null);
      manager.setContextualData(sceneRoomId, "suddenActionLogsTurnInScene", null);
      manager.setContextualData(sceneRoomId, "worldlineSceneUpdate", null);
    };

    // Turn number
    const currentTurnNumber =
      conversationHistory.length > 0
        ? Math.max(...conversationHistory.map((h) => h.turnNumber)) + 1
        : 1;
    const isFirstRealTurn = conversationHistory.length === 0;

    const template = getKeeperTemplate(language);

    // Build active player IDs (excluding time-frozen players)
    const frozenPlayerIds = new Set(
      Object.keys(sceneRoom.timeFrozenPlayers ?? {})
    );
    const activePlayerIds = sceneRoom.memberPlayerIds.filter(
      (id) => !frozenPlayerIds.has(id)
    );

    // Individual player character profiles
    const allPlayerCharacters = activePlayerIds
      .map((pid) => {
        const ps = state.players[pid];
        if (!ps) return null;
        return this.extractCompletePlayerCharacter(
          ps.profile,
          currentLocation,
          null
        );
      })
      .filter(Boolean);

    // Structured per-player inputs from contextualData
    const roundInputsRaw = tempInfo.contextualData?.roundInputsForKeeper as
      | Array<{ playerId: string; inputType: string; content?: string }>
      | undefined;
    const playerInputs = (roundInputsRaw ?? [])
      .filter((i) => !frozenPlayerIds.has(i.playerId))
      .map((i) => ({
        name: state.players[i.playerId]?.characterName ?? i.playerId,
        content:
          i.inputType === "skip" || !i.content?.trim()
            ? "[No action this round]"
            : i.content.trim(),
      }));

    // Full game time
    const fullGameTime = manager.getSceneRoomFullGameTime(sceneRoomId);

    // Scene change request for narrative
    const sceneChangeRequestForNarrative = sceneChangeRequest
      ? {
          shouldChange: sceneChangeRequest.shouldChange,
          targetSceneName: sceneChangeRequest.targetSceneName,
          reason: sceneChangeRequest.reason,
        }
      : null;

    const templateContext: Record<string, unknown> = {
      characterInput,
      allActionResultsDetailed,
      fullGameTime,
      tension: state.tension,
      isTransition,
      sceneChangeRequest: sceneChangeRequestForNarrative,
      conversationHistory,
      relevantHistory,
      hasRetrievedClues: retrievedClueContext.length > 0,
      retrievedClueContextJson: retrievedClueContext.length > 0
        ? this.safeStringify(retrievedClueContext)
        : null,
      hasHeartbeatActivatedNarratives,
      heartbeatActivatedNarrativesJson: hasHeartbeatActivatedNarratives
        ? this.safeStringify(heartbeatActivatedNarratives)
        : null,
      hasActionTargetInfo,
      actionTargetName,
      actionTargetIntent,
      currentTurnNumber,
      isFirstRealTurn,
      keeperGuidance: state.keeperGuidance || null,
      hasFumbleThisTurn: clueAccessMap.hasFumble,
      perTargetClueAccessJson: this.safeStringify(
        Object.fromEntries(
          [...clueAccessMap.targets.entries()].map(([k, v]) => [
            k,
            {
              bestSuccessLevel: v.bestSuccessLevel,
              interactedBy: v.playerNames,
            },
          ])
        )
      ),
      scenarioContextJson: this.safeStringify(completeScenarioInfo),
      playerCharacterJson: this.safeStringify(allPlayerCharacters),
      playerInputs,
      hasPlayerInputs: playerInputs.length > 0,
      actionRelatedNpcsJson: this.safeStringify(actionRelatedNpcs),
      hasWorldlineSceneUpdate,
      worldlinePreviousSnapshotJson: hasWorldlineSceneUpdate
        ? this.safeStringify(worldlineSceneUpdate?.previousSnapshot || null)
        : null,
      worldlineUpdatedSnapshotJson: hasWorldlineSceneUpdate
        ? this.safeStringify(worldlineSceneUpdate?.updatedSnapshot || null)
        : null,
      worldlineSuddenActionLogsJson: hasWorldlineSceneUpdate
        ? this.safeStringify(worldlineSceneUpdate?.suddenActionLogs || [])
        : null,
      worldlineReactionNpcActionLogsJson: hasWorldlineSceneUpdate
        ? this.safeStringify(
            worldlineSceneUpdate?.reactionNpcActionLogUpdates || []
          )
        : null,
      hasSuddenActionLogs,
      suddenActionLogsJson: hasSuddenActionLogs
        ? this.safeStringify(suddenActionLogs)
        : null,
      previousScenarioJson: previousScenarioInfo
        ? this.safeStringify(previousScenarioInfo)
        : "null",
      selectedSkill: null,
      // Time-grouping context for multiplayer
      ...((): Record<string, unknown> => {
        const tgInfo = tempInfo.contextualData?.timeGroupingInfo as {
          hasTimeGrouping?: boolean;
          fastGroupPlayerNames?: string;
          slowGroupPlayerNames?: string;
          fastGroupMinutes?: number;
        } | undefined;
        if (!tgInfo?.hasTimeGrouping) return {};
        return {
          hasTimeGrouping: true,
          fastGroupPlayerNames: tgInfo.fastGroupPlayerNames ?? "",
          slowGroupPlayerNames: tgInfo.slowGroupPlayerNames ?? "",
          fastGroupMinutes: tgInfo.fastGroupMinutes ?? 0,
        };
      })(),
    };

    // Compose template with images (multiplayer scene-scoped state for scenario map extraction)
    const sceneScopedState: MultiplayerSceneScopedState = {
      multiplayerSceneScope: true,
      currentScenario,
    };
    const { content: prompt, images } = composeTemplateWithImages(
      template,
      sceneScopedState,
      templateContext,
      "handlebars"
    );

    const narrativeStream = options?.onNarrativeDelta
      ? this.createNarrativeStreamParser(options.onNarrativeDelta)
      : null;
    let response = "";
    let parsedResponse: any;
    const maxAttempts = narrativeStream ? 1 : 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await generateText({
          runtime,
          context: prompt,
          images,
          modelClass: ModelClass.MEDIUM,
          maxRetries: narrativeStream ? 1 : undefined,
          onToken: narrativeStream
            ? (chunk) => narrativeStream.ingest(chunk)
            : undefined,
        });

        const jsonText =
          response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
          response.match(/\{[\s\S]*\}/)?.[0];

        if (!jsonText) {
          if (attempt < maxAttempts) {
            console.warn(
              `⚠️ Failed to extract JSON from keeper response (attempt ${attempt}/${maxAttempts}), retrying...`
            );
            continue;
          }
          console.warn("Failed to extract JSON from keeper response");
          console.warn("Response content:", response);
          clearSuddenActionLogsContext();
          return {
            narrative: response,
            clueRevelations: {
              scenarioClues: [],
              npcClues: [],
              npcSecrets: [],
              damagedScenarioClues: [],
            },
          };
        }

        parsedResponse = JSON.parse(jsonText);
        console.log(
          `✅ Successfully parsed keeper response on attempt ${attempt}`
        );
        break;
      } catch (error) {
        if (attempt < maxAttempts) {
          console.warn(
            `⚠️ Failed to parse keeper response as JSON (attempt ${attempt}/${maxAttempts}), retrying...`
          );
          continue;
        }

        console.error("Failed to parse keeper response as JSON:", error);
        console.warn("Response content:", response);

        let fallbackNarrative = response;
        const narrativeMatch = response.match(
          /"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/
        );
        if (narrativeMatch && narrativeMatch[1]) {
          fallbackNarrative = narrativeMatch[1]
            .replace(/\\n/g, "\n")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
          console.log("✓ Extracted narrative from incomplete JSON");
        }

        clearSuddenActionLogsContext();
        return {
          narrative: fallbackNarrative,
          clueRevelations: {
            scenarioClues: [],
            npcClues: [],
            npcSecrets: [],
            damagedScenarioClues: [],
          },
        };
      }
    }

    // Update clue states directly on manager state
    this.updateClueStates(
      manager,
      sceneRoomId,
      parsedResponse.clueRevelations,
      allPlayerNames,
      clueAccessMap
    );

    // Record clue/secret revelations to each active player in the room
    if (parsedResponse.clueRevelations) {
      const newNpcClueKeys: string[] = [];
      const newNpcSecretKeys: string[] = [];
      const newScenarioClueIds: string[] = [];
      const newDamagedScenarioClueIds: string[] = [];

      if (Array.isArray(parsedResponse.clueRevelations.npcClues)) {
        for (const item of parsedResponse.clueRevelations.npcClues) {
          if (item?.npcId && item?.clueId) {
            newNpcClueKeys.push(`${item.npcId}:${item.clueId}`);
          }
        }
      }
      if (Array.isArray(parsedResponse.clueRevelations.npcSecrets)) {
        for (const item of parsedResponse.clueRevelations.npcSecrets) {
          if (item?.npcId != null && item?.secretIndex != null) {
            newNpcSecretKeys.push(`${item.npcId}:${item.secretIndex}`);
          }
        }
      }
      if (Array.isArray(parsedResponse.clueRevelations.scenarioClues)) {
        for (const item of parsedResponse.clueRevelations.scenarioClues) {
          const clueId = typeof item === "string" ? item : item?.clueId;
          if (clueId) newScenarioClueIds.push(clueId);
        }
      }
      if (Array.isArray(parsedResponse.clueRevelations.damagedScenarioClues)) {
        for (const item of parsedResponse.clueRevelations.damagedScenarioClues) {
          const clueId = typeof item === "string" ? item : item?.clueId;
          if (clueId) newDamagedScenarioClueIds.push(clueId);
        }
      }

      const hasAny =
        newNpcClueKeys.length > 0 ||
        newNpcSecretKeys.length > 0 ||
        newScenarioClueIds.length > 0 ||
        newDamagedScenarioClueIds.length > 0;

      if (hasAny) {
        const allState = manager.getState();
        for (const pid of activePlayerIds) {
          const ps = allState.players[pid];
          if (!ps) continue;
          if (!ps.revealedNpcClueIds) ps.revealedNpcClueIds = [];
          if (!ps.revealedNpcSecretKeys) ps.revealedNpcSecretKeys = [];
          if (!ps.revealedScenarioClueIds) ps.revealedScenarioClueIds = [];
          if (!ps.damagedScenarioClueIds) ps.damagedScenarioClueIds = [];
          for (const key of newNpcClueKeys) {
            if (!ps.revealedNpcClueIds.includes(key)) ps.revealedNpcClueIds.push(key);
          }
          for (const key of newNpcSecretKeys) {
            if (!ps.revealedNpcSecretKeys.includes(key)) ps.revealedNpcSecretKeys.push(key);
          }
          for (const id of newScenarioClueIds) {
            if (!ps.revealedScenarioClueIds.includes(id)) ps.revealedScenarioClueIds.push(id);
          }
          for (const id of newDamagedScenarioClueIds) {
            if (!ps.damagedScenarioClueIds.includes(id)) ps.damagedScenarioClueIds.push(id);
          }
        }
      }
    }

    // Update tension
    if (
      parsedResponse.tensionLevel &&
      typeof parsedResponse.tensionLevel === "number"
    ) {
      const oldTension = state.tension;
      manager.updateTension(parsedResponse.tensionLevel);
      const newTension = manager.getState().tension;
      if (oldTension !== newTension) {
        console.log(`🎭 Tension changed: ${oldTension} → ${newTension}`);
      }
    }

    clearSuddenActionLogsContext();
    return {
      narrative: parsedResponse.narrative || response,
      clueRevelations: parsedResponse.clueRevelations || {
        scenarioClues: [],
        npcClues: [],
        npcSecrets: [],
        damagedScenarioClues: [],
      },
    };
  }

  /**
   * Generate epilogue narrative when game ends.
   */
  async generateEpilogue(
    characterInput: string,
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    language: "en" | "zh" = "zh"
  ): Promise<{ narrative: string; clueRevelations: any }> {
    const runtime = createRuntime();
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId)!;

    // Get endState
    const endState = state.endState;
    if (!endState) {
      throw new Error("Cannot generate epilogue: endState is not defined");
    }

    // Build player character information for all active players
    const currentLocation = sceneRoom.currentScenario?.location || null;
    const frozenPlayerIds = new Set(
      Object.keys(sceneRoom.timeFrozenPlayers ?? {})
    );
    const activePlayerIds = sceneRoom.memberPlayerIds.filter(
      (id) => !frozenPlayerIds.has(id)
    );
    const allPlayerCharacters = activePlayerIds
      .map((pid) => {
        const ps = state.players[pid];
        if (!ps) return null;
        return this.extractCompletePlayerCharacter(
          ps.profile,
          currentLocation,
          null
        );
      })
      .filter(Boolean);

    // Conversation history (last 1 turn)
    const conversationHistory =
      (sceneRoom.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) || [];
    const recentHistory = conversationHistory.slice(-1);

    // Format full game time
    const fullGameTime = manager.getSceneRoomFullGameTime(sceneRoomId);

    const template = getEpilogueTemplate(language);
    const macroScene = state.macroScene;

    const templateContext = {
      characterInput,
      macroSceneJson: macroScene ? JSON.stringify(macroScene, null, 2) : "null",
      endStateJson: JSON.stringify(endState, null, 2),
      pointOfNoReturnTrigger:
        state.pointOfNoReturnTrigger || endState.pointOfNoReturn.trigger,
      fullGameTime,
      playerCharacterJson: this.safeStringify(allPlayerCharacters),
      gameHistoryJson: JSON.stringify(recentHistory, null, 2),
      gameEndingJson: this.safeStringify(state.gameEnding || null),
      achievedVictoryCondition:
        typeof sceneRoom.temporaryInfo.contextualData
          ?.triggerCheckAchievedVictoryCondition === "string"
          ? sceneRoom.temporaryInfo.contextualData
              .triggerCheckAchievedVictoryCondition
          : null,
      triggerCheckEvidenceJson: this.safeStringify(
        sceneRoom.temporaryInfo.contextualData?.triggerCheckEvidence || []
      ),
      triggerCheckCurrentTurnActionLogsJson: this.safeStringify(
        sceneRoom.temporaryInfo.contextualData
          ?.triggerCheckCurrentTurnActionLogs || []
      ),
    };

    const epilogueScopedState: MultiplayerSceneScopedState = {
      multiplayerSceneScope: true,
      currentScenario: sceneRoom.currentScenario,
    };
    const { content: prompt, images } = composeTemplateWithImages(
      template,
      epilogueScopedState,
      templateContext,
      "handlebars"
    );

    let response = "";
    let parsedResponse: any;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await generateText({
          runtime,
          context: prompt,
          images,
          modelClass: ModelClass.LARGE,
        });

        let jsonText = response.trim();
        const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1].trim();
        }

        if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) {
          const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
          if (jsonObjectMatch) {
            jsonText = jsonObjectMatch[0];
          }
        }

        parsedResponse = JSON.parse(jsonText);

        if (parsedResponse.narrative) {
          break;
        }
      } catch (error) {
        if (attempt === maxAttempts) {
          console.error(
            `❌ [Keeper Agent] Failed to parse epilogue response after ${maxAttempts} attempts:`,
            error
          );
          throw new Error(
            `Failed to generate epilogue: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        console.warn(
          `⚠️  [Keeper Agent] Epilogue parse attempt ${attempt} failed, retrying...`
        );
      }
    }

    return {
      narrative: parsedResponse.narrative || response,
      clueRevelations: null,
    };
  }

  /**
   * Extract complete scenario information.
   */
  private extractCompleteScenarioInfo(
    currentScenario: DynamicScenarioSnapshot | null,
    scenarioOutlines: ScenarioOutline[],
    allowRegularPlus: boolean
  ) {
    if (!currentScenario) {
      return {
        hasScenario: false,
        message: "No current scenario loaded",
      };
    }

    const currentScenarioOutline = scenarioOutlines.find(
      (outline) =>
        outline.id === currentScenario.id ||
        outline.name === currentScenario.name
    );
    const connections = currentScenarioOutline?.connections || [];

    const { gameTime, sceneImage, ...snapshot } = currentScenario;

    return {
      ...snapshot,
      clues: this.filterScenarioCluesForKeeper(snapshot.clues, allowRegularPlus),
      connections: connections.map((conn) => {
        const targetScenario = scenarioOutlines.find(
          (outline) =>
            outline.name === conn.scenarioName ||
            outline.id === conn.scenarioName
        );
        return {
          scenarioName: targetScenario?.name || conn.scenarioName,
          scenarioId: targetScenario?.id || conn.scenarioName,
          relationshipType: conn.relationshipType,
          description: conn.description,
          blocked: conn.blocked,
          blockReason: conn.blockReason,
        };
      }),
    };
  }

  /**
   * Extract previous scenario information (for scene transitions).
   */
  private extractPreviousScenarioInfo(
    previousScenario: DynamicScenarioSnapshot | null,
    scenarioOutlines: ScenarioOutline[]
  ) {
    if (!previousScenario) {
      return null;
    }

    const previousScenarioOutline = scenarioOutlines.find(
      (outline) =>
        outline.id === previousScenario.id ||
        outline.name === previousScenario.name
    );
    const connections = previousScenarioOutline?.connections || [];

    return {
      hasScenario: true,
      id: previousScenario.id,
      name: previousScenario.name,
      location: previousScenario.location,
      description: previousScenario.description,
      characters: previousScenario.characters || [],
      connections: connections.map((conn) => {
        const targetScenario = scenarioOutlines.find(
          (outline) =>
            outline.name === conn.scenarioName ||
            outline.id === conn.scenarioName
        );
        return {
          scenarioName: targetScenario?.name || conn.scenarioName,
          scenarioId: targetScenario?.id || conn.scenarioName,
          relationshipType: conn.relationshipType,
          description: conn.description,
          blocked: conn.blocked,
          blockReason: conn.blockReason,
        };
      }),
      clues: (previousScenario.clues || []).map((clue) => ({
        id: clue.id,
        clueText: clue.clueText,
        location: clue.location,
        category: clue.category,
        difficulty: clue.difficulty,
        reveals: clue.reveals,
        discovered: clue.discovered,
        damaged: clue.damaged,
        ...(clue.damaged && clue.damageDetails
          ? { damageDetails: clue.damageDetails }
          : {}),
        ...(clue.discovered && clue.discoveryDetails
          ? { discoveryDetails: clue.discoveryDetails }
          : {}),
      })),
    };
  }

  /**
   * Extract complete attributes of NPCs involved in all action results.
   */
  private extractActionRelatedNpcs(
    npcCharacters: any[],
    allPlayerNames: string[],
    currentLocation: string | null,
    actionAnalysis: ActionAnalysis | null,
    allActionResults: Omit<ActionResult, "diceRolls" | "location">[],
    interactionPartnerName: string | null = null,
    allowRegularPlus = false
  ) {
    if (!allActionResults || allActionResults.length === 0) {
      return [];
    }

    const relatedNpcNames = new Set<string>();

    // Extract related NPCs from all action results
    for (const actionResult of allActionResults) {
      if (actionResult.character && !allPlayerNames.includes(actionResult.character)) {
        relatedNpcNames.add(actionResult.character);
      }

      if (actionResult.result) {
        npcCharacters.forEach((npc: any) => {
          if (
            actionResult.result.toLowerCase().includes(npc.name.toLowerCase())
          ) {
            relatedNpcNames.add(npc.name);
          }
        });
      }
    }

    // Get target character from action analysis
    if (actionAnalysis?.target?.name) {
      relatedNpcNames.add(actionAnalysis.target.name);
    }

    // Find related NPCs and get complete attributes
    const actionRelatedNpcs = [];
    const addedNpcIds = new Set<string>();

    for (const npcName of relatedNpcNames) {
      const npc = npcCharacters.find(
        (n: any) =>
          n.name.toLowerCase() === npcName.toLowerCase() ||
          n.name.toLowerCase().includes(npcName.toLowerCase())
      );

      if (npc && !addedNpcIds.has(npc.id)) {
        addedNpcIds.add(npc.id);

        const partnerForThisNpc =
          interactionPartnerName &&
          npc.name.toLowerCase().includes(interactionPartnerName.toLowerCase())
            ? allPlayerNames[0] ?? null
            : null;

        actionRelatedNpcs.push({
          source: "action_related",
          character: this.extractCompleteCharacterAttributes(
            npc,
            currentLocation,
            partnerForThisNpc,
            allowRegularPlus
          ),
        });
      }
    }

    return actionRelatedNpcs;
  }

  /**
   * Extract complete character attribute information.
   */
  private extractCompleteCharacterAttributes(
    character: DynamicCharacterProfile,
    currentLocation: string | null = null,
    interactionPartnerName: string | null = null,
    allowRegularPlus = false
  ) {
    const npcData = character as DynamicNPCProfile;

    return {
      id: character.id,
      name: character.name,
      isNPC: npcData.isNPC === true,

      occupation: npcData.occupation || "Unknown",
      age: npcData.age,
      appearance: npcData.appearance || "No description",
      personality: npcData.personality || "Unknown personality",
      background: npcData.background || "Unknown background",

      goals: npcData.goals || [],
      secrets: npcData.secrets || [],

      status: {
        hp: character.status.hp,
        maxHp: character.status.maxHp,
        sanity: character.status.sanity,
        maxSanity: character.status.maxSanity,
        conditions: character.status.conditions || [],
      },

      inventory: character.inventory || [],

      actionLog: currentLocation
        ? (character.actionLog || []).filter(
            (log) => log.location === currentLocation
          )
        : (character.actionLog || []),

      clues: this.filterNpcCluesForKeeper(npcData.clues || [], allowRegularPlus),

      relationships: npcData.relationships || [],

      notes: character.notes || "",
    };
  }

  /**
   * Extract complete player character information.
   */
  private extractCompletePlayerCharacter(
    player: DynamicCharacterProfile,
    currentLocation: string | null = null,
    interactionPartnerName: string | null = null
  ) {
    return this.extractCompleteCharacterAttributes(
      player,
      currentLocation,
      interactionPartnerName
    );
  }

  /**
   * Update clue states directly on the multiplayer game state.
   */
  private updateClueStates(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    clueRevelations: any,
    allPlayerNames: string[],
    clueAccessMap?: PerTargetClueAccessMap
  ): void {
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    const currentScenario = sceneRoom?.currentScenario;
    const newDiscoveredClues: DiscoveredClue[] = [];
    const damagedScenarioClueIds = new Set<string>();

    // Helper: get discoveredBy names from clueAccessMap for a given target key
    const getDiscoveredBy = (targetKey: string): string => {
      const targetAccess = clueAccessMap?.targets.get(targetKey);
      if (targetAccess && targetAccess.playerNames.length > 0) {
        return targetAccess.playerNames.join(", ");
      }
      return allPlayerNames.join(", ") || "Unknown";
    };

    // Apply scenario clue damage first
    if (
      clueRevelations?.damagedScenarioClues &&
      Array.isArray(clueRevelations.damagedScenarioClues)
    ) {
      if (currentScenario?.clues) {
        clueRevelations.damagedScenarioClues.forEach(
          (item: string | { clueId: string; reason?: string }) => {
            const clueId = typeof item === "string" ? item : item?.clueId;
            const reason =
              typeof item === "object" && item?.reason
                ? item.reason
                : "Clue destroyed by fumble";
            if (!clueId) return;
            const clue = currentScenario.clues.find((c) => c.id === clueId);
            if (!clue || clue.discovered || clue.damaged) return;
            clue.damaged = true;
            clue.damageDetails = {
              damagedBy: getDiscoveredBy("scenario"),
              damagedAt: new Date().toISOString(),
              reason,
            };
            damagedScenarioClueIds.add(clueId);
          }
        );
      }
    }

    // Update scenario clue states
    if (
      clueRevelations?.scenarioClues &&
      clueRevelations.scenarioClues.length > 0
    ) {
      if (currentScenario && currentScenario.clues) {
        const scenarioDiscoveredBy = getDiscoveredBy("scenario");
        clueRevelations.scenarioClues.forEach(
          (item: string | { clueId: string }) => {
            const clueId = typeof item === "string" ? item : item?.clueId;
            if (!clueId) return;
            const clue = currentScenario.clues.find((c) => c.id === clueId);
            if (
              clue &&
              !clue.discovered &&
              !clue.damaged &&
              !damagedScenarioClueIds.has(clueId)
            ) {
              const discoveredAt = new Date().toISOString();
              clue.discovered = true;
              clue.discoveryDetails = {
                discoveredBy: scenarioDiscoveredBy,
                discoveredAt,
                method: "Keeper revelation",
              };

              newDiscoveredClues.push({
                text: clue.clueText,
                type: "scenario",
                sourceName: currentScenario.name,
                discoveredBy: scenarioDiscoveredBy,
                discoveredAt,
                category: clue.category,
                difficulty: clue.difficulty,
                method: "Keeper revelation",
              });
            }
          }
        );
      }
    }

    // Update NPC clue states (on real global NPC state)
    if (clueRevelations?.npcClues && clueRevelations.npcClues.length > 0) {
      clueRevelations.npcClues.forEach(
        (item: { npcId: string; clueId: string }) => {
          const npc = state.npcCharacters.find(
            (n: any) => n.id === item.npcId
          );
          if (npc && npc.clues) {
            const clue = npc.clues.find((c: any) => c.id === item.clueId);
            if (clue && !clue.revealed) {
              clue.revealed = true;
              const npcDiscoveredBy = getDiscoveredBy(npc.name);

              newDiscoveredClues.push({
                text: clue.clueText,
                type: "npc",
                sourceName: npc.name,
                discoveredBy: npcDiscoveredBy,
                discoveredAt: new Date().toISOString(),
                category: clue.category as any,
                difficulty: clue.difficulty as any,
                method: "Social interaction",
              });
            }
          }
        }
      );
    }

    // Handle NPC secret revelations
    if (clueRevelations?.npcSecrets && clueRevelations.npcSecrets.length > 0) {
      clueRevelations.npcSecrets.forEach(
        (item: { npcId: string; secretIndex: number }) => {
          const npc = state.npcCharacters.find(
            (n: any) => n.id === item.npcId
          );
          if (npc && npc.secrets && npc.secrets[item.secretIndex]) {
            const secret = npc.secrets[item.secretIndex];
            const npcDiscoveredBy = getDiscoveredBy(npc.name);

            newDiscoveredClues.push({
              text: `Secret: ${secret}`,
              type: "secret",
              sourceName: npc.name,
              discoveredBy: npcDiscoveredBy,
              discoveredAt: new Date().toISOString(),
              method: "Secret revelation",
            });
          }
        }
      );
    }

    // Add newly discovered clues to global discovery list
    newDiscoveredClues.forEach((discoveredClue) => {
      const exists = state.discoveredClues.some(
        (c) => c.text === discoveredClue.text
      );
      if (!exists) {
        manager.addDiscoveredClue(discoveredClue);
      }
    });
  }

  private createNarrativeStreamParser(onDelta: (delta: string) => void) {
    let buffer = "";
    let lastNarrative = "";

    return {
      ingest: (chunk: string) => {
        if (!chunk) return;
        buffer += chunk;

        const narrative = this.extractNarrativeFromBuffer(buffer);
        if (narrative === null) return;

        if (narrative.length > lastNarrative.length) {
          const delta = narrative.slice(lastNarrative.length);
          if (delta) {
            onDelta(delta);
          }
          lastNarrative = narrative;
        }
      },
    };
  }

  private extractNarrativeFromBuffer(buffer: string): string | null {
    const keyMatch = /"narrative"\s*:\s*"/.exec(buffer);
    if (!keyMatch || keyMatch.index === undefined) {
      return null;
    }

    let index = keyMatch.index + keyMatch[0].length;
    let result = "";
    let escaped = false;

    for (; index < buffer.length; index++) {
      const char = buffer[index];

      if (escaped) {
        switch (char) {
          case '"':
            result += '"';
            break;
          case "\\":
            result += "\\";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "u": {
            const hex = buffer.slice(index + 1, index + 5);
            if (hex.length < 4) {
              return result;
            }
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              result += String.fromCharCode(Number.parseInt(hex, 16));
              index += 4;
            } else {
              result += "u";
            }
            break;
          }
          default:
            result += char;
            break;
        }
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        return result;
      }

      result += char;
    }

    return result;
  }

  private safeStringify(obj: any): string {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (error) {
      return typeof obj === "string" ? obj : "";
    }
  }
}
