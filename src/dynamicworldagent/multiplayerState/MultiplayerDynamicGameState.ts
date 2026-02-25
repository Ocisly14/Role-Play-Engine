/**
 * Multiplayer Dynamic Game State
 * Multi-player extension of DynamicGameState.
 * Follows "copy-then-modify" principle — single-player DynamicGameState is NOT modified.
 */

import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import { InventoryUtils } from "../../shared/agents/models/gameTypes.js";
import type {
  EndStateDefinition,
  KnowledgeHolder,
  MacroSceneStructure,
  ModuleDigest,
  MythosEvent,
  RedHerring,
  ScenarioOutline,
  TruthEvent,
  DynamicCharacterProfile,
  DynamicNPCProfile,
  DynamicScenarioSnapshot,
} from "../world_builder/types.js";

import type {
  ActionAnalysis,
  ActionResult,
  DiscoveredClue,
  GameEndingInfo,
  NPCResponseAnalysis,
  SceneChangeRequest,
} from "../../shared/state/index.js";

import type {
  CombatState,
  DefeatedNpcHistoryEntry,
  HeartbeatAction,
  PendingNpcAction,
} from "../state/DynamicGameState.js";

// Re-export single-player types that are still needed
export type {
  CombatState,
  DefeatedNpcHistoryEntry,
  HeartbeatAction,
  PendingNpcAction,
};

// =============================================
// Per-player state (replaces single-player playerCharacter + staminaState)
// =============================================

export interface MultiplayerPlayerState {
  playerId: string; // userId
  characterId: string;
  characterName: string;
  profile: DynamicCharacterProfile;
  currentSceneRoomId: string;
  /** Per-player fatigue/stamina (different players may have different activity levels) */
  staminaState: {
    minutesSinceLastRest: number;
    fatigueActive: boolean;
    fatigueStartedAtGameTime?: string;
  };
}

// =============================================
// Per-round input (one record per player per round)
// =============================================

export interface MultiplayerTurnInput {
  playerId: string;
  characterId: string;
  inputType: "input" | "skip";
  content?: string;
  selectedSkill?: string | null;
  skillSelectionMode?: "manual" | "auto";
}

// =============================================
// Temporary info — kept per sceneRoom (mirrors DynamicTemporaryInfo)
// =============================================

export interface MultiplayerTemporaryInfo {
  rules: string[];
  contextualData: Record<string, unknown>;
  actionResults: ActionResult[];
  actionResultsDetailed: Array<Record<string, unknown>>;
  currentActionAnalysis: ActionAnalysis | null;
  npcResponseAnalyses: NPCResponseAnalysis[];
  sceneChangeRequest: SceneChangeRequest | null;
  previousScenario: DynamicScenarioSnapshot | null;
}

export function emptyTemporaryInfo(): MultiplayerTemporaryInfo {
  return {
    rules: [],
    contextualData: {},
    actionResults: [],
    actionResultsDetailed: [],
    currentActionAnalysis: null,
    npcResponseAnalyses: [],
    sceneChangeRequest: null,
    previousScenario: null,
  };
}

// =============================================
// SceneRoom state — one record per active sub-room
// =============================================

export interface MultiplayerSceneRoomState {
  sceneRoomId: string;
  scenarioId: string | null;
  scenarioName: string | null;
  snapshotId: string | null;
  snapshotName: string | null;
  /** The current active scenario snapshot object (mirrors single-player currentScenario) */
  currentScenario: DynamicScenarioSnapshot | null;
  memberPlayerIds: string[]; // playerIds of members in this sceneRoom
  roundNumber: number;
  turnsInCurrentScene: number; // mirrors single-player turnsInCurrentScene
  lastPlayerInputTimeByPlayer: Record<string, string | null>; // playerId → ISO timestamp
  temporaryInfo: MultiplayerTemporaryInfo;
  // ── Tree structure fields ──
  /** Empty = root node; one ID = fork child; multiple IDs = merged child */
  parentSceneRoomIds: string[];
  /** True when this room is frozen (no longer accepts input) */
  isFrozen: boolean;
  /** Timestamp when the room was frozen; null while active */
  frozenAt: Date | null;
}

// =============================================
// Rest consensus state (per sceneRoom)
// =============================================

export interface RestConsensusState {
  phase: "idle" | "voting";
  votes: Record<string, { decision: "rest" | "continue"; restHours?: number }>;
  resolvedDecision?: "rest" | "continue";
  resolvedRestHours?: number;
}

// =============================================
// MultiplayerDynamicGameState — the top-level multiplayer game state
// =============================================

export interface MultiplayerDynamicGameState {
  // ===== Multiplayer identity =====
  roomId: string;
  moduleName: string;

