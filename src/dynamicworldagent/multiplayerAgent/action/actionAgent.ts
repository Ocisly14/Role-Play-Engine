import { randomUUID } from "crypto";
import { generateText } from "../../../models/index.js";
import { ModelClass } from "../../../models/types.js";
import type { ScenarioLoader } from "../../../shared/agents/memory/scenarioloader/index.js";
import type {
  ActionLogEntry,
  NPCRelationship,
} from "../../../shared/agents/models/gameTypes.js";
import type {
  ActionAnalysis,
  ActionResult,
  NPCResponseAnalysis,
  SceneChangeRequest,
} from "../../../shared/state/index.js";
import type {
  CombatState,
  HeartbeatAction,
  PendingNpcAction,
} from "../../state/DynamicGameState.js";
import type { DynamicGameState } from "../../state/index.js";
import type {
  FrozenPlayerInput,
  MultiplayerDynamicGameStateManager,
  MultiplayerHeartbeatAction,
  MultiplayerTurnInput,
} from "../../multiplayerState/MultiplayerDynamicGameState.js";
import {
  getLatestActionLogEntryWithLocation,
  parseGameTime,
  isTimeAfter,
} from "../../utils/gameTime.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import { getStaticSkillDefaults } from "../skillDefaults.js";
import {
  buildActionSystemPrompt,
} from "./actionTemplate.js";

type StagedTime = {
  elapsedMinutesByPlayer: Record<string, number>;
  fatigueMinutesByPlayer: Record<string, number>;
};

/**
 * Action Agent class - handles action resolution and skill checks
 */
export class ActionAgent {
  private scenarioLoader?: ScenarioLoader;

  constructor(scenarioLoader?: ScenarioLoader) {
    this.scenarioLoader = scenarioLoader;
  }

  /**
   * Multiplayer native entrypoint:
   * - Processes one sceneRoom's round inputs (skip omitted)
   * - Uses per-player orchestrator analyses (stored in sceneRoom contextualData)
   * - Does NOT advance global game time per player; instead advances once per round (max minutes)
   */
  private extractTimeFromModelOutput(rawOutput: any): number {
    if (!rawOutput || typeof rawOutput !== "object") return 0;
    const t = rawOutput.timeElapsedMinutes;
    return typeof t === "number" && t > 0 ? t : 0;
  }

  /**
   * Build a narrative-only ActionResult + detailed record WITHOUT applying state updates.
   * Used for slow-group players whose actions are shown in the narrative but not mechanically applied.
   */
  private buildNarrativeOnlyResult(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string,
    rawOutput: any,
    diceUsed: string[]
  ): { actionResult: ActionResult; detailedResult: Record<string, unknown> } {
    const state = manager.getState();
    const room = manager.getSceneRoom(sceneRoomId);
    const p = state.players[playerId];
    const character = p?.profile as any;

    const parsed = { ...(rawOutput as any) };
    this.sanitizeSuccessLevels(parsed);

    const actionResult: ActionResult = {
      timestamp: new Date(),
      gameTime: room?.timeOfDay || state.timeOfDay || "Unknown time",
      timeElapsedMinutes:
        typeof parsed.timeElapsedMinutes === "number"
          ? parsed.timeElapsedMinutes
          : 0,
      location: room?.currentScenario?.location || "Unknown location",
      character: character?.name ?? p?.characterName ?? playerId,
      result:
        parsed.summary ||
        (Array.isArray(parsed.actionLog) &&
        typeof parsed.actionLog[0]?.summary === "string"
          ? parsed.actionLog[0].summary
          : undefined) ||
        "performing an extended action",
      diceRolls: diceUsed,
      timeConsumption: parsed.timeConsumption || "long",
      isFrozenPreview: true,
    };

    const detailedResult = this.buildDetailedActionResult(
      character ?? { name: p?.characterName ?? playerId },
      parsed,
      diceUsed
    );
    (detailedResult as any).isFrozenPreview = true;

    return { actionResult, detailedResult };
  }

  async processSceneRoomRound(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    roundInputs: MultiplayerTurnInput[],
    language: "en" | "zh",
    roundTurnId?: string | null
  ): Promise<void> {
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    if (!sceneRoom) {
      throw new Error(`SceneRoom ${sceneRoomId} not found`);
    }

    const playerAnalyses: Record<string, any> =
      (sceneRoom.temporaryInfo.contextualData?.playerActionAnalyses as Record<
        string,
        any
      >) ?? {};

    // 1. Filter real inputs from this round
    const roundInputsInjected = roundInputs
      .filter((ri) => ri.inputType === "input" && Boolean(ri.content?.trim()))
      .map((ri) => ({
        playerId: ri.playerId,
        characterId: ri.characterId,
        inputType: "input" as const,
        content: ri.content?.trim() ?? "",
        selectedSkill: ri.selectedSkill ?? null,
        skillSelectionMode: ri.skillSelectionMode ?? ("manual" as "manual" | "auto"),
      }));

    // 2. Inject frozen inputs for players who did not submit new input this round
    const submittedPlayerIds = new Set(roundInputsInjected.map((ri) => ri.playerId));
    const frozenInputs = sceneRoom.frozenPlayerInputs ?? [];
    for (const frozen of frozenInputs) {
      if (submittedPlayerIds.has(frozen.playerId)) {
        // Player submitted new input — their frozen entry will be removed later
        continue;
      }
      // Auto-inject the frozen input
      roundInputsInjected.push({
        playerId: frozen.playerId,
        characterId: frozen.characterId,
        inputType: "input" as const,
        content: frozen.content,
        selectedSkill: frozen.selectedSkill,
        skillSelectionMode: frozen.skillSelectionMode,
      });
    }

    const inputPlayerIds = new Set(roundInputsInjected.map((ri) => ri.playerId));

    // Build scenePlayers context for templates
    const scenePlayers = sceneRoom.memberPlayerIds
      .map((playerId) => {
        const p = state.players[playerId];
        if (!p) return null;
        const input = roundInputsInjected.find((ri) => ri.playerId === playerId);
        const thisRoundInput = input
          ? {
              inputType: "input" as const,
              content: input.content ?? "",
              selectedSkill: input.selectedSkill ?? null,
              skillSelectionMode: input.skillSelectionMode ?? "manual",
            }
          : null;
        return {
          roleType: "player" as const,
          playerId,
          characterId: p.characterId,
          name: p.characterName,
          profile: p.profile,
          omittedThisRound: !inputPlayerIds.has(playerId),
          ...(thisRoundInput ? { thisRoundInput } : {}),
        };
      })
      .filter(Boolean);

    manager.setContextualData(sceneRoomId, "scenePlayers", scenePlayers);
    manager.setContextualData(sceneRoomId, "roundInputs", roundInputsInjected);

    const staged = {
      elapsedMinutesByPlayer: {} as Record<string, number>,
      fatigueMinutesByPlayer: {} as Record<string, number>,
    };

    // 3. Resolve all actions with LLM (single call)
    let parsedResult: {
      outputsByPlayerId: Record<string, any>;
      timeGroups: Array<{ groupId: number; estimatedMinutes: number; playerIds: string[] }>;
    };
    try {
      parsedResult = await this.resolveSceneRoomRoundWithSingleCall(
        manager,
        sceneRoomId,
        roundInputsInjected,
        playerAnalyses,
        language
      );
    } catch (e) {
      console.warn(
        `[MP ActionAgent] Batch round resolution failed; falling back to per-player calls:`,
        e
      );
      // Fallback: no time grouping, behave like before
      await this.processSceneRoomRoundPerPlayer(
        manager,
        sceneRoomId,
        roundInputsInjected,
        playerAnalyses,
        language,
        staged,
        roundTurnId ?? null
      );

      const elapsedMinutes = Object.values(staged.elapsedMinutesByPlayer);
      const roundElapsed = elapsedMinutes.length > 0 ? Math.max(...elapsedMinutes) : 0;
      if (roundElapsed > 0) {
        manager.advanceSceneRoomGameTime(sceneRoomId, roundElapsed);
      }
      for (const [playerId, minutes] of Object.entries(staged.fatigueMinutesByPlayer)) {
        manager.addFatigueMinutes(playerId, minutes);
      }

      // Detect rest-only round (fallback path — all inputs are rest)
      const allAreRest =
        roundInputsInjected.length > 0 &&
        roundInputsInjected.every((ri) => this.hasRestIntent(ri.content ?? ""));
      manager.setContextualData(sceneRoomId, "isRestRound", allAreRest);
      return;
    }

    const { outputsByPlayerId, timeGroups } = parsedResult;

    // Group 1 = fastest (full resolution). Groups 2+ = slow (narrative only).
    const fastGroup = timeGroups.find((g) => g.groupId === 1) ?? timeGroups[0];
    const slowGroups = timeGroups.filter((g) => g.groupId !== (fastGroup?.groupId ?? 1));
    const fastPlayerIds = new Set(fastGroup?.playerIds ?? []);
    const slowPlayerIds = new Set(slowGroups.flatMap((g) => g.playerIds));

    console.log(
      `⏱️  [MP ActionAgent] Time groups from LLM: group1=[${[...fastPlayerIds].join(",")}] (${fastGroup?.estimatedMinutes ?? 0}min)` +
      (slowGroups.length > 0
        ? `, slow=[${slowGroups.map((g) => `g${g.groupId}:${g.playerIds.join(",")}`).join("; ")}]`
        : "")
    );

    // Store time group result for keeper context
    manager.setContextualData(sceneRoomId, "timeGroupResult", { timeGroups });

    // 4. FAST GROUP (group 1): apply full results with state mutations
    for (const input of roundInputsInjected) {
      if (!fastPlayerIds.has(input.playerId)) continue;

      const pa = playerAnalyses[input.playerId];
      if (!pa?.actionAnalysis) continue;

      manager.setCurrentActionAnalysis(sceneRoomId, pa.actionAnalysis ?? null);
      manager.setSceneChangeRequest(sceneRoomId, pa.sceneChangeRequest ?? null);

      try {
        const rawOutput = outputsByPlayerId[input.playerId];
        if (!rawOutput || typeof rawOutput !== "object") {
          const room = manager.getSceneRoom(sceneRoomId);
          const p = state.players[input.playerId];
          if (room && p) {
            manager.addActionResult(sceneRoomId, {
              timestamp: new Date(),
              gameTime: room.timeOfDay ?? manager.getState().timeOfDay,
              timeElapsedMinutes: 0,
              location: room.currentScenario?.location ?? "Unknown",
              character: p.characterName,
              result: `[错误] Missing action output for player ${input.playerId}`,
              diceRolls: [],
              timeConsumption: "instant",
            });
          }
          continue;
        }

        await this.applyPlayerRoundModelOutput(
          manager,
          sceneRoomId,
          input.playerId,
          staged,
          rawOutput,
          input.content ?? "",
          roundTurnId ?? null
        );
      } catch (e) {
        console.error(
          `[MP ActionAgent] Error applying model output for player ${input.playerId}:`,
          e
        );
        const room = manager.getSceneRoom(sceneRoomId);
        const p = state.players[input.playerId];
        if (room && p) {
          manager.addActionResult(sceneRoomId, {
            timestamp: new Date(),
            gameTime: room.timeOfDay ?? manager.getState().timeOfDay,
            timeElapsedMinutes: 0,
            location: room.currentScenario?.location ?? "Unknown",
            character: p.characterName,
            result: `[错误] ${e instanceof Error ? e.message : String(e)}`,
            diceRolls: [],
            timeConsumption: "instant",
          });
        }
      } finally {
        const room = manager.getSceneRoom(sceneRoomId);
        const updatedReq = room?.temporaryInfo.sceneChangeRequest ?? null;
        const stored = (room?.temporaryInfo.contextualData?.playerActionAnalyses as any)?.[
          input.playerId
        ];
        if (stored && typeof stored === "object") {
          stored.sceneChangeRequest = updatedReq;
        }

        manager.setSceneChangeRequest(sceneRoomId, null);
        manager.setCurrentActionAnalysis(sceneRoomId, null);
      }
    }

    // 5. SLOW GROUPS (2+): build narrative-only results (no state mutation)
    const slowActionResults: ActionResult[] = [];
    const slowActionResultsDetailed: Array<Record<string, unknown>> = [];
    for (const playerId of slowPlayerIds) {
      const rawOutput = outputsByPlayerId[playerId];
      if (!rawOutput || typeof rawOutput !== "object") continue;

      const diceUsed = Array.isArray(rawOutput.diceUsed)
        ? rawOutput.diceUsed.filter((d: unknown): d is string => typeof d === "string")
        : [];

      const { actionResult, detailedResult } = this.buildNarrativeOnlyResult(
        manager,
        sceneRoomId,
        playerId,
        rawOutput,
        diceUsed
      );
      slowActionResults.push(actionResult);
      slowActionResultsDetailed.push(detailedResult);
    }

    // Store slow group results in temporaryInfo for keeper narrative
    if (slowActionResults.length > 0) {
      const room = manager.getSceneRoom(sceneRoomId);
      if (room) {
        manager.updateSceneRoom(sceneRoomId, {
          temporaryInfo: {
            ...room.temporaryInfo,
            slowGroupActionResults: slowActionResults,
            slowGroupActionResultsDetailed: slowActionResultsDetailed,
          },
        });
      }
    }

    // 6. Compute time advance from fast group
    const roundElapsed = fastGroup?.estimatedMinutes ?? 0;

    // 7. Update frozenPlayerInputs: remove fast group entries, add/increment slow group entries
    const newFrozenInputs: FrozenPlayerInput[] = [];
    for (const playerId of slowPlayerIds) {
      const input = roundInputsInjected.find((ri) => ri.playerId === playerId);
      if (!input) continue;

      const existingFrozen = frozenInputs.find((f) => f.playerId === playerId);
      newFrozenInputs.push({
        playerId,
        characterId: input.characterId,
        content: input.content,
        selectedSkill: input.selectedSkill,
        skillSelectionMode: input.skillSelectionMode,
        originalRoundNumber: existingFrozen?.originalRoundNumber ?? sceneRoom.roundNumber,
        frozenRoundCount: (existingFrozen?.frozenRoundCount ?? 0) + 1,
        lastEstimatedMinutes: this.extractTimeFromModelOutput(outputsByPlayerId[playerId]),
        actionStartGameTime: existingFrozen?.actionStartGameTime ?? manager.getSceneRoomFullGameTime(sceneRoomId),
        accumulatedElapsedMinutes: (existingFrozen?.accumulatedElapsedMinutes ?? 0) + roundElapsed,
      });
    }
    manager.updateSceneRoom(sceneRoomId, { frozenPlayerInputs: newFrozenInputs });

    // 8. Advance game time (per-room)
    if (roundElapsed > 0) {
      manager.advanceSceneRoomGameTime(sceneRoomId, roundElapsed);
    }

    // 8. Apply per-player fatigue for fast group only
    for (const playerId of fastPlayerIds) {
      const minutes = staged.fatigueMinutesByPlayer[playerId];
      if (minutes && minutes > 0) {
        manager.addFatigueMinutes(playerId, minutes);
      }
    }

    // 9. Store time-grouping info for keeper template context
    const fastGroupPlayerNames = [...fastPlayerIds]
      .map((id) => state.players[id]?.characterName ?? id)
      .join(", ");
    const slowGroupPlayerNames = [...slowPlayerIds]
      .map((id) => state.players[id]?.characterName ?? id)
      .join(", ");
    manager.setContextualData(sceneRoomId, "timeGroupingInfo", {
      hasTimeGrouping: slowPlayerIds.size > 0,
      fastGroupPlayerNames,
      slowGroupPlayerNames,
      fastGroupMinutes: fastGroup?.estimatedMinutes ?? 0,
    });

    // 10. Detect rest-only round for rest-freeze logic
    const fastGroupInputs = roundInputsInjected.filter((ri) =>
      fastPlayerIds.has(ri.playerId)
    );
    const allFastAreRest =
      fastGroupInputs.length > 0 &&
      fastGroupInputs.every((ri) => this.hasRestIntent(ri.content ?? ""));
    manager.setContextualData(sceneRoomId, "isRestRound", allFastAreRest);
  }

