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

/** Multiplayer extension: tracks which player created the heartbeat */
export interface MultiplayerHeartbeatAction extends HeartbeatAction {
  ownerPlayerId: string;
}

// =============================================
// Frozen player input — stored on sceneRoom for time-grouped re-injection
// =============================================

export interface FrozenPlayerInput {
  playerId: string;
  characterId: string;
  content: string;
  selectedSkill: string | null;
  skillSelectionMode: "manual" | "auto";
  originalRoundNumber: number;
  frozenRoundCount: number;
  lastEstimatedMinutes: number;
  /** Game time when the action was first submitted, e.g. "Day 1, 14:00" */
  actionStartGameTime: string;
  /** Total game minutes elapsed since the action started (sum of fast-group advances each round) */
  accumulatedElapsedMinutes: number;
}

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
  /** NPC clue IDs this player has discovered (format: "npcId:clueId") */
  revealedNpcClueIds: string[];
  /** NPC secret keys this player has discovered (format: "npcId:secretIndex") */
  revealedNpcSecretKeys: string[];
  /** Scenario clue IDs this player has discovered */
  revealedScenarioClueIds: string[];
  /** Scenario clue IDs that were damaged in this player's presence */
  damagedScenarioClueIds: string[];
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
  /** Action results from slow-group players (narrative only, no state mutation) */
  slowGroupActionResults: ActionResult[];
  slowGroupActionResultsDetailed: Array<Record<string, unknown>>;
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
    slowGroupActionResults: [],
    slowGroupActionResultsDetailed: [],
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
  /** Frozen player inputs awaiting re-injection in subsequent rounds */
  frozenPlayerInputs: FrozenPlayerInput[];
  /** Players frozen due to time difference — key=playerId, value=player's source room time */
  timeFrozenPlayers: Record<string, { gameDay: number; timeOfDay: string }>;
  // ── Per-room time tracking ──
  /** Current game day for this room (inherited from parent on creation) */
  gameDay: number;
  /** Current time of day for this room, "HH:MM" format */
  timeOfDay: string;
  // ── Tree structure fields ──
  /** Empty = root node; one ID = fork child; multiple IDs = merged child */
  parentSceneRoomIds: string[];
  /** True when this room is frozen (no longer accepts input) */
  isFrozen: boolean;
  /** Timestamp when the room was frozen; null while active */
  frozenAt: Date | null;
  // ── Per-room game state ──
  /** Game tension level (1-10) for this room */
  tension: number;
  /** Whether this room is currently in combat */
  isBattle: boolean;
  /** Combat details (round, participants, pending actions); null when not in combat */
  combatState: CombatState | null;
  // ── Rest-freeze fields ──
  /** True when room is frozen after rest (prevents input, defers trigger check) */
  isRestFrozen?: boolean;
  /** ISO timestamp of when rest-freeze started */
  restFrozenAt?: string;
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

  // Combat defeat history (global — NPC defeat is world-level)
  defeatedNpcHistory: DefeatedNpcHistoryEntry[];
  heartbeatActions: MultiplayerHeartbeatAction[];

  // Game ending
  gameEnding: GameEndingInfo | null;

  // Module guidance (permanent)
  keeperGuidance: string | null;
  moduleLimitations: string | null;

  // NPCs (shared across the room)
  npcCharacters: DynamicNPCProfile[];

  // Clues (shared)
  discoveredClues: DiscoveredClue[];

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
    playerMap[p.playerId] = {
      ...p,
      currentSceneRoomId: initialSceneRoomId,
      revealedNpcClueIds: p.revealedNpcClueIds ?? [],
      revealedNpcSecretKeys: p.revealedNpcSecretKeys ?? [],
      revealedScenarioClueIds: p.revealedScenarioClueIds ?? [],
      damagedScenarioClueIds: p.damagedScenarioClueIds ?? [],
    };
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
    frozenPlayerInputs: [],
    timeFrozenPlayers: {},
    gameDay,
    timeOfDay,
    parentSceneRoomIds: [],
    isFrozen: false,
    frozenAt: null,
    tension: 0,
    isBattle: false,
    combatState: null,
  };

  return {
    roomId,
    moduleName,
    players: playerMap,
    sceneRooms: { [initialSceneRoomId]: initialSceneRoom },
    roundInputs: [],
    sessionId,
    gameDay,
    timeOfDay,
    scenarioTimeState: {
      sceneStartTime: timeOfDay,
      playerTimeConsumption: {},
    },

    defeatedNpcHistory: [],
    heartbeatActions: [],
    gameEnding: null,

    keeperGuidance: null,
    moduleLimitations: null,

    npcCharacters: [],
    discoveredClues: [],

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
// Time drift types & helpers
// =============================================

export interface TimeDriftInfo {
  fastestRoomId: string;
  slowestRoomId: string;
  /** Absolute drift in minutes between fastest and slowest room */
  driftMinutes: number;
  /** Room IDs whose time >= slowest + 2H (should be blocked from input) */
  blockedRoomIds: string[];
  /** True when all active rooms are within 1H of each other */
  allWithinResume: boolean;
}

/** Convert gameDay + "HH:MM" to absolute minutes since Day 0 00:00. */
export function toAbsoluteMinutes(gameDay: number, timeOfDay: string): number {
  const [h, m] = timeOfDay.split(":").map(Number);
  return (gameDay - 1) * 1440 + h * 60 + m;
}

/** Convert absolute minutes back to { gameDay, timeOfDay }. */
export function fromAbsoluteMinutes(absMinutes: number): {
  gameDay: number;
  timeOfDay: string;
} {
  const gameDay = Math.floor(absMinutes / 1440) + 1;
  const remainder = absMinutes % 1440;
  const hours = Math.floor(remainder / 60);
  const minutes = remainder % 60;
  return {
    gameDay,
    timeOfDay: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
  };
}

// =============================================
// Clue ID stabilization — code-level guard against LLM drift
// =============================================

/**
 * Reconcile an incoming snapshot's clues against a baseline snapshot.
 * - Baseline clues that match by ID keep their discovered/damaged state.
 * - Baseline clues that lost their ID but match by clueText get re-assigned
 *   the original ID and state (fuzzy fallback).
 * - Genuinely new clues (no match) are kept as-is.
 *
 * Mutates `incoming.clues` in place and returns it for convenience.
 */
function stabilizeSnapshotClues(
  incoming: DynamicScenarioSnapshot,
  baseline: DynamicScenarioSnapshot | null
): void {
  if (!baseline?.clues || !incoming.clues) return;

  const baseById = new Map(baseline.clues.map((c) => [c.id, c]));
  // Secondary index: normalised clueText → clue (for fuzzy match when ID is lost)
  const baseByText = new Map<string, typeof baseline.clues[number]>();
  for (const c of baseline.clues) {
    const key = c.clueText?.trim().toLowerCase();
    if (key && !baseByText.has(key)) baseByText.set(key, c);
  }

  const usedBaseIds = new Set<string>();

  for (const clue of incoming.clues) {
    // 1. Exact ID match
    let baseClue = baseById.get(clue.id);
    if (baseClue) {
      usedBaseIds.add(baseClue.id);
    } else {
      // 2. Fuzzy match by clueText
      const textKey = clue.clueText?.trim().toLowerCase();
      if (textKey) {
        baseClue = baseByText.get(textKey);
        if (baseClue && !usedBaseIds.has(baseClue.id)) {
          // Restore original ID
          clue.id = baseClue.id;
          usedBaseIds.add(baseClue.id);
        }
      }
    }

    // Protect discovered/damaged state — only game mechanics may set these
    if (baseClue) {
      if (baseClue.discovered) {
        clue.discovered = true;
        if (baseClue.discoveryDetails) clue.discoveryDetails = baseClue.discoveryDetails;
      }
      if (baseClue.damaged) {
        clue.damaged = true;
        if (baseClue.damageDetails) clue.damageDetails = baseClue.damageDetails;
      }
    }
  }
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

  // ---------- SceneRoom view methods (replaces adapter pattern) ----------

  /**
   * Return a merged view of global state + room-scoped overrides.
   * This replaces all `buildManagerAdapter().getView()` closures in multiplayer agents.
   *
   * @param sceneRoomId - The scene room to scope the view to
   * @param playerId - Optional: when provided, `playerCharacter` is scoped to this player;
   *                   otherwise the first member of the room is used.
   */
  getSceneRoomState(sceneRoomId: string, playerId?: string): any {
    const s = this.state;
    const scr = this.getSceneRoom(sceneRoomId);
    const playerIds = scr?.memberPlayerIds ?? [];

    // Build all player profiles for the room
    const allProfiles = playerIds
      .map((pid) => {
        const p = s.players[pid];
        if (!p?.profile) return null;
        const prof: any = { ...p.profile };
        if (!prof.id) prof.id = p.characterId ?? prof.id;
        if (!prof.name) prof.name = p.characterName ?? prof.name;
        return prof;
      })
      .filter(Boolean);

    // Single player profile (specified playerId or first player)
    const targetPid = playerId ?? playerIds[0];
    const targetPlayer = targetPid ? s.players[targetPid] : undefined;
    const singleProfile = playerId
      ? allProfiles.find((p: any) => p.id === targetPlayer?.characterId) ?? allProfiles[0]
      : allProfiles[0];

    // Aggregated action log from all room members
    const aggregatedActionLog = playerIds.flatMap(
      (id) => ((s.players[id]?.profile as any)?.actionLog ?? [])
    );

    return {
      ...s,
      // Room-scoped overrides
      gameDay: scr?.gameDay ?? s.gameDay,
      timeOfDay: scr?.timeOfDay ?? s.timeOfDay,
      currentScenario: scr?.currentScenario ?? null,
      temporaryInfo: scr?.temporaryInfo ?? emptyTemporaryInfo(),
      turnsInCurrentScene: scr?.turnsInCurrentScene ?? 0,
      // Per-room game state
      tension: scr?.tension ?? 0,
      isBattle: scr?.isBattle ?? false,
      combatState: scr?.combatState ?? null,
      // Player data
      playerCharacter: singleProfile
        ? { ...singleProfile, actionLog: aggregatedActionLog }
        : null,
      playerCharacters: allProfiles,
      staminaState: targetPlayer?.staminaState ?? {
        minutesSinceLastRest: 0,
        fatigueActive: false,
      },
    };
  }

  /**
   * Check if ANY player in the sceneRoom is fatigued.
   * Used by combat agents that need a single boolean for the whole room.
   */
  isAnyPlayerFatigued(sceneRoomId: string): boolean {
    const scr = this.getSceneRoom(sceneRoomId);
    return (scr?.memberPlayerIds ?? []).some((pid) => this.isFatigued(pid));
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
      frozenPlayerInputs: [],
      timeFrozenPlayers: {},
      gameDay: 1,
      timeOfDay: "08:00",
      parentSceneRoomIds: [],
      isFrozen: false,
      frozenAt: null,
      tension: 0,
      isBattle: false,
      combatState: null,
      ...initial, // caller can override gameDay/timeOfDay with parent room's values
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
    // Frozen players (with pending re-injection) count as auto-submitted
    const frozenPlayerIds = new Set(
      (room.frozenPlayerInputs ?? []).map((f) => f.playerId)
    );
    // Time-frozen players also skip submission
    const timeFrozenIds = new Set(
      Object.keys(room.timeFrozenPlayers ?? {})
    );
    return room.memberPlayerIds.every(
      (id) =>
        submitted.has(id) || frozenPlayerIds.has(id) || timeFrozenIds.has(id)
    );
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

  // ---------- Rest-freeze operations ----------

  /** Freeze a scene room after rest (prevents input, defers trigger check) */
  restFreezeSceneRoom(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.isRestFrozen = true;
    room.restFrozenAt = new Date().toISOString();
    this.state.lastUpdated = new Date();
  }

  /** Unfreeze a rest-frozen scene room */
  restUnfreezeSceneRoom(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.isRestFrozen = false;
    room.restFrozenAt = undefined;
    this.state.lastUpdated = new Date();
  }

  /** Get all rest-frozen scene rooms (active but rest-frozen) */
  getRestFrozenSceneRooms(): MultiplayerSceneRoomState[] {
    return this.getActiveSceneRooms().filter((r) => r.isRestFrozen);
  }

  /** Check if a scene room is rest-frozen */
  isSceneRoomRestFrozen(sceneRoomId: string): boolean {
    const room = this.state.sceneRooms[sceneRoomId];
    return room?.isRestFrozen === true;
  }

  /**
   * Check which rest-frozen rooms can be unfrozen.
   * A room is eligible when its time is within 2H of all non-rest-frozen active rooms.
   * If all active rooms are rest-frozen, all are eligible (no non-frozen rooms to wait for).
   */
  checkRestUnfreezeEligibility(): string[] {
    const frozenRooms = this.getRestFrozenSceneRooms();
    if (frozenRooms.length === 0) return [];

    const activeNonFrozen = this.getActiveSceneRooms().filter(
      (r) => !r.isRestFrozen
    );

    if (activeNonFrozen.length === 0) {
      // All active rooms are rest-frozen → unfreeze all
      return frozenRooms.map((r) => r.sceneRoomId);
    }

    const BLOCK_THRESHOLD = 120; // 2 hours in minutes
    const eligible: string[] = [];
    for (const frozen of frozenRooms) {
      const frozenMinutes = toAbsoluteMinutes(frozen.gameDay, frozen.timeOfDay);
      let withinThreshold = true;
      for (const other of activeNonFrozen) {
        const otherMinutes = toAbsoluteMinutes(other.gameDay, other.timeOfDay);
        if (Math.abs(frozenMinutes - otherMinutes) > BLOCK_THRESHOLD) {
          withinThreshold = false;
          break;
        }
      }
      if (withinThreshold) eligible.push(frozen.sceneRoomId);
    }
    return eligible;
  }

  // ---------- Time-frozen player operations ----------

  /** Mark a player as time-frozen in a sceneRoom, recording their source room time. */
  freezePlayerByTime(
    sceneRoomId: string,
    playerId: string,
    sourceGameDay: number,
    sourceTimeOfDay: string
  ): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.timeFrozenPlayers[playerId] = {
      gameDay: sourceGameDay,
      timeOfDay: sourceTimeOfDay,
    };
    this.state.lastUpdated = new Date();
  }

  /** Check if a player is currently time-frozen in a sceneRoom. */
  isPlayerTimeFrozen(sceneRoomId: string, playerId: string): boolean {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return false;
    return playerId in (room.timeFrozenPlayers ?? {});
  }

  /**
   * Check all time-frozen players in a sceneRoom and unfreeze those whose
   * source time is within 20 minutes of (or behind) the room's current time.
   * When unfreezing, the room time is set to max(roomTime, playerFrozenTime).
   * Returns the list of player IDs that were unfrozen this call.
   */
  checkAndUnfreezeTimeFrozenPlayers(sceneRoomId: string): string[] {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return [];
    const frozen = room.timeFrozenPlayers ?? {};
    if (Object.keys(frozen).length === 0) return [];

    const unfrozen: string[] = [];
    const roomAbsMin = toAbsoluteMinutes(room.gameDay, room.timeOfDay);

    for (const [playerId, frozenTime] of Object.entries(frozen)) {
      const playerAbsMin = toAbsoluteMinutes(
        frozenTime.gameDay,
        frozenTime.timeOfDay
      );
      // Unfreeze if room has caught up to within 20 minutes (or surpassed)
      if (playerAbsMin - roomAbsMin <= 20) {
        unfrozen.push(playerId);
        // Set room time to the later of the two
        const maxAbsMin = Math.max(roomAbsMin, playerAbsMin);
        const newTime = fromAbsoluteMinutes(maxAbsMin);
        room.gameDay = newTime.gameDay;
        room.timeOfDay = newTime.timeOfDay;
        delete room.timeFrozenPlayers[playerId];
      }
    }

    if (unfrozen.length > 0) {
      this.state.lastUpdated = new Date();
    }
    return unfrozen;
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

  // ---------- Per-SceneRoom time operations ----------

  /**
   * Advance game time for a specific sceneRoom, then sync global time to max of all active rooms.
   * This replaces the global `advanceGameTime()` for per-room time tracking.
   */
  advanceSceneRoomGameTime(sceneRoomId: string, elapsedMinutes: number): void {
    if (!elapsedMinutes || elapsedMinutes <= 0) return;
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;

    const [hours, minutes] = room.timeOfDay.split(":").map(Number);
    let totalMinutes = hours * 60 + minutes + elapsedMinutes;
    if (totalMinutes >= 1440) {
      const daysElapsed = Math.floor(totalMinutes / 1440);
      room.gameDay += daysElapsed;
      totalMinutes = totalMinutes % 1440;
    }
    const newHours = Math.floor(totalMinutes / 60);
    const newMinutes = totalMinutes % 60;
    room.timeOfDay = `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`;
    this.state.lastUpdated = new Date();

    // Keep global time = max(all active rooms)
    this.syncGlobalTimeToMax();

    // Check if any time-frozen players can now be unfrozen
    const unfrozenIds = this.checkAndUnfreezeTimeFrozenPlayers(sceneRoomId);
    if (unfrozenIds.length > 0) {
      // Store unfrozen IDs in contextualData so service.ts can send WS notifications
      const updatedRoom = this.state.sceneRooms[sceneRoomId];
      if (updatedRoom) {
        const existing =
          (updatedRoom.temporaryInfo.contextualData?.unfrozenPlayerIds as string[] | undefined) ?? [];
        updatedRoom.temporaryInfo.contextualData = {
          ...updatedRoom.temporaryInfo.contextualData,
          unfrozenPlayerIds: [...existing, ...unfrozenIds],
        };
      }
      // Re-sync global time since unfreezing may have bumped room time
      this.syncGlobalTimeToMax();
    }
  }

  /**
   * Set global gameDay/timeOfDay to the maximum time across all active (non-frozen) sceneRooms.
   * NPC worldline flows and global trigger checks continue to use global time.
   */
  syncGlobalTimeToMax(): void {
    const activeRooms = this.getActiveSceneRooms();
    if (activeRooms.length === 0) return;

    let maxDay = 0;
    let maxAbsMinutes = 0;
    let maxTimeOfDay = "00:00";

    for (const room of activeRooms) {
      const absMin = toAbsoluteMinutes(room.gameDay, room.timeOfDay);
      if (absMin > maxAbsMinutes) {
        maxAbsMinutes = absMin;
        maxDay = room.gameDay;
        maxTimeOfDay = room.timeOfDay;
      }
    }

    this.state.gameDay = maxDay;
    this.state.timeOfDay = maxTimeOfDay;
    this.state.lastUpdated = new Date();
  }

  /** Get formatted game time for a specific sceneRoom: "Day X, HH:MM" */
  getSceneRoomFullGameTime(sceneRoomId: string): string {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return this.getFullGameTime(); // fallback to global
    return `Day ${room.gameDay}, ${room.timeOfDay}`;
  }

  /** Compute time drift information across all active sceneRooms. */
  getTimeDriftInfo(): TimeDriftInfo {
    const activeRooms = this.getActiveSceneRooms();
    if (activeRooms.length <= 1) {
      return {
        fastestRoomId: activeRooms[0]?.sceneRoomId ?? "",
        slowestRoomId: activeRooms[0]?.sceneRoomId ?? "",
        driftMinutes: 0,
        blockedRoomIds: [],
        allWithinResume: true,
      };
    }

    let fastestRoom = activeRooms[0];
    let slowestRoom = activeRooms[0];
    let fastestAbs = toAbsoluteMinutes(fastestRoom.gameDay, fastestRoom.timeOfDay);
    let slowestAbs = fastestAbs;

    for (let i = 1; i < activeRooms.length; i++) {
      const room = activeRooms[i];
      const abs = toAbsoluteMinutes(room.gameDay, room.timeOfDay);
      if (abs > fastestAbs) {
        fastestAbs = abs;
        fastestRoom = room;
      }
      if (abs < slowestAbs) {
        slowestAbs = abs;
        slowestRoom = room;
      }
    }

    const driftMinutes = fastestAbs - slowestAbs;
    const BLOCK_THRESHOLD = 120; // 2 hours
    const RESUME_THRESHOLD = 60; // 1 hour

    // Rooms whose time >= slowest + 2H are blocked
    const blockedRoomIds: string[] = [];
    for (const room of activeRooms) {
      const abs = toAbsoluteMinutes(room.gameDay, room.timeOfDay);
      if (abs - slowestAbs >= BLOCK_THRESHOLD) {
        blockedRoomIds.push(room.sceneRoomId);
      }
    }

    return {
      fastestRoomId: fastestRoom.sceneRoomId,
      slowestRoomId: slowestRoom.sceneRoomId,
      driftMinutes,
      blockedRoomIds,
      allWithinResume: driftMinutes <= RESUME_THRESHOLD,
    };
  }

  // ---------- Scenario snapshot operations ----------

  addOrUpdateScenarioSnapshot(
    scenarioId: string,
    snapshot: DynamicScenarioSnapshot
  ): void {
    const existing =
      this.state.updatedDynamicScenarioSnapshots.get(scenarioId) ?? [];
    const idx = existing.findIndex((s) => s.id === snapshot.id);

    // Stabilize clue IDs and protect discovered/damaged state against LLM drift
    const baseline = idx >= 0
      ? existing[idx]
      : existing.length > 0
        ? existing[existing.length - 1]
        : null;
    stabilizeSnapshotClues(snapshot, baseline);

    if (idx >= 0) {
      existing[idx] = snapshot;
    } else {
      existing.push(snapshot);
    }
    this.state.updatedDynamicScenarioSnapshots.set(scenarioId, existing);
    this.state.lastUpdated = new Date();
  }

  // ---------- Combat state ----------

  setCombatState(combatData: CombatState | null, sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.isBattle = combatData !== null;
    room.combatState = combatData;
    this.state.lastUpdated = new Date();
  }

  exitCombat(sceneRoomId: string): void {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return;
    room.isBattle = false;
    room.combatState = null;
    this.state.lastUpdated = new Date();
  }

  isSceneRoomInBattle(sceneRoomId: string): boolean {
    return this.state.sceneRooms[sceneRoomId]?.isBattle ?? false;
  }

  /** Aggregated actionLog from all players in a sceneRoom */
  getAggregatedActionLog(sceneRoomId: string): any[] {
    const room = this.state.sceneRooms[sceneRoomId];
    if (!room) return [];
    return room.memberPlayerIds.flatMap(
      (id) => ((this.state.players[id]?.profile as any)?.actionLog ?? [])
    );
  }

  // ---------- Tension ----------

  updateTension(newTension: number, sceneRoomId?: string): void {
    const clamped = Math.max(1, Math.min(10, Math.round(newTension)));
    if (sceneRoomId) {
      const room = this.state.sceneRooms[sceneRoomId];
      if (room) room.tension = clamped;
    }
    this.state.lastUpdated = new Date();
  }

  // ---------- Heartbeat ----------

  setHeartbeatActions(actions: MultiplayerHeartbeatAction[]): void {
    this.state.heartbeatActions = Array.isArray(actions) ? [...actions] : [];
    this.state.lastUpdated = new Date();
  }

  upsertHeartbeatActions(actions: MultiplayerHeartbeatAction[]): void {
    if (!Array.isArray(actions) || actions.length === 0) return;
    const current = this.state.heartbeatActions || [];

    const findByFingerprint = (incoming: MultiplayerHeartbeatAction): number =>
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

  // ---------- Game time (elapsed-minutes version, mirrors single-player) ----------

  /** @deprecated Use advanceSceneRoomGameTime() for per-room time tracking. */
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

    // Serialize sceneRooms — handle Date fields and sanitize temporaryInfo
    const serializedSceneRooms: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.sceneRooms)) {
      serializedSceneRooms[k] = {
        ...v,
        frozenAt:
          v.frozenAt instanceof Date ? v.frozenAt.toISOString() : v.frozenAt ?? null,
        temporaryInfo: {
          rules: [],
          contextualData: v.temporaryInfo.contextualData
            ? JSON.parse(JSON.stringify(v.temporaryInfo.contextualData))
            : {},
          actionResults: [],
          actionResultsDetailed: [],
          currentActionAnalysis: null,
          npcResponseAnalyses: [],
          sceneChangeRequest: null,
          previousScenario: null,
          slowGroupActionResults: [],
          slowGroupActionResultsDetailed: [],
        },
      };
    }

    // Serialize updatedDynamicScenarioSnapshots — only latest snapshot per scenario
    const serializedSnapshots: Record<string, unknown> = {};
    for (const [scenarioId, snapshots] of s.updatedDynamicScenarioSnapshots) {
      if (snapshots.length > 0) {
        const latest = snapshots[snapshots.length - 1];
        serializedSnapshots[scenarioId] = {
          ...latest,
          timestamp: latest.timestamp
            ? latest.timestamp instanceof Date
              ? latest.timestamp.toISOString()
              : latest.timestamp
            : undefined,
        };
      }
    }

    return {
      ...s,
      sceneRooms: serializedSceneRooms,
      revealedTruthEvents: [...s.revealedTruthEvents],
      activatedKnowledgeHolders: [...s.activatedKnowledgeHolders],
      deployedRedHerrings: [...s.deployedRedHerrings],
      mythosRevelations: [...s.mythosRevelations],
      updatedDynamicScenarioSnapshots: serializedSnapshots,
      loadedAt: s.loadedAt.toISOString(),
      lastUpdated: s.lastUpdated.toISOString(),
    };
  }

  // ---------- Deserialization (for checkpoint load) ----------

  /**
   * Reconstruct a MultiplayerDynamicGameState from a serialized JSON payload
   * (inverse of `toJSON()`).  Hydrates Sets, Maps, Dates, and resets ephemeral fields.
   */
  static deserialize(data: any): MultiplayerDynamicGameState {
    // --- updatedDynamicScenarioSnapshots: Object → Map<string, DynamicScenarioSnapshot[]> ---
    const updatedDynamicScenarioSnapshots = new Map<
      string,
      DynamicScenarioSnapshot[]
    >();
    if (data.updatedDynamicScenarioSnapshots) {
      if (data.updatedDynamicScenarioSnapshots instanceof Map) {
        data.updatedDynamicScenarioSnapshots.forEach(
          (snapshots: any[], scenarioId: string) => {
            if (snapshots.length > 0) {
              const latest = snapshots[snapshots.length - 1];
              updatedDynamicScenarioSnapshots.set(scenarioId, [
                {
                  ...latest,
                  timestamp: latest.timestamp
                    ? typeof latest.timestamp === "string"
                      ? new Date(latest.timestamp)
                      : latest.timestamp
                    : undefined,
                },
              ]);
            }
          }
        );
      } else {
        for (const [scenarioId, snapshotData] of Object.entries(
          data.updatedDynamicScenarioSnapshots as Record<string, any>
        )) {
          const latest = Array.isArray(snapshotData)
            ? snapshotData[snapshotData.length - 1]
            : snapshotData;
          if (latest) {
            updatedDynamicScenarioSnapshots.set(scenarioId, [
              {
                ...latest,
                timestamp: latest.timestamp
                  ? typeof latest.timestamp === "string"
                    ? new Date(latest.timestamp)
                    : latest.timestamp
                  : undefined,
              },
            ]);
          }
        }
      }
    }

    // --- sceneRooms: hydrate frozenAt (Date|null), reset temporaryInfo ---
    const sceneRooms: Record<string, MultiplayerSceneRoomState> = {};
    if (data.sceneRooms && typeof data.sceneRooms === "object") {
      for (const [sceneRoomId, room] of Object.entries(
        data.sceneRooms as Record<string, any>
      )) {
        sceneRooms[sceneRoomId] = {
          ...room,
          frozenAt: room.frozenAt ? new Date(room.frozenAt) : null,
          temporaryInfo: emptyTemporaryInfo(),
          frozenPlayerInputs: Array.isArray(room.frozenPlayerInputs)
            ? room.frozenPlayerInputs
            : [],
          timeFrozenPlayers: room.timeFrozenPlayers ?? {},
          parentSceneRoomIds: Array.isArray(room.parentSceneRoomIds)
            ? room.parentSceneRoomIds
            : [],
          isFrozen: room.isFrozen ?? false,
          memberPlayerIds: Array.isArray(room.memberPlayerIds)
            ? room.memberPlayerIds
            : [],
          roundNumber: room.roundNumber ?? 1,
          turnsInCurrentScene: room.turnsInCurrentScene ?? 0,
          lastPlayerInputTimeByPlayer:
            room.lastPlayerInputTimeByPlayer ?? {},
          gameDay: room.gameDay ?? data.gameDay ?? 1,
          timeOfDay: room.timeOfDay ?? data.timeOfDay ?? "08:00",
          tension: room.tension ?? data.tension ?? 0,
          isBattle: room.isBattle ?? false,
          combatState: room.combatState ?? null,
        };
      }
    }

    // --- Backward compat: migrate global combat state to per-room ---
    if (data.isBattle === true && data.combatSceneRoomId && sceneRooms[data.combatSceneRoomId]) {
      sceneRooms[data.combatSceneRoomId].isBattle = true;
      sceneRooms[data.combatSceneRoomId].combatState = data.combatState ?? null;
    }

    // --- players: ensure arrays default properly ---
    const players: Record<string, MultiplayerPlayerState> = {};
    if (data.players && typeof data.players === "object") {
      for (const [playerId, p] of Object.entries(
        data.players as Record<string, any>
      )) {
        players[playerId] = {
          ...p,
          staminaState: p.staminaState ?? {
            minutesSinceLastRest: 0,
            fatigueActive: false,
          },
          revealedNpcClueIds: Array.isArray(p.revealedNpcClueIds)
            ? p.revealedNpcClueIds
            : [],
          revealedNpcSecretKeys: Array.isArray(p.revealedNpcSecretKeys)
            ? p.revealedNpcSecretKeys
            : [],
          revealedScenarioClueIds: Array.isArray(p.revealedScenarioClueIds)
            ? p.revealedScenarioClueIds
            : [],
          damagedScenarioClueIds: Array.isArray(p.damagedScenarioClueIds)
            ? p.damagedScenarioClueIds
            : [],
        };
      }
    }

    // --- defeatedNpcHistory ---
    const defeatedNpcHistory: DefeatedNpcHistoryEntry[] = Array.isArray(
      data.defeatedNpcHistory
    )
      ? data.defeatedNpcHistory
          .filter(
            (e: any) =>
              e && typeof e.name === "string" && e.name.trim().length > 0
          )
          .map((e: any) => ({
            name: e.name.trim(),
            count:
              typeof e.count === "number" && e.count > 0
                ? Math.floor(e.count)
                : 0,
          }))
      : [];

    // --- heartbeatActions ---
    // Backward compat: old checkpoints may lack ownerPlayerId — default to first player
    const fallbackOwnerPlayerId = Object.keys(data.players ?? {})[0] ?? "";
    const heartbeatActions: MultiplayerHeartbeatAction[] = Array.isArray(
      data.heartbeatActions
    )
      ? data.heartbeatActions
          .filter(
            (h: any) =>
              h &&
              typeof h.scheduledGameTime === "string" &&
              typeof h.npcId === "string"
          )
          .map((h: any) => ({
            ...h,
            ownerPlayerId: h.ownerPlayerId ?? fallbackOwnerPlayerId,
          }))
      : [];

    const state: MultiplayerDynamicGameState = {
      roomId: data.roomId ?? "",
      moduleName: data.moduleName ?? "",
      players,
      sceneRooms,
      roundInputs: [], // ephemeral — always reset

      sessionId: data.sessionId ?? "",
      gameDay: data.gameDay ?? 1,
      timeOfDay: data.timeOfDay ?? "08:00",
      scenarioTimeState: data.scenarioTimeState ?? {
        sceneStartTime: data.timeOfDay ?? "08:00",
        playerTimeConsumption: {},
      },

      defeatedNpcHistory,
      heartbeatActions,
      gameEnding: data.gameEnding ?? null,

      keeperGuidance: data.keeperGuidance ?? null,
      moduleLimitations: data.moduleLimitations ?? null,
      npcCharacters: Array.isArray(data.npcCharacters)
        ? data.npcCharacters
        : [],
      discoveredClues: Array.isArray(data.discoveredClues)
        ? data.discoveredClues
        : [],

      moduleDigest: data.moduleDigest ?? null,
      macroScene: data.macroScene ?? null,
      truthTimeline: Array.isArray(data.truthTimeline)
        ? data.truthTimeline
        : [],
      knowledgeMatrix: Array.isArray(data.knowledgeMatrix)
        ? data.knowledgeMatrix
        : [],
      redHerrings: Array.isArray(data.redHerrings) ? data.redHerrings : [],
      mythosEvents: Array.isArray(data.mythosEvents)
        ? data.mythosEvents
        : [],
      endState: data.endState ?? null,
      scenarioOutlines: Array.isArray(data.scenarioOutlines)
        ? data.scenarioOutlines
        : [],

      revealedTruthEvents: new Set(data.revealedTruthEvents ?? []),
      activatedKnowledgeHolders: new Set(
        data.activatedKnowledgeHolders ?? []
      ),
      deployedRedHerrings: new Set(data.deployedRedHerrings ?? []),
      mythosRevelations: new Set(data.mythosRevelations ?? []),

      pointOfNoReturnReached: data.pointOfNoReturnReached ?? false,
      pointOfNoReturnTrigger: data.pointOfNoReturnTrigger ?? null,

      updatedDynamicScenarioSnapshots,
      globalTrigger: data.globalTrigger ?? null,

      loadedAt: data.loadedAt ? new Date(data.loadedAt) : new Date(),
      lastUpdated: data.lastUpdated
        ? new Date(data.lastUpdated)
        : new Date(),
    };

    return state;
  }
}