  // ===== Players (replaces single playerCharacter) =====
  players: Record<string, MultiplayerPlayerState>; // key = playerId

  // ===== SceneRooms (replaces top-level currentScenario/turnsInCurrentScene) =====
  sceneRooms: Record<string, MultiplayerSceneRoomState>; // key = sceneRoomId

  // ===== Round inputs (pending inputs for the current round) =====
  roundInputs: MultiplayerTurnInput[];

  // ===== Rest consensus (per sceneRoom) =====
  restConsensusBySceneRoom: Record<string, RestConsensusState>;

  // ===== Fields aligned with single-player DynamicGameState =====
  sessionId: string; // maps to a multiplayer session record

  // Time management (shared timeline for the room)
  gameDay: number;
  timeOfDay: string;
  scenarioTimeState: {
    sceneStartTime: string;
    playerTimeConsumption: Record<
      string,
      { totalShortActions: number; lastActionTime: string }
    >;
  };

  // Game tension
  tension: number;

  // Combat (sceneRoom-level — combat happens inside a specific sceneRoom)
  isBattle: boolean;
  combatState: CombatState | null;
  defeatedNpcHistory: DefeatedNpcHistoryEntry[];
  heartbeatActions: HeartbeatAction[];

  // Game ending
  gameEnding: GameEndingInfo | null;

  // Module guidance (permanent)
  keeperGuidance: string | null;
  moduleLimitations: string | null;

  // NPCs (shared across the room)
  npcCharacters: DynamicNPCProfile[];

  // Clues (shared)
  discoveredClues: DiscoveredClue[];

  // Progression tracking
  consecutiveProgressionTriggers: number;

  // ===== DynamicWorld-specific data (same as single-player) =====
  moduleDigest: ModuleDigest | null;
  macroScene: MacroSceneStructure | null;
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition | null;
  scenarioOutlines: ScenarioOutline[];

  revealedTruthEvents: Set<string>;
  activatedKnowledgeHolders: Set<string>;
  deployedRedHerrings: Set<string>;
  mythosRevelations: Set<string>;

  pointOfNoReturnReached: boolean;
  pointOfNoReturnTrigger: string | null;

  updatedDynamicScenarioSnapshots: Map<string, DynamicScenarioSnapshot[]>;

  globalTrigger: {
    timeRestriction?: string;
    timeReason?: string;
    events?: string[];
    eventReasons?: string[];
    keeperNotes?: string;
  } | null;

  // Metadata
  loadedAt: Date;
  lastUpdated: Date;
}

// =============================================
// Factory: create initial state
// =============================================

export function initialMultiplayerDynamicGameState(params: {
  roomId: string;
  sessionId: string;
  moduleName: string;
  players: MultiplayerPlayerState[];
  initialSceneRoomId: string;
  gameDay?: number;
  timeOfDay?: string;
}): MultiplayerDynamicGameState {
  const { roomId, sessionId, moduleName, players, initialSceneRoomId } = params;
  const gameDay = params.gameDay ?? 1;
  const timeOfDay = params.timeOfDay ?? "08:00";

  const playerMap: Record<string, MultiplayerPlayerState> = {};
  for (const p of players) {
    playerMap[p.playerId] = { ...p, currentSceneRoomId: initialSceneRoomId };
  }

  const initialSceneRoom: MultiplayerSceneRoomState = {
    sceneRoomId: initialSceneRoomId,
    scenarioId: null,
    scenarioName: null,
    snapshotId: null,
    snapshotName: null,
    currentScenario: null,
    memberPlayerIds: players.map((p) => p.playerId),
    roundNumber: 1,
    turnsInCurrentScene: 0,
    lastPlayerInputTimeByPlayer: Object.fromEntries(
      players.map((p) => [p.playerId, null])
    ),
    temporaryInfo: emptyTemporaryInfo(),
    parentSceneRoomIds: [],
    isFrozen: false,
    frozenAt: null,
  };

  return {
    roomId,
    moduleName,
    players: playerMap,
    sceneRooms: { [initialSceneRoomId]: initialSceneRoom },
    roundInputs: [],
    restConsensusBySceneRoom: {},

    sessionId,
    gameDay,
    timeOfDay,
    scenarioTimeState: {
      sceneStartTime: timeOfDay,
      playerTimeConsumption: {},
    },

    tension: 0,
    isBattle: false,
    combatState: null,
    defeatedNpcHistory: [],
    heartbeatActions: [],
    gameEnding: null,

    keeperGuidance: null,
    moduleLimitations: null,

    npcCharacters: [],
    discoveredClues: [],
    consecutiveProgressionTriggers: 0,

    moduleDigest: null,
    macroScene: null,
    truthTimeline: [],
    knowledgeMatrix: [],
    redHerrings: [],
    mythosEvents: [],
    endState: null,
    scenarioOutlines: [],

    revealedTruthEvents: new Set(),
    activatedKnowledgeHolders: new Set(),
    deployedRedHerrings: new Set(),
    mythosRevelations: new Set(),

    pointOfNoReturnReached: false,
    pointOfNoReturnTrigger: null,

    updatedDynamicScenarioSnapshots: new Map(),
    globalTrigger: null,

    loadedAt: new Date(),
    lastUpdated: new Date(),
  };
}