  private async processSceneRoomRoundPerPlayer(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    roundInputsInjected: Array<{
      playerId: string;
      characterId: string;
      inputType: "input";
      content: string;
      selectedSkill: string | null;
      skillSelectionMode: "manual" | "auto";
    }>,
    playerAnalyses: Record<string, any>,
    language: "en" | "zh",
    staged: {
      elapsedMinutesByPlayer: Record<string, number>;
      fatigueMinutesByPlayer: Record<string, number>;
    },
    roundTurnId: string | null
  ): Promise<void> {
    const state = manager.getState();
    for (const input of roundInputsInjected) {
      const pa = playerAnalyses[input.playerId];
      if (!pa?.actionAnalysis) continue;

      manager.setCurrentActionAnalysis(sceneRoomId, pa.actionAnalysis ?? null);
      manager.setSceneChangeRequest(sceneRoomId, pa.sceneChangeRequest ?? null);

      try {
        await this.processAction(
          {},
          manager,
          sceneRoomId,
          input.playerId,
          staged,
          input.content ?? "",
          input.selectedSkill ?? null,
          input.skillSelectionMode ?? "manual",
          language,
          roundTurnId ?? null
        );
      } catch (e) {
        console.error(
          `[MP ActionAgent] Error processing player ${input.playerId}:`,
          e
        );
        const room = manager.getSceneRoom(sceneRoomId);
        const p = state.players[input.playerId];
        if (room && p) {
          manager.addActionResult(sceneRoomId, {
            timestamp: new Date(),
            gameTime: room.timeOfDay ?? manager.getState().timeOfDay,
            timeElapsedMinutes: 0,
            location: room.currentScenario?.location ?? "Unknown",
            character: p.characterName,
            result: `[错误] ${e instanceof Error ? e.message : String(e)}`,
            diceRolls: [],
            timeConsumption: "instant",
          });
        }
      } finally {
        const room = manager.getSceneRoom(sceneRoomId);
        const updatedReq = room?.temporaryInfo.sceneChangeRequest ?? null;
        const stored = (room?.temporaryInfo.contextualData?.playerActionAnalyses as any)?.[
          input.playerId
        ];
        if (stored && typeof stored === "object") {
          stored.sceneChangeRequest = updatedReq;
        }

        manager.setSceneChangeRequest(sceneRoomId, null);
        manager.setCurrentActionAnalysis(sceneRoomId, null);
      }
    }
  }

  private makeSceneRoomDynamicStateView(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerIdForView: string
  ): DynamicGameState {
    const state = manager.getState();
    const room = manager.getSceneRoom(sceneRoomId);
    const p = state.players[playerIdForView];
    if (!room || !p) {
      throw new Error(
        `[MP ActionAgent] Cannot build view: missing sceneRoom=${sceneRoomId} or player=${playerIdForView}`
      );
    }

    const profile: any = p.profile ?? null;
    if (profile) {
      if (!profile.id) profile.id = p.characterId ?? profile.id;
      if (!profile.name) profile.name = p.characterName ?? profile.name;
    }

    return {
      ...(state as any),
      playerCharacter: profile,
      staminaState: p.staminaState ?? {
        minutesSinceLastRest: 0,
        fatigueActive: false,
      },
      currentScenario: room.currentScenario ?? null,
      turnsInCurrentScene: room.turnsInCurrentScene ?? 0,
      temporaryInfo: room.temporaryInfo ?? {
        rules: [],
        contextualData: {},
        actionResults: [],
        actionResultsDetailed: [],
        currentActionAnalysis: null,
        npcResponseAnalyses: [],
        sceneChangeRequest: null,
        previousScenario: null,
      },
    } as DynamicGameState;
  }

