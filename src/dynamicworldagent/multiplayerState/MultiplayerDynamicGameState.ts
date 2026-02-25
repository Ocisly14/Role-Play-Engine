/**
 * Multiplayer Dynamic Game State
 * Multi-player extension of DynamicGameState.
 * Follows "copy-then-modify" principle — single-player DynamicGameState is NOT modified.
 */

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
    if (!room) return false;
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

  // ---------- Game ending ----------

  setGameEnding(ending: GameEndingInfo): void {
    this.state.gameEnding = ending;
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