// =============================================
// MultiplayerDynamicGameStateManager
// Manages state mutations for a single multiplayer room session
// =============================================

export class MultiplayerDynamicGameStateManager {
  /** Fatigue threshold: 6 hours of uninterrupted player-action time (mirrors single-player). */
  private static readonly FATIGUE_TRIGGER_MINUTES = 360;

  private state: MultiplayerDynamicGameState;

  constructor(state: MultiplayerDynamicGameState) {
    this.state = state;
  }

  getState(): MultiplayerDynamicGameState {
    return this.state;
  }

  // ---------- SceneRoom operations ----------

  getSceneRoom(sceneRoomId: string): MultiplayerSceneRoomState | undefined {
    return this.state.sceneRooms[sceneRoomId];
  }

  updateSceneRoom(
    sceneRoomId: string,
    updates: Partial<MultiplayerSceneRoomState>
  ): void {
    const existing = this.state.sceneRooms[sceneRoomId];
    if (!existing) {
      throw new Error(`SceneRoom ${sceneRoomId} not found`);
    }
    this.state.sceneRooms[sceneRoomId] = { ...existing, ...updates };
    this.state.lastUpdated = new Date();
  }

  createSceneRoom(
    sceneRoomId: string,
    playerIds: string[],
    initial?: Partial<MultiplayerSceneRoomState>
  ): MultiplayerSceneRoomState {
    const newRoom: MultiplayerSceneRoomState = {
      sceneRoomId,
      scenarioId: null,
      scenarioName: null,
      snapshotId: null,
      snapshotName: null,
      currentScenario: null,
      memberPlayerIds: playerIds,
      roundNumber: 1,
      turnsInCurrentScene: 0,
      lastPlayerInputTimeByPlayer: Object.fromEntries(
        playerIds.map((id) => [id, null])
      ),
      temporaryInfo: emptyTemporaryInfo(),
      parentSceneRoomIds: [],
      isFrozen: false,
      frozenAt: null,
      ...initial,
    };
    this.state.sceneRooms[sceneRoomId] = newRoom;
    this.state.lastUpdated = new Date();
    return newRoom;
  }

  /** Clear temporaryInfo for a specific sceneRoom (called at start of each round) */
  clearSceneRoomTemporaryInfo(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.temporaryInfo = emptyTemporaryInfo();
    this.state.lastUpdated = new Date();
  }

  incrementSceneRoomRound(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.roundNumber += 1;
    room.turnsInCurrentScene += 1;
    this.state.lastUpdated = new Date();
  }

  // ---------- Player operations ----------

  getPlayer(playerId: string): MultiplayerPlayerState | undefined {
    return this.state.players[playerId];
  }

  updatePlayerProfile(
    playerId: string,
    updates: Partial<MultiplayerPlayerState>
  ): void {
    const existing = this.state.players[playerId];
    if (!existing) {
      throw new Error(`Player ${playerId} not found in state`);
    }
    this.state.players[playerId] = { ...existing, ...updates };
    this.state.lastUpdated = new Date();
  }

  updatePlayerStamina(
    playerId: string,
    stamina: Partial<MultiplayerPlayerState["staminaState"]>
  ): void {
    const player = this.state.players[playerId];
    if (!player) return;
    player.staminaState = { ...player.staminaState, ...stamina };
    this.state.lastUpdated = new Date();
  }

  movePlayerToSceneRoom(playerId: string, sceneRoomId: string): void {
    const player = this.state.players[playerId];
    if (!player) return;
    const oldRoom = this.state.sceneRooms[player.currentSceneRoomId];
    if (oldRoom) {
      oldRoom.memberPlayerIds = oldRoom.memberPlayerIds.filter(
        (id) => id !== playerId
      );
    }
    player.currentSceneRoomId = sceneRoomId;
    const newRoom = this.state.sceneRooms[sceneRoomId];
    if (newRoom && !newRoom.memberPlayerIds.includes(playerId)) {
      newRoom.memberPlayerIds.push(playerId);
    }
    this.state.lastUpdated = new Date();
  }