  private async resolveSceneRoomRoundWithSingleCall(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    roundInputsInjected: Array<{
      playerId: string;
      characterId: string;
      inputType: "input";
      content: string;
      selectedSkill: string | null;
      skillSelectionMode: "manual" | "auto";
    }>,
    playerAnalyses: Record<string, any>,
    language: "en" | "zh"
  ): Promise<{
    outputsByPlayerId: Record<string, any>;
    timeGroups: Array<{ groupId: number; estimatedMinutes: number; playerIds: string[] }>;
  }> {
    const state = manager.getState();
    const room = manager.getSceneRoom(sceneRoomId);
    if (!room) throw new Error(`SceneRoom ${sceneRoomId} not found`);

    const viewPlayerId =
      roundInputsInjected[0]?.playerId ??
      room.memberPlayerIds.find((id) => Boolean(state.players[id])) ??
      "";
    if (!viewPlayerId) {
      throw new Error(`[MP ActionAgent] No player available to build sceneRoom view`);
    }

    const baseView = this.makeSceneRoomDynamicStateView(
      manager,
      sceneRoomId,
      viewPlayerId
    );

    const sceneNPCs = this.extractSceneNPCsForAction(baseView);
    const heartbeatDueActions = this.parseHeartbeatDueActionsContext(
      baseView.temporaryInfo.contextualData?.heartbeatDueActions
    );
    const heartbeatRelatedNpcs =
      heartbeatDueActions.length > 0
        ? this.extractHeartbeatRelatedNpcs(baseView, heartbeatDueActions)
        : [];

    const playerCount = roundInputsInjected.length;
    const preRolledDice = this.preRollDice(playerCount);

    // Build a lookup for frozen inputs to annotate round requests
    const frozenInputLookup = new Map(
      (room.frozenPlayerInputs ?? []).map((f) => [f.playerId, f])
    );

    const roundRequests = roundInputsInjected.map((input) => {
      const p = state.players[input.playerId];
      const analysis = playerAnalyses[input.playerId]?.actionAnalysis ?? null;
      const sceneChangeRequest =
        playerAnalyses[input.playerId]?.sceneChangeRequest ?? null;
      const fatigueActive = manager.isFatigued(input.playerId);

      const playerView = this.makeSceneRoomDynamicStateView(
        manager,
        sceneRoomId,
        input.playerId
      );
      const targetCharacter = analysis
        ? this.findTargetCharacter(playerView, analysis)
        : null;

      const frozenInfo = frozenInputLookup.get(input.playerId);

      return {
        playerId: input.playerId,
        characterId: input.characterId,
        name: p?.characterName ?? input.playerId,
        fatigueActive,
        selectedSkill: input.selectedSkill ?? null,
        skillSelectionMode: input.skillSelectionMode ?? "manual",
        userInput: input.content ?? "",
        orchestratorActionAnalysis: analysis,
        sceneChangeRequest,
        // Frozen re-injection metadata
        frozenReinjection: Boolean(frozenInfo),
        frozenRoundCount: frozenInfo?.frozenRoundCount ?? 0,
        lastEstimatedMinutes: frozenInfo?.lastEstimatedMinutes ?? 0,
        actionStartGameTime: frozenInfo?.actionStartGameTime ?? null,
        accumulatedElapsedMinutes: frozenInfo?.accumulatedElapsedMinutes ?? 0,
        // dicePoolKey removed — shared dice pool used
        characterProfile: p?.profile
          ? this.filterCharacterForContext(p.profile)
          : null,
        targetCharacter: targetCharacter
          ? this.filterCharacterForContext(targetCharacter)
          : null,
      };
    });

    const skillDefaults = getStaticSkillDefaults();
    const scenarioOutline = baseView.currentScenario
      ? baseView.scenarioOutlines.find((o) => o.id === baseView.currentScenario?.id)
      : null;

    const scenarioInfo = baseView.currentScenario
      ? {
          name: baseView.currentScenario.name,
          location: baseView.currentScenario.location,
          description: baseView.currentScenario.description,
          conditions: baseView.currentScenario.conditions ?? [],
          connections: scenarioOutline?.connections ?? [],
        }
      : null;

    const defeatedNpcHistory = Array.isArray(baseView.defeatedNpcHistory)
      ? baseView.defeatedNpcHistory
          .filter(
            (entry): entry is { name: string; count: number } =>
              !!entry &&
              typeof entry.name === "string" &&
              typeof entry.count === "number" &&
              entry.name.trim().length > 0 &&
              Number.isFinite(entry.count) &&
              entry.count > 0
          )
          .map((entry) => ({
            name: entry.name.trim(),
            count: Math.floor(entry.count),
          }))
      : [];

    const fullGameTime = manager.getSceneRoomFullGameTime(sceneRoomId);

    const scenePlayersRaw = baseView.temporaryInfo.contextualData?.scenePlayers;
    const scenePlayersLight = Array.isArray(scenePlayersRaw)
      ? scenePlayersRaw.map((sp: any) => ({
          roleType: sp?.roleType ?? "player",
          playerId: sp?.playerId ?? null,
          characterId: sp?.characterId ?? null,
          name: sp?.name ?? null,
          omittedThisRound: Boolean(sp?.omittedThisRound),
          thisRoundInput: sp?.thisRoundInput ?? null,
        }))
      : null;

    const prompt =
      buildActionSystemPrompt(null, "", preRolledDice, null, sceneNPCs, null, "auto", null, language) +
      `\n\n=== SCENE ROOM CONTEXT (sceneRoomId isolated) ===\n` +
      JSON.stringify(
        {
          sceneRoomId,
          gameTime: fullGameTime,
          scenario: scenarioInfo,
          temporaryRules: baseView.temporaryInfo.rules ?? [],
          defaultSkillValues: skillDefaults,
          defeatedNpcHistory,
          heartbeatDueActions: heartbeatDueActions.length > 0 ? heartbeatDueActions : [],
          heartbeatRelatedNpcs:
            heartbeatRelatedNpcs.length > 0 ? heartbeatRelatedNpcs : [],
          scenePlayers: scenePlayersLight,
          roundInputs: baseView.temporaryInfo.contextualData?.roundInputs ?? null,
        },
        null,
        2
      ) +
      `\n=== END SCENE ROOM CONTEXT ===\n` +
      `\n\n=== ROUND ACTION REQUESTS (produce output per acting player) ===\n` +
      JSON.stringify(roundRequests, null, 2) +
      `\n=== END ROUND ACTION REQUESTS ===\n`;

    const response = await generateText({
      runtime: {},
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = this.parseRoundOutputsFromModel(response);
    if (Object.keys(parsed.outputsByPlayerId).length === 0) {
      throw new Error("[MP ActionAgent] Empty/invalid batch model output");
    }
    return parsed;
  }

  private parseRoundOutputsFromModel(response: string): {
    outputsByPlayerId: Record<string, any>;
    timeGroups: Array<{
      groupId: number;
      estimatedMinutes: number;
      playerIds: string[];
    }>;
  } {
    let jsonText = response.trim();

    const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) jsonText = codeBlockMatch[1].trim();

    if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) {
      const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonObjectMatch) jsonText = jsonObjectMatch[0];
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.warn("[MP ActionAgent] Failed to parse batch JSON:", e);
      return { outputsByPlayerId: {}, timeGroups: [] };
    }

    // Top-level diceUsed contains ALL dice rolls (players + NPCs) for the entire round
    const globalDiceUsed: string[] = Array.isArray(parsed?.diceUsed)
      ? parsed.diceUsed.filter((d: unknown): d is string => typeof d === "string")
      : [];

    const outputsByPlayerId: Record<string, any> = {};
    const timeGroups: Array<{
      groupId: number;
      estimatedMinutes: number;
      playerIds: string[];
    }> = [];

    // New format: timeGroups array
    const rawTimeGroups = Array.isArray(parsed?.timeGroups) ? parsed.timeGroups : null;

    if (rawTimeGroups && rawTimeGroups.length > 0) {
      for (const group of rawTimeGroups) {
        if (!group || typeof group !== "object") continue;
        const groupId = typeof group.groupId === "number" ? group.groupId : timeGroups.length + 1;
        const estimatedMinutes = typeof group.estimatedMinutes === "number" ? group.estimatedMinutes : 0;
        const groupPlayerIds: string[] = [];

        const players = Array.isArray(group.players) ? group.players : [];
        for (const entry of players) {
          if (!entry || typeof entry !== "object") continue;
          const playerId = (entry as any).playerId;
          const output = (entry as any).output;
          if (typeof playerId === "string" && playerId.trim() && output && typeof output === "object") {
            if (!Array.isArray(output.diceUsed) || output.diceUsed.length === 0) {
              output.diceUsed = globalDiceUsed;
            }
            outputsByPlayerId[playerId.trim()] = output;
            groupPlayerIds.push(playerId.trim());
          }
        }

        if (groupPlayerIds.length > 0) {
          timeGroups.push({ groupId, estimatedMinutes, playerIds: groupPlayerIds });
        }
      }
      // Ensure sorted by groupId ascending (1 = fastest)
      timeGroups.sort((a, b) => a.groupId - b.groupId);
    } else {
      // Fallback: old flat "players" array format — treat all as group 1
      const players = Array.isArray(parsed?.players) ? parsed.players : [];
      const allIds: string[] = [];
      for (const entry of players) {
        if (!entry || typeof entry !== "object") continue;
        const playerId = (entry as any).playerId;
        const output = (entry as any).output;
        if (typeof playerId === "string" && playerId.trim() && output && typeof output === "object") {
          if (!Array.isArray(output.diceUsed) || output.diceUsed.length === 0) {
            output.diceUsed = globalDiceUsed;
          }
          outputsByPlayerId[playerId.trim()] = output;
          allIds.push(playerId.trim());
        }
      }
      if (allIds.length > 0) {
        const totalMinutes = allIds.reduce((sum, id) => {
          const t = outputsByPlayerId[id]?.timeElapsedMinutes;
          return sum + (typeof t === "number" ? t : 0);
        }, 0);
        timeGroups.push({
          groupId: 1,
          estimatedMinutes: allIds.length > 0 ? Math.round(totalMinutes / allIds.length) : 0,
          playerIds: allIds,
        });
      }
    }

