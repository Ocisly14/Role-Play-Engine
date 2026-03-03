import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../../models/index.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import type { ScenarioLoader } from "../../../shared/agents/memory/scenarioloader/index.js";
import type {
  ActionLogEntry,
  CharacterStatus,
  InventoryItem,
  NPCRelationship,
} from "../../../shared/agents/models/gameTypes.js";
import { InventoryUtils } from "../../../shared/agents/models/gameTypes.js";
import type { ScenarioCharacter } from "../../../shared/agents/models/scenarioTypes.js";
import { composeTemplate } from "../../../template.js";
import type { DynamicGameState } from "../../state/index.js";
import type { MultiplayerDynamicGameStateManager, PerPlayerActionWindow } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import type { PlayerActionAnalysis } from "../orchestrator/orchestratorAgent.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import type { ScenarioConnectionType } from "../../world_builder/types.js";
import {
  retrieveTriggerEvidence,
  type TriggerEvidenceItem,
} from "../memory/memoryAgent.js";
import { serializeMultiplayerCheckpoint, generateMultiplayerCheckpointName } from "../memory/checkpoint.js";
import {
  getGlobalTriggerEventCheckTemplate,
  getStuckHintNarrativeTemplate,
} from "./directorAuxTemplates.js";
import {
  getCurrentSceneReactionSnapshotTemplate,
  getNonPlayerBackgroundSimplifiedSnapshotsTemplate,
  getNpcActionTimelineWithPlayerSceneIngressTemplate,
} from "./nonPlayerFlowTemplates.js";
import {
  getNpcActionTimelineTemplate,
  getSceneSwitchBackgroundSimplifiedSnapshotsTemplate,
  getTargetSnapshotFromTimelineTemplate,
} from "./sceneSwitchFlowTemplates.js";

interface DirectorRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): DirectorRuntime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

interface CurrentTurnActionLogItem {
  character: string;
  time: string;
  location: string;
  summary: string;
  source: "actionResults" | "actionResultsDetailed";
}

/**
 * Director Agent - Story progression and scene transition director
 * Responsible for monitoring game progress and advancing story development
 */
export class DirectorAgent {
  private scenarioLoader: ScenarioLoader;
  private db: CoCDatabase | CoCDatabaseAdapter;

  constructor(
    scenarioLoader: ScenarioLoader,
    db: CoCDatabase | CoCDatabaseAdapter
  ) {
    this.scenarioLoader = scenarioLoader;
    this.db = db;
  }

  /**
   * Execute scene transition (shared logic)
   */
  private async executeSceneTransition(
    targetSnapshot: DynamicScenarioSnapshot,
    scenarioName: string,
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): Promise<void> {
    console.log(`\n🔄 [Executing Scene Transition]:`);
    console.log(`   To: ${targetSnapshot.name}`);
    console.log(`   Location: ${targetSnapshot.location}`);

    try {
      manager.updateCurrentScenario(sceneRoomId, {
        snapshot: targetSnapshot,
        scenarioName: scenarioName,
      });

      const updatedState = manager.getSceneRoomState(sceneRoomId);

      console.log(`   ✓ Scene transition completed successfully`);
      console.log(`\n📍 [Post-Transition State]:`);
      console.log(
        `   Current Scene: ${updatedState.currentScenario?.name || "None"}`
      );
      console.log(`   Scene ID: ${updatedState.currentScenario?.id || "None"}`);
      console.log(
        `   Location: ${updatedState.currentScenario?.location || "None"}`
      );

      console.log(`\n✅ [Director Agent] Scene transition completed`);
      console.log(
        `🎬 [Director Agent] ========================================\n`
      );
    } catch (error) {
      console.error(`   ❌ Scene transition failed:`, error);
      throw error;
    }
  }