  // ---------- Round input operations ----------

  addRoundInput(input: MultiplayerTurnInput): void {
    // Remove any prior input from this player for current round (idempotent)
    this.state.roundInputs = this.state.roundInputs.filter(
      (i) => i.playerId !== input.playerId
    );
    this.state.roundInputs.push(input);
    this.state.lastUpdated = new Date();
  }

  getRoundInputsForSceneRoom(sceneRoomId: string): MultiplayerTurnInput[] {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return [];
    const memberIds = new Set(room.memberPlayerIds);
    return this.state.roundInputs.filter((i) => memberIds.has(i.playerId));
  }

  allPlayersSubmittedForSceneRoom(sceneRoomId: string): boolean {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room || room.isFrozen) return false;
    const submitted = new Set(
      this.getRoundInputsForSceneRoom(sceneRoomId).map((i) => i.playerId)
    );
    return room.memberPlayerIds.every((id) => submitted.has(id));
  }

  clearRoundInputsForSceneRoom(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    const memberIds = new Set(room.memberPlayerIds);
    this.state.roundInputs = this.state.roundInputs.filter(
      (i) => !memberIds.has(i.playerId)
    );
    this.state.lastUpdated = new Date();
  }

  // ---------- Tree structure operations ----------

  /** Freeze a sceneRoom — it can no longer accept inputs and is treated as historical */
  freezeSceneRoom(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.isFrozen = true;
    room.frozenAt = new Date();
    this.state.lastUpdated = new Date();
  }

  /** Return all sceneRooms that are currently active (not frozen) */
  getActiveSceneRooms(): MultiplayerSceneRoomState[] {
    return Object.values(this.state.sceneRooms).filter((r) => !r.isFrozen);
  }

  /**
   * Relocate a player to a new sceneRoom without modifying the old room's
   * memberPlayerIds (used when the old room is being frozen as a historical snapshot).
   * The new room must already have the player in its memberPlayerIds list.
   */
  relocatePlayerToSceneRoom(playerId: string, newSceneRoomId: string): void {
    const player = this.state.players[playerId];
    if (!player) return;
    player.currentSceneRoomId = newSceneRoomId;
    this.state.lastUpdated = new Date();
  }

  // ---------- NPC operations ----------

  updateNpcCharacters(npcs: DynamicNPCProfile[]): void {
    this.state.npcCharacters = npcs;
    this.state.lastUpdated = new Date();
  }

  // ---------- Clue operations ----------

  addDiscoveredClue(clue: DiscoveredClue): void {
    this.state.discoveredClues.push(clue);
    this.state.lastUpdated = new Date();
  }

  // ---------- Time operations ----------

  updateGameTime(gameDay: number, timeOfDay: string): void {
    this.state.gameDay = gameDay;
    this.state.timeOfDay = timeOfDay;
    this.state.lastUpdated = new Date();
  }

  // ---------- Scenario snapshot operations ----------

  addOrUpdateScenarioSnapshot(
    scenarioId: string,
    snapshot: DynamicScenarioSnapshot
  ): void {
    const existing =
      this.state.updatedDynamicScenarioSnapshots.get(scenarioId) ?? [];
    const idx = existing.findIndex((s) => s.id === snapshot.id);
    if (idx >= 0) {
      existing[idx] = snapshot;
    } else {
      existing.push(snapshot);
    }
    this.state.updatedDynamicScenarioSnapshots.set(scenarioId, existing);
    this.state.lastUpdated = new Date();
  }

  // ---------- Rest consensus ----------

  setRestConsensus(
    sceneRoomId: string,
    consensus: RestConsensusState
  ): void {
    this.state.restConsensusBySceneRoom[sceneRoomId] = consensus;
    this.state.lastUpdated = new Date();
  }

  getRestConsensus(sceneRoomId: string): RestConsensusState | undefined {
    return this.state.restConsensusBySceneRoom[sceneRoomId];
  }

  // ---------- Combat state ----------

  setCombatState(combatData: CombatState | null): void {
    this.state.isBattle = combatData !== null;
    this.state.combatState = combatData;
    this.state.lastUpdated = new Date();
  }

  exitCombat(): void {
    this.state.isBattle = false;
    this.state.combatState = null;
    this.state.lastUpdated = new Date();
  }

  // ---------- Tension ----------

  updateTension(newTension: number): void {
    this.state.tension = Math.max(1, Math.min(10, Math.round(newTension)));
    this.state.lastUpdated = new Date();
  }

  // ---------- Heartbeat ----------

  setHeartbeatActions(actions: HeartbeatAction[]): void {
    this.state.heartbeatActions = Array.isArray(actions) ? [...actions] : [];
    this.state.lastUpdated = new Date();
  }

  upsertHeartbeatActions(actions: HeartbeatAction[]): void {
    if (!Array.isArray(actions) || actions.length === 0) return;
    const current = this.state.heartbeatActions || [];

    const findByFingerprint = (incoming: HeartbeatAction): number =>
      current.findIndex((existing) => {
        if (!existing) return false;
        const isActive =
          existing.status === "scheduled" ||
          existing.status === "due" ||
          existing.status === "overdue";
        if (!isActive) return false;
        return (
          existing.npcId === incoming.npcId &&
          existing.scheduledGameTime === incoming.scheduledGameTime &&
          existing.task.trim().toLowerCase() ===
            incoming.task.trim().toLowerCase() &&
          existing.location.trim().toLowerCase() ===
            incoming.location.trim().toLowerCase()
        );
      });

    for (const incoming of actions) {
      if (!incoming?.heartbeatId) continue;
      const byIdIndex = current.findIndex(
        (item) => item.heartbeatId === incoming.heartbeatId
      );
      if (byIdIndex >= 0) {
        current[byIdIndex] = { ...current[byIdIndex], ...incoming };
        continue;
      }
      const byFingerprintIndex = findByFingerprint(incoming);
      if (byFingerprintIndex >= 0) {
        const existing = current[byFingerprintIndex];
        current[byFingerprintIndex] = {
          ...existing,
          ...incoming,
          heartbeatId: existing.heartbeatId,
          createdAtGameTime: existing.createdAtGameTime,
          sourceTurnId: existing.sourceTurnId || incoming.sourceTurnId,
        };
        continue;
      }
      current.push(incoming);
    }
    this.state.heartbeatActions = current;
    this.state.lastUpdated = new Date();
  }

  // ---------- Progression ----------

  incrementConsecutiveTriggers(): void {
    this.state.consecutiveProgressionTriggers =
      (this.state.consecutiveProgressionTriggers || 0) + 1;
    this.state.lastUpdated = new Date();
  }

  resetConsecutiveTriggers(): void {
    this.state.consecutiveProgressionTriggers = 0;
    this.state.lastUpdated = new Date();
  }

  // ---------- Game time (elapsed-minutes version, mirrors single-player) ----------

  advanceGameTime(elapsedMinutes: number): void {
    if (!elapsedMinutes || elapsedMinutes <= 0) return;
    const [hours, minutes] = this.state.timeOfDay.split(":").map(Number);
    let totalMinutes = hours * 60 + minutes + elapsedMinutes;
    if (totalMinutes >= 1440) {
      const daysElapsed = Math.floor(totalMinutes / 1440);
      this.state.gameDay += daysElapsed;
      totalMinutes = totalMinutes % 1440;
    }
    const newHours = Math.floor(totalMinutes / 60);
    const newMinutes = totalMinutes % 60;
    this.state.timeOfDay = `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`;
    this.state.lastUpdated = new Date();
  }

  // ---------- Game ending ----------

  setGameEnding(ending: GameEndingInfo): void {
    this.state.gameEnding = ending;
    this.state.lastUpdated = new Date();
  }

  // ---------- A1: SceneRoom context reading ----------

  getTurnsInCurrentScene(sceneRoomId: string): number {
    return this.state.sceneRooms[sceneRoomId]?.turnsInCurrentScene ?? 0;
  }

  getProgressionThreshold(): number {
    return 5;
  }

  getMinutesSinceLastInput(sceneRoomId: string): number {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return 0;
    const times = Object.values(room.lastPlayerInputTimeByPlayer).filter(
      Boolean
    ) as string[];
    if (times.length === 0) return 0;
    const latestIso = times.sort().pop()!;
    const latestMs = new Date(latestIso).getTime();
    if (Number.isNaN(latestMs)) return 0;
    return Math.floor((Date.now() - latestMs) / 60000);
  }

  shouldTriggerProgression(sceneRoomId: string): boolean {
    return (
      this.getTurnsInCurrentScene(sceneRoomId) >= this.getProgressionThreshold()
    );
  }

  // ---------- A2: SceneRoom scene switching ----------

  updateCurrentScenario(
    sceneRoomId: string,
    opts: {
      snapshot: DynamicScenarioSnapshot;
      scenarioName: string;
      scenarioId?: string;
    }
  ): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      currentScenario: opts.snapshot,
      scenarioName: opts.scenarioName,
      snapshotId: (opts.snapshot as any)?.id ?? null,
      snapshotName: (opts.snapshot as any)?.name ?? null,
      turnsInCurrentScene: 0,
    });
  }

  /** setUpdatedDynamicScenarioSnapshot — stores snapshot in shared updatedDynamicScenarioSnapshots map */
  async setUpdatedDynamicScenarioSnapshot(
    sceneRoomId: string,
    scenarioId: string,
    snapshot: DynamicScenarioSnapshot
  ): Promise<void> {
    // Delegate to the shared map on top-level state (matches legacy single-player snapshot behavior)
    this.addOrUpdateScenarioSnapshot(scenarioId, snapshot);
  }

  getUpdatedDynamicScenarioSnapshots(
    _sceneRoomId: string
  ): Map<string, DynamicScenarioSnapshot[]> {
    return this.state.updatedDynamicScenarioSnapshots;
  }

  clearSceneChangeRequest(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      temporaryInfo: { ...room.temporaryInfo, sceneChangeRequest: null },
    });
  }

  // ---------- A3: ContextualData convenience ----------

  setContextualData(sceneRoomId: string, key: string, value: unknown): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      temporaryInfo: {
        ...room.temporaryInfo,
        contextualData: { ...room.temporaryInfo.contextualData, [key]: value },
      },
    });
  }

  getContextualData(sceneRoomId: string, key: string): unknown {
    return this.state.sceneRooms[sceneRoomId]?.temporaryInfo.contextualData?.[
      key
    ];
  }

  // ---------- A4: ActionResult management ----------

  addActionResult(sceneRoomId: string, result: ActionResult): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      temporaryInfo: {
        ...room.temporaryInfo,
        actionResults: [...room.temporaryInfo.actionResults, result],
      },
    });
  }

  addActionResults(sceneRoomId: string, results: ActionResult[]): void {
    if (!results.length) return;
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      temporaryInfo: {
        ...room.temporaryInfo,
        actionResults: [...room.temporaryInfo.actionResults, ...results],
      },
    });
  }

  clearActionResults(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      temporaryInfo: { ...room.temporaryInfo, actionResults: [], actionResultsDetailed: [] },
    });
  }

  clearNPCResponseAnalyses(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      temporaryInfo: { ...room.temporaryInfo, npcResponseAnalyses: [] },
    });
  }

  clearActionAnalysis(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    this.updateSceneRoom(sceneRoomId, {
      temporaryInfo: { ...room.temporaryInfo, currentActionAnalysis: null },
    });
  }

  // ---------- A5: Player / NPC state changes ----------

  isFatigued(playerId: string): boolean {
    return this.state.players[playerId]?.staminaState.fatigueActive ?? false;
  }

  /**
   * Accumulate per-player fatigue minutes.
   * Call this once per round after determining how many minutes that player spent acting.
   */
  addFatigueMinutes(playerId: string, minutes: number): void {
    if (!minutes || minutes <= 0) return;
    const player = this.state.players[playerId];
    if (!player) return;
    const stamina = player.staminaState;
    stamina.minutesSinceLastRest += minutes;
    if (
      !stamina.fatigueActive &&
      stamina.minutesSinceLastRest >= MultiplayerDynamicGameStateManager.FATIGUE_TRIGGER_MINUTES
    ) {
      stamina.fatigueActive = true;
      stamina.fatigueStartedAtGameTime = this.getFullGameTime();
      console.log(
        `😴 [Stamina][MP] Player ${playerId} is now fatigued! Accumulated: ${stamina.minutesSinceLastRest} minutes`
      );
    }
    this.state.lastUpdated = new Date();
  }

  /**
   * Apply rest recovery for a specific player.
   * Mirrors DynamicGameStateManager.applyRest() semantics.
   */
  applyRestForPlayer(playerId: string, restMinutes: number): {
    restType: "none" | "short" | "long";
    hpRestored: number;
    sanRestored: number;
    summary: string;
  } {
    const player = this.state.players[playerId];
    if (!player) {
      return {
        restType: "none",
        hpRestored: 0,
        sanRestored: 0,
        summary: `休息失败：玩家不存在（${playerId}）。`,
      };
    }

    if (restMinutes < 240) {
      return {
        restType: "none",
        hpRestored: 0,
        sanRestored: 0,
        summary: `休息了 ${restMinutes} 分钟，时间不足，未能有效恢复（需至少4小时）。`,
      };
    }

    // Clear fatigue
    player.staminaState.fatigueActive = false;
    player.staminaState.minutesSinceLastRest = 0;
    delete player.staminaState.fatigueStartedAtGameTime;

    if (restMinutes < 480) {
      this.state.lastUpdated = new Date();
      const hours = Math.round(restMinutes / 60);
      return {
        restType: "short",
        hpRestored: 0,
        sanRestored: 0,
        summary: `进行了 ${hours} 小时的短暂休息，疲劳状态已解除。`,
      };
    }

    // Long rest: restore HP and SAN (best-effort; uses profile fields when available)
    const profile: any = player.profile as any;
    if (!profile.status) profile.status = {};

    const maxHP: number = profile.maxHp ?? profile.attributes?.siz ?? 10;
    const initialSAN: number = profile.initialSan ?? profile.attributes?.pow ?? 50;
    const recoveryScale = restMinutes / 480;

    const hpGain = Math.ceil(maxHP * 0.3 * recoveryScale);
    const sanGain = Math.ceil(initialSAN * 0.1 * recoveryScale);

    const currentHP = profile.status.hp ?? maxHP;
    const currentSAN = profile.status.sanity ?? initialSAN;
    const newHP = Math.min(maxHP, currentHP + hpGain);
    const newSAN = Math.min(initialSAN, currentSAN + sanGain);

    const actualHpRestored = newHP - currentHP;
    const actualSanRestored = newSAN - currentSAN;

    profile.status.hp = newHP;
    profile.status.sanity = newSAN;

    this.state.lastUpdated = new Date();
    const hours = Math.round(restMinutes / 60);
    const restoreDesc =
      actualHpRestored > 0 || actualSanRestored > 0
        ? `恢复了 ${actualHpRestored} HP 和 ${actualSanRestored} SAN。`
        : `HP与SAN已满，无需恢复。`;
    return {
      restType: "long",
      hpRestored: actualHpRestored,
      sanRestored: actualSanRestored,
      summary: `进行了 ${hours} 小时的深度休息，疲劳解除。${restoreDesc}`,
    };
  }

  /** Update the active sceneRoom's temporary sceneChangeRequest (per-sceneRoom). */
  setSceneChangeRequest(sceneRoomId: string, req: SceneChangeRequest | null): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.temporaryInfo.sceneChangeRequest = req;
    this.state.lastUpdated = new Date();
  }

  /** Update the active sceneRoom's currentActionAnalysis (per-sceneRoom). */
  setCurrentActionAnalysis(sceneRoomId: string, analysis: ActionAnalysis | null): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.temporaryInfo.currentActionAnalysis = analysis;
    this.state.lastUpdated = new Date();
  }

  /** Add one detailed action output record (keeper prompt input). */
  addActionResultDetail(sceneRoomId: string, detail: Record<string, unknown>): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.temporaryInfo.actionResultsDetailed.push(detail);
    this.state.lastUpdated = new Date();
  }

  /** Update current scenario state for a specific sceneRoom (description/conditions/clues). */
  updateScenarioState(sceneRoomId: string, scenarioUpdates: any): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room?.currentScenario || !scenarioUpdates) return;

    if (scenarioUpdates.description) {
      (room.currentScenario as any).description = scenarioUpdates.description;
    }

    if (scenarioUpdates.conditions && Array.isArray(scenarioUpdates.conditions)) {
      const conditions = ((room.currentScenario as any).conditions ?? []) as any[];
      (room.currentScenario as any).conditions = conditions;
      for (const newCondition of scenarioUpdates.conditions) {
        const existingIndex = conditions.findIndex(
          (condition) => condition.type === newCondition.type
        );
        if (existingIndex >= 0) {
          conditions[existingIndex] = newCondition;
        } else {
          conditions.push(newCondition);
        }
      }
    }

    if (scenarioUpdates.clues && Array.isArray(scenarioUpdates.clues)) {
      const clues = ((room.currentScenario as any).clues ?? []) as any[];
      (room.currentScenario as any).clues = clues;
      for (const clueUpdate of scenarioUpdates.clues) {
        const existingIndex = clues.findIndex((clue) => clue.id === clueUpdate.id);
        if (existingIndex >= 0) {
          clues[existingIndex] = { ...clues[existingIndex], ...clueUpdate };
        } else if (clueUpdate.id) {
          clues.push(clueUpdate);
        }
      }
    }

    this.state.lastUpdated = new Date();
  }

  /**
   * Apply a raw stateUpdate object (from LLM JSON) to a player's profile.
   * Mirrors DynamicGameStateManager.applyActionUpdate() but scoped to one player.
   */
  applyPlayerActionUpdate(
    _sceneRoomId: string,
    playerId: string,
    stateUpdate: any
  ): void {
    if (!stateUpdate) return;
    const player = this.state.players[playerId];
    if (!player) return;

    const profile = player.profile as any;

    if (stateUpdate.playerCharacter) {
      this.applyCharacterUpdate(profile, stateUpdate.playerCharacter);
    }

    // NPC updates piggyback here too for convenience
    if (stateUpdate.npcCharacters && Array.isArray(stateUpdate.npcCharacters)) {
      const updatedNpcs = this.state.npcCharacters.map((npc) => {
        const upd = (stateUpdate.npcCharacters as any[]).find(
          (u: any) => u.id === npc.id
        );
        if (!upd) return npc;
        const copy: any = { ...npc };
        this.applyCharacterUpdate(copy, upd);
        return copy;
      });
      this.state.npcCharacters = updatedNpcs;
    }

    this.state.lastUpdated = new Date();
  }

  /** Apply NPC-only update (hp, conditions) */
  applyNpcActionUpdate(
    npcId: string,
    update: Partial<{ hp: number | null; conditions: string[] }>
  ): void {
    const npcs = this.state.npcCharacters.map((npc) => {
      if (npc.id !== npcId) return npc;
      const copy: any = { ...npc, status: { ...npc.status } };
      if (update.hp !== null && update.hp !== undefined) {
        copy.status.hp = Math.max(0, (copy.status.hp ?? 0) + update.hp);
      }
      if (update.conditions !== undefined) {
        copy.status.conditions = update.conditions;
      }
      return copy;
    });
    this.state.npcCharacters = npcs as DynamicNPCProfile[];
    this.state.lastUpdated = new Date();
  }

  /** Shared character-update helper (mirrors DynamicGameStateManager.updateCharacter) */
  private applyCharacterUpdate(character: any, updates: any): void {
    if (updates.name) character.name = updates.name;

    if (updates.status) {
      if (!character.status) character.status = {};
      for (const [key, value] of Object.entries(updates.status)) {
        if (key === "conditions" && Array.isArray(value)) {
          character.status.conditions = Array.from(
            new Set(
              (value as string[])
                .filter((s) => typeof s === "string")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            )
          );
          continue;
        }
        if (typeof value === "number" && key in (character.status || {})) {
          character.status[key] = Math.max(0, (character.status[key] ?? 0) + value);
        }
      }
    }

    if (updates.inventory !== undefined) {
      character.inventory = InventoryUtils.normalizeInventory(
        character.inventory ?? []
      );
      if (Array.isArray(updates.inventory)) {
        character.inventory = InventoryUtils.normalizeInventory(updates.inventory);
      } else if (typeof updates.inventory === "object") {
        if (updates.inventory.add) {
          character.inventory = InventoryUtils.addItems(
            character.inventory,
            InventoryUtils.normalizeInventory(
              Array.isArray(updates.inventory.add)
                ? updates.inventory.add
                : [updates.inventory.add]
            )
          );
        }
        if (updates.inventory.remove) {
          character.inventory = InventoryUtils.removeItems(
            character.inventory,
            InventoryUtils.normalizeInventory(
              Array.isArray(updates.inventory.remove)
                ? updates.inventory.remove
                : [updates.inventory.remove]
            )
          );
        }
      }
    }
  }

  // ---------- A6: Global utility methods ----------

  getFullGameTime(): string {
    return `Day ${this.state.gameDay}, ${this.state.timeOfDay}`;
  }

  private _db: CoCDatabase | CoCDatabaseAdapter | undefined;

  setDb(db: CoCDatabase | CoCDatabaseAdapter): void {
    this._db = db;
  }

  getDb(): CoCDatabase | CoCDatabaseAdapter | undefined {
    return this._db;
  }

  checkPointOfNoReturn(_gameDay: number, _timeOfDay: string): boolean {
    return this.state.pointOfNoReturnReached;
  }

  getSessionId(): string {
    return this.state.sessionId ?? this.state.roomId;
  }

  setGlobalTrigger(
    trigger: MultiplayerDynamicGameState["globalTrigger"]
  ): void {
    this.state.globalTrigger = trigger;
    this.state.lastUpdated = new Date();
  }

  // ---------- Serialization (for checkpoint save) ----------

  toJSON(): Record<string, unknown> {
    const s = this.state;
    return {
      ...s,
      sceneRooms: Object.fromEntries(
        Object.entries(s.sceneRooms).map(([k, v]) => [k, v])
      ),
      revealedTruthEvents: [...s.revealedTruthEvents],
      activatedKnowledgeHolders: [...s.activatedKnowledgeHolders],
      deployedRedHerrings: [...s.deployedRedHerrings],
      mythosRevelations: [...s.mythosRevelations],
      updatedDynamicScenarioSnapshots: Object.fromEntries(
        s.updatedDynamicScenarioSnapshots
      ),
      loadedAt: s.loadedAt.toISOString(),
      lastUpdated: s.lastUpdated.toISOString(),
    };
  }
}