    return { outputsByPlayerId, timeGroups };
  }

  private async applyPlayerRoundModelOutput(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string,
    staged: StagedTime,
    rawOutput: Record<string, unknown>,
    originalUserInput: string,
    currentTurnId: string | null
  ): Promise<void> {
    const dynamicState = manager.getSceneRoomState(sceneRoomId, playerId);
    if (!dynamicState.playerCharacter) {
      console.warn(`[MP ActionAgent] No player profile for playerId=${playerId}, skipping round output`);
      return;
    }
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const targetCharacter = this.findTargetCharacter(dynamicState, actionAnalysis);

    const parsed = { ...(rawOutput as any) };
    this.sanitizeSuccessLevels(parsed);
    const diceUsed = Array.isArray(parsed.diceUsed)
      ? parsed.diceUsed.filter((d: unknown): d is string => typeof d === "string")
      : [];

    await this.buildFinalResult(
      {},
      dynamicState,
      dynamicState.playerCharacter,
      parsed,
      diceUsed,
      {
        targetCharacter,
        sourceTurnId: currentTurnId ?? null,
      },
      manager,
      sceneRoomId,
      playerId,
      staged,
      originalUserInput
    );
  }

  private clampAttitude(value: unknown): number | null {
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    const rounded = Math.round(value);
    if (rounded > 100) return 100;
    if (rounded < -100) return -100;
    return rounded;
  }

  private hasSkillCheckFromDice(diceUsed: unknown): boolean {
    if (!Array.isArray(diceUsed)) return false;
    return diceUsed.some((entry) => {
      if (typeof entry !== "string") return false;
      const text = entry.toLowerCase();
      return text.includes("1d100") || /\b\d+%/.test(text);
    });
  }

  private sanitizeActionLogsBySkillUsage(
    actionLogs: unknown,
    hasSkillCheck: boolean
  ): unknown {
    if (!Array.isArray(actionLogs)) return actionLogs;
    return actionLogs.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const cleaned = { ...(entry as Record<string, unknown>) };
      if (!hasSkillCheck && "successLevel" in cleaned) {
        delete cleaned.successLevel;
      }
      return cleaned;
    });
  }

  private sanitizeSuccessLevels(parsed: Record<string, unknown>): void {
    const playerUsedSkill = this.hasSkillCheckFromDice(parsed.diceUsed);
    parsed.actionLog = this.sanitizeActionLogsBySkillUsage(
      parsed.actionLog,
      playerUsedSkill
    );

    if (Array.isArray(parsed.npcResponses)) {
      parsed.npcResponses = parsed.npcResponses.map((response) => {
        if (!response || typeof response !== "object") return response;
        const cleaned = { ...(response as Record<string, unknown>) };
        const npcUsedSkill = this.hasSkillCheckFromDice(cleaned.diceUsed);
        cleaned.actionLog = this.sanitizeActionLogsBySkillUsage(
          cleaned.actionLog,
          npcUsedSkill
        );
        return cleaned;
      });
    }
  }

  private parseOpeningPendingNpcActions(raw: unknown): PendingNpcAction[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const data = item as Record<string, unknown>;
        const npcId = data.npcId;
        const npcName = data.npcName;
        const actionNarrative = data.actionNarrative;
        if (
          typeof npcId !== "string" ||
          typeof npcName !== "string" ||
          typeof actionNarrative !== "string"
        ) {
          return null;
        }
        const cleanedNarrative = actionNarrative.trim();
        if (!cleanedNarrative) return null;
        return {
          npcId,
          npcName,
          actionNarrative: cleanedNarrative,
        } satisfies PendingNpcAction;
      })
      .filter((item): item is PendingNpcAction => item !== null);
  }

  private parseHeartbeatDueActionsContext(
    raw: unknown
  ): Array<{
    heartbeatId: string;
    npcId: string;
    scheduledGameTime: string;
    status: "due" | "overdue";
    npcName: string;
    task: string;
    location: string;
  }> {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const data = item as Record<string, unknown>;
        const heartbeatId =
          typeof data.heartbeatId === "string" ? data.heartbeatId.trim() : "";
        const npcId = typeof data.npcId === "string" ? data.npcId.trim() : "";
        const scheduledGameTime =
          typeof data.scheduledGameTime === "string"
            ? data.scheduledGameTime.trim()
            : "";
        const status = data.status;
        const npcName = typeof data.npcName === "string" ? data.npcName : "";
        const task = typeof data.task === "string" ? data.task : "";
        const location =
          typeof data.location === "string" ? data.location : "";
        if (
          !heartbeatId ||
          !npcId ||
          !scheduledGameTime ||
          (status !== "due" && status !== "overdue") ||
          !npcName ||
          !task ||
          !location
        ) {
          return null;
        }
        return {
          heartbeatId,
          npcId,
          scheduledGameTime,
          status,
          npcName,
          task,
          location,
        } as const;
      })
      .filter(
        (
          item
        ): item is {
          heartbeatId: string;
          npcId: string;
          scheduledGameTime: string;
          status: "due" | "overdue";
          npcName: string;
          task: string;
          location: string;
        } => item !== null
      );
  }

  private extractHeartbeatRelatedNpcs(
    dynamicState: DynamicGameState,
    heartbeatDueActions: Array<{
      heartbeatId: string;
      npcId: string;
      scheduledGameTime: string;
      status: "due" | "overdue";
      npcName: string;
      task: string;
      location: string;
    }>
  ): any[] {
    if (!Array.isArray(heartbeatDueActions) || heartbeatDueActions.length === 0) {
      return [];
    }

    const grouped = new Map<string, { npcId: string; npcName: string }>();
    for (const item of heartbeatDueActions) {
      const key =
        item.npcId.trim().length > 0
          ? `id:${item.npcId.trim()}`
          : `name:${item.npcName.trim().toLowerCase()}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          npcId: item.npcId,
          npcName: item.npcName,
        });
      }
    }

    const out: any[] = [];
    const seenNpcIds = new Set<string>();
    for (const group of grouped.values()) {
      const npc =
        dynamicState.npcCharacters.find((candidate) => candidate.id === group.npcId) ||
        dynamicState.npcCharacters.find(
          (candidate) =>
            candidate.name.toLowerCase() === group.npcName.toLowerCase()
        );
      if (!npc) continue;
      if (seenNpcIds.has(npc.id)) continue;
      seenNpcIds.add(npc.id);
      out.push(this.toActionContextNpc(npc));
    }

    return out;
  }

  private parseHeartbeatActionsFromModel(
    raw: unknown,
    dynamicState: Readonly<DynamicGameState>,
    sourceTurnId: string | null | undefined
  ): HeartbeatAction[] {
    if (!Array.isArray(raw)) return [];
    if (!sourceTurnId || sourceTurnId.trim().length === 0) {
      console.warn(
        "⚠️ [Action Agent] heartbeatActions returned but sourceTurnId missing; skipping heartbeat persistence."
      );
      return [];
    }

    const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const npcById = new Map(dynamicState.npcCharacters.map((npc) => [npc.id, npc]));
    const normalizedTurnId = sourceTurnId.trim();

    return raw
      .map((item): HeartbeatAction | null => {
        if (!item || typeof item !== "object") return null;
        const data = item as Record<string, unknown>;
        const scheduledGameTime =
          typeof data.scheduledGameTime === "string"
            ? data.scheduledGameTime.trim()
            : "";
        const npcIdRaw = typeof data.npcId === "string" ? data.npcId.trim() : "";
        const npcNameRaw =
          typeof data.npcName === "string" ? data.npcName.trim() : "";
        const task = typeof data.task === "string" ? data.task.trim() : "";
        const location =
          typeof data.location === "string" ? data.location.trim() : "";

        if (!scheduledGameTime || !task || !location) {
          return null;
        }
        if (!parseGameTime(scheduledGameTime)) {
          return null;
        }

        let npcId = npcIdRaw;
        let npcName = npcNameRaw;
        if (!npcId && npcName) {
          const npc = dynamicState.npcCharacters.find(
            (candidate) =>
              candidate.name.toLowerCase() === npcName.toLowerCase()
          );
          if (npc) {
            npcId = npc.id;
            npcName = npc.name;
          }
        }

        if (!npcId || !npcById.has(npcId)) {
          return null;
        }
        if (!npcName) {
          npcName = npcById.get(npcId)?.name || npcId;
        }

        const existingByFingerprint = (dynamicState.heartbeatActions || []).find(
          (existing) =>
            (existing.status === "scheduled" ||
              existing.status === "due" ||
              existing.status === "overdue") &&
            existing.npcId === npcId &&
            existing.scheduledGameTime === scheduledGameTime &&
            existing.task.trim().toLowerCase() === task.toLowerCase() &&
            existing.location.trim().toLowerCase() === location.toLowerCase()
        );

        return {
          heartbeatId:
            (typeof data.heartbeatId === "string" &&
            data.heartbeatId.trim().length > 0
              ? data.heartbeatId.trim()
              : existingByFingerprint?.heartbeatId) ||
            `heartbeat-${Date.now()}-${randomUUID().slice(0, 8)}`,
          scheduledGameTime,
          npcId,
          npcName,
          task,
          location,
          status: "scheduled" as HeartbeatAction["status"],
          createdAtGameTime:
            existingByFingerprint?.createdAtGameTime || currentGameTime,
          sourceTurnId: existingByFingerprint?.sourceTurnId || normalizedTurnId,
          ...(existingByFingerprint?.triggeredAtGameTime
            ? { triggeredAtGameTime: existingByFingerprint.triggeredAtGameTime }
            : {}),
        };
      })
      .filter((item): item is HeartbeatAction => item !== null);
  }

  private consumeDueHeartbeatActionsFromContext(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string
  ): void {
    const state = manager.getSceneRoomState(sceneRoomId, playerId);
    const dueRaw = state.temporaryInfo.contextualData?.heartbeatDueActions;
    if (!Array.isArray(dueRaw) || dueRaw.length === 0) return;

    const dueIds = new Set(
      dueRaw
        .map((item) =>
          item && typeof item === "object" && typeof item.heartbeatId === "string"
            ? item.heartbeatId.trim()
            : ""
        )
        .filter((id) => id.length > 0)
    );
    if (dueIds.size === 0) return;

    const current = Array.isArray(state.heartbeatActions)
      ? state.heartbeatActions
      : [];
    const next = current.filter((item: any) => !dueIds.has(item.heartbeatId));
    const removedCount = current.length - next.length;
    if (removedCount <= 0) return;

    manager.setHeartbeatActions(next);
    console.log(
      `🫀 [Action Agent] Consumed heartbeat actions for this turn: removed=${removedCount}`
    );
  }

  private parseJsonFromModelResponse(
    response: string,
    label: string
  ): Record<string, unknown> | null {
    try {
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

      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      console.error(`❌ [Action Agent] Failed to parse ${label} JSON:`, error);
      return null;
    }
  }

  private hasRestIntent(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return false;
    return /(休息|睡觉|睡覺|小睡|打盹|午睡|补觉|補覺|过夜|過夜|休整|歇会|歇會|眯一会|眯一會|\brest\b|\bsleep\b|\bnap\b|\bpower nap\b|\btake a break\b|\bturn in\b|\bovernight\b)/i.test(
      normalized
    );
  }

  private normalizeDurationText(text: string): string {
    if (!text) return "";
    return text
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248))
      .replace(/：/g, ":")
      .replace(/，/g, ",")
      .replace(/。/g, ".")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  private parseChineseNumber(token: string): number | null {
    const normalized = token
      .trim()
      .replace(/兩/g, "两")
      .replace(/〇/g, "零")
      .replace(/[个個余餘多來来约約左右]/g, "");
    if (!normalized) return null;
    if (normalized === "半") return 0.5;

    const digitMap: Record<string, number> = {
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
    };
    const unitMap: Record<string, number> = {
      十: 10,
      百: 100,
    };

    if (normalized.includes("点")) {
      const [intPartRaw, decimalPartRaw] = normalized.split("点");
      const intPart = this.parseChineseNumber(intPartRaw || "零");
      if (intPart === null) return null;
      const decimalDigits = [...(decimalPartRaw || "")]
        .map((char) => digitMap[char])
        .filter((digit) => digit !== undefined);
      if (decimalDigits.length === 0) return null;
      const decimalValue = Number(`0.${decimalDigits.join("")}`);
      return intPart + decimalValue;
    }

    const allDigits = [...normalized].every((char) => digitMap[char] !== undefined);
    if (allDigits) {
      const joined = [...normalized].map((char) => digitMap[char]).join("");
      const value = Number(joined);
      return Number.isFinite(value) ? value : null;
    }

    let result = 0;
    let current = 0;
    let seen = false;
    for (const char of normalized) {
      if (digitMap[char] !== undefined) {
        current = digitMap[char];
        seen = true;
        continue;
      }
      if (unitMap[char] !== undefined) {
        const unit = unitMap[char];
        result += (current || 1) * unit;
        current = 0;
        seen = true;
        continue;
      }
      return null;
    }

    if (!seen) return null;
    return result + current;
  }

  private parseNumericToken(token: string): number | null {
    const normalized = token.trim().replace(/[个個余餘多來来约約左右]/g, "");
    if (!normalized) return null;
    if (normalized === "半") return 0.5;
    const asNumber = Number(normalized);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
    return this.parseChineseNumber(normalized);
  }

  private parseDurationMinutes(text: string): number | null {
    const normalized = this.normalizeDurationText(text);
    if (!normalized) return null;

    const hourUnits = "(?:个?\\s*小时|個?\\s*小時|小时|小時|hours?|hrs?|hr|h)";
    const minuteUnits = "(?:分钟|分鐘|minutes?|mins?|min|m)";
    const numberToken = "(?:\\d+(?:\\.\\d+)?|[零〇一二两兩三四五六七八九十百半点]+)";

    let working = normalized;
    let totalMinutes = 0;
    let matched = false;

    const addMinutes = (value: number | null, multiplier: number): void => {
      if (value !== null && Number.isFinite(value) && value > 0) {
        totalMinutes += value * multiplier;
        matched = true;
      }
    };

    const halfAfterHours = new RegExp(`(${numberToken})\\s*${hourUnits}\\s*半`, "gi");
    working = working.replace(halfAfterHours, (_full, token: string) => {
      const hours = this.parseNumericToken(token);
      addMinutes(hours, 60);
      totalMinutes += 30;
      matched = true;
      return " ";
    });

    const halfBeforeHours = new RegExp(`(${numberToken})\\s*(?:个?\\s*)?半\\s*${hourUnits}`, "gi");
    working = working.replace(halfBeforeHours, (_full, token: string) => {
      const hours = this.parseNumericToken(token);
      addMinutes(hours, 60);
      totalMinutes += 30;
      matched = true;
      return " ";
    });

    const plainHalfHour = new RegExp(`(^|[^\\w])半\\s*${hourUnits}`, "gi");
    working = working.replace(plainHalfHour, (_full, prefix: string) => {
      totalMinutes += 30;
      matched = true;
      return `${prefix} `;
    });

    const hourRegex = new RegExp(`(${numberToken})\\s*${hourUnits}`, "gi");
    let hourMatch: RegExpExecArray | null;
    while ((hourMatch = hourRegex.exec(working)) !== null) {
      const hours = this.parseNumericToken(hourMatch[1]);
      addMinutes(hours, 60);
    }

    const minuteRegex = new RegExp(`(${numberToken})\\s*${minuteUnits}`, "gi");
    let minuteMatch: RegExpExecArray | null;
    while ((minuteMatch = minuteRegex.exec(working)) !== null) {
      const minutes = this.parseNumericToken(minuteMatch[1]);
      addMinutes(minutes, 1);
    }

    if (matched) {
      return Math.max(1, Math.min(1440, Math.round(totalMinutes)));
    }

    if (
      /(overnight|all night|through the night|sleep until morning|过夜|整晚|一晚|一宿|睡到天亮|睡到早上)/i.test(
        normalized
      )
    ) {
      return 480;
    }

    if (/(half day|半天)/i.test(normalized)) {
      return 720;
    }

    if (/(all day|full day|整天|全天|一整天|一天)/i.test(normalized)) {
      return 720;
    }

    if (
      /(power nap|nap|short while|for a while|a bit|小睡|午睡|眯一会|眯一會|一会儿|一會兒|一会|一會|片刻|歇会|歇會)/i.test(
        normalized
      )
    ) {
      return 30;
    }

    const compactHourMinuteMatch = normalized.match(
      /(\d{1,2})\s*:\s*(\d{1,2})/
    );
    if (compactHourMinuteMatch) {
      const hours = Number(compactHourMinuteMatch[1]);
      const minutes = Number(compactHourMinuteMatch[2]);
      if (
        Number.isFinite(hours) &&
        Number.isFinite(minutes) &&
        hours >= 0 &&
        minutes >= 0
      ) {
        return Math.max(1, Math.min(1440, Math.round(hours * 60 + minutes)));
      }
    }

    return null;
  }

  private resolveRestMinutes(
    originalUserInput: string | null | undefined,
    actionAnalysis: ActionAnalysis | null | undefined,
    parsed: Record<string, unknown>
  ): number | null {
    const candidates = [
      originalUserInput,
      actionAnalysis?.action,
      actionAnalysis?.target?.intent,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    const hasRestIntent = candidates.some((value) => this.hasRestIntent(value));
    if (!hasRestIntent) return null;

    for (const candidate of candidates) {
      const parsedMinutes = this.parseDurationMinutes(candidate);
      if (parsedMinutes !== null) {
        return parsedMinutes;
      }
    }

    const modelMinutes = parsed.timeElapsedMinutes;
    if (typeof modelMinutes === "number" && Number.isFinite(modelMinutes) && modelMinutes > 0) {
      return Math.max(1, Math.min(1440, Math.round(modelMinutes)));
    }

    return null;
  }

  private getRestTimeConsumption(restMinutes: number): ActionResult["timeConsumption"] {
    if (restMinutes >= 480) return "very long";
    if (restMinutes >= 240) return "long";
    if (restMinutes >= 60) return "medium";
    return "short";
  }

  /**
   * Apply relationship changes already embedded in the main action parsed response.
   * Replaces the old separate LLM call for relationship updates.
   */
  private applyRelationshipChangesFromParsed(
    parsed: Record<string, unknown>,
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string
  ): void {
    try {
      const rawUpdates = parsed.relationshipChanges;
      if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
        return;
      }

      const dynamicState = manager.getSceneRoomState(sceneRoomId, playerId);
      const allNpcs = dynamicState.npcCharacters;

      const npcById = new Map<string, DynamicNPCProfile>();
      for (const npc of allNpcs) {
        npcById.set(npc.id, npc);
      }
      // Also allow player as a target
      const playerChar = dynamicState.playerCharacter;

      // Group raw updates by sourceNpcId
      const updatesBySource = new Map<string, NPCRelationship[]>();

      for (const item of rawUpdates) {
        if (!item || typeof item !== "object") continue;
        const raw = item as Record<string, unknown>;
        const sourceNpcId = raw.sourceNpcId;
        const targetId = raw.targetId;
        if (typeof sourceNpcId !== "string" || typeof targetId !== "string")
          continue;
        if (!npcById.has(sourceNpcId)) continue;
        if (sourceNpcId === targetId) continue;

        const targetName =
          typeof raw.targetName === "string" && raw.targetName.trim()
            ? raw.targetName.trim()
            : (npcById.get(targetId)?.name ?? playerChar?.name ?? "Unknown");

        const rel: NPCRelationship = {
          targetId,
          targetName,
          relationshipType: (typeof raw.relationshipType === "string" &&
          raw.relationshipType.trim()
            ? raw.relationshipType.trim()
            : "neutral") as NPCRelationship["relationshipType"],
          attitude: this.clampAttitude(raw.attitude) ?? 0,
          ...(typeof raw.description === "string" && raw.description.trim()
            ? { description: raw.description.trim() }
            : {}),
        };

        if (!updatesBySource.has(sourceNpcId)) {
          updatesBySource.set(sourceNpcId, []);
        }
        updatesBySource.get(sourceNpcId)!.push(rel);
      }

      if (updatesBySource.size === 0) return;

      const npcCharactersUpdate = [...updatesBySource.entries()].map(
        ([id, relationships]) => ({
          id,
          name: npcById.get(id)!.name,
          relationships,
        })
      );

      // updateCharacter() in applyActionUpdate handles the upsert merge by targetId
      manager.applyPlayerActionUpdate(sceneRoomId, playerId, {
        npcCharacters: npcCharactersUpdate,
      });
      console.log(
        `   ✓ Relationship updates applied: ${rawUpdates.length} changes across ${npcCharactersUpdate.length} NPCs`
      );
    } catch (error) {
      console.warn(
        "   ⚠️ [Action Agent] Relationship update generation failed, skipped:",
        error
      );
    }
  }

  /**
   * Unified method to process any character's action (player or NPC)
   */
  private async processCharacterAction(
    runtime: any,
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    actionDescription: string,
    options: {
      targetCharacter?: DynamicCharacterProfile | null;
      selectedSkill?: string | null;
      skillSelectionMode?: "auto" | "manual";
      language?: "en" | "zh";
      sourceTurnId?: string | null;
    },
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string,
    staged: StagedTime,
    originalUserInput?: string | null
  ): Promise<DynamicGameState> {
    const {
      targetCharacter,
      selectedSkill,
      skillSelectionMode,
      sourceTurnId,
    } = options;
    const language =
      options.language === "en" || options.language === "zh"
        ? options.language
        : "zh";

    // Pre-roll dice
    const preRolledDice = this.preRollDice();

    // Get existing scene change request
    const existingSceneChangeRequest =
      dynamicState.temporaryInfo.sceneChangeRequest;

    // Extract scene NPCs for player actions (for NPC response analysis)
    // Exclude the target character to avoid duplicating data already injected as Target NPC
    const sceneNPCs = this.extractSceneNPCsForAction(dynamicState).filter(
      (npc) =>
        !targetCharacter ||
        (npc.id !== targetCharacter.id && npc.name !== targetCharacter.name)
    );
    const targetIntent =
      dynamicState.temporaryInfo.currentActionAnalysis?.target?.intent ?? "";

    // Build system prompt using template
    const fatigueActive = manager.isFatigued(playerId);
    const baseSystemPrompt = buildActionSystemPrompt(
      originalUserInput,
      actionDescription,
      preRolledDice,
      existingSceneChangeRequest,
      sceneNPCs,
      selectedSkill ?? null,
      skillSelectionMode,
      targetIntent,
      language,
      fatigueActive
    );

    const systemPrompt = baseSystemPrompt;

    // Single call - no tool loop needed with pre-rolled dice
    const context = this.buildContext(
      dynamicState,
      character,
      { targetCharacter },
      manager,
      sceneRoomId
    );
    const fullPrompt = systemPrompt + context;

    const response = await generateText({
      runtime,
      context: fullPrompt,
      modelClass: ModelClass.MEDIUM,
    });

    // Parse JSON response
    let parsed;
    try {
      let jsonText = response.trim();

      const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
        console.log(
          `📝 [Action Agent] Detected markdown code block, extracted JSON content`
        );
      }

      if (!jsonText.startsWith("{") && !jsonText.startsWith("[")) {
        const jsonObjectMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          jsonText = jsonObjectMatch[0];
          console.log(`📝 [Action Agent] Extracted JSON object from text`);
        }
      }

      parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") {
        this.sanitizeSuccessLevels(parsed as Record<string, unknown>);
      }
    } catch (error) {
      console.error(`❌ [Action Agent] JSON parsing error:`, error);
      console.error(
        `   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`
      );
      console.error(
        `   Error message: ${error instanceof Error ? error.message : String(error)}`
      );
      console.error(
        `   Original response (first 500 chars): ${response.substring(0, 500)}${response.length > 500 ? "..." : ""}`
      );
      console.error(
        `   Original response length: ${response.length} characters`
      );
      return this.buildErrorResult(
        dynamicState,
        character,
        `Invalid JSON response from model: ${error instanceof Error ? error.message : String(error)}`,
        [],
        manager,
        sceneRoomId,
        playerId
      );
    }

    // Extract dice usage from response
    const diceUsed = parsed.diceUsed || [];

    // Return final result
    return await this.buildFinalResult(
      runtime,
      dynamicState,
      character,
      parsed,
      diceUsed,
      { targetCharacter, sourceTurnId },
      manager,
      sceneRoomId,
      playerId,
      staged,
      originalUserInput
    );
  }

  async processAction(
    runtime: any,
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string,
    staged: StagedTime,
    userMessage: string,
    selectedSkill?: string | null,
    skillSelectionMode?: "auto" | "manual",
    language?: "en" | "zh",
    currentTurnId?: string | null
  ): Promise<void> {
    const dynamicState = manager.getSceneRoomState(sceneRoomId, playerId);
    if (!dynamicState.playerCharacter) {
      console.warn(`[MP ActionAgent] No player profile for playerId=${playerId}, skipping action`);
      return;
    }
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const targetCharacter = this.findTargetCharacter(
      dynamicState,
      actionAnalysis
    );

    const updatedState = await this.processCharacterAction(
      runtime,
      dynamicState,
      dynamicState.playerCharacter,
      userMessage,
      {
        targetCharacter,
        selectedSkill: selectedSkill ?? null,
        skillSelectionMode,
        language,
        sourceTurnId: currentTurnId ?? null,
      },
      manager,
      sceneRoomId,
      playerId,
      staged,
      userMessage // Pass original user input
    );

    // The state has been updated through the manager in buildFinalResult
    // No need to do anything else here
  }

  /**
   * Pre-roll common dice expressions
   */
  private preRollDice(playerCount = 1) {
    const scale = Math.max(1, playerCount);
    const rollDice = (sides: number, count = 1): number[] => {
      return Array.from(
        { length: count },
        () => Math.floor(Math.random() * sides) + 1
      );
    };

    const d100_results = rollDice(100, 5 * scale);
    const d100_opposed_results = rollDice(100, 2 * scale);
    const d20_results = rollDice(20, 2 * scale);
    const d10_results = rollDice(10, 2 * scale);
    const d8_results = rollDice(8, 2 * scale);
    const d6_results = rollDice(6, 2 * scale);
    const d4_results = rollDice(4, 2 * scale);
    const d3_results = rollDice(3, 2 * scale);

    const d6_pairs: number[] = [];
    for (let i = 0; i < 2 * scale; i++) {
      const pair = rollDice(6, 2);
      d6_pairs.push(pair[0] + pair[1]);
    }

    return {
      "1d100": d100_results,
      "1d100_opposed": d100_opposed_results,
      "1d20": d20_results,
      "1d10": d10_results,
      "1d8": d8_results,
      "1d6": d6_results,
      "2d6": d6_pairs,
      "1d4": d4_results,
      "1d3": d3_results,
    };
  }

  /**
   * Find target character based on action analysis or NPC response
   */
  private findTargetCharacter(
    dynamicState: DynamicGameState,
    actionAnalysis?: ActionAnalysis | null,
    npcResponse?: NPCResponseAnalysis
  ): DynamicCharacterProfile | null {
    let targetName: string | null = null;

    if (npcResponse?.targetCharacter) {
      targetName = npcResponse.targetCharacter;
    } else if (actionAnalysis?.target?.name) {
      targetName = actionAnalysis.target.name;
    }

    if (!targetName) {
      return null;
    }

    const targetLower = targetName.toLowerCase();

    // Check if target is the acting player
    if (dynamicState.playerCharacter?.name?.toLowerCase().includes(targetLower)) {
      return dynamicState.playerCharacter;
    }

    // Multiplayer: allow targeting another investigator in the same sceneRoom.
    const scenePlayers = dynamicState.temporaryInfo?.contextualData?.scenePlayers;
    if (Array.isArray(scenePlayers)) {
      const match = scenePlayers.find((sp: any) => {
        if (!sp || typeof sp !== "object") return false;
        if (typeof sp.name !== "string") return false;
        if (!sp.profile || typeof sp.profile !== "object") return false;
        const n = sp.name.toLowerCase();
        return n.includes(targetLower) || targetLower.includes(n);
      });
      if (match?.profile) {
        const profile: any = match.profile;
        if (!profile.id && typeof match.characterId === "string") {
          profile.id = match.characterId;
        }
        if (!profile.name && typeof match.name === "string") {
          profile.name = match.name;
        }
        return profile as DynamicCharacterProfile;
      }
    }

    // Check NPCs
    const targetNpc = dynamicState.npcCharacters.find(
      (npc) =>
        npc.name.toLowerCase().includes(targetLower) ||
        npc.id.toLowerCase().includes(targetLower)
    );

    return targetNpc || null;
  }

  /**
   * Filter character profile to remove unnecessary fields for action context
   * Removes: backstory, background, clues, instantiatedFrom,
   * inheritsKnowledge, actionLog
   * Keeps: occupation, notes, and all core fields (id, name, attributes, status, inventory, skills, weapons, derivedAttributes, etc.)
   */
  private filterCharacterForContext(
    character: DynamicCharacterProfile
  ): Partial<DynamicCharacterProfile> {
    const {
      backstory,
      background,
      clues,
      instantiatedFrom,
      inheritsKnowledge,
      actionLog,
      ...filteredCharacter
    } = character as any;

    return {
      ...filteredCharacter,
      // Only include skills explicitly set in the character file.
      // Missing skills fall back to the shared default table injected in buildContext.
      skills: filteredCharacter.skills ?? {},
    };
  }

  private toActionContextNpc(npc: DynamicNPCProfile): Record<string, unknown> {
    const filtered = this.filterCharacterForContext(npc);
    return {
      id: filtered.id,
      name: filtered.name,
      appearance: filtered.appearance ?? null,
      age: filtered.age ?? null,
      gender: filtered.gender ?? null,
      personality: filtered.personality ?? null,
      attributes: filtered.attributes,
      status: filtered.status,
      skills: filtered.skills,
      inventory: filtered.inventory || [],
      occupation: filtered.occupation || null,
      notes: filtered.notes || null,
      goals: npc.goals || [],
      secrets: npc.secrets || [],
      relationships: npc.relationships || [],
      last3ActionLog: (npc.actionLog || []).slice(-3),
    };
  }

  /**
   * Extract NPCs in current scene for action context
   * Returns filtered NPC information (only essential fields)
   */
  private extractSceneNPCsForAction(dynamicState: DynamicGameState): any[] {
    const scenario = dynamicState.currentScenario;
    if (!scenario?.location) return [];

    const scenarioLocation = scenario.location;
    const snapshotTime =
      scenario.gameTime ??
      `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const out: any[] = [];
    const seen = new Set<string>();

    // Helper to normalize names for deduplication
    const normalizeName = (name: string): string => {
      return name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
        .trim();
    };

    // Helper to check if names are similar
    const isNameSimilar = (name1: string, name2: string): boolean => {
      const na = normalizeName(name1);
      const nb = normalizeName(name2);
      if (!na || !nb) return false;
      if (na === nb) return true;
      const tokensA = na.split(/\s+/);
      const tokensB = nb.split(/\s+/);
      if (tokensA[0] && tokensA[0] === tokensB[0]) return true;
      return false;
    };

    const addNPC = (npc: DynamicNPCProfile) => {
      const key = normalizeName(npc.name);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(this.toActionContextNpc(npc));
    };

    // 1. From scenario.characters: include unless we can prove they "left" (latest actionLog
    //    after snapshot time and location !== current scene). If no actionLog → use scene NPC as authority (include).
    for (const sc of scenario.characters || []) {
      const npc = dynamicState.npcCharacters.find((n) =>
        isNameSimilar(n.name, sc.name)
      );
      if (!npc) continue;
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() !== scenarioLocation.toLowerCase()
      ) {
        // NPC's latest actionLog is after snapshot and they're elsewhere → left, don't inject
        continue;
      }
      addNPC(npc);
    }

    // 2. From all NPCs: include only if we have actionLog showing they "arrived" (latest after snapshot and at current scene). If no actionLog, do not add here (scene NPC list is the authority).
    for (const npc of dynamicState.npcCharacters) {
      const latest = getLatestActionLogEntryWithLocation(npc.actionLog);
      if (
        latest &&
        isTimeAfter(latest.time, snapshotTime) &&
        latest.location.toLowerCase() === scenarioLocation.toLowerCase()
      ) {
        addNPC(npc);
      }
    }

    return out;
  }

  /**
   * Unified method to build context for any character action
   */
  private buildContext(
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    options: {
      targetCharacter?: DynamicCharacterProfile | null;
      sourceTurnId?: string | null;
    },
    manager?: MultiplayerDynamicGameStateManager,
    sceneRoomId?: string
  ): string {
    const { targetCharacter } = options;

    // Add current game time information for actionLog generation
    const fullGameTime = manager && sceneRoomId
      ? manager.getSceneRoomFullGameTime(sceneRoomId)
      : `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    let context = `\n\n=== CURRENT GAME TIME ===\n${fullGameTime}\n=== END OF GAME TIME ===\n`;

    // Multiplayer: inject other players in the same sceneRoom (skip omitted).
    // This is sceneRoom-scoped data provided by processSceneRoomRound().
    const scenePlayers = dynamicState.temporaryInfo.contextualData?.scenePlayers;
    if (Array.isArray(scenePlayers) && scenePlayers.length > 0) {
      context +=
        "\n\n=== SCENE PLAYERS (CURRENT SCENE ROOM, SKIP OMITTED) ===\n" +
        JSON.stringify(scenePlayers, null, 2) +
        "\n=== END SCENE PLAYERS ===\n";
    }
    const roundInputs = dynamicState.temporaryInfo.contextualData?.roundInputs;
    if (Array.isArray(roundInputs) && roundInputs.length > 0) {
      context +=
        "\n\n=== ROUND INPUTS (CURRENT SCENE ROOM, SKIP OMITTED) ===\n" +
        JSON.stringify(roundInputs, null, 2) +
        "\n=== END ROUND INPUTS ===\n";
    }

    // Inject skill defaults once — character skill fields only list explicitly set values.
    // For any skill not present in a character's skills object, use these base values.
    // Dodge default = character DEX ÷ 2.
    const skillDefaults = getStaticSkillDefaults();
    context += `\n=== DEFAULT SKILL VALUES (for skills not listed in a character's profile) ===\n${JSON.stringify(skillDefaults)}\nDodge: character DEX ÷ 2\n=== END DEFAULT SKILL VALUES ===\n`;
    context += "\n\nCurrent Scenario:\n";
    if (dynamicState.currentScenario) {
      // Find the corresponding scenario outline to get connections
      const scenarioOutline = dynamicState.scenarioOutlines.find(
        (outline) => outline.id === dynamicState.currentScenario!.id
      );

      const scenarioInfo = {
        name: dynamicState.currentScenario.name,
        location: dynamicState.currentScenario.location,
        description: dynamicState.currentScenario.description,
        conditions: dynamicState.currentScenario.conditions,
        connections: scenarioOutline?.connections || [], // Array of {scenarioName, relationshipType, description} - only "leads_to" connections allow scene change
      };
      context += JSON.stringify(scenarioInfo, null, 2);
    } else {
      context += "No current scenario";
    }

    // Add scene change information only if there's a valid scene change request from orchestrator
    const existingSceneChangeRequest =
      dynamicState.temporaryInfo.sceneChangeRequest;
    const hasValidSceneChangeRequest =
      existingSceneChangeRequest?.shouldChange === true &&
      existingSceneChangeRequest?.targetSceneName;

    if (hasValidSceneChangeRequest) {
      context += `\n\n=== SCENE CHANGE REQUEST ===`;
      context += `\nTarget Scene: ${existingSceneChangeRequest.targetSceneName}`;
      context += `\nReason: ${existingSceneChangeRequest.reason || "Scene change requested"}`;
      context += `\nYour task: Determine if the current action enables this scene change (check for obstructions, skill requirements, etc.)`;
      context += `\n=== END OF SCENE CHANGE REQUEST ===\n`;
    }

    // Add temporary rules if any
    if (dynamicState.temporaryInfo.rules.length > 0) {
      context += "\n\nTemporary Rules:\n";
      dynamicState.temporaryInfo.rules.forEach((rule, index) => {
        context += `${index + 1}. ${rule}\n`;
      });
    }

    const heartbeatDueActions = this.parseHeartbeatDueActionsContext(
      dynamicState.temporaryInfo.contextualData?.heartbeatDueActions
    );
    if (heartbeatDueActions.length > 0) {
      context +=
        "\n\n=== HEARTBEAT DUE ACTIONS ===\n" +
        JSON.stringify(heartbeatDueActions, null, 2) +
        "\nRules:\n" +
        "- These are scheduled appointments/actions that are now due or overdue.\n" +
        "- Your actionLog should reflect whether the investigator keeps, delays, misses, reschedules, or ignores these items.\n" +
        "- Do not force player behavior; preserve player agency while maintaining timeline consistency.\n" +
        "=== END HEARTBEAT DUE ACTIONS ===\n";

      const heartbeatRelatedNpcs = this.extractHeartbeatRelatedNpcs(
        dynamicState,
        heartbeatDueActions
      );
      if (heartbeatRelatedNpcs.length > 0) {
        context +=
          "\n\n=== HEARTBEAT RELATED NPCS (DEDUPED, SAME SHAPE AS SCENE NPCS) ===\n" +
          JSON.stringify(heartbeatRelatedNpcs, null, 2) +
          "\nUse this NPC context when resolving due/overdue heartbeat actions.\n" +
          "=== END HEARTBEAT RELATED NPCS ===\n";
      }
    }

    const defeatedNpcHistory = Array.isArray(dynamicState.defeatedNpcHistory)
      ? dynamicState.defeatedNpcHistory
          .filter(
            (entry): entry is { name: string; count: number } =>
              !!entry &&
              typeof entry.name === "string" &&
              typeof entry.count === "number" &&
              entry.name.trim().length > 0 &&
              Number.isFinite(entry.count) &&
              entry.count > 0
          )
          .map((entry) => ({
            name: entry.name.trim(),
            count: Math.floor(entry.count),
          }))
      : [];

    context +=
      "\n\n=== DEFEATED NPC HISTORY (name + times defeated) ===\n" +
      (defeatedNpcHistory.length > 0
        ? JSON.stringify(defeatedNpcHistory, null, 2)
        : "[]") +
      "\n=== END DEFEATED NPC HISTORY ===\n";

    // Add acting character (filtered to remove unnecessary fields)
    const filteredCharacter = this.filterCharacterForContext(character);
    context +=
      `\n\nCharacter:\n` +
      JSON.stringify(filteredCharacter, null, 2);

    // Add target character if applicable (filtered to remove unnecessary fields)
    if (targetCharacter) {
      const isPlayerTarget =
        targetCharacter.id === character.id ||
        targetCharacter.name === character.name;
      const filteredTargetCharacter =
        this.filterCharacterForContext(targetCharacter);
      context +=
        `\n\nTarget ${isPlayerTarget ? "Character (Player)" : "NPC"}:\n` +
        JSON.stringify(filteredTargetCharacter, null, 2);
    }

    return context;
  }

  /**
   * Unified method to build final result for any character action
   */
  private async buildFinalResult(
    runtime: any,
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    parsed: any,
    toolLogs: string[],
    options: {
      targetCharacter?: DynamicCharacterProfile | null;
      sourceTurnId?: string | null;
    },
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string,
    staged: StagedTime,
    originalUserInput?: string | null
  ): Promise<DynamicGameState> {
    const { targetCharacter, sourceTurnId } = options;
    const actionAnalysis = dynamicState.temporaryInfo.currentActionAnalysis;
    const parsedRecord =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const detectedRestMinutes =
      this.resolveRestMinutes(originalUserInput, actionAnalysis, parsedRecord);
    let restSummary: string | null = null;
    let restType: "none" | "short" | "long" | null = null;
    let restHpRestored = 0;
    let restSanRestored = 0;

    if (detectedRestMinutes !== null) {
      const restResult = manager.applyRestForPlayer(playerId, detectedRestMinutes);
      restSummary = restResult.summary;
      restType = restResult.restType;
      restHpRestored = restResult.hpRestored;
      restSanRestored = restResult.sanRestored;
    }

    // Apply the state update from LLM result
    if (parsed.stateUpdate) {
      manager.applyPlayerActionUpdate(sceneRoomId, playerId, parsed.stateUpdate);
    }

    // Once due heartbeat actions are injected for this turn and action agent runs,
    // treat them as consumed and remove from persistent state.
    this.consumeDueHeartbeatActionsFromContext(manager, sceneRoomId, playerId);

    const heartbeatActionsRaw = this.parseHeartbeatActionsFromModel(
      parsed.heartbeatActions,
      manager.getSceneRoomState(sceneRoomId, playerId),
      sourceTurnId ?? null
    );
    const heartbeatActions: MultiplayerHeartbeatAction[] = heartbeatActionsRaw.map(
      (a) => ({ ...a, ownerPlayerId: playerId })
    );
    if (heartbeatActions.length > 0) {
      manager.upsertHeartbeatActions(heartbeatActions);
      console.log(
        `🫀 [Action Agent] Persisted ${heartbeatActions.length} heartbeat action(s)`
      );
    }

    // Handle combat entry detection
    if (parsed.entersCombat === true) {
      const participantIds: string[] = Array.isArray(
        parsed.combatParticipantIds
      )
        ? (parsed.combatParticipantIds as string[]).filter(
            (id) => typeof id === "string"
          )
        : [];
      const initiatedBy: CombatState["initiatedBy"] =
        parsed.combatInitiatedBy === "npc" ? "npc" : "player";

      // Only enter combat if we're not already in battle
      const currentState = manager.getSceneRoomState(sceneRoomId, playerId);
      if (!currentState.isBattle) {
        manager.setCombatState({
          round: 1,
          participantNpcIds: participantIds,
          initiatedBy,
          pendingNpcActions: null,
        }, sceneRoomId);

        // Reset opening-combat contextual data for this turn
        manager.setContextualData(sceneRoomId, "openingPendingNpcActions", null);

        // For NPC-initiated combat, carry opening pending actions from normal action output.
        if (initiatedBy === "npc") {
          const openingPending = this.parseOpeningPendingNpcActions(
            parsed.openingPendingNpcActions
          );
          if (openingPending.length > 0) {
            manager.setContextualData(
              sceneRoomId,
              "openingPendingNpcActions",
              openingPending
            );
          }
        }

        // Set flag so the graph can detect this turn just entered combat
        manager.setContextualData(sceneRoomId, "justEnteredCombat", true);
        console.log(
          `⚔️  [Action Agent] Combat entered! Participants: [${participantIds.join(", ")}], initiated by: ${initiatedBy}`
        );
      }
    }

    // Handle scene change modification from Action Agent
    // Action Agent modifies the existing sceneChangeRequest from Orchestrator
    const currentSceneChangeRequest =
      dynamicState.temporaryInfo.sceneChangeRequest;
    if (parsed.sceneChange && currentSceneChangeRequest) {
      // Update the existing sceneChangeRequest based on action result
      const updatedRequest: SceneChangeRequest = {
        shouldChange: parsed.sceneChange.shouldChange,
        targetSceneName:
          parsed.sceneChange.targetSceneName ||
          currentSceneChangeRequest.targetSceneName,
        reason: parsed.sceneChange.reason || currentSceneChangeRequest.reason,
        timestamp: currentSceneChangeRequest.timestamp,
      };
      manager.setSceneChangeRequest(sceneRoomId, updatedRequest);

      // Player scene change: log the result
      if (parsed.sceneChange.shouldChange) {
        console.log(
          `Action Agent: Action succeeded, scene change to ${updatedRequest.targetSceneName} will proceed`
        );
      } else {
        console.log(
          `Action Agent: Action failed, scene change blocked - ${parsed.sceneChange.reason || "Unknown reason"}`
        );
      }
    }

    // Apply scenario updates if provided (clues handled by Keeper)
    const scenarioChanges: string[] = [];
    const scenarioUpdate = parsed.scenarioUpdate
      ? { ...parsed.scenarioUpdate }
      : null;
    if (scenarioUpdate && "clues" in scenarioUpdate) {
      delete scenarioUpdate.clues;
    }
    if (scenarioUpdate) {
      manager.updateScenarioState(sceneRoomId, scenarioUpdate);

      // Generate scenario change descriptions for action results
      if (scenarioUpdate.description) {
        scenarioChanges.push("Environment description updated");
      }

      if (scenarioUpdate.conditions && scenarioUpdate.conditions.length > 0) {
        scenarioChanges.push(
          `Environmental conditions changed: ${scenarioUpdate.conditions.map((c: any) => c.description).join(", ")}`
        );
      }
    }

    // Create structured action result
    const actionResult: ActionResult = {
      timestamp: new Date(),
      gameTime: dynamicState.timeOfDay || "Unknown time",
      timeElapsedMinutes:
        detectedRestMinutes ??
        (typeof parsed.timeElapsedMinutes === "number"
          ? parsed.timeElapsedMinutes
          : 0),
      location: dynamicState.currentScenario?.location || "Unknown location",
      character: character.name,
      result:
        restSummary ||
        parsed.summary ||
        (Array.isArray(parsed.actionLog) &&
        typeof parsed.actionLog[0]?.summary === "string"
          ? parsed.actionLog[0].summary
          : undefined) ||
        "performed an action",
      diceRolls: toolLogs.map((log) => log), // toolLogs already contain "expression -> result" format
      timeConsumption:
        detectedRestMinutes !== null
          ? this.getRestTimeConsumption(detectedRestMinutes)
          : parsed.timeConsumption || "instant", // Default to instant if not specified
      scenarioChanges: scenarioChanges.length > 0 ? scenarioChanges : undefined,
    };

    // Add to action results
    manager.addActionResult(sceneRoomId, actionResult);

    // Record full action output for downstream prompts (keeper)
    const detailedResult = this.buildDetailedActionResult(
      character,
      parsed,
      toolLogs
    );
    if (detectedRestMinutes !== null) {
      detailedResult.rest = {
        minutes: detectedRestMinutes,
        restType,
        hpRestored: restHpRestored,
        sanRestored: restSanRestored,
        summary: restSummary,
      };
    }
    {
      const room = manager.getSceneRoom(sceneRoomId);
      if (room) {
        room.temporaryInfo.actionResultsDetailed.push(detailedResult);
        manager.updateSceneRoom(sceneRoomId, {});
      }
    }

    // Log detailed action result
    console.log(`\n📊 [Action Result] Detailed execution result:`);
    console.log(`   Character: ${actionResult.character}`);
    console.log(`   Location: ${actionResult.location}`);
    console.log(`   Game Time: ${actionResult.gameTime}`);
    console.log(
      `   Time Elapsed: ${actionResult.timeElapsedMinutes || 0} minutes`
    );
    console.log(`   Time Consumption: ${actionResult.timeConsumption}`);
    console.log(`   Result: ${actionResult.result}`);
    if (actionResult.diceRolls && actionResult.diceRolls.length > 0) {
      console.log(
        `   Dice Rolls (${actionResult.diceRolls.length}):`
      );
      actionResult.diceRolls.forEach((roll, index) => {
        console.log(`     [${index + 1}] ${roll}`);
      });
    } else {
      console.log(`   Dice Rolls: None`);
    }
    if (
      actionResult.scenarioChanges &&
      actionResult.scenarioChanges.length > 0
    ) {
      console.log(
        `   Scenario Changes (${actionResult.scenarioChanges.length}):`
      );
      actionResult.scenarioChanges.forEach((change, index) => {
        console.log(`     [${index + 1}] ${change}`);
      });
    }

    // Update game time based on elapsed time (staged for multiplayer)
    if (
      actionResult.timeElapsedMinutes &&
      actionResult.timeElapsedMinutes > 0
    ) {
      const oldDay = dynamicState.gameDay;
      const oldTime = dynamicState.timeOfDay;
      staged.elapsedMinutesByPlayer[playerId] =
        (staged.elapsedMinutesByPlayer[playerId] ?? 0) + actionResult.timeElapsedMinutes;
      if (detectedRestMinutes === null) {
        staged.fatigueMinutesByPlayer[playerId] =
          (staged.fatigueMinutesByPlayer[playerId] ?? 0) + actionResult.timeElapsedMinutes;
      }
      const updatedState = manager.getSceneRoomState(sceneRoomId, playerId);
      const newDay = updatedState.gameDay;
      const fullTime = manager.getSceneRoomFullGameTime(sceneRoomId);

      console.log(
        `⏰ Time advanced by ${actionResult.timeElapsedMinutes} minutes (Player action)`
      );
      if (newDay > oldDay) {
        console.log(`   Day ${oldDay}, ${oldTime} → ${fullTime} 🌅`);
      } else {
        console.log(`   ${oldTime} → ${fullTime}`);
      }
    }

    // Process NPC responses
    if (parsed.npcResponses && Array.isArray(parsed.npcResponses)) {
      const npcResponses = parsed.npcResponses
        .filter(
          (r: any) =>
            r.willRespond && r.responseType && r.responseType !== "none"
        )
        .sort(
          (a: any, b: any) =>
            (a.executionOrder || 999) - (b.executionOrder || 999)
        );

      if (npcResponses.length > 0) {
        console.log(
          `\n🎭 [Action Agent] Processing ${npcResponses.length} NPC responses...`
        );

        const currentState = manager.getSceneRoomState(sceneRoomId, playerId);
        const fullGameTime = manager.getSceneRoomFullGameTime(sceneRoomId);

        for (const npcResponse of npcResponses) {
          const npc = currentState.npcCharacters.find(
            (n: DynamicNPCProfile) =>
              n.id === npcResponse.npcId ||
              n.name.toLowerCase() === npcResponse.npcName.toLowerCase()
          );

          if (!npc) {
            console.warn(
              `⚠️ [Action Agent] NPC not found: ${npcResponse.npcName} (ID: ${npcResponse.npcId})`
            );
            continue;
          }

          console.log(
            `\n🎭 [Action Agent] Processing NPC response [${npcResponse.executionOrder}]: ${npc.name} (${npcResponse.responseType})`
          );

          // Create ActionResult for NPC response
          const npcActionResult: ActionResult = {
            timestamp: new Date(),
            gameTime: currentState.timeOfDay || "Unknown time",
            timeElapsedMinutes: 0, // NPC reactions don't advance time
            location:
              currentState.currentScenario?.location || "Unknown location",
            character: npc.name,
            result: npcResponse.summary || `${npc.name} responds`,
            diceRolls: npcResponse.diceUsed || [],
            timeConsumption: "instant",
            scenarioChanges: undefined,
          };

          manager.addActionResult(sceneRoomId, npcActionResult);

          // Update NPC state if provided
          if (npcResponse.stateUpdate) {
            const npcStateUpdate: any = {
              npcCharacters: [
                {
                  id: npc.id,
                  name: npc.name,
                  ...npcResponse.stateUpdate,
                },
              ],
            };
            manager.applyPlayerActionUpdate(sceneRoomId, playerId, npcStateUpdate);
          }

          // Add actionLog entries for NPC
          if (npcResponse.actionLog && Array.isArray(npcResponse.actionLog)) {
            const updatedStateAfterUpdate = manager.getSceneRoomState(sceneRoomId, playerId);
            const npcInState = updatedStateAfterUpdate.npcCharacters.find(
              (n: DynamicNPCProfile) => n.id === npc.id
            );

            if (npcInState) {
              if (!npcInState.actionLog) {
                npcInState.actionLog = [];
              }

              for (const logEntry of npcResponse.actionLog) {
                if (logEntry.time && logEntry.location && logEntry.summary) {
                  const npcUsedSkill = this.hasSkillCheckFromDice(
                    npcResponse.diceUsed
                  );
                  const actionLogEntry: ActionLogEntry = {
                    time: logEntry.time,
                    location: logEntry.location,
                    summary: logEntry.summary,
                    successLevel:
                      npcUsedSkill && typeof logEntry.successLevel === "string"
                        ? logEntry.successLevel
                        : undefined,
                  };
                  npcInState.actionLog.push(actionLogEntry);
                }
              }
            }
          } else {
            // Fallback: create a basic actionLog entry
            const updatedStateAfterUpdate = manager.getSceneRoomState(sceneRoomId, playerId);
            const npcInState = updatedStateAfterUpdate.npcCharacters.find(
              (n: DynamicNPCProfile) => n.id === npc.id
            );

            if (npcInState) {
              if (!npcInState.actionLog) {
                npcInState.actionLog = [];
              }

              const locationName =
                currentState.currentScenario?.location || "Unknown location";
              const fallbackLogEntry: ActionLogEntry = {
                time: fullGameTime,
                location: locationName,
                summary: npcResponse.summary || `${npc.name} responds`,
                successLevel: this.hasSkillCheckFromDice(npcResponse.diceUsed)
                  ? "unknown"
                  : undefined,
              };
              npcInState.actionLog.push(fallbackLogEntry);
            }
          }

          console.log(
            `   ✓ NPC ${npc.name} response processed: ${npcResponse.responseDescription}`
          );
        }

        console.log(
          `\n✅ [Action Agent] Completed processing ${npcResponses.length} NPC responses`
        );
      }
    }

    // Append actionLog entries generated by LLM to the corresponding character
    // LLM generates actionLog entries in the response
    const updatedState = manager.getSceneRoomState(sceneRoomId, playerId);

    // Get actionLog entries from LLM response and add to the corresponding character based on characterId
    if (parsed.actionLog && Array.isArray(parsed.actionLog)) {
      // Process each actionLog entry and add to the corresponding character based on characterId
      for (const logEntry of parsed.actionLog) {
        if (logEntry.time && logEntry.location && logEntry.summary) {
          // Find the character by characterId if provided, otherwise use acting character
          let targetCharacter: DynamicCharacterProfile | undefined;

          if (logEntry.characterId) {
            // Find character by ID — check acting player first, then NPCs
            if (updatedState.playerCharacter && logEntry.characterId === updatedState.playerCharacter.id) {
              targetCharacter = updatedState.playerCharacter;
            } else {
              targetCharacter = updatedState.npcCharacters.find(
                (npc: DynamicNPCProfile) => npc.id === logEntry.characterId
              );
            }

            if (!targetCharacter) {
              console.warn(
                `   ⚠️  Character with ID "${logEntry.characterId}" not found, skipping actionLog entry`
              );
              continue;
            }
          } else {
            // Fallback: use acting character if characterId not provided (backward compatibility)
            targetCharacter = updatedState.playerCharacter;

            if (!targetCharacter) {
              console.warn(
                `   ⚠️  Acting character not found, skipping actionLog entry`
              );
              continue;
            }
          }

          // Initialize actionLog array if needed
          if (!targetCharacter.actionLog) {
            targetCharacter.actionLog = [];
          }

          // Create ActionLogEntry without characterId (not stored in the entry)
          const actionLogEntry: ActionLogEntry = {
            time: logEntry.time,
            location: logEntry.location,
            summary: logEntry.summary,
            successLevel:
              this.hasSkillCheckFromDice(parsed.diceUsed) &&
              typeof logEntry.successLevel === "string"
                ? logEntry.successLevel
                : undefined,
          };

          targetCharacter.actionLog.push(actionLogEntry);
        }
      }

      if (parsed.actionLog.length > 0) {
        console.log(
          `   ✓ Processed ${parsed.actionLog.length} actionLog entries`
        );
      }
    } else {
      // Fallback: if LLM didn't generate actionLog, create a basic entry
      const fullTime = manager.getSceneRoomFullGameTime(sceneRoomId);

      // Find the acting character in the current state
      const actorInState: DynamicCharacterProfile | undefined = updatedState.playerCharacter;

      if (actorInState) {
        if (!actorInState.actionLog) {
          actorInState.actionLog = [];
        }

        // Use location name for actionLog location field
        const locationName =
          updatedState.currentScenario?.location || "Unknown location";

        const fallbackLogEntry: ActionLogEntry = {
          time: fullTime,
          location: locationName,
          summary: actionResult.result,
          successLevel: this.hasSkillCheckFromDice(parsed.diceUsed)
            ? "unknown"
            : undefined,
        };
        actorInState.actionLog.push(fallbackLogEntry);
        console.log(
          `   ⚠️  LLM did not generate actionLog, added fallback entry to player ${actorInState.name} with location: ${locationName}`
        );
      }
    }

    // Note: Target character actionLog should be generated by LLM if the action affects them
    // The LLM can include actionLog entries for target characters in the response if needed

    this.applyRelationshipChangesFromParsed(
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {},
      manager,
      sceneRoomId,
      playerId
    );

    // Return the updated game state
    return manager.getSceneRoomState(sceneRoomId, playerId);
  }

  /**
   * Build a normalized detailed action result payload for keeper prompts.
   */
  private buildDetailedActionResult(
    character: DynamicCharacterProfile,
    parsed: unknown,
    toolLogs: string[]
  ): Record<string, unknown> {
    const parsedObject =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const detailedResult: Record<string, unknown> = {
      character: character.name,
      ...parsedObject,
    };

    if ("sceneChange" in detailedResult) {
      delete detailedResult.sceneChange;
    }

    if ("diceUsed" in detailedResult) {
      delete detailedResult.diceUsed;
    }

    const stripActionLogLocation = (entries: unknown): unknown => {
      if (!Array.isArray(entries)) return entries;
      return entries.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const cleaned = { ...(entry as Record<string, unknown>) };
        if ("location" in cleaned) {
          delete cleaned.location;
        }
        return cleaned;
      });
    };

    if ("actionLog" in detailedResult) {
      detailedResult.actionLog = stripActionLogLocation(
        detailedResult.actionLog
      );
    }

    if (Array.isArray(detailedResult.npcResponses)) {
      detailedResult.npcResponses = detailedResult.npcResponses.map(
        (response) => {
          if (!response || typeof response !== "object") return response;
          const cleaned = { ...(response as Record<string, unknown>) };
          if ("summary" in cleaned) {
            delete cleaned.summary;
          }
          if ("diceUsed" in cleaned) {
            delete cleaned.diceUsed;
          }
          if ("actionLog" in cleaned) {
            cleaned.actionLog = stripActionLogLocation(cleaned.actionLog);
          }
          return cleaned;
        }
      );
    }

    return detailedResult;
  }

  /**
   * Unified method to build error result for any character action
   */
  private buildErrorResult(
    dynamicState: DynamicGameState,
    character: DynamicCharacterProfile,
    errorMessage: string,
    toolLogs: string[],
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    playerId: string
  ): DynamicGameState {
    console.error(`\n❌ [Action Agent] Error handling: ${errorMessage}`);
    console.error(
      `   Current game state: Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`
    );
    console.error(
      `   Location: ${dynamicState.currentScenario?.location || "Unknown"}`
    );
    console.error(`   Character: ${character.name}`);
    if (toolLogs.length > 0) {
      console.error(`   Executed tool calls (${toolLogs.length}):`);
      toolLogs.forEach((log, index) => {
        console.error(`     [${index + 1}] ${log}`);
      });
    }

    // Create an error action result to record the failure
    const errorActionResult: ActionResult = {
      timestamp: new Date(),
      gameTime: dynamicState.timeOfDay || "Unknown time",
      timeElapsedMinutes: 0, // No time elapsed on error
      location: dynamicState.currentScenario?.location || "Unknown location",
      character: character.name,
      result: `[Error] action processing failed: ${errorMessage}`,
      diceRolls: toolLogs.length > 0 ? toolLogs : [],
      timeConsumption: "instant",
      scenarioChanges: [`Error: ${errorMessage}`],
    };

    // Add error result to action results (writes to multiplayer manager directly)
    manager.addActionResult(sceneRoomId, errorActionResult);

    // Record detailed error output for downstream prompts (keeper)
    const errorDetail: Record<string, unknown> = {
      character: character.name,
      timeElapsedMinutes: 0,
      timeConsumption: "instant",
      error: errorMessage,
    };
    {
      const room = manager.getSceneRoom(sceneRoomId);
      if (room) {
        room.temporaryInfo.actionResultsDetailed.push(errorDetail);
        manager.updateSceneRoom(sceneRoomId, {});
      }
    }

    console.error(`\n📊 [Action Result] Error result recorded:`);
    console.error(`   Character: ${errorActionResult.character}`);
    console.error(`   Location: ${errorActionResult.location}`);
    console.error(`   Error: ${errorActionResult.result}`);

    // Return valid DynamicGameState with error recorded
    return manager.getSceneRoomState(sceneRoomId, playerId);
  }

}