  /**
   * Handle scene change request initiated by Action Agent
   * Use map data and LLM to validate and select target scene
   * @deprecated Use handleUnifiedSceneChanges instead. Retained because internal helpers
   * (updateScenariosForSceneSwitch) are shared with the replacement method.
   */
  async handleActionDrivenSceneChange(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    targetSceneName: string,
    reason: string,
    currentCharacterInput?: string
  ): Promise<void> {
    console.log(
      `\n🎬 [Director Agent] ========================================`
    );
    console.log(
      `🎬 [Director Agent] Starting to process Action-driven scene transition`
    );
    console.log(`🎬 [Director Agent] ========================================`);

    const dynamicState = manager.getSceneRoomState(sceneRoomId);
    const currentScenario = dynamicState.currentScenario;
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;

    // Save current scenario as previousScenario for Keeper to access
    if (currentScenario) {
      const scr = manager.getSceneRoom(sceneRoomId);
      if (scr) {
        scr.temporaryInfo.previousScenario = { ...currentScenario };
      }
      console.log(
        `\n💾 [Director Agent] Saved previous scenario: ${currentScenario.name}`
      );
    }

    // Log current state
    console.log(`\n📍 [Current Scene State]:`);
    if (currentScenario) {
      console.log(`   Scene Name: ${currentScenario.name}`);
      console.log(`   Scene ID: ${currentScenario.id}`);
      console.log(`   Location: ${currentScenario.location}`);
      console.log(
        `   Description: ${currentScenario.description ? currentScenario.description.substring(0, 100) + "..." : "None"}`
      );
    } else {
      console.log(`   ⚠️  No current scene`);
    }

    // Log target scene request
    console.log(`\n🎯 [Scene Transition Request]:`);
    console.log(`   Target Scene Name: ${targetSceneName}`);
    console.log(`   Transition Reason: ${reason}`);

    // Check if scene change request exists
    if (!sceneChangeRequest?.shouldChange) {
      console.log(`   ⚠️  No scene change request found, skipping transition`);
      return;
    }

    // Step 1: Unified update - validates target + generates all snapshots (complete target + simplified background)
    let updateResult =
      await this.updateScenariosForSceneSwitch(manager, sceneRoomId);

    if (!updateResult) {
      const currentProvider =
        (process.env.MODEL_PROVIDER as ModelProviderName) ||
        ModelProviderName.OPENAI;
      const canFallbackToOpenAI =
        currentProvider !== ModelProviderName.OPENAI &&
        Boolean(process.env.OPENAI_API_KEY?.trim());

      if (canFallbackToOpenAI) {
        console.warn(
          `   ⚠️ Scene switch validation failed with ${currentProvider}, retrying scene switch generation with openai...`
        );
        updateResult = await this.updateScenariosForSceneSwitch(
          manager,
          sceneRoomId,
          {
            providerOverride: ModelProviderName.OPENAI,
          }
        );

        if (updateResult) {
          console.log(`   ✓ OpenAI scene switch retry succeeded`);
        }
      }
    }

    if (!updateResult) {
      // Validation failed, clear scene change request and return
      console.error(`   ❌ Scene change validation failed`);
      manager.clearSceneChangeRequest(sceneRoomId);
      return;
    }

    const {
      validatedTargetSceneName,
      targetSnapshot,
      backgroundSnapshots,
      modifiedConnections,
    } = updateResult;

    console.log(`   ✓ Validated target scene: ${validatedTargetSceneName}`);
    console.log(`   ✓ Generated complete target snapshot`);
    console.log(`   ✓ Background simplified snapshots completed`);
    if (modifiedConnections) {
      console.log(
        `   ✓ Updated ${modifiedConnections.length} connections for target scene`
      );
    }

    // Step 2: Find target scenario outline to get scenarioId
    const targetScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline: any) => outline.name === validatedTargetSceneName
    );

    if (!targetScenarioOutline) {
      console.error(
        `   ❌ Target scenario outline not found for: ${validatedTargetSceneName}`
      );
      manager.clearSceneChangeRequest(sceneRoomId);
      return;
    }

    // Step 3: Save target snapshot to state (using scenarioId as key)
    manager.setDb(this.db);
    await manager.setUpdatedDynamicScenarioSnapshot(
      sceneRoomId,
      targetScenarioOutline.id,
      targetSnapshot
    );

    if (backgroundSnapshots.size > 0) {
      for (const [scenarioId, snapshot] of backgroundSnapshots) {
        await manager.setUpdatedDynamicScenarioSnapshot(
          sceneRoomId,
          scenarioId,
          snapshot
        );
      }
    }

    console.log(`   ✓ Saved target snapshot to state`);

    // Step 4: Execute scene transition using the UPDATED complete snapshot
    await this.executeSceneTransition(
      targetSnapshot,
      validatedTargetSceneName,
      manager,
      sceneRoomId
    );

    // Step 5: Clean up scene change request
    manager.clearSceneChangeRequest(sceneRoomId);

    console.log(`✅ [Director Agent] Scene change completed successfully`);
    console.log(
      `🎬 [Director Agent] ========================================\n`
    );
  }

  // ===========================================================================
  // Native multiplayer scene change — Phase 1/2/3 run once globally
  // ===========================================================================

  /**
   * Handle all scene change requests for a sceneRoom natively (no adapter).
   * Phase 1 (NPC timeline): run ONCE globally.
   * Phase 2 (target snapshots): run once per unique target scene, in parallel.
   * Phase 3 (background simplified): run ONCE, excluding current + all targets.
   * Current scene is NOT updated.
   *
   * After this method, the manager's updatedDynamicScenarioSnapshots contains
   * pre-generated snapshots that sceneRoomSplitter/Merger can look up.
   */
  async handleMultiplayerSceneChanges(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): Promise<{
    targetSceneNames: string[];
    anyChanges: boolean;
  }> {
    const state = manager.getState();
    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    if (!sceneRoom) {
      return { targetSceneNames: [], anyChanges: false };
    }

    // Step 1: Collect unique target scenes from playerActionAnalyses
    const contextualData = sceneRoom.temporaryInfo.contextualData ?? {};
    const playerActionAnalyses =
      (contextualData.playerActionAnalyses as Record<string, PlayerActionAnalysis>) ?? {};

    const uniqueTargets = new Map<string, { targetSceneName: string; reason: string }>();
    for (const pa of Object.values(playerActionAnalyses)) {
      const scr = pa?.sceneChangeRequest;
      if (scr?.shouldChange && scr.targetSceneName) {
        const key = scr.targetSceneName.toLowerCase();
        if (!uniqueTargets.has(key)) {
          uniqueTargets.set(key, {
            targetSceneName: scr.targetSceneName,
            reason: scr.reason ?? "",
          });
        }
      }
    }

    if (uniqueTargets.size === 0) {
      return { targetSceneNames: [], anyChanges: false };
    }

    const targetSceneNames = [...uniqueTargets.values()].map((t) => t.targetSceneName);
    console.log(
      `\n🎬 [MP Director] handleMultiplayerSceneChanges — ${uniqueTargets.size} target(s): ${targetSceneNames.join(", ")}`
    );

    // Step 2: Save previousScenario for keeper context
    const currentScenario = sceneRoom.currentScenario;
    if (currentScenario) {
      manager.updateSceneRoom(sceneRoomId, {
        temporaryInfo: {
          ...sceneRoom.temporaryInfo,
          previousScenario: { ...currentScenario },
        },
      });
    }

    // Step 3: Build data context from multiplayer state (use room time)
    const currentGameTime = `Day ${sceneRoom.gameDay}, ${sceneRoom.timeOfDay}`;
    const runtime = createRuntime();

    const allScenariosData = await this.buildAllScenariosDataFromState(state);

    // Phase 1 NPCs
    const phase1Npcs = state.npcCharacters.map((npc) => ({
      ...npc,
      actionLog: npc.actionLog || [],
    }));

    // Determine previousSnapshotTime: earliest among all targets' baseline times
    const targetScenariosData = targetSceneNames.map((name) =>
      allScenariosData.find(
        (s) => s.scenarioName === name || s.scenarioId === name
      )
    ).filter(Boolean) as typeof allScenariosData;

    let previousSnapshotTime = currentScenario?.gameTime || currentGameTime;
    for (const td of targetScenariosData) {
      const pst = td.snapshot.previousGameTime;
      if (pst && this.isTimeBeforeOrEqual(pst, previousSnapshotTime)) {
        previousSnapshotTime = pst;
      }
    }

    // Aggregate player action logs from ALL members of the sceneRoom (filtered by time window)
    const playerActionWindow = this.getAggregatedPlayerActionWindow(
      state,
      sceneRoom.memberPlayerIds,
      currentGameTime,
      previousSnapshotTime
    );

    // Step 4: Phase 1 — NPC Timeline (run ONCE)
    console.log(`   📋 Phase 1: Generating timeline for ${phase1Npcs.length} NPCs...`);

    const phase1Context = {
      currentGameDay: sceneRoom.gameDay,
      currentTimeOfDay: sceneRoom.timeOfDay,
      previousSnapshotTime,
      currentGameTime,
      truthTimelineJson: JSON.stringify(state.truthTimeline, null, 2),
      knowledgeMatrixJson: JSON.stringify(state.knowledgeMatrix, null, 2),
      previousGlobalTrigger: state.globalTrigger,
      previousGlobalTriggerJson: state.globalTrigger
        ? JSON.stringify(state.globalTrigger, null, 2)
        : null,
      playerCurrentSceneJson: JSON.stringify(
        currentScenario
          ? { id: currentScenario.id, name: currentScenario.name, location: currentScenario.location }
          : null,
        null,
        2
      ),
      allScenariosJson: JSON.stringify(allScenariosData, null, 2),
      phase1NpcsJson: JSON.stringify(phase1Npcs, null, 2),
    };

    const phase1Prompt = composeTemplate(
      getNpcActionTimelineTemplate(),
      { dynamicGameState: state as any },
      phase1Context,
      "handlebars"
    );

    const phase1Response = await generateText({
      runtime,
      context: phase1Prompt,
      modelClass: ModelClass.MEDIUM,
    });
    this.logRawActionTimeline("MP Phase 1 timeline", phase1Response);

    type TimelineNpcUpdate = {
      id: string;
      actionLog?: ActionLogEntry[];
      statusDelta?: Partial<CharacterStatus>;
      inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
    };
    type TimelineBucket = {
      time?: string;
      npcActionLogUpdates?: TimelineNpcUpdate[];
    };
    const parsedTimeline = this.parseModelJson<{
      actionTimeline?: TimelineBucket[];
    }>(phase1Response, "MP Phase 1 timeline");

    const cleanedTimeline: TimelineBucket[] = [];
    let mergedNpcUpdates = 0;

    if (parsedTimeline?.actionTimeline) {
      for (const bucket of parsedTimeline.actionTimeline) {
        if (
          !bucket?.time ||
          !this.isTimeBeforeOrEqual(bucket.time, currentGameTime)
        ) {
          continue;
        }

        const cleanedNpcUpdates: TimelineNpcUpdate[] = [];
        for (const update of bucket.npcActionLogUpdates || []) {
          if (!update?.id) continue;

          const npc = this.findNPCById(state.npcCharacters, update.id);
          if (!npc) {
            console.warn(`   ⚠️ NPC "${update.id}" not found, skipping timeline update`);
            continue;
          }
          const npcLatestAction = this.getLatestActionLogAtOrBefore(
            npc.actionLog,
            currentGameTime
          );
          const validActionLog = this.sanitizeGeneratedActionLogEntries({
            entries: update.actionLog || [],
            bucketTime: bucket.time,
            currentGameTime,
            previousSnapshotTime,
            npcLatestActionTime: npcLatestAction?.time,
          });

          if (validActionLog.length === 0) continue;

          this.mergeCharacterDeltaToNPC(npc, {
            actionLog: validActionLog,
            status: update.statusDelta,
            inventory: update.inventoryDelta,
          });

          cleanedNpcUpdates.push({
            id: update.id,
            actionLog: validActionLog,
            statusDelta: update.statusDelta,
            inventoryDelta: update.inventoryDelta,
          });
          mergedNpcUpdates += 1;
        }

        if (cleanedNpcUpdates.length > 0) {
          cleanedTimeline.push({
            time: bucket.time,
            npcActionLogUpdates: cleanedNpcUpdates,
          });
        }
      }
    }

    console.log(`   ✓ Phase 1 merged updates for ${mergedNpcUpdates} NPC entries`);

    // Step 5: Phase 2 (ALL target snapshots in one LLM call)
    // Step 6: Phase 3 (background simplified) — parallel with Phase 2
    const currentSceneId = currentScenario?.id || null;
    const currentSceneName = currentScenario?.name || null;
    const targetSceneNamesLower = new Set(targetSceneNames.map((n) => n.toLowerCase()));

    const scenesToUpdateInBackground = allScenariosData.filter((scene) => {
      if (targetSceneNamesLower.has(scene.scenarioName.toLowerCase())) return false;
      if (currentSceneId && scene.scenarioId === currentSceneId) return false;
      if (currentSceneName && scene.scenarioName === currentSceneName) return false;
      return true;
    });

    // Phase 2: single LLM call for ALL targets
    console.log(`   📋 Phase 2: Generating ${targetScenariosData.length} target snapshot(s) in one call...`);

    const phase2Context = {
      currentGameDay: sceneRoom.gameDay,
      currentTimeOfDay: sceneRoom.timeOfDay,
      previousSnapshotTime,
      currentGameTime,
      targetScenesJson: JSON.stringify(
        targetScenariosData.map((td) => ({
          scenarioId: td.scenarioId,
          scenarioName: td.scenarioName,
          location: td.snapshot.location,
          connections: td.connections,
        })),
        null,
        2
      ),
      targetBaselineSnapshotsJson: JSON.stringify(
        targetScenariosData.map((td) => ({
          scenarioId: td.scenarioId,
          snapshot: td.snapshot,
        })),
        null,
        2
      ),
      actionTimelineJson: JSON.stringify({ actionTimeline: cleanedTimeline }, null, 2),
      playerActionWindowJson: JSON.stringify(playerActionWindow, null, 2),
      truthTimelineJson: JSON.stringify(state.truthTimeline, null, 2),
      knowledgeMatrixJson: JSON.stringify(state.knowledgeMatrix, null, 2),
      endStateJson: state.endState ? JSON.stringify(state.endState, null, 2) : "null",
      previousGlobalTrigger: state.globalTrigger,
      previousGlobalTriggerJson: state.globalTrigger
        ? JSON.stringify(state.globalTrigger, null, 2)
        : null,
    };

    const phase2Prompt = composeTemplate(
      getTargetSnapshotFromTimelineTemplate(),
      { dynamicGameState: state as any },
      phase2Context,
      "handlebars"
    );

    // Phase 3: runs in parallel with Phase 2
    const phase3Promise = this.generateBackgroundSnapshotsPhase3(
      manager,
      state,
      currentGameTime,
      previousSnapshotTime,
      scenesToUpdateInBackground,
      cleanedTimeline,
      playerActionWindow
    );

    const phase2Response = await generateText({
      runtime,
      context: phase2Prompt,
      modelClass: ModelClass.MEDIUM,
    });
    this.logRawActionTimeline("MP Phase 2 target snapshots", phase2Response);

    const parsedPhase2 = this.parseModelJson<{
      targetSnapshots?: Array<{
        scenarioId: string;
        snapshot: DynamicScenarioSnapshot;
        connections?: Array<{
          scenarioName: string;
          relationshipType: string;
          description?: string;
          blocked?: boolean;
          blockReason?: string | null;
        }>;
      }>;
      globalTrigger?: unknown;
    }>(phase2Response, "MP Phase 2 target snapshots");

    if (parsedPhase2?.targetSnapshots) {
      // Build a lookup from scenarioId → targetScenarioData for fallback values
      const targetDataMap = new Map(
        targetScenariosData.map((td) => [td.scenarioId, td])
      );

      for (const item of parsedPhase2.targetSnapshots) {
        if (!item?.snapshot) continue;

        const baseline = targetDataMap.get(item.scenarioId);
        const snapshot: DynamicScenarioSnapshot = {
          ...item.snapshot,
          id: item.snapshot.id || baseline?.snapshot.id || item.scenarioId,
          name: item.snapshot.name || baseline?.scenarioName || "",
          location: item.snapshot.location || baseline?.snapshot.location || "",
          description: item.snapshot.description || baseline?.snapshot.description || "",
          gameTime: currentGameTime,
          snapshotType: "complete",
          clues: Array.isArray(item.snapshot.clues)
            ? item.snapshot.clues
            : (baseline?.snapshot.clues as DynamicScenarioSnapshot["clues"]) ?? [],
          conditions: Array.isArray(item.snapshot.conditions)
            ? item.snapshot.conditions
            : (baseline?.snapshot.conditions as DynamicScenarioSnapshot["conditions"]) ?? [],
          characters: Array.isArray(item.snapshot.characters)
            ? (item.snapshot.characters as DynamicScenarioSnapshot["characters"])
            : this.buildLightweightCharactersForScene(
                item.snapshot.location || baseline?.snapshot.location || "",
                currentGameTime,
                state.npcCharacters
              ),
        };

        manager.addOrUpdateScenarioSnapshot(item.scenarioId, snapshot);
        console.log(`   ✓ Phase 2 snapshot stored for "${snapshot.name}"`);

        if (item.connections && item.connections.length > 0) {
          this.applyConnectionsUpdateNative(
            state.scenarioOutlines,
            snapshot.name || baseline?.scenarioName || "",
            item.connections
          );
        }
      }

      if (parsedPhase2.globalTrigger) {
        manager.setGlobalTrigger(parsedPhase2.globalTrigger);
        console.log(`   ✓ Saved global trigger condition from Phase 2`);
      }
    } else {
      console.error(`   ❌ Phase 2 returned no targetSnapshots`);
    }

    try {
      await phase3Promise;
    } catch (error) {
      console.error(`   ❌ Phase 3 background simplified snapshot update failed:`, error);
    }

    console.log(
      `✅ [MP Director] handleMultiplayerSceneChanges complete — ` +
        `${targetSceneNames.length} target(s), ${mergedNpcUpdates} NPC timeline updates`
    );

    return { targetSceneNames, anyChanges: true };
  }

  // ---------------------------------------------------------------------------
  // handleUnifiedSceneChanges — cross-room unified scene snapshot generation
  // ---------------------------------------------------------------------------

  /**
   * Scan ALL active (non-frozen) scene rooms for movement intentions and
   * generate ALL target snapshots in one pass.  Called once after every room
   * in the processing queue has finished its graph core execution.
   *
   * Returns the set of target scene names and the set of sceneRoomIds that
   * contained movements (for WS notification purposes).
   */
  async handleUnifiedSceneChanges(
    manager: MultiplayerDynamicGameStateManager
  ): Promise<{
    targetSceneNames: string[];
    roomsWithMovements: string[];
    anyChanges: boolean;
  }> {
    const state = manager.getState();
    const activeRooms = manager.getActiveSceneRooms();

    // Step 1: Collect unique target scenes from ALL active rooms
    const uniqueTargets = new Map<string, { targetSceneName: string; reason: string }>();
    const roomsWithMovements: string[] = [];

    for (const room of activeRooms) {
      const contextualData = room.temporaryInfo.contextualData ?? {};
      const playerActionAnalyses =
        (contextualData.playerActionAnalyses as Record<string, PlayerActionAnalysis>) ?? {};

      let roomHasMovement = false;
      for (const pa of Object.values(playerActionAnalyses)) {
        const scr = pa?.sceneChangeRequest;
        if (scr?.shouldChange && scr.targetSceneName) {
          const key = scr.targetSceneName.toLowerCase();
          if (!uniqueTargets.has(key)) {
            uniqueTargets.set(key, {
              targetSceneName: scr.targetSceneName,
              reason: scr.reason ?? "",
            });
          }
          roomHasMovement = true;
        }
      }

      if (roomHasMovement) {
        roomsWithMovements.push(room.sceneRoomId);
      }
    }

    if (uniqueTargets.size === 0) {
      return { targetSceneNames: [], roomsWithMovements: [], anyChanges: false };
    }

    const targetSceneNames = [...uniqueTargets.values()].map((t) => t.targetSceneName);
    console.log(
      `\n🎬 [MP Director] handleUnifiedSceneChanges — ` +
        `${uniqueTargets.size} target(s) from ${roomsWithMovements.length} room(s): ` +
        `${targetSceneNames.join(", ")}`
    );

    // Step 2: Save previousScenario for each room that has players moving away
    for (const srId of roomsWithMovements) {
      const room = manager.getSceneRoom(srId);
      if (room?.currentScenario) {
        manager.updateSceneRoom(srId, {
          temporaryInfo: {
            ...room.temporaryInfo,
            previousScenario: { ...room.currentScenario },
          },
        });
      }
    }

    // Step 3: Build data context — unified across all rooms
    const runtime = createRuntime();
    const allScenariosData = await this.buildAllScenariosDataFromState(state);

    // Determine currentGameTime: use MAX game time across all active rooms
    let maxGameDay = 1;
    let maxTimeOfDay = "00:00";
    for (const room of activeRooms) {
      const roomMin = room.gameDay * 1440 + this.parseTimeToMinutes(room.timeOfDay);
      const maxMin = maxGameDay * 1440 + this.parseTimeToMinutes(maxTimeOfDay);
      if (roomMin > maxMin) {
        maxGameDay = room.gameDay;
        maxTimeOfDay = room.timeOfDay;
      }
    }
    const currentGameTime = `Day ${maxGameDay}, ${maxTimeOfDay}`;

    // Build playerCurrentScenes: array of current scenes from all rooms
    const playerCurrentScenesJson = JSON.stringify(
      activeRooms
        .filter((r) => r.currentScenario)
        .map((r) => ({
          sceneRoomId: r.sceneRoomId,
          id: r.currentScenario!.id,
          name: r.currentScenario!.name,
          location: r.currentScenario!.location,
          playerIds: r.memberPlayerIds,
        })),
      null,
      2
    );

    // Phase 1 NPCs
    const phase1Npcs = state.npcCharacters.map((npc) => ({
      ...npc,
      actionLog: npc.actionLog || [],
    }));

    // Determine previousSnapshotTime: earliest among all targets' baseline times
    const targetScenariosData = targetSceneNames
      .map((name) =>
        allScenariosData.find(
          (s) => s.scenarioName === name || s.scenarioId === name
        )
      )
      .filter(Boolean) as typeof allScenariosData;

    let previousSnapshotTime = currentGameTime;
    // Also consider all rooms' current scenario gameTime as baseline
    for (const room of activeRooms) {
      const roomScenarioTime = room.currentScenario?.gameTime;
      if (roomScenarioTime && this.isTimeBeforeOrEqual(roomScenarioTime, previousSnapshotTime)) {
        previousSnapshotTime = roomScenarioTime;
      }
    }
    for (const td of targetScenariosData) {
      const pst = td.snapshot.previousGameTime;
      if (pst && this.isTimeBeforeOrEqual(pst, previousSnapshotTime)) {
        previousSnapshotTime = pst;
      }
    }

    // Aggregate playerActionWindow from ALL rooms' members (filtered by time window)
    const allPlayerIds = activeRooms.flatMap((r) => r.memberPlayerIds);
    const playerActionWindow = this.getAggregatedPlayerActionWindow(
      state,
      [...new Set(allPlayerIds)],
      currentGameTime,
      previousSnapshotTime
    );

    // Step 4: Phase 1 — NPC Timeline (run ONCE with unified context)
    console.log(`   📋 Phase 1: Generating timeline for ${phase1Npcs.length} NPCs...`);

    const phase1Context = {
      currentGameDay: maxGameDay,
      currentTimeOfDay: maxTimeOfDay,
      previousSnapshotTime,
      currentGameTime,
      truthTimelineJson: JSON.stringify(state.truthTimeline, null, 2),
      knowledgeMatrixJson: JSON.stringify(state.knowledgeMatrix, null, 2),
      previousGlobalTrigger: state.globalTrigger,
      previousGlobalTriggerJson: state.globalTrigger
        ? JSON.stringify(state.globalTrigger, null, 2)
        : null,
      // Unified: pass array of all rooms' current scenes instead of a single scene
      playerCurrentSceneJson: playerCurrentScenesJson,
      allScenariosJson: JSON.stringify(allScenariosData, null, 2),
      phase1NpcsJson: JSON.stringify(phase1Npcs, null, 2),
    };

    const phase1Prompt = composeTemplate(
      getNpcActionTimelineTemplate(),
      { dynamicGameState: state as any },
      phase1Context,
      "handlebars"
    );

    const phase1Response = await generateText({
      runtime,
      context: phase1Prompt,
      modelClass: ModelClass.MEDIUM,
    });
    this.logRawActionTimeline("MP Unified Phase 1 timeline", phase1Response);

    type TimelineNpcUpdate = {
      id: string;
      actionLog?: ActionLogEntry[];
      statusDelta?: Partial<CharacterStatus>;
      inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
    };
    type TimelineBucket = {
      time?: string;
      npcActionLogUpdates?: TimelineNpcUpdate[];
    };
    const parsedTimeline = this.parseModelJson<{
      actionTimeline?: TimelineBucket[];
    }>(phase1Response, "MP Unified Phase 1 timeline");

    const cleanedTimeline: TimelineBucket[] = [];
    let mergedNpcUpdates = 0;

    if (parsedTimeline?.actionTimeline) {
      for (const bucket of parsedTimeline.actionTimeline) {
        if (
          !bucket?.time ||
          !this.isTimeBeforeOrEqual(bucket.time, currentGameTime)
        ) {
          continue;
        }

        const cleanedNpcUpdates: TimelineNpcUpdate[] = [];
        for (const update of bucket.npcActionLogUpdates || []) {
          if (!update?.id) continue;

          const npc = this.findNPCById(state.npcCharacters, update.id);
          if (!npc) {
            console.warn(`   ⚠️ NPC "${update.id}" not found, skipping timeline update`);
            continue;
          }
          const npcLatestAction = this.getLatestActionLogAtOrBefore(
            npc.actionLog,
            currentGameTime
          );
          const validActionLog = this.sanitizeGeneratedActionLogEntries({
            entries: update.actionLog || [],
            bucketTime: bucket.time,
            currentGameTime,
            previousSnapshotTime,
            npcLatestActionTime: npcLatestAction?.time,
          });

          if (validActionLog.length === 0) continue;

          this.mergeCharacterDeltaToNPC(npc, {
            actionLog: validActionLog,
            status: update.statusDelta,
            inventory: update.inventoryDelta,
          });

          cleanedNpcUpdates.push({
            id: update.id,
            actionLog: validActionLog,
            statusDelta: update.statusDelta,
            inventoryDelta: update.inventoryDelta,
          });
          mergedNpcUpdates += 1;
        }

        if (cleanedNpcUpdates.length > 0) {
          cleanedTimeline.push({
            time: bucket.time,
            npcActionLogUpdates: cleanedNpcUpdates,
          });
        }
      }
    }

    console.log(`   ✓ Phase 1 merged updates for ${mergedNpcUpdates} NPC entries`);

    // Step 4b: Refresh currentScenario.characters for ALL active rooms.
    // NPC timeline (Phase 1) may have moved NPCs between scenes. Update each room's
    // character list so downstream consumers (Keeper, frontend, next round) see accurate data.
    if (mergedNpcUpdates > 0) {
      this.refreshSceneRoomCharacters(manager, currentGameTime);
    }

    // Step 5: Phase 2 (ALL target snapshots in one LLM call)
    // Step 6: Phase 3 (background simplified) — parallel with Phase 2
    const currentSceneIds = new Set(
      activeRooms
        .filter((r) => r.currentScenario)
        .map((r) => r.currentScenario!.id)
    );
    const currentSceneNames = new Set(
      activeRooms
        .filter((r) => r.currentScenario)
        .map((r) => r.currentScenario!.name)
    );
    const targetSceneNamesLower = new Set(targetSceneNames.map((n) => n.toLowerCase()));

    const scenesToUpdateInBackground = allScenariosData.filter((scene) => {
      if (targetSceneNamesLower.has(scene.scenarioName.toLowerCase())) return false;
      if (currentSceneIds.has(scene.scenarioId)) return false;
      if (currentSceneNames.has(scene.scenarioName)) return false;
      return true;
    });

    // Phase 2: single LLM call for ALL targets
    console.log(`   📋 Phase 2: Generating ${targetScenariosData.length} target snapshot(s) in one call...`);

    const phase2Context = {
      currentGameDay: maxGameDay,
      currentTimeOfDay: maxTimeOfDay,
      previousSnapshotTime,
      currentGameTime,
      targetScenesJson: JSON.stringify(
        targetScenariosData.map((td) => ({
          scenarioId: td.scenarioId,
          scenarioName: td.scenarioName,
          location: td.snapshot.location,
          connections: td.connections,
        })),
        null,
        2
      ),
      targetBaselineSnapshotsJson: JSON.stringify(
        targetScenariosData.map((td) => ({
          scenarioId: td.scenarioId,
          snapshot: td.snapshot,
        })),
        null,
        2
      ),
      actionTimelineJson: JSON.stringify({ actionTimeline: cleanedTimeline }, null, 2),
      playerActionWindowJson: JSON.stringify(playerActionWindow, null, 2),
      truthTimelineJson: JSON.stringify(state.truthTimeline, null, 2),
      knowledgeMatrixJson: JSON.stringify(state.knowledgeMatrix, null, 2),
      endStateJson: state.endState ? JSON.stringify(state.endState, null, 2) : "null",
      previousGlobalTrigger: state.globalTrigger,
      previousGlobalTriggerJson: state.globalTrigger
        ? JSON.stringify(state.globalTrigger, null, 2)
        : null,
    };

    const phase2Prompt = composeTemplate(
      getTargetSnapshotFromTimelineTemplate(),
      { dynamicGameState: state as any },
      phase2Context,
      "handlebars"
    );

    // Phase 3: runs in parallel with Phase 2
    const phase3Promise = this.generateBackgroundSnapshotsPhase3(
      manager,
      state,
      currentGameTime,
      previousSnapshotTime,
      scenesToUpdateInBackground,
      cleanedTimeline,
      playerActionWindow
    );

    const phase2Response = await generateText({
      runtime,
      context: phase2Prompt,
      modelClass: ModelClass.MEDIUM,
    });
    this.logRawActionTimeline("MP Unified Phase 2 target snapshots", phase2Response);

    const parsedPhase2 = this.parseModelJson<{
      targetSnapshots?: Array<{
        scenarioId: string;
        snapshot: DynamicScenarioSnapshot;
        connections?: Array<{
          scenarioName: string;
          relationshipType: string;
          description?: string;
          blocked?: boolean;
          blockReason?: string | null;
        }>;
      }>;
      globalTrigger?: unknown;
    }>(phase2Response, "MP Unified Phase 2 target snapshots");

    if (parsedPhase2?.targetSnapshots) {
      const targetDataMap = new Map(
        targetScenariosData.map((td) => [td.scenarioId, td])
      );

      for (const item of parsedPhase2.targetSnapshots) {
        if (!item?.snapshot) continue;

        const baseline = targetDataMap.get(item.scenarioId);
        const snapshot: DynamicScenarioSnapshot = {
          ...item.snapshot,
          id: item.snapshot.id || baseline?.snapshot.id || item.scenarioId,
          name: item.snapshot.name || baseline?.scenarioName || "",
          location: item.snapshot.location || baseline?.snapshot.location || "",
          description: item.snapshot.description || baseline?.snapshot.description || "",
          gameTime: currentGameTime,
          snapshotType: "complete",
          clues: Array.isArray(item.snapshot.clues)
            ? item.snapshot.clues
            : (baseline?.snapshot.clues as DynamicScenarioSnapshot["clues"]) ?? [],
          conditions: Array.isArray(item.snapshot.conditions)
            ? item.snapshot.conditions
            : (baseline?.snapshot.conditions as DynamicScenarioSnapshot["conditions"]) ?? [],
          characters: Array.isArray(item.snapshot.characters)
            ? (item.snapshot.characters as DynamicScenarioSnapshot["characters"])
            : this.buildLightweightCharactersForScene(
                item.snapshot.location || baseline?.snapshot.location || "",
                currentGameTime,
                state.npcCharacters
              ),
        };

        manager.addOrUpdateScenarioSnapshot(item.scenarioId, snapshot);
        console.log(`   ✓ Phase 2 snapshot stored for "${snapshot.name}"`);

        if (item.connections && item.connections.length > 0) {
          this.applyConnectionsUpdateNative(
            state.scenarioOutlines,
            snapshot.name || baseline?.scenarioName || "",
            item.connections
          );
        }
      }

      if (parsedPhase2.globalTrigger) {
        manager.setGlobalTrigger(parsedPhase2.globalTrigger);
        console.log(`   ✓ Saved global trigger condition from Phase 2`);
      }
    } else {
      console.error(`   ❌ Phase 2 returned no targetSnapshots`);
    }

    try {
      await phase3Promise;
    } catch (error) {
      console.error(`   ❌ Phase 3 background simplified snapshot update failed:`, error);
    }

    console.log(
      `✅ [MP Director] handleUnifiedSceneChanges complete — ` +
        `${targetSceneNames.length} target(s) from ${roomsWithMovements.length} room(s), ` +
        `${mergedNpcUpdates} NPC timeline updates`
    );

    return { targetSceneNames, roomsWithMovements, anyChanges: true };
  }

  // ---------------------------------------------------------------------------
  // Private helpers for handleMultiplayerSceneChanges / handleUnifiedSceneChanges
  // ---------------------------------------------------------------------------

  /**
   * Build allScenariosData array from multiplayer state (no adapter needed).
   * Same logic as lines 1339-1399 of updateScenariosForSceneSwitch but reads
   * from MultiplayerDynamicGameState directly.
   */
  private async buildAllScenariosDataFromState(
    state: ReturnType<MultiplayerDynamicGameStateManager["getState"]>
  ): Promise<
    Array<{
      scenarioId: string;
      scenarioName: string;
      sourcePlaceId: string | null;
      sourcePlaceName: string | null;
      connections: unknown[];
      snapshot: {
        id: string;
        name: string;
        location: string;
        description: string;
        clues: unknown[];
        conditions: unknown[];
        characters: unknown[];
        previousGameTime: string | null;
      };
    }>
  > {
    const result: Array<{
      scenarioId: string;
      scenarioName: string;
      sourcePlaceId: string | null;
      sourcePlaceName: string | null;
      connections: unknown[];
      snapshot: {
        id: string;
        name: string;
        location: string;
        description: string;
        clues: unknown[];
        conditions: unknown[];
        characters: unknown[];
        previousGameTime: string | null;
      };
    }> = [];

    for (const outline of state.scenarioOutlines) {
      const latestSnapshot = this.getLatestSnapshotFromMap(
        outline.id,
        state.updatedDynamicScenarioSnapshots
      );

      const baselineSnapshot = latestSnapshot
        ? {
            id: latestSnapshot.id,
            name: latestSnapshot.name,
            location: latestSnapshot.location,
            description: latestSnapshot.description,
            clues: latestSnapshot.clues || [],
            conditions: latestSnapshot.conditions || [],
            characters: latestSnapshot.characters || [],
            previousGameTime: latestSnapshot.gameTime || null,
          }
        : {
            id: `${outline.id}-baseline`,
            name: outline.name,
            location: outline.name,
            description: outline.description || "",
            clues: Array.isArray((outline as any).clues) ? (outline as any).clues : [],
            conditions: [],
            characters: [],
            previousGameTime: null,
          };

      result.push({
        scenarioId: outline.id,
        scenarioName: outline.name,
        sourcePlaceId: outline.sourcePlaceId || null,
        sourcePlaceName: outline.sourcePlaceName || null,
        connections: outline.connections || [],
        snapshot: baselineSnapshot,
      });
    }

    return result;
  }

  /**
   * Get latest snapshot from the in-memory Map, falling back to scenarioLoader.
   */
  private getLatestSnapshotFromMap(
    scenarioId: string,
    snapshotMap: Map<string, DynamicScenarioSnapshot[]>
  ): DynamicScenarioSnapshot | null {
    const snapshots = snapshotMap.get(scenarioId);
    if (snapshots && snapshots.length > 0) {
      return snapshots[snapshots.length - 1];
    }
    return null;
  }

  /**
   * Aggregate player action logs from all players in a sceneRoom.
   * Returns per-player arrays so downstream consumers know which entries
   * belong to which player (mirrors how NPC actionLogs are keyed by NPC id).
   * When previousSnapshotTime is provided, filters to (previousSnapshotTime, currentGameTime].
   */
  private getAggregatedPlayerActionWindow(
    state: ReturnType<MultiplayerDynamicGameStateManager["getState"]>,
    memberPlayerIds: string[],
    currentGameTime: string,
    previousSnapshotTime?: string
  ): PerPlayerActionWindow[] {
    const result: PerPlayerActionWindow[] = [];
    for (const pid of memberPlayerIds) {
      const player = state.players[pid];
      if (!player?.profile?.actionLog || player.profile.actionLog.length === 0) continue;

      const filtered = player.profile.actionLog.filter((entry) => {
        if (!entry.time || !entry.location || !entry.summary) return false;
        if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) return false;
        if (!previousSnapshotTime) return true;
        return this.isTimeAfter(entry.time, previousSnapshotTime);
      });

      if (filtered.length === 0) continue;

      filtered.sort((a, b) => {
        const timeA = this.parseGameTimeFromSnapshot(a.time);
        const timeB = this.parseGameTimeFromSnapshot(b.time);
        if (!timeA || !timeB) return 0;
        if (timeA.gameDay !== timeB.gameDay) return timeA.gameDay - timeB.gameDay;
        const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
        const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
        return hA * 60 + mA - (hB * 60 + mB);
      });

      result.push({
        playerId: pid,
        characterName: player.characterName,
        actionLog: filtered,
      });
    }
    return result;
  }

  /**
   * Phase 3: Generate background simplified snapshots for all scenes
   * that are NOT the current scene and NOT any of the target scenes.
   * Stores each via manager.addOrUpdateScenarioSnapshot.
   */
  private async generateBackgroundSnapshotsPhase3(
    manager: MultiplayerDynamicGameStateManager,
    state: ReturnType<MultiplayerDynamicGameStateManager["getState"]>,
    currentGameTime: string,
    previousSnapshotTime: string,
    scenesToUpdate: Array<{
      scenarioId: string;
      scenarioName: string;
      sourcePlaceId: string | null;
      sourcePlaceName: string | null;
      connections: unknown[];
      snapshot: {
        id: string;
        name: string;
        location: string;
        description: string;
        clues: unknown[];
        conditions: unknown[];
        previousGameTime: string | null;
      };
    }>,
    cleanedTimeline: Array<{
      time?: string;
      npcActionLogUpdates?: Array<{
        id: string;
        actionLog?: ActionLogEntry[];
        statusDelta?: Partial<CharacterStatus>;
        inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
      }>;
    }>,
    playerActionWindow: PerPlayerActionWindow[],
    templateOverride?: string
  ): Promise<void> {
    if (scenesToUpdate.length === 0) return;

    console.log(`   📋 Phase 3: Generating simplified background snapshots for ${scenesToUpdate.length} scenes...`);

    const runtime = createRuntime();
    // Parse day/time from the already-corrected currentGameTime (max across rooms)
    const dayMatch = currentGameTime.match(/Day\s+(\d+)/);
    const timeMatch = currentGameTime.match(/,\s*(\d{1,2}:\d{2})/);
    const templateContext = {
      currentGameDay: dayMatch ? parseInt(dayMatch[1], 10) : state.gameDay,
      currentTimeOfDay: timeMatch ? timeMatch[1] : state.timeOfDay,
      previousSnapshotTime,
      currentGameTime,
      scenesToUpdateJson: JSON.stringify(
        scenesToUpdate.map((scene) => ({
          scenarioId: scene.scenarioId,
          scenarioName: scene.scenarioName,
          location: scene.snapshot.location,
          connections: scene.connections,
        })),
        null,
        2
      ),
      baselineSnapshotsJson: JSON.stringify(
        scenesToUpdate.map((scene) => ({
          scenarioId: scene.scenarioId,
          snapshot: scene.snapshot,
        })),
        null,
        2
      ),
      actionTimelineJson: JSON.stringify({ actionTimeline: cleanedTimeline }, null, 2),
      playerActionWindowJson: JSON.stringify(playerActionWindow, null, 2),
      truthTimelineJson: JSON.stringify(state.truthTimeline, null, 2),
      knowledgeMatrixJson: JSON.stringify(state.knowledgeMatrix, null, 2),
    };

    const prompt = composeTemplate(
      templateOverride ?? getSceneSwitchBackgroundSimplifiedSnapshotsTemplate(),
      { dynamicGameState: state as any },
      templateContext,
      "handlebars"
    );

    const response = await generateText({
      runtime,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = this.parseModelJson<{
      updatedSimplifiedSnapshots?: Array<{
        scenarioId: string;
        snapshot: Partial<DynamicScenarioSnapshot>;
        connections?: Array<{
          scenarioName: string;
          relationshipType: string;
          description?: string;
          blocked?: boolean;
          blockReason?: string | null;
        }>;
      }>;
    }>(response, "MP Phase 3 simplified snapshots");

    if (!parsed?.updatedSimplifiedSnapshots?.length) {
      console.log(`   ℹ️ Phase 3 returned no simplified snapshot updates`);
      return;
    }

    let updatedCount = 0;
    for (const item of parsed.updatedSimplifiedSnapshots) {
      const baseline = scenesToUpdate.find(
        (scene) => scene.scenarioId === item.scenarioId
      );
      if (!baseline) continue;

      const latestSnapshot = this.getLatestSnapshotFromMap(
        item.scenarioId,
        state.updatedDynamicScenarioSnapshots
      );

      // Use baseline if no latest snapshot in map; fall back to scenarioLoader
      let baseSnapshot = latestSnapshot;
      if (!baseSnapshot) {
        const scenarioProfile = await this.scenarioLoader.getScenarioById(item.scenarioId);
        baseSnapshot = scenarioProfile?.snapshot || null;
      }
      if (!baseSnapshot) continue;

      const updatedSnapshot: DynamicScenarioSnapshot = {
        ...baseSnapshot,
        description: item.snapshot.description || baseSnapshot.description,
        clues: Array.isArray(item.snapshot.clues)
          ? item.snapshot.clues
          : baseSnapshot.clues,
        conditions: Array.isArray(item.snapshot.conditions)
          ? item.snapshot.conditions
          : baseSnapshot.conditions,
        gameTime: currentGameTime,
        snapshotType: "simplified",
      };

      manager.addOrUpdateScenarioSnapshot(item.scenarioId, updatedSnapshot);
      updatedCount += 1;

      if (item.connections && item.connections.length > 0) {
        this.applyConnectionsUpdateNative(
          state.scenarioOutlines,
          baseline.scenarioName,
          item.connections
        );
      }
    }

    console.log(`   ✓ Phase 3 background simplified snapshot updates: ${updatedCount}`);
  }

  /**
   * Apply connection updates directly to scenarioOutlines array (in-memory only).
   * Checkpoint serialization preserves connections; no need to persist to Scenario table.
   */
  private applyConnectionsUpdateNative(
    scenarioOutlines: ReturnType<MultiplayerDynamicGameStateManager["getState"]>["scenarioOutlines"],
    scenarioName: string,
    modifiedConnections: Array<{
      scenarioName: string;
      relationshipType: string;
      description?: string;
      blocked?: boolean;
      blockReason?: string | null;
    }>
  ): void {
    if (!modifiedConnections || modifiedConnections.length === 0) return;

    const targetOutline = scenarioOutlines.find(
      (outline) => outline.name === scenarioName
    );
    if (!targetOutline) {
      console.warn(`   ⚠️ Outline not found for connection update: ${scenarioName}`);
      return;
    }

    const convertedConnections = modifiedConnections.map((conn) => {
      const linkedScenario = scenarioOutlines.find(
        (outline) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );
      return {
        scenarioName: linkedScenario?.name || conn.scenarioName,
        scenarioId: linkedScenario?.id || conn.scenarioName,
        relationshipType: conn.relationshipType as ScenarioConnectionType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason ?? undefined,
      };
    });

    targetOutline.connections = convertedConnections;
  }

  /**
   * Parse game time from snapshot gameTime string or actionLog time
   * Format: "Day N, HH:MM" or "initial" or other formats
   */
  private parseGameTimeFromSnapshot(
    gameTime?: string
  ): { gameDay: number; timeOfDay: string } | null {
    if (!gameTime) return null;

    // Handle "initial" or other non-standard formats
    if (gameTime.toLowerCase() === "initial" || !gameTime.includes("Day")) {
      return null; // Cannot parse, treat as before any valid time
    }

    const match = gameTime.match(/Day\s*(\d+),\s*(\d{2}:\d{2})/i);
    if (match) {
      return {
        gameDay: Number.parseInt(match[1], 10),
        timeOfDay: match[2],
      };
    }

    return null;
  }

  /**
   * Get all scenarios with their latest snapshots (excluding player's current scene)
   * Gets snapshots from dynamicState.updatedDynamicScenarioSnapshots or scenarioLoader (initial snapshots)
   */
  private async getAllScenariosLatestSnapshots(
    currentScenarioId: string | null,
    currentGameDay: number,
    currentTimeOfDay: string,
    dynamicState: DynamicGameState
  ): Promise<
    Array<{
      scenarioId: string;
      scenarioName: string;
      snapshot: DynamicScenarioSnapshot;
    }>
  > {
    const allScenarios = await this.scenarioLoader.getAllScenarios();

    const scenariosWithLatestSnapshots: Array<{
      scenarioId: string;
      scenarioName: string;
      snapshot: DynamicScenarioSnapshot;
    }> = [];

    for (const scenario of allScenarios) {
      // Skip player's current scenario
      if (currentScenarioId && scenario.id === currentScenarioId) {
        continue;
      }

      // Try to get latest updated snapshot from dynamicState first
      const snapshots = dynamicState.updatedDynamicScenarioSnapshots.get(
        scenario.id
      );
      let snapshot: DynamicScenarioSnapshot | null = null;

      if (snapshots && snapshots.length > 0) {
        // Get the latest snapshot (last in array)
        snapshot = snapshots[snapshots.length - 1];
      }

      // If no updated snapshot, get initial snapshot from scenarioLoader
      if (!snapshot) {
        const scenarioProfile = await this.scenarioLoader.getScenarioById(
          scenario.id
        );
        if (scenarioProfile && scenarioProfile.snapshot) {
          snapshot = scenarioProfile.snapshot;
        }
      }

      if (snapshot) {
        scenariosWithLatestSnapshots.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          snapshot: snapshot,
        });
      }
    }

    return scenariosWithLatestSnapshots;
  }

  /**
   * Get current location from actionLog (latest entry with location)
   */
  private getCurrentLocationFromActionLog(
    actionLog?: ActionLogEntry[]
  ): string | null {
    if (!actionLog || actionLog.length === 0) {
      return null;
    }

    // Find the latest entry with a location (iterate backwards)
    for (let i = actionLog.length - 1; i >= 0; i--) {
      if (actionLog[i].location) {
        return actionLog[i].location;
      }
    }

    return null;
  }

  /**
   * Convert full character data to lightweight ScenarioCharacter format
   * This prevents data duplication in snapshots (full data is in gameState.npcCharacters)
   */
  private convertToLightweightScenarioCharacter(
    char: ScenarioCharacter & {
      actionLog?: ActionLogEntry[];
      status?: any;
      inventory?: any;
      relationships?: any;
    }
  ): ScenarioCharacter {
    // Extract latest location from actionLog if available
    let location = char.location;
    if (char.actionLog && char.actionLog.length > 0) {
      const latestLog = char.actionLog[char.actionLog.length - 1];
      if (latestLog.location) {
        location = latestLog.location;
      }
    }

    // Determine status string based on character state
    let statusString = "active"; // Default status

    // If status is already a string, use it
    if (typeof char.status === "string") {
      statusString = char.status;
    }
    // If status is an object with HP/sanity deltas, infer status
    else if (char.status && typeof char.status === "object") {
      const statusObj = char.status as Partial<CharacterStatus>;

      // Check for negative HP changes (injuries)
      if (statusObj.hp !== undefined && statusObj.hp < -5) {
        statusString = "injured";
      } else if (statusObj.hp !== undefined && statusObj.hp < -10) {
        statusString = "critically_injured";
      }
      // Check for negative sanity changes (mental state)
      else if (statusObj.sanity !== undefined && statusObj.sanity < -5) {
        statusString = "shaken";
      } else if (statusObj.sanity !== undefined && statusObj.sanity < -10) {
        statusString = "disturbed";
      }
      // Check for conditions
      else if (
        statusObj.conditions &&
        Array.isArray(statusObj.conditions) &&
        statusObj.conditions.length > 0
      ) {
        statusString = statusObj.conditions[0]; // Use first condition as status
      }
    }

    // Return lightweight ScenarioCharacter (only essential presence info)
    return {
      id: char.id,
      name: char.name,
      role: char.role || "npc",
      status: statusString,
      location: location || "unknown",
      notes: char.notes,
    };
  }

  /**
   * Get NPCs that should be in a specific scenario at the current time point
   * Based on NPC's actionLog location and scenario conditions
   */
  private getNPCsForScenario(
    scenarioLocation: string,
    scenarioId: string,
    npcCharacters: DynamicNPCProfile[],
    previousSnapshotTime: string | undefined,
    currentGameTime: string
  ): Array<{
    id: string;
    name: string;
    occupation?: string;
    age?: number;
    gender?: string;
    appearance?: string;
    personality?: string;
    background?: string;
    goals?: string[];
    secrets?: string[];
    notes?: string;
    status: CharacterStatus;
    inventory: InventoryItem[];
    relationships: NPCRelationship[];
    actionLog: ActionLogEntry[]; // Timeline from previous snapshot to current time
    instantiatedFrom?: string | null; // Knowledge holder ID (ROLE/ORGANIZATION)
    inheritsKnowledge?: string[]; // Truth event IDs this NPC knows
  }> {
    const npcsInScenario: Array<{
      id: string;
      name: string;
      occupation?: string;
      age?: number;
      gender?: string;
      appearance?: string;
      personality?: string;
      background?: string;
      goals?: string[];
      secrets?: string[];
      notes?: string;
      status: CharacterStatus;
      inventory: InventoryItem[];
      relationships: NPCRelationship[];
      actionLog: ActionLogEntry[];
      instantiatedFrom?: string | null;
      inheritsKnowledge?: string[];
    }> = [];

    for (const npc of npcCharacters) {
      const npcProfile = npc;

      // Check if NPC is currently in this scenario location
      // Get current location from actionLog (latest entry with location)
      const currentLocation = this.getCurrentLocationFromActionLog(
        npcProfile.actionLog
      );
      let isInScenario = false;

      if (
        currentLocation &&
        currentLocation.toLowerCase() === scenarioLocation.toLowerCase()
      ) {
        isInScenario = true;
      }

      if (isInScenario) {
        // Extract timeline actionLog from previous snapshot time to current time
        // This creates a timeline of events that happened in this scenario during the time period
        let timelineActionLog: ActionLogEntry[] = [];

        if (npcProfile.actionLog && npcProfile.actionLog.length > 0) {
          // Filter actionLog entries that fall between previous snapshot time and current time
          // This represents what happened in the scenario during this time period
          timelineActionLog = npcProfile.actionLog.filter((log) => {
            // Skip entries with invalid time formats (like "initial")
            const logTime = this.parseGameTimeFromSnapshot(log.time);
            if (!logTime) {
              // If time is "initial" or invalid, only include if no previous snapshot time
              // (meaning this is the first update)
              return !previousSnapshotTime;
            }

            // If no previous snapshot time, include all entries up to current time
            if (!previousSnapshotTime) {
              return this.isTimeBeforeOrEqual(log.time, currentGameTime);
            }

            // Include entries between previous snapshot time and current time
            // (exclusive of previous time, inclusive of current time)
            return (
              this.isTimeAfter(log.time, previousSnapshotTime) &&
              this.isTimeBeforeOrEqual(log.time, currentGameTime)
            );
          });

          // Sort by time to ensure chronological order
          timelineActionLog.sort((a, b) => {
            const timeA = this.parseGameTimeFromSnapshot(a.time);
            const timeB = this.parseGameTimeFromSnapshot(b.time);
            if (!timeA || !timeB) return 0;
            if (timeA.gameDay !== timeB.gameDay)
              return timeA.gameDay - timeB.gameDay;
            const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
            const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
            return hA * 60 + mA - (hB * 60 + mB);
          });
        }

        npcsInScenario.push({
          id: npcProfile.id,
          name: npcProfile.name,
          occupation: npcProfile.occupation,
          age: npcProfile.age,
          gender: npcProfile.gender,
          appearance: npcProfile.appearance,
          personality: npcProfile.personality,
          background: npcProfile.background,
          goals: npcProfile.goals,
          secrets: npcProfile.secrets,
          notes: npcProfile.notes,
          status: npcProfile.status, // Full CharacterStatus object
          inventory: npcProfile.inventory || [], // InventoryItem[]
          relationships: npcProfile.relationships || [], // NPCRelationship[]
          actionLog: timelineActionLog,
          // DynamicWorld specific fields for matching with knowledge matrix
          instantiatedFrom: npcProfile.instantiatedFrom || null, // Knowledge holder ID (ROLE/ORGANIZATION)
          inheritsKnowledge: npcProfile.inheritsKnowledge || [], // Truth event IDs this NPC knows
        });
      }
    }

    return npcsInScenario;
  }

  /**
   * Compare game times (format: "Day N, HH:MM")
   * Returns true if time1 is before or equal to time2
   */
  private isTimeBeforeOrEqual(time1: string, time2: string): boolean {
    const t1 = this.parseGameTimeFromSnapshot(time1);
    const t2 = this.parseGameTimeFromSnapshot(time2);

    if (!t1 || !t2) return false;

    if (t1.gameDay < t2.gameDay) return true;
    if (t1.gameDay > t2.gameDay) return false;

    // Same day, compare time
    const [h1, m1] = t1.timeOfDay.split(":").map(Number);
    const [h2, m2] = t2.timeOfDay.split(":").map(Number);

    return h1 < h2 || (h1 === h2 && m1 <= m2);
  }

  /**
   * Compare game times (format: "Day N, HH:MM")
   * Returns true if time1 is after time2
   */
  private isTimeAfter(time1: string, time2: string): boolean {
    const t1 = this.parseGameTimeFromSnapshot(time1);
    const t2 = this.parseGameTimeFromSnapshot(time2);

    if (!t1 || !t2) return false;

    if (t1.gameDay > t2.gameDay) return true;
    if (t1.gameDay < t2.gameDay) return false;

    // Same day, compare time
    const [h1, m1] = t1.timeOfDay.split(":").map(Number);
    const [h2, m2] = t2.timeOfDay.split(":").map(Number);

    return h1 > h2 || (h1 === h2 && m1 > m2);
  }

  /** Parse "HH:MM" to total minutes (for simple comparisons). */
  private parseTimeToMinutes(timeOfDay: string): number {
    const [h, m] = timeOfDay.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  /**
   * Subtract N minutes from a game time string (format: "Day N, HH:MM").
   * Handles day boundaries (e.g. Day 2, 00:30 - 60 min = Day 1, 23:30).
   * Returns the resulting game time string.
   */
  private subtractMinutesFromGameTime(
    gameTime: string,
    minutes: number
  ): string {
    const t = this.parseGameTimeFromSnapshot(gameTime);
    if (!t) return gameTime;
    const [h, m] = t.timeOfDay.split(":").map(Number);
    let totalMinutes = h * 60 + m - minutes;
    let day = t.gameDay;
    while (totalMinutes < 0) {
      totalMinutes += 24 * 60;
      day -= 1;
    }
    if (day < 1) day = 1;
    const rh = Math.floor(totalMinutes / 60);
    const rm = totalMinutes % 60;
    const hh = String(rh).padStart(2, "0");
    const mm = String(rm).padStart(2, "0");
    return `Day ${day}, ${hh}:${mm}`;
  }

  /**
   * Find NPC by ID with fuzzy matching fallback
   * 1st priority: Exact match (case-sensitive)
   * 2nd priority: Fuzzy match (case-insensitive, normalized)
   */
  private findNPCById(
    npcCharacters: DynamicNPCProfile[],
    targetId: string,
    targetName?: string
  ): DynamicNPCProfile | null {
    // Stage 1: Exact match (case-sensitive)
    const exactMatch = npcCharacters.find((npc) => npc.id === targetId);
    if (exactMatch) {
      return exactMatch;
    }

    // Stage 2: Fuzzy match by ID (case-insensitive, normalized)
    const normalizeId = (id: string) =>
      id
        .toLowerCase()
        .trim()
        .replace(/[\s_-]/g, "");
    const normalizedTargetId = normalizeId(targetId);

    let bestMatch: DynamicNPCProfile | null = null;
    let bestScore = 0;

    for (const npc of npcCharacters) {
      const normalizedNpcId = normalizeId(npc.id);

      // Calculate similarity score
      let score = 0;

      // Check if normalized IDs match
      if (normalizedNpcId === normalizedTargetId) {
        score = 0.9; // High score for normalized match
      } else if (
        normalizedNpcId.includes(normalizedTargetId) ||
        normalizedTargetId.includes(normalizedNpcId)
      ) {
        score = 0.7; // Medium score for substring match
      }

      // Bonus: Check name similarity if provided
      if (targetName && npc.name) {
        const normalizedTargetName = normalizeId(targetName);
        const normalizedNpcName = normalizeId(npc.name);

        if (normalizedNpcName === normalizedTargetName) {
          score += 0.3;
        } else if (
          normalizedNpcName.includes(normalizedTargetName) ||
          normalizedTargetName.includes(normalizedNpcName)
        ) {
          score += 0.2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = npc;
      }
    }

    // Only return fuzzy match if score is above threshold
    if (bestScore >= 0.5) {
      console.log(
        `   ℹ️  Fuzzy matched "${targetId}"${targetName ? ` (${targetName})` : ""} → "${bestMatch?.id}" (${bestMatch?.name}) [score: ${bestScore.toFixed(2)}]`
      );
      return bestMatch;
    }

    return null;
  }

  /**
   * Merge character delta updates from snapshot to actual NPC data
   * Applies status changes, inventory add/remove, and relationship updates
   */
  private mergeCharacterDeltaToNPC(
    npc: DynamicNPCProfile,
    delta: {
      status?: Partial<CharacterStatus>;
      inventory?:
        | { add?: InventoryItem[]; remove?: InventoryItem[] }
        | InventoryItem[];
      relationships?: NPCRelationship[];
      actionLog?: ActionLogEntry[];
    }
  ): void {
    // Apply status delta (only changed attributes)
    if (delta.status) {
      for (const [key, value] of Object.entries(delta.status)) {
        if (typeof value === "number" && key in npc.status) {
          // Apply differential update (e.g., hp: -2 means subtract 2)
          (npc.status as any)[key] += value;

          // Ensure values don't go below 0 (except for conditions array)
          if (key !== "conditions" && (npc.status as any)[key] < 0) {
            (npc.status as any)[key] = 0;
          }

          // Ensure hp/sanity don't exceed max
          if (key === "hp" && npc.status.hp > npc.status.maxHp) {
            npc.status.hp = npc.status.maxHp;
          }
          if (key === "sanity" && npc.status.sanity > npc.status.maxSanity) {
            npc.status.sanity = npc.status.maxSanity;
          }
        }
      }
    }

    // Apply inventory delta (add/remove format)
    if (delta.inventory) {
      npc.inventory = InventoryUtils.normalizeInventory(npc.inventory);

      if (Array.isArray(delta.inventory)) {
        // Replace entire inventory (legacy support)
        npc.inventory = InventoryUtils.normalizeInventory(delta.inventory);
      } else if (
        typeof delta.inventory === "object" &&
        !Array.isArray(delta.inventory)
      ) {
        // Support { add: [...], remove: [...] } format
        if (delta.inventory.add) {
          const itemsToAdd = Array.isArray(delta.inventory.add)
            ? delta.inventory.add
            : [delta.inventory.add];
          npc.inventory = InventoryUtils.addItems(
            npc.inventory,
            InventoryUtils.normalizeInventory(itemsToAdd)
          );
        }

        if (delta.inventory.remove) {
          const itemsToRemove = Array.isArray(delta.inventory.remove)
            ? delta.inventory.remove
            : [delta.inventory.remove];
          npc.inventory = InventoryUtils.removeItems(
            npc.inventory,
            InventoryUtils.normalizeInventory(itemsToRemove)
          );
        }
      }
    }

    // Apply relationship updates (merge new/changed relationships)
    if (delta.relationships && delta.relationships.length > 0) {
      for (const newRel of delta.relationships) {
        const existingIndex = npc.relationships.findIndex(
          (r) => r.targetId === newRel.targetId
        );
        if (existingIndex >= 0) {
          // Update existing relationship
          npc.relationships[existingIndex] = newRel;
        } else {
          // Add new relationship
          npc.relationships.push(newRel);
        }
      }
    }

    // Merge actionLog (append new entries)
    if (delta.actionLog && delta.actionLog.length > 0) {
      if (!npc.actionLog) {
        npc.actionLog = [];
      }
      // Append new actionLog entries (avoid duplicates by checking time+location+summary)
      for (const newEntry of delta.actionLog) {
        const isDuplicate = npc.actionLog.some(
          (existing) =>
            existing.time === newEntry.time &&
            existing.location === newEntry.location &&
            existing.summary === newEntry.summary
        );
        if (!isDuplicate) {
          npc.actionLog.push(newEntry);
        }
      }
      // Sort by time
      npc.actionLog.sort((a, b) => {
        const timeA = this.parseGameTimeFromSnapshot(a.time);
        const timeB = this.parseGameTimeFromSnapshot(b.time);
        if (!timeA || !timeB) return 0;
        if (timeA.gameDay !== timeB.gameDay)
          return timeA.gameDay - timeB.gameDay;
        const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
        const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
        return hA * 60 + mA - (hB * 60 + mB);
      });
    }
  }

  private parseModelJson<T>(response: string, label: string): T | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      return JSON.parse(response) as T;
    } catch (error) {
      console.error(`❌ Failed to parse ${label} response as JSON:`, error);
      console.error(`Raw ${label} response:`, response);
      return null;
    }
  }

  private logRawActionTimeline(label: string, response: string): void {
    console.log(`   🧾 Raw ${label} (BEGIN)`);
    console.log(response);
    console.log(`   🧾 Raw ${label} (END)`);
  }

  private getLatestActionLogAtOrBefore(
    actionLog: ActionLogEntry[] | undefined,
    cutoffGameTime: string
  ): ActionLogEntry | null {
    if (!actionLog || actionLog.length === 0) {
      return null;
    }

    for (let i = actionLog.length - 1; i >= 0; i--) {
      const entry = actionLog[i];
      if (!entry.time || !entry.location) {
        continue;
      }
      if (this.isTimeBeforeOrEqual(entry.time, cutoffGameTime)) {
        return entry;
      }
    }

    return null;
  }

  private getPlayerActionLogInWindow(
    playerActionWindows: PerPlayerActionWindow[],
    previousSnapshotTime: string | undefined,
    currentGameTime: string
  ): PerPlayerActionWindow[] {
    return playerActionWindows
      .map(({ playerId, characterName, actionLog }) => {
        const filtered = (actionLog || []).filter((entry) => {
          if (!entry.time || !entry.location || !entry.summary) return false;
          if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) return false;
          if (!previousSnapshotTime) return true;
          return this.isTimeAfter(entry.time, previousSnapshotTime);
        });

        filtered.sort((a, b) => {
          const timeA = this.parseGameTimeFromSnapshot(a.time);
          const timeB = this.parseGameTimeFromSnapshot(b.time);
          if (!timeA || !timeB) return 0;
          if (timeA.gameDay !== timeB.gameDay) return timeA.gameDay - timeB.gameDay;
          const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
          const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
          return hA * 60 + mA - (hB * 60 + mB);
        });

        return { playerId, characterName, actionLog: filtered };
      })
      .filter(({ actionLog }) => actionLog.length > 0);
  }

  private sanitizeGeneratedActionLogEntries(options: {
    entries: ActionLogEntry[];
    currentGameTime: string;
    previousSnapshotTime?: string;
    npcLatestActionTime?: string;
    bucketTime?: string;
  }): ActionLogEntry[] {
    const {
      entries,
      currentGameTime,
      previousSnapshotTime,
      npcLatestActionTime,
      bucketTime,
    } = options;

    const prepared = entries
      .map((entry) => ({
        ...entry,
        time: entry.time || bucketTime || "",
      }))
      .filter((entry) => !!entry.time && !!entry.location && !!entry.summary);

    prepared.sort((a, b) => {
      const timeA = this.parseGameTimeFromSnapshot(a.time);
      const timeB = this.parseGameTimeFromSnapshot(b.time);
      if (!timeA || !timeB) return 0;
      if (timeA.gameDay !== timeB.gameDay) {
        return timeA.gameDay - timeB.gameDay;
      }
      const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
      const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
      return hA * 60 + mA - (hB * 60 + mB);
    });

    const valid: ActionLogEntry[] = [];
    let latestAcceptedTime = npcLatestActionTime;

    for (const entry of prepared) {
      if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) {
        continue;
      }
      if (
        previousSnapshotTime &&
        !this.isTimeAfter(entry.time, previousSnapshotTime)
      ) {
        continue;
      }
      if (
        latestAcceptedTime &&
        !this.isTimeAfter(entry.time, latestAcceptedTime)
      ) {
        continue;
      }

      valid.push(entry);
      latestAcceptedTime = entry.time;
    }

    return valid;
  }

  private buildLightweightCharactersForScene(
    sceneLocation: string,
    currentGameTime: string,
    npcs: DynamicNPCProfile[]
  ): ScenarioCharacter[] {
    const characters: ScenarioCharacter[] = [];
    const normalizedSceneLocation = sceneLocation.toLowerCase().trim();

    for (const npc of npcs) {
      const latestEntry = this.getLatestActionLogAtOrBefore(
        npc.actionLog,
        currentGameTime
      );
      if (!latestEntry || !latestEntry.location) {
        continue;
      }

      if (
        latestEntry.location.toLowerCase().trim() !== normalizedSceneLocation
      ) {
        continue;
      }

      const lightweight = this.convertToLightweightScenarioCharacter({
        id: npc.id,
        name: npc.name,
        role: "npc",
        status: "active",
        location: latestEntry.location,
        notes: latestEntry.summary,
      });

      characters.push(lightweight);
    }

    return characters;
  }

  /**
   * Refresh currentScenario.characters for ALL active scene rooms using two-pass
   * cross-validation against npcCharacters[].actionLog.
   *
   * Pass 1: Keep NPCs from the existing characters[] unless their actionLog proves they left.
   * Pass 2: Add NPCs whose actionLog shows they arrived at this scene after snapshot time.
   *
   * This is called after Phase 1 NPC timeline merge so that the in-memory state is
   * accurate for all downstream consumers (Keeper, frontend, next round).
   */
  private refreshSceneRoomCharacters(
    manager: MultiplayerDynamicGameStateManager,
    currentGameTime: string
  ): void {
    const state = manager.getState();
    const activeRooms = manager.getActiveSceneRooms();
    let totalRefreshed = 0;

    for (const room of activeRooms) {
      const scenario = room.currentScenario;
      if (!scenario?.location) continue;

      const scenarioLocation = scenario.location.toLowerCase().trim();
      const snapshotTime = (scenario as any).gameTime ?? currentGameTime;

      const validated: ScenarioCharacter[] = [];
      const seen = new Set<string>();

      // Pass 1: existing characters — keep unless proven to have left
      for (const sc of scenario.characters ?? []) {
        const key = sc.name.toLowerCase().trim();
        if (seen.has(key)) continue;

        const npc = state.npcCharacters.find(
          (n) => n.name.toLowerCase().trim() === key
        );
        if (!npc) {
          // NPC not in global list — keep the snapshot stub as-is
          seen.add(key);
          validated.push(sc);
          continue;
        }

        const latest = this.getLatestActionLogAtOrBefore(npc.actionLog, currentGameTime);
        if (
          latest &&
          this.isTimeAfter(latest.time, snapshotTime) &&
          latest.location.toLowerCase().trim() !== scenarioLocation
        ) {
          continue; // NPC left this scene
        }

        seen.add(key);
        validated.push({
          id: npc.id,
          name: npc.name,
          role: sc.role ?? "npc",
          status: sc.status ?? "active",
          location: sc.location,
          notes: sc.notes,
        });
      }

      // Pass 2: all global NPCs — include if actionLog shows they arrived
      for (const npc of state.npcCharacters) {
        const key = npc.name.toLowerCase().trim();
        if (seen.has(key)) continue;

        const latest = this.getLatestActionLogAtOrBefore(npc.actionLog, currentGameTime);
        if (
          latest &&
          this.isTimeAfter(latest.time, snapshotTime) &&
          latest.location.toLowerCase().trim() === scenarioLocation
        ) {
          seen.add(key);
          validated.push(
            this.convertToLightweightScenarioCharacter({
              id: npc.id,
              name: npc.name,
              role: "npc",
              status: "active",
              location: latest.location,
              notes: latest.summary,
            })
          );
        }
      }

      // Write back only if the list actually changed
      const oldNames = (scenario.characters ?? []).map((c) => c.name).sort().join(",");
      const newNames = validated.map((c) => c.name).sort().join(",");
      if (oldNames !== newNames) {
        scenario.characters = validated;
        totalRefreshed++;
      }
    }

    if (totalRefreshed > 0) {
      console.log(`   ✓ Refreshed NPC characters for ${totalRefreshed} scene room(s)`);
    }
  }

  private async getLatestScenarioSnapshot(
    scenarioId: string,
    dynamicState: DynamicGameState
  ): Promise<DynamicScenarioSnapshot | null> {
    const updatedSnapshots =
      dynamicState.updatedDynamicScenarioSnapshots.get(scenarioId);
    if (updatedSnapshots && updatedSnapshots.length > 0) {
      return updatedSnapshots[updatedSnapshots.length - 1];
    }

    const scenarioProfile =
      await this.scenarioLoader.getScenarioById(scenarioId);
    return scenarioProfile?.snapshot || null;
  }

  private applyScenarioConnectionsUpdate(
    dynamicState: DynamicGameState,
    scenarioName: string,
    modifiedConnections: Array<{
      scenarioName: string;
      relationshipType: string;
      description?: string;
      blocked?: boolean;
      blockReason?: string | null;
    }>
  ): void {
    if (!modifiedConnections || modifiedConnections.length === 0) {
      return;
    }

    const targetScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) => outline.name === scenarioName
    );

    if (!targetScenarioOutline) {
      console.warn(
        `   ⚠️ Target scenario outline not found for connection update: ${scenarioName}`
      );
      return;
    }

    const convertedConnections = modifiedConnections.map((conn) => {
      const linkedScenario = dynamicState.scenarioOutlines.find(
        (outline) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );

      return {
        scenarioName: linkedScenario?.name || conn.scenarioName,
        scenarioId: linkedScenario?.id || conn.scenarioName,
        relationshipType: conn.relationshipType as ScenarioConnectionType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason ?? undefined,
      };
    });

    targetScenarioOutline.connections = convertedConnections;
  }

  /**
   * Update scenarios for scene switch in 3 phases:
   * 1) Generate background NPC action timeline + merge deltas
   * 2) Generate target snapshot + optional global trigger
   * 3) Generate and apply background simplified snapshot updates
   */
  async updateScenariosForSceneSwitch(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    options?: {
      providerOverride?: ModelProviderName;
    }
  ): Promise<{
    validatedTargetSceneName: string;
    targetSnapshot: DynamicScenarioSnapshot;
    backgroundSnapshots: Map<string, DynamicScenarioSnapshot>;
    modifiedConnections: Array<{
      scenarioName: string;
      relationshipType: string;
      description?: string;
      blocked?: boolean;
      blockReason?: string | null;
    }> | null;
  } | null> {
    console.log(`\n🔄 [Director Agent] Updating scenarios for scene switch...`);

    manager.setDb(this.db);

    const dynamicState = manager.getSceneRoomState(sceneRoomId);
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    const currentScenario = dynamicState.currentScenario;
    const currentScenarioName = currentScenario?.name || null;

    if (!sceneChangeRequest) {
      console.error(`   ❌ No scene change request found`);
      return null;
    }

    console.log(
      `   📋 Scene change request: ${sceneChangeRequest.targetSceneName}`
    );
    console.log(`   📍 Current scenario: ${currentScenarioName}`);

    try {
      const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
      const runtime = createRuntime();

      const scenarioOutlineMap = new Map(
        dynamicState.scenarioOutlines.map((outline: any) => [outline.id, outline])
      );

      const allScenariosData: Array<{
        scenarioId: string;
        scenarioName: string;
        sourcePlaceId: string | null;
        sourcePlaceName: string | null;
        connections: unknown[];
        snapshot: {
          id: string;
          name: string;
          location: string;
          description: string;
          clues: unknown[];
          conditions: unknown[];
          previousGameTime: string | null;
        };
      }> = [];

      // Use module scenario outlines as the source of truth for scene list.
      // Even if a scene has no persisted snapshot yet, it should still be selectable.
      const outlineSource = dynamicState.scenarioOutlines;
      for (const scenarioOutline of outlineSource) {
        const latestSnapshot = await this.getLatestScenarioSnapshot(
          scenarioOutline.id,
          dynamicState
        );

        const baselineSnapshot = latestSnapshot
          ? {
              id: latestSnapshot.id,
              name: latestSnapshot.name,
              location: latestSnapshot.location,
              description: latestSnapshot.description,
              clues: latestSnapshot.clues || [],
              conditions: latestSnapshot.conditions || [],
              previousGameTime: latestSnapshot.gameTime || null,
            }
          : {
              id: `${scenarioOutline.id}-baseline`,
              name: scenarioOutline.name,
              location: scenarioOutline.name,
              description: scenarioOutline.description || "",
              clues: Array.isArray((scenarioOutline as any).clues)
                ? (scenarioOutline as any).clues
                : [],
              conditions: [],
              previousGameTime: currentScenario?.gameTime || null,
            };

        allScenariosData.push({
          scenarioId: scenarioOutline.id,
          scenarioName: scenarioOutline.name,
          sourcePlaceId: scenarioOutline.sourcePlaceId || null,
          sourcePlaceName: scenarioOutline.sourcePlaceName || null,
          connections: scenarioOutline.connections || [],
          snapshot: baselineSnapshot,
        });
      }

      console.log(`   📚 Scenario list (${allScenariosData.length}):`);
      allScenariosData.forEach((s, index) => {
        console.log(`      ${index + 1}. ${s.scenarioName} [${s.scenarioId}]`);
      });

      const targetScenarioData = allScenariosData.find(
        (s) =>
          s.scenarioName === sceneChangeRequest.targetSceneName ||
          s.scenarioId === sceneChangeRequest.targetSceneName
      );

      if (!targetScenarioData) {
        console.error(
          `   ❌ Target scenario "${sceneChangeRequest.targetSceneName}" not found in scenario list`
        );
        return null;
      }

      const previousSnapshotTime =
        targetScenarioData.snapshot.previousGameTime ||
        currentScenario?.gameTime ||
        currentGameTime;

      const phase1Npcs = dynamicState.npcCharacters.map((npc: any) => ({
        ...npc,
        actionLog: npc.actionLog || [],
      }));

      console.log(
        `   📋 Phase 1: Generating timeline for ${phase1Npcs.length} NPCs...`
      );

      const phase1Context = {
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        previousSnapshotTime,
        currentGameTime,
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(
          dynamicState.knowledgeMatrix,
          null,
          2
        ),
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger
          ? JSON.stringify(dynamicState.globalTrigger, null, 2)
          : null,
        playerCurrentSceneJson: JSON.stringify(
          currentScenario
            ? {
                id: currentScenario.id,
                name: currentScenario.name,
                location: currentScenario.location,
              }
            : null,
          null,
          2
        ),
        allScenariosJson: JSON.stringify(allScenariosData, null, 2),
        phase1NpcsJson: JSON.stringify(phase1Npcs, null, 2),
      };

      const phase1Prompt = composeTemplate(
        getNpcActionTimelineTemplate(),
        { dynamicGameState: dynamicState },
        phase1Context,
        "handlebars"
      );

      const phase1Response = await generateText({
        runtime,
        context: phase1Prompt,
        modelClass: ModelClass.MEDIUM,
        providerOverride: options?.providerOverride,
      });
      this.logRawActionTimeline("Phase 1 timeline", phase1Response);

      type TimelineNpcUpdate = {
        id: string;
        actionLog?: ActionLogEntry[];
        statusDelta?: Partial<CharacterStatus>;
        inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
      };
      type TimelineBucket = {
        time?: string;
        npcActionLogUpdates?: TimelineNpcUpdate[];
      };
      const parsedTimeline = this.parseModelJson<{
        actionTimeline?: TimelineBucket[];
      }>(phase1Response, "Phase 1 timeline");

      if (
        !parsedTimeline?.actionTimeline ||
        parsedTimeline.actionTimeline.length === 0
      ) {
        console.error(`   ❌ Phase 1 response missing actionTimeline`);
        return null;
      }

      const cleanedTimeline: TimelineBucket[] = [];
      let mergedNpcUpdates = 0;

      for (const bucket of parsedTimeline.actionTimeline) {
        if (
          !bucket?.time ||
          !this.isTimeBeforeOrEqual(bucket.time, currentGameTime)
        ) {
          continue;
        }

        const cleanedNpcUpdates: TimelineNpcUpdate[] = [];
        const updates = bucket.npcActionLogUpdates || [];
        for (const update of updates) {
          if (!update?.id) {
            continue;
          }

          const npc = this.findNPCById(dynamicState.npcCharacters, update.id);
          if (!npc) {
            console.warn(
              `   ⚠️ NPC "${update.id}" not found, skipping timeline update`
            );
            continue;
          }
          const npcLatestAction = this.getLatestActionLogAtOrBefore(
            npc.actionLog,
            currentGameTime
          );
          const validActionLog = this.sanitizeGeneratedActionLogEntries({
            entries: update.actionLog || [],
            bucketTime: bucket.time,
            currentGameTime,
            previousSnapshotTime,
            npcLatestActionTime: npcLatestAction?.time,
          });

          // Apply delta only when there is at least one valid actionLog entry in window
          if (validActionLog.length === 0) {
            continue;
          }

          this.mergeCharacterDeltaToNPC(npc, {
            actionLog: validActionLog,
            status: update.statusDelta,
            inventory: update.inventoryDelta,
          });

          cleanedNpcUpdates.push({
            id: update.id,
            actionLog: validActionLog,
            statusDelta: update.statusDelta,
            inventoryDelta: update.inventoryDelta,
          });
          mergedNpcUpdates += 1;
        }

        if (cleanedNpcUpdates.length > 0) {
          cleanedTimeline.push({
            time: bucket.time,
            npcActionLogUpdates: cleanedNpcUpdates,
          });
        }
      }

      console.log(
        `   ✓ Phase 1 merged updates for ${mergedNpcUpdates} NPC entries`
      );

      const playerActionWindow = this.getPlayerActionLogInWindow(
        manager.getAggregatedActionLog(sceneRoomId),
        previousSnapshotTime,
        currentGameTime
      );

      const currentSceneId = currentScenario?.id || null;
      const currentSceneName = currentScenario?.name || null;
      const scenesToUpdateInBackground = allScenariosData.filter((scene) => {
        if (scene.scenarioId === targetScenarioData.scenarioId) {
          return false;
        }
        if (currentSceneId && scene.scenarioId === currentSceneId) {
          return false;
        }
        if (currentSceneName && scene.scenarioName === currentSceneName) {
          return false;
        }
        return true;
      });

      // Phase 3 runs in parallel with Phase 2
      const phase3Promise =
        this.updateBackgroundSimplifiedSnapshotsForSceneSwitch(
          manager,
          sceneRoomId,
          currentGameTime,
          previousSnapshotTime,
          scenesToUpdateInBackground,
          cleanedTimeline,
          playerActionWindow,
          getSceneSwitchBackgroundSimplifiedSnapshotsTemplate(),
          options
        );

      console.log(`   📋 Phase 2: Generating target scene snapshot...`);

      const phase2Context = {
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        previousSnapshotTime,
        currentGameTime,
        targetScenesJson: JSON.stringify(
          [
            {
              scenarioId: targetScenarioData.scenarioId,
              scenarioName: targetScenarioData.scenarioName,
              location: targetScenarioData.snapshot.location,
              connections: targetScenarioData.connections,
            },
          ],
          null,
          2
        ),
        targetBaselineSnapshotsJson: JSON.stringify(
          [
            {
              scenarioId: targetScenarioData.scenarioId,
              snapshot: targetScenarioData.snapshot,
            },
          ],
          null,
          2
        ),
        actionTimelineJson: JSON.stringify(
          { actionTimeline: cleanedTimeline },
          null,
          2
        ),
        playerActionWindowJson: JSON.stringify(playerActionWindow, null, 2),
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(
          dynamicState.knowledgeMatrix,
          null,
          2
        ),
        endStateJson: dynamicState.endState
          ? JSON.stringify(dynamicState.endState, null, 2)
          : "null",
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger
          ? JSON.stringify(dynamicState.globalTrigger, null, 2)
          : null,
      };

      const phase2Prompt = composeTemplate(
        getTargetSnapshotFromTimelineTemplate(),
        { dynamicGameState: dynamicState },
        phase2Context,
        "handlebars"
      );

      const phase2Response = await generateText({
        runtime,
        context: phase2Prompt,
        modelClass: ModelClass.MEDIUM,
        providerOverride: options?.providerOverride,
      });
      this.logRawActionTimeline("Phase 2 target snapshot", phase2Response);

      const parsedPhase2 = this.parseModelJson<{
        targetSnapshots?: Array<{
          scenarioId: string;
          snapshot: DynamicScenarioSnapshot;
          connections?: Array<{
            scenarioName: string;
            relationshipType: string;
            description?: string;
            blocked?: boolean;
            blockReason?: string | null;
          }>;
        }>;
        globalTrigger?: {
          timeRestriction?: string;
          timeReason?: string;
          events?: string[];
          eventReasons?: string[];
          keeperNotes?: string;
        };
      }>(phase2Response, "Phase 2 target snapshot");

      const firstTarget = parsedPhase2?.targetSnapshots?.[0];
      if (!firstTarget?.snapshot) {
        console.error(`   ❌ Phase 2 response missing targetSnapshots`);
        return null;
      }

      const modifiedConnections = firstTarget.connections || null;
      const validatedTargetSceneName =
        firstTarget.snapshot.name || targetScenarioData.scenarioName;

      const targetSnapshot: DynamicScenarioSnapshot = {
        ...firstTarget.snapshot,
        id:
          firstTarget.snapshot.id ||
          targetScenarioData.snapshot.id,
        name:
          firstTarget.snapshot.name ||
          targetScenarioData.snapshot.name,
        location:
          firstTarget.snapshot.location ||
          targetScenarioData.snapshot.location,
        description:
          firstTarget.snapshot.description ||
          targetScenarioData.snapshot.description,
        gameTime: currentGameTime,
        snapshotType: "complete",
        clues: Array.isArray(firstTarget.snapshot.clues)
          ? firstTarget.snapshot.clues
          : (targetScenarioData.snapshot
              .clues as DynamicScenarioSnapshot["clues"]),
        conditions: Array.isArray(firstTarget.snapshot.conditions)
          ? firstTarget.snapshot.conditions
          : (targetScenarioData.snapshot
              .conditions as DynamicScenarioSnapshot["conditions"]),
        characters: Array.isArray(firstTarget.snapshot.characters)
          ? (firstTarget.snapshot
              .characters as DynamicScenarioSnapshot["characters"])
          : this.buildLightweightCharactersForScene(
              firstTarget.snapshot.location ||
                targetScenarioData.snapshot.location,
              currentGameTime,
              dynamicState.npcCharacters
            ),
      };

      if (modifiedConnections && modifiedConnections.length > 0) {
        this.applyScenarioConnectionsUpdate(
          dynamicState,
          validatedTargetSceneName,
          modifiedConnections
        );
        console.log(
          `   ✓ Updated ${modifiedConnections.length} connections for target scene`
        );
      }

      if (parsedPhase2?.globalTrigger) {
        manager.setGlobalTrigger(parsedPhase2.globalTrigger);
        console.log(`   ✓ Saved global trigger condition`);
      }

      // Wait for phase 3 completion before returning to avoid mid-save inconsistency
      try {
        await phase3Promise;
      } catch (error) {
        console.error(
          `   ❌ Background simplified snapshot update failed:`,
          error
        );
      }

      console.log(`✅ [Director Agent] Scene switch update completed`);
      console.log(
        `   - Target: ${validatedTargetSceneName} (complete snapshot)`
      );
      console.log(`   - Timeline merged updates: ${mergedNpcUpdates}`);

      return {
        validatedTargetSceneName,
        targetSnapshot,
        backgroundSnapshots: new Map(),
        modifiedConnections,
      };
    } catch (error) {
      console.error(
        `❌ [Director Agent] Failed to update scenarios for scene switch:`,
        error
      );
      return null;
    }
  }

  private async updateBackgroundSimplifiedSnapshotsForSceneSwitch(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    currentGameTime: string,
    previousSnapshotTime: string,
    scenesToUpdate: Array<{
      scenarioId: string;
      scenarioName: string;
      sourcePlaceId: string | null;
      sourcePlaceName: string | null;
      connections: unknown[];
      snapshot: {
        id: string;
        name: string;
        location: string;
        description: string;
        clues: unknown[];
        conditions: unknown[];
        previousGameTime: string | null;
      };
    }>,
    cleanedTimeline: Array<{
      time?: string;
      npcActionLogUpdates?: Array<{
        id: string;
        actionLog?: ActionLogEntry[];
        statusDelta?: Partial<CharacterStatus>;
        inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
      }>;
    }>,
    playerActionWindow: PerPlayerActionWindow[],
    phase3Template: string,
    options?: {
      providerOverride?: ModelProviderName;
    }
  ): Promise<void> {
    if (scenesToUpdate.length === 0) {
      return;
    }

    const dynamicState = manager.getSceneRoomState(sceneRoomId);
    const runtime = createRuntime();
    const templateContext = {
      currentGameDay: dynamicState.gameDay,
      currentTimeOfDay: dynamicState.timeOfDay,
      previousSnapshotTime,
      currentGameTime,
      scenesToUpdateJson: JSON.stringify(
        scenesToUpdate.map((scene) => ({
          scenarioId: scene.scenarioId,
          scenarioName: scene.scenarioName,
          location: scene.snapshot.location,
          connections: scene.connections,
        })),
        null,
        2
      ),
      baselineSnapshotsJson: JSON.stringify(
        scenesToUpdate.map((scene) => ({
          scenarioId: scene.scenarioId,
          snapshot: scene.snapshot,
        })),
        null,
        2
      ),
      actionTimelineJson: JSON.stringify(
        { actionTimeline: cleanedTimeline },
        null,
        2
      ),
      playerActionWindowJson: JSON.stringify(playerActionWindow, null, 2),
      truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
      knowledgeMatrixJson: JSON.stringify(
        dynamicState.knowledgeMatrix,
        null,
        2
      ),
    };

    const prompt = composeTemplate(
      phase3Template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    const response = await generateText({
      runtime,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      providerOverride: options?.providerOverride,
    });

    const parsed = this.parseModelJson<{
      updatedSimplifiedSnapshots?: Array<{
        scenarioId: string;
        snapshot: Partial<DynamicScenarioSnapshot>;
        connections?: Array<{
          scenarioName: string;
          relationshipType: string;
          description?: string;
          blocked?: boolean;
          blockReason?: string | null;
        }>;
      }>;
    }>(response, "Phase 3 simplified snapshots");

    if (!parsed?.updatedSimplifiedSnapshots?.length) {
      console.log(`   ℹ️ Phase 3 returned no simplified snapshot updates`);
      return;
    }

    let updatedCount = 0;
    for (const item of parsed.updatedSimplifiedSnapshots) {
      const baseline = scenesToUpdate.find(
        (scene) => scene.scenarioId === item.scenarioId
      );
      if (!baseline) {
        continue;
      }

      const latestSnapshot = await this.getLatestScenarioSnapshot(
        item.scenarioId,
        dynamicState
      );
      if (!latestSnapshot) {
        continue;
      }

      const updatedSnapshot: DynamicScenarioSnapshot = {
        ...latestSnapshot,
        description: item.snapshot.description || latestSnapshot.description,
        clues: Array.isArray(item.snapshot.clues)
          ? item.snapshot.clues
          : latestSnapshot.clues,
        conditions: Array.isArray(item.snapshot.conditions)
          ? item.snapshot.conditions
          : latestSnapshot.conditions,
        gameTime: currentGameTime,
        snapshotType: "simplified",
      };

      await manager.setUpdatedDynamicScenarioSnapshot(
        sceneRoomId,
        item.scenarioId,
        updatedSnapshot
      );
      updatedCount += 1;

      if (item.connections && item.connections.length > 0) {
        this.applyScenarioConnectionsUpdate(
          dynamicState,
          baseline.scenarioName,
          item.connections
        );
      }
    }

    console.log(
      `   ✓ Phase 3 background simplified snapshot updates: ${updatedCount}`
    );
  }

  /**
   * Update non-player scenarios — natively multiplayer.
   * Runs ONCE across ALL active player scenes (not per-sceneRoom).
   */
  async updateNonPlayerScenarios(
    manager: MultiplayerDynamicGameStateManager
  ): Promise<void> {
    console.log(
      `\n🎬 [Director Agent] Starting native multiplayer non-player scenario update...`
    );

    const state = manager.getState();
    // Use MAX game time across all active rooms (not stale global time)
    const activeRooms = manager.getActiveSceneRooms();
    let maxGameDay = state.gameDay;
    let maxTimeOfDay = state.timeOfDay;
    for (const room of activeRooms) {
      const roomMin = room.gameDay * 1440 + this.parseTimeToMinutes(room.timeOfDay);
      const maxMin = maxGameDay * 1440 + this.parseTimeToMinutes(maxTimeOfDay);
      if (roomMin > maxMin) {
        maxGameDay = room.gameDay;
        maxTimeOfDay = room.timeOfDay;
      }
    }
    const currentGameTime = `Day ${maxGameDay}, ${maxTimeOfDay}`;

    // Save auto-checkpoint before scenario update
    try {
      const { getPrismaClient } = await import("../../../shared/agents/memory/database/prismaClient.js");
      const { randomUUID } = await import("crypto");
      const prisma = getPrismaClient();
      const cpPayload = await serializeMultiplayerCheckpoint(manager, this.db);
      const cpId = `mp-auto-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const cpName = `Auto Save - ${generateMultiplayerCheckpointName(manager)}`;
      await prisma.multiplayerCheckpoint.create({
        data: {
          checkpointId: cpId,
          roomId: state.roomId,
          name: cpName,
          payload: cpPayload as any,
          createdBy: "system",
        },
      });
    } catch (cpError) {
      console.warn("[MP Director] Auto-checkpoint save failed:", cpError);
    }

    try {
      // ── Collect all active player scenes ──
      const activeSceneRooms = manager.getActiveSceneRooms();
      const scenarioOutlineMap = new Map(
        state.scenarioOutlines.map((outline) => [outline.id, outline])
      );

      const playerScenes: Array<{
        sceneRoomId: string;
        scenarioId: string;
        name: string;
        location: string;
        memberPlayerNames: string[];
        currentScenario: DynamicScenarioSnapshot;
      }> = [];

      for (const room of activeSceneRooms) {
        if (!room.currentScenario) continue;
        const memberNames = room.memberPlayerIds
          .map((pid) => state.players[pid]?.characterName)
          .filter(Boolean) as string[];
        playerScenes.push({
          sceneRoomId: room.sceneRoomId,
          scenarioId: room.currentScenario.id,
          name: room.currentScenario.name,
          location: room.currentScenario.location,
          memberPlayerNames: memberNames,
          currentScenario: room.currentScenario,
        });
      }

      if (playerScenes.length === 0) {
        console.log(`   ✓ No active player scenes, skipping`);
        return;
      }

      // ── Build allScenariosData ──
      const allScenariosData = await this.buildAllScenariosDataFromState(state);
      if (allScenariosData.length === 0) {
        console.log(`   ✓ No scenarios to update`);
        return;
      }

      // ── Previous snapshot time ──
      const previousSnapshotCandidates = allScenariosData
        .map((scene) => scene.snapshot.previousGameTime)
        .filter((time): time is string => {
          const parsed = this.parseGameTimeFromSnapshot(time || undefined);
          return Boolean(parsed);
        });
      const previousSnapshotTime =
        previousSnapshotCandidates.length > 0
          ? previousSnapshotCandidates.reduce((earliest, current) =>
              this.isTimeBeforeOrEqual(current, earliest) ? current : earliest
            )
          : currentGameTime;

      // ── Excluded NPCs: those in ANY player scene location ──
      const playerSceneLocations = new Set(
        playerScenes.map((ps) => ps.location.toLowerCase().trim())
      );
      const excludedNpcIds = new Set<string>();
      for (const npc of state.npcCharacters) {
        const latest = this.getLatestActionLogAtOrBefore(
          npc.actionLog,
          currentGameTime
        );
        if (
          latest?.location &&
          playerSceneLocations.has(latest.location.toLowerCase().trim())
        ) {
          excludedNpcIds.add(npc.id);
        }
      }

      const backgroundNpcs = state.npcCharacters
        .filter((npc) => !excludedNpcIds.has(npc.id))
        .map((npc) => ({ ...npc, actionLog: npc.actionLog || [] }));

      // ── Scenes to exclude from Phase 3 background: ALL player scene locations ──
      const playerSceneNames = new Set(
        playerScenes.map((ps) => ps.name)
      );
      const scenesToUpdateInBackground = allScenariosData.filter((scene) => {
        if (playerSceneNames.has(scene.scenarioName)) return false;
        if (playerSceneLocations.has(scene.snapshot.location?.toLowerCase().trim())) return false;
        return true;
      });

      console.log(
        `   📋 Phase 1: ${backgroundNpcs.length} background NPCs, ${playerScenes.length} player scene(s)...`
      );

      // ── Phase 1: Timeline + SuddenActionLogs (one LLM call, all player scenes) ──
      const runtime = createRuntime();
      const phase1Context = {
        currentGameDay: state.gameDay,
        currentTimeOfDay: state.timeOfDay,
        previousSnapshotTime,
        currentGameTime,
        truthTimelineJson: JSON.stringify(state.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(state.knowledgeMatrix, null, 2),
        previousGlobalTrigger: state.globalTrigger,
        previousGlobalTriggerJson: state.globalTrigger
          ? JSON.stringify(state.globalTrigger, null, 2)
          : null,
        playerScenesJson: JSON.stringify(
          playerScenes.map((ps) => ({
            sceneRoomId: ps.sceneRoomId,
            id: ps.scenarioId,
            name: ps.name,
            location: ps.location,
            memberPlayerNames: ps.memberPlayerNames,
          })),
          null,
          2
        ),
        allScenariosJson: JSON.stringify(allScenariosData, null, 2),
        backgroundNpcsJson: JSON.stringify(backgroundNpcs, null, 2),
      };
      const phase1Prompt = composeTemplate(
        getNpcActionTimelineWithPlayerSceneIngressTemplate(),
        { dynamicGameState: state as any },
        phase1Context,
        "handlebars"
      );
      const phase1Response = await generateText({
        runtime,
        context: phase1Prompt,
        modelClass: ModelClass.MEDIUM,
      });
      this.logRawActionTimeline("Non-player Phase 1 timeline", phase1Response);

      type TimelineNpcUpdate = {
        id: string;
        actionLog?: ActionLogEntry[];
        statusDelta?: Partial<CharacterStatus>;
        inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
      };
      type SuddenActionNpcUpdate = {
        id: string;
        name?: string;
        targetSceneRoomId?: string;
        actionLog?: ActionLogEntry[];
      };
      type TimelineBucket = {
        time?: string;
        npcActionLogUpdates?: TimelineNpcUpdate[];
      };
      const parsedTimeline = this.parseModelJson<{
        actionTimeline?: TimelineBucket[];
        SuddenActionLogs?: SuddenActionNpcUpdate[];
        globalTrigger?: {
          timeRestriction?: string;
          timeReason?: string;
          events?: string[];
          eventReasons?: string[];
        };
      }>(phase1Response, "Non-player Phase 1 timeline");
      if (
        !parsedTimeline ||
        ((!parsedTimeline.actionTimeline ||
          parsedTimeline.actionTimeline.length === 0) &&
          (!parsedTimeline.SuddenActionLogs ||
            parsedTimeline.SuddenActionLogs.length === 0))
      ) {
        console.error(
          `   ❌ Non-player Phase 1 response missing actionTimeline/SuddenActionLogs`
        );
        return;
      }

      // Always update globalTrigger
      if (parsedTimeline.globalTrigger) {
        manager.setGlobalTrigger(parsedTimeline.globalTrigger);
        console.log(`   ✓ Updated global trigger condition`);
      } else {
        manager.setGlobalTrigger(null);
        console.log(`   ✓ No significant upcoming events, cleared global trigger`);
      }

      // ── Process actionTimeline ──
      const cleanedTimeline: TimelineBucket[] = [];
      let mergedNpcUpdates = 0;
      for (const bucket of parsedTimeline.actionTimeline || []) {
        if (
          !bucket?.time ||
          !this.isTimeBeforeOrEqual(bucket.time, currentGameTime)
        ) {
          continue;
        }

        const cleanedNpcUpdates: TimelineNpcUpdate[] = [];
        for (const update of bucket.npcActionLogUpdates || []) {
          if (!update?.id || excludedNpcIds.has(update.id)) continue;

          const npc = this.findNPCById(state.npcCharacters, update.id);
          if (!npc) {
            console.warn(`   ⚠️ NPC "${update.id}" not found, skipping timeline update`);
            continue;
          }
          const npcLatestAction = this.getLatestActionLogAtOrBefore(
            npc.actionLog,
            currentGameTime
          );
          const validActionLog = this.sanitizeGeneratedActionLogEntries({
            entries: update.actionLog || [],
            bucketTime: bucket.time,
            currentGameTime,
            previousSnapshotTime,
            npcLatestActionTime: npcLatestAction?.time,
          });

          if (validActionLog.length === 0) continue;

          this.mergeCharacterDeltaToNPC(npc, {
            actionLog: validActionLog,
            status: update.statusDelta,
            inventory: update.inventoryDelta,
          });

          cleanedNpcUpdates.push({
            id: update.id,
            actionLog: validActionLog,
            statusDelta: update.statusDelta,
            inventoryDelta: update.inventoryDelta,
          });
          mergedNpcUpdates += 1;
        }

        if (cleanedNpcUpdates.length > 0) {
          cleanedTimeline.push({
            time: bucket.time,
            npcActionLogUpdates: cleanedNpcUpdates,
          });
        }
      }

      // ── Process SuddenActionLogs — group by targetSceneRoomId ──
      // Build a lookup: sceneRoomId → playerScene
      const playerSceneByRoomId = new Map(
        playerScenes.map((ps) => [ps.sceneRoomId, ps])
      );

      // Per-room sudden logs
      const suddenLogsByRoom = new Map<
        string,
        Array<{ id: string; name: string; actionLog: ActionLogEntry[] }>
      >();
      let suddenMergedNpcUpdates = 0;

      if (parsedTimeline.SuddenActionLogs?.length) {
        for (const update of parsedTimeline.SuddenActionLogs) {
          if (!update?.id || excludedNpcIds.has(update.id)) continue;

          // Resolve targetSceneRoomId; fall back to first player scene if only one
          let targetRoomId = update.targetSceneRoomId;
          if (!targetRoomId && playerScenes.length === 1) {
            targetRoomId = playerScenes[0].sceneRoomId;
          }
          if (!targetRoomId || !playerSceneByRoomId.has(targetRoomId)) {
            console.warn(
              `   ⚠️ SuddenActionLog for NPC "${update.id}" has invalid targetSceneRoomId "${targetRoomId}", skipping`
            );
            continue;
          }

          const targetScene = playerSceneByRoomId.get(targetRoomId)!;
          const targetLocationNormalized = targetScene.location.toLowerCase().trim();
          const targetNameNormalized = targetScene.name.toLowerCase().trim();

          const npc = this.findNPCById(state.npcCharacters, update.id);
          if (!npc) {
            console.warn(`   ⚠️ NPC "${update.id}" not found, skipping sudden actionLog`);
            continue;
          }
          const npcLatestAction = this.getLatestActionLogAtOrBefore(
            npc.actionLog,
            currentGameTime
          );
          const validActionLog = this.sanitizeGeneratedActionLogEntries({
            entries: update.actionLog || [],
            currentGameTime,
            previousSnapshotTime,
            npcLatestActionTime: npcLatestAction?.time,
          }).filter((entry) => {
            const normalizedLocation = entry.location.toLowerCase().trim();
            return (
              normalizedLocation === targetLocationNormalized ||
              normalizedLocation === targetNameNormalized
            );
          });

          if (validActionLog.length !== 1) continue;

          this.mergeCharacterDeltaToNPC(npc, { actionLog: validActionLog });

          const roomLogs = suddenLogsByRoom.get(targetRoomId) || [];
          roomLogs.push({
            id: npc.id,
            name: (typeof update.name === "string" && update.name.trim()) || npc.name,
            actionLog: validActionLog,
          });
          suddenLogsByRoom.set(targetRoomId, roomLogs);
          suddenMergedNpcUpdates += 1;
        }
      }

      // Store per-room suddenActionLogs in contextualData
      for (const [roomId, logs] of suddenLogsByRoom) {
        manager.setContextualData(roomId, "suddenActionLogs", logs);
        manager.setContextualData(roomId, "suddenActionLogsGameTime", currentGameTime);
        const room = manager.getSceneRoom(roomId);
        manager.setContextualData(roomId, "suddenActionLogsTurnInScene", room?.turnsInCurrentScene ?? 0);
      }

      console.log(
        `   ✓ Phase 1 merged updates for ${mergedNpcUpdates} NPC entries (+${suddenMergedNpcUpdates} sudden across ${suddenLogsByRoom.size} room(s))`
      );

      // Refresh scene room characters after NPC movements (background timeline + sudden ingress)
      if (mergedNpcUpdates > 0 || suddenMergedNpcUpdates > 0) {
        this.refreshSceneRoomCharacters(manager, currentGameTime);
      }

      // ── Player action window: aggregate from ALL players across ALL active rooms ──
      const allMemberIds = activeSceneRooms.flatMap((r) => r.memberPlayerIds);
      const playerActionWindow = this.getAggregatedPlayerActionWindow(
        state,
        allMemberIds,
        currentGameTime,
        previousSnapshotTime
      );

      // ── Phase 3: Background simplified snapshots (exclude ALL player scenes) ──
      console.log(
        `   📋 Phase 3: Generating simplified background snapshots for ${scenesToUpdateInBackground.length} scenes...`
      );
      const phase3Promise = this.generateBackgroundSnapshotsPhase3(
        manager,
        state,
        currentGameTime,
        previousSnapshotTime,
        scenesToUpdateInBackground,
        cleanedTimeline,
        playerActionWindow,
        getNonPlayerBackgroundSimplifiedSnapshotsTemplate()
      );

      // ── Phase 2: Update ALL player scenes that received sudden logs ──
      let reactionMergedNpcUpdates = 0;
      if (suddenLogsByRoom.size > 0) {
        try {
          console.log(
            `   📋 Phase 2: Updating ${suddenLogsByRoom.size} player scene(s) from sudden logs...`
          );

          // Build the multi-scene intrusions input
          const playerScenesWithIntrusions: Array<Record<string, unknown>> = [];
          for (const [roomId, logs] of suddenLogsByRoom) {
            const ps = playerSceneByRoomId.get(roomId);
            if (!ps) continue;

            const scenarioOutline = scenarioOutlineMap.get(ps.scenarioId) ||
              state.scenarioOutlines.find(
                (o) => o.id === ps.scenarioId || o.name === ps.name
              );
            const storageId = scenarioOutline?.id || ps.scenarioId;
            const sceneNpcs = this.getNPCsForScenario(
              ps.location,
              storageId,
              state.npcCharacters,
              previousSnapshotTime,
              currentGameTime
            );

            playerScenesWithIntrusions.push({
              sceneRoomId: roomId,
              scenarioId: storageId,
              scenarioName: ps.name,
              location: ps.location,
              connections: scenarioOutline?.connections || [],
              baselineSnapshot: ps.currentScenario,
              suddenActionLogs: logs,
              sceneNpcProfiles: sceneNpcs,
            });
          }

          const phase2Context = {
            currentGameDay: state.gameDay,
            currentTimeOfDay: state.timeOfDay,
            previousSnapshotTime,
            currentGameTime,
            playerScenesWithIntrusionsJson: JSON.stringify(
              playerScenesWithIntrusions,
              null,
              2
            ),
          };

          const phase2Prompt = composeTemplate(
            getCurrentSceneReactionSnapshotTemplate(),
            { dynamicGameState: state as any },
            phase2Context,
            "handlebars"
          );

          const phase2Response = await generateText({
            runtime,
            context: phase2Prompt,
            modelClass: ModelClass.MEDIUM,
          });

          type ReactionNpcUpdate = {
            sceneRoomId?: string;
            id: string;
            name?: string;
            actionLog?: ActionLogEntry[];
          };
          const parsedPhase2 = this.parseModelJson<{
            sceneUpdates?: Array<{
              sceneRoomId?: string;
              scenarioId?: string;
              snapshot?: Partial<DynamicScenarioSnapshot>;
              connections?: Array<{
                scenarioName: string;
                relationshipType: string;
                description?: string;
                blocked?: boolean;
                blockReason?: string | null;
              }>;
            }>;
            reactionNpcActionLogUpdates?: ReactionNpcUpdate[];
          }>(phase2Response, "Non-player Phase 2 multi-scene snapshot");

          // Process reaction NPC action logs
          if (parsedPhase2?.reactionNpcActionLogUpdates?.length) {
            for (const update of parsedPhase2.reactionNpcActionLogUpdates) {
              if (!update?.id) continue;

              // Determine which scene this reaction belongs to
              const reactionRoomId = update.sceneRoomId;
              const targetPs = reactionRoomId ? playerSceneByRoomId.get(reactionRoomId) : undefined;
              const locationNormalized = targetPs?.location?.toLowerCase().trim();
              const nameNormalized = targetPs?.name?.toLowerCase().trim();

              const npc = this.findNPCById(state.npcCharacters, update.id);
              if (!npc) continue;

              const validActionLog = (update.actionLog || [])
                .map((entry) => ({
                  ...entry,
                  time: entry.time || currentGameTime,
                }))
                .filter((entry) => {
                  if (!entry.time || !entry.location || !entry.summary) return false;
                  if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) return false;
                  if (previousSnapshotTime && !this.isTimeAfter(entry.time, previousSnapshotTime)) return false;
                  if (locationNormalized || nameNormalized) {
                    const loc = entry.location.toLowerCase().trim();
                    if (loc !== locationNormalized && loc !== nameNormalized) return false;
                  }
                  return true;
                });

              if (validActionLog.length === 0) continue;

              this.mergeCharacterDeltaToNPC(npc, { actionLog: validActionLog });
              reactionMergedNpcUpdates += 1;
            }
          }

          // Process scene updates
          if (parsedPhase2?.sceneUpdates?.length) {
            for (const sceneUpdate of parsedPhase2.sceneUpdates) {
              if (!sceneUpdate?.snapshot || !sceneUpdate.sceneRoomId) continue;

              const roomId = sceneUpdate.sceneRoomId;
              const ps = playerSceneByRoomId.get(roomId);
              if (!ps) {
                console.warn(`   ⚠️ Phase 2 sceneUpdate for unknown room "${roomId}", skipping`);
                continue;
              }

              const scenarioOutline = scenarioOutlineMap.get(ps.scenarioId) ||
                state.scenarioOutlines.find(
                  (o) => o.id === ps.scenarioId || o.name === ps.name
                );
              const storageId = scenarioOutline?.id || ps.scenarioId;

              const modelSnapshot = sceneUpdate.snapshot as Record<string, unknown>;
              const snapshotName =
                typeof modelSnapshot.name === "string" ? modelSnapshot.name.trim() : "";
              const snapshotLocation =
                typeof modelSnapshot.location === "string" ? modelSnapshot.location.trim() : "";
              const snapshotDescription =
                typeof modelSnapshot.description === "string" ? modelSnapshot.description.trim() : "";

              if (!snapshotName || !snapshotLocation || !snapshotDescription) {
                console.warn(
                  `   ⚠️ Phase 2 sceneUpdate for room "${roomId}" missing required fields, skipping`
                );
                continue;
              }

              const generatedSnapshotId =
                typeof modelSnapshot.id === "string" && modelSnapshot.id.trim() !== ""
                  ? modelSnapshot.id.trim()
                  : `${storageId}-snap-${Date.now()}`;
              const updatedSnapshot: DynamicScenarioSnapshot = {
                id: generatedSnapshotId,
                name: snapshotName,
                location: snapshotLocation,
                description: snapshotDescription,
                gameTime: currentGameTime,
                snapshotType: "complete",
                showMap:
                  typeof modelSnapshot.showMap === "boolean" ? modelSnapshot.showMap : undefined,
                keeperNotes:
                  typeof modelSnapshot.keeperNotes === "string" ? modelSnapshot.keeperNotes : undefined,
                timeRestriction:
                  typeof modelSnapshot.timeRestriction === "string" ? modelSnapshot.timeRestriction : undefined,
                characters: Array.isArray(modelSnapshot.characters)
                  ? (modelSnapshot.characters as DynamicScenarioSnapshot["characters"])
                  : [],
                clues: Array.isArray(modelSnapshot.clues)
                  ? (modelSnapshot.clues as DynamicScenarioSnapshot["clues"])
                  : [],
                conditions: Array.isArray(modelSnapshot.conditions)
                  ? (modelSnapshot.conditions as DynamicScenarioSnapshot["conditions"])
                  : [],
              };

              // Store in shared snapshot map
              manager.addOrUpdateScenarioSnapshot(storageId, updatedSnapshot);

              // Update the sceneRoom's currentScenario directly (NOT via updateCurrentScenario which resets turnsInCurrentScene)
              manager.updateSceneRoom(roomId, { currentScenario: updatedSnapshot });

              // Apply connection updates
              if (sceneUpdate.connections?.length) {
                this.applyConnectionsUpdateNative(
                  state.scenarioOutlines,
                  updatedSnapshot.name,
                  sceneUpdate.connections
                );
                console.log(
                  `   ✓ Updated ${sceneUpdate.connections.length} connections for room "${roomId}"`
                );
              }

              // Store worldlineSceneUpdate per-room
              const previousSnapshot = JSON.parse(JSON.stringify(ps.currentScenario)) as DynamicScenarioSnapshot;
              const roomSuddenLogs = suddenLogsByRoom.get(roomId) || [];
              const roomReactions = (parsedPhase2.reactionNpcActionLogUpdates || [])
                .filter((r) => r.sceneRoomId === roomId);

              manager.setContextualData(roomId, "worldlineSceneUpdate", {
                previousSnapshot,
                updatedSnapshot,
                suddenActionLogs: roomSuddenLogs,
                reactionNpcActionLogUpdates: roomReactions,
                gameTime: currentGameTime,
              });

              console.log(`   ✓ Phase 2 updated scene snapshot for room "${roomId}"`);
            }
          }
        } catch (error) {
          console.error(`   ❌ Phase 2 multi-scene update failed:`, error);
        }
      } else {
        console.log(
          `   ℹ️ Phase 2 skipped (no sudden logs affecting any player scene)`
        );
      }

      try {
        await phase3Promise;
      } catch (error) {
        console.error(
          `   ❌ Background simplified snapshot update failed:`,
          error
        );
      }

      console.log(`✅ [Director Agent] Native multiplayer scenario update completed`);
      console.log(
        `   - Timeline merged updates: ${mergedNpcUpdates} (+${reactionMergedNpcUpdates} reactions)`
      );
    } catch (error) {
      console.error(`❌ [Director Agent] Failed to update scenarios:`, error);
      throw error;
    }
  }

  /**
   * Check if global trigger time restriction has been reached
   * @returns true if current game time >= trigger time, false otherwise
   */
  checkGlobalTriggerTime(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): boolean {
    const dynamicState = manager.getSceneRoomState(sceneRoomId);
    const globalTrigger = dynamicState.globalTrigger;

    if (!globalTrigger || !globalTrigger.timeRestriction) {
      return false;
    }

    const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const triggerTime = globalTrigger.timeRestriction;

    // Parse both times
    const currentTime = this.parseGameTimeFromSnapshot(currentGameTime);
    const targetTime = this.parseGameTimeFromSnapshot(triggerTime);

    if (!currentTime || !targetTime) {
      console.warn(
        `   ⚠️ Failed to parse time: current="${currentGameTime}", trigger="${triggerTime}"`
      );
      return false;
    }

    // Check if current time >= trigger time
    const timeReached =
      currentTime.gameDay > targetTime.gameDay ||
      (currentTime.gameDay === targetTime.gameDay &&
        this.compareTimeOfDay(currentTime.timeOfDay, targetTime.timeOfDay) >=
          0);

    if (timeReached) {
      console.log(`   ⏰ Global trigger time reached: ${triggerTime}`);
      if (globalTrigger.timeReason) {
        console.log(`      Reason: ${globalTrigger.timeReason}`);
      }
    }

    return timeReached;
  }

  /**
   * Aggregate action logs from ALL active scene rooms for global trigger checking.
   */
  private collectCurrentTurnActionLogsAcrossAllRooms(
    manager: MultiplayerDynamicGameStateManager
  ): CurrentTurnActionLogItem[] {
    const activeRooms = manager.getActiveSceneRooms();
    const allLogs: CurrentTurnActionLogItem[] = [];
    const dedupe = new Set<string>();

    for (const room of activeRooms) {
      const roomState = manager.getSceneRoomState(room.sceneRoomId);
      const roomLogs = this.collectCurrentTurnActionLogs(roomState);
      for (const log of roomLogs) {
        const key = `${log.character}|${log.time}|${log.location}|${log.summary}`;
        if (!dedupe.has(key)) {
          dedupe.add(key);
          allLogs.push(log);
        }
      }
    }
    return allLogs;
  }

  private collectCurrentTurnActionLogs(
    dynamicState: DynamicGameState
  ): CurrentTurnActionLogItem[] {
    const rows: CurrentTurnActionLogItem[] = [];
    const dedupe = new Set<string>();

    const push = (row: CurrentTurnActionLogItem): void => {
      const summary = row.summary.trim();
      if (!summary) return;
      const key = `${row.character}|${row.time}|${row.location}|${summary}`;
      if (dedupe.has(key)) return;
      dedupe.add(key);
      rows.push({
        ...row,
        summary,
      });
    };

    const actionResults = dynamicState.temporaryInfo.actionResults || [];
    for (const result of actionResults) {
      push({
        character: result.character || "Unknown",
        time: result.gameTime || `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`,
        location:
          result.location || dynamicState.currentScenario?.location || "Unknown",
        summary: result.result || "",
        source: "actionResults",
      });
    }

    const detailed = dynamicState.temporaryInfo.actionResultsDetailed || [];
    for (const item of detailed) {
      const actor =
        typeof item.character === "string" && item.character.trim().length > 0
          ? item.character
          : "Unknown";
      const defaultTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
      const defaultLocation = dynamicState.currentScenario?.location || "Unknown";

      const collectFromLogs = (logs: unknown): void => {
        if (!Array.isArray(logs)) return;
        for (const rawLog of logs) {
          if (!rawLog || typeof rawLog !== "object") continue;
          const log = rawLog as Record<string, unknown>;
          if (typeof log.summary !== "string" || !log.summary.trim()) continue;

          push({
            character:
              typeof log.character === "string" && log.character.trim().length > 0
                ? log.character
                : actor,
            time:
              typeof log.time === "string" && log.time.trim().length > 0
                ? log.time
                : defaultTime,
            location:
              typeof log.location === "string" && log.location.trim().length > 0
                ? log.location
                : defaultLocation,
            summary: log.summary,
            source: "actionResultsDetailed",
          });
        }
      };

      collectFromLogs(item.actionLog);

      if (Array.isArray(item.npcResponses)) {
        for (const npcResponse of item.npcResponses) {
          if (!npcResponse || typeof npcResponse !== "object") continue;
          const response = npcResponse as Record<string, unknown>;
          collectFromLogs(response.actionLog);
        }
      }
    }

    return rows;
  }

  /**
   * Check global trigger and victory trigger simultaneously
   * Combines time check and event check for doom, and checks victory conditions
   * @returns { triggered: boolean, causesGameEnd: boolean, victoryAchieved: boolean }
   */
  async checkGlobalTriggerAndGameEnd(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): Promise<{
    triggered: boolean;
    causesGameEnd: boolean;
    victoryAchieved: boolean;
    achievedVictoryCondition: string | null;
  }> {
    const dynamicState = manager.getSceneRoomState(sceneRoomId);
    const globalTrigger = dynamicState.globalTrigger;
    const endState = dynamicState.endState;
    const victoryTrigger = dynamicState.moduleDigest?.victoryTrigger;

    // Reset trigger-check context every time to avoid stale epilogue evidence.
    manager.setContextualData(sceneRoomId, "triggerCheckEvidence", []);
    manager.setContextualData(sceneRoomId, "triggerCheckCurrentTurnActionLogs", []);
    manager.setContextualData(sceneRoomId, "triggerCheckAchievedVictoryCondition", null);
    manager.setContextualData(sceneRoomId, "triggerCheckResult", null);

    // If no global trigger, return early
    if (!globalTrigger) {
      return {
        triggered: false,
        causesGameEnd: false,
        victoryAchieved: false,
        achievedVictoryCondition: null,
      };
    }

    console.log(
      `\n🔍 [Director Agent] Checking global trigger and game end conditions...`
    );

    let triggered = false;

    // Check 1: Time restriction
    const timeReached = this.checkGlobalTriggerTime(manager, sceneRoomId);
    if (timeReached) {
      triggered = true;
    }

    // Check 2: Event/condition evidence via RAG
    const globalEvents = (globalTrigger.events || []).filter(
      (event: any): event is string => typeof event === "string" && event.trim().length > 0
    );
    const victoryConditions = (victoryTrigger?.conditions || []).filter(
      (condition: any): condition is string =>
        typeof condition === "string" && condition.trim().length > 0
    );

    const shouldRunEvidenceCheck =
      (!triggered && globalEvents.length > 0) || victoryConditions.length > 0;

    if (shouldRunEvidenceCheck) {
      // Try pre-fetched evidence from Memory Agent (available during graph pipeline).
      // Falls back to direct RAG call for rest-unfreeze path (no graph pipeline).
      const preloaded = dynamicState.temporaryInfo.contextualData
        ?.triggerEvidence as TriggerEvidenceItem[] | undefined;

      const triggerEvidence: TriggerEvidenceItem[] =
        preloaded && Array.isArray(preloaded)
          ? preloaded
          : await retrieveTriggerEvidence({
              sessionId: dynamicState.sessionId,
              globalEvents,
              victoryConditions,
            });
      const currentTurnActionLogs = this.collectCurrentTurnActionLogsAcrossAllRooms(manager);
      manager.setContextualData(sceneRoomId, "triggerCheckEvidence", triggerEvidence);
      manager.setContextualData(
        sceneRoomId,
        "triggerCheckCurrentTurnActionLogs",
        currentTurnActionLogs
      );

      if (triggerEvidence.length > 0 || currentTurnActionLogs.length > 0) {
        console.log(
          `   📚 Retrieved ${triggerEvidence.length} deduped trigger evidence chunks from RAG`
        );
        console.log(
          `   🕒 Collected ${currentTurnActionLogs.length} current-turn action logs`
        );

        const runtime = createRuntime();
        const template = getGlobalTriggerEventCheckTemplate();

        const templateContext = {
          globalTriggerJson: JSON.stringify(globalTrigger, null, 2),
          endStateJson: endState ? JSON.stringify(endState, null, 2) : "null",
          victoryTriggerJson: victoryTrigger
            ? JSON.stringify(victoryTrigger, null, 2)
            : null,
          triggerEvidenceJson: JSON.stringify(triggerEvidence, null, 2),
          currentTurnActionLogsJson: JSON.stringify(currentTurnActionLogs, null, 2),
        };

        const prompt = composeTemplate(
          template,
          { dynamicGameState: dynamicState },
          templateContext,
          "handlebars"
        );

        try {
          const response = await generateText({
            runtime,
            context: prompt,
            modelClass: ModelClass.SMALL,
          });

          let parsed: {
            triggered: boolean;
            causesGameEnd: boolean;
            victoryAchieved: boolean;
            achievedVictoryCondition?: string | null;
          };
          try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : response);
          } catch (error) {
            console.error(
              "   ❌ Failed to parse trigger check response:",
              error
            );
            return {
              triggered: false,
              causesGameEnd: false,
              victoryAchieved: false,
              achievedVictoryCondition: null,
            };
          }

          if (parsed.victoryAchieved) {
            console.log(`   🏆 Victory conditions achieved!`);
            manager.setContextualData(
              sceneRoomId,
              "triggerCheckAchievedVictoryCondition",
              parsed.achievedVictoryCondition ?? null
            );
            manager.setContextualData(sceneRoomId, "triggerCheckResult", parsed);
            return {
              triggered: parsed.triggered || triggered,
              causesGameEnd: false,
              victoryAchieved: true,
              achievedVictoryCondition: parsed.achievedVictoryCondition ?? null,
            };
          }

          if (parsed.triggered) {
            console.log(
              `   ✅ Global trigger triggered${parsed.causesGameEnd ? " AND causes game end" : " but does NOT cause game end"}`
            );
            manager.setContextualData(sceneRoomId, "triggerCheckResult", parsed);
            return {
              triggered: true,
              causesGameEnd: parsed.causesGameEnd,
              victoryAchieved: false,
              achievedVictoryCondition: null,
            };
          }
        } catch (error) {
          console.error("   ❌ Error checking global trigger events:", error);
          return {
            triggered: false,
            causesGameEnd: false,
            victoryAchieved: false,
            achievedVictoryCondition: null,
          };
        }
      }
    }

    // If time reached, check if it causes game end
    if (triggered && timeReached) {
      if (endState && endState.pointOfNoReturn.type === "time") {
        const pointOfNoReturnReached = manager.checkPointOfNoReturn(
          dynamicState.gameDay,
          dynamicState.timeOfDay
        );
        if (pointOfNoReturnReached) {
          console.log(
            `   ✅ Global trigger time reached AND causes game end (point of no return)`
          );
          return {
            triggered: true,
            causesGameEnd: true,
            victoryAchieved: false,
            achievedVictoryCondition: null,
          };
        }
      }
      console.log(
        `   ✅ Global trigger time reached but does NOT cause game end`
      );
      return {
        triggered: true,
        causesGameEnd: false,
        victoryAchieved: false,
        achievedVictoryCondition: null,
      };
    }

    return {
      triggered: false,
      causesGameEnd: false,
      victoryAchieved: false,
      achievedVictoryCondition: null,
    };
  }

  /**
   * Generate a stuck-hint narrative when the player appears stuck.
   * Builds context (game time, tension, current scene snapshot, connections, last 3 inputs/narratives),
   * calls the stuck-hint template and LLM, parses { "narrative": string } and returns the narrative.
   * @returns The hint narrative string, or null if no current scenario, parse failure, or LLM error.
   */
  async generateStuckHintNarrative(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string
  ): Promise<string | null> {
    const dynamicState = manager.getSceneRoomState(sceneRoomId);
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario) {
      return null;
    }

    const gameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const tension = dynamicState.tension;

    const currentSceneSnapshotJson = JSON.stringify(currentScenario, null, 2);

    const currentScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline: any) =>
        outline.id === currentScenario.id ||
        outline.name === currentScenario.name
    );
    const rawConnections = currentScenarioOutline?.connections || [];
    const connections = rawConnections.map((conn: any) => {
      const targetScenario = dynamicState.scenarioOutlines.find(
        (outline: any) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );
      return {
        scenarioName: targetScenario?.name ?? conn.scenarioName,
        relationshipType: conn.relationshipType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason,
      };
    });
    const scenarioConnectionsJson = JSON.stringify(connections, null, 2);

    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
      }>) ?? [];
    const recentTurns = conversationHistory.slice(-3).map((t) => ({
      turnNumber: t.turnNumber,
      characterInput: t.characterInput,
      keeperNarrative: t.keeperNarrative,
    }));

    const runtime = createRuntime();
    const template = getStuckHintNarrativeTemplate();
    const templateContext = {
      gameTime,
      tension,
      currentSceneSnapshotJson,
      scenarioConnectionsJson,
      recentTurns,
    };

    const prompt = composeTemplate(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    try {
      const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const raw = jsonMatch ? jsonMatch[0] : response;
      const parsed = JSON.parse(raw) as { narrative?: string };
      if (typeof parsed.narrative === "string") {
        return parsed.narrative;
      }
      return null;
    } catch (error) {
      console.error(
        "[Director Agent] generateStuckHintNarrative failed:",
        error
      );
      return null;
    }
  }

  /**
   * Compare two time-of-day strings (HH:MM format)
   * @returns negative if time1 < time2, 0 if equal, positive if time1 > time2
   */
  private compareTimeOfDay(time1: string, time2: string): number {
    const [h1, m1] = time1.split(":").map(Number);
    const [h2, m2] = time2.split(":").map(Number);

    const minutes1 = h1 * 60 + m1;
    const minutes2 = h2 * 60 + m2;

    return minutes1 - minutes2;
  }
}
