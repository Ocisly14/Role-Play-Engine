/**
 * Multiplayer Dynamic Game State Loader
 *
 * Initialises MultiplayerDynamicGameState for a room.
 * Reuses single-player world-loading utilities (database / file loaders),
 * then layers in all player characters and creates the first sceneRoom.
 *
 * Single-player DynamicGameState / DynamicGameStateLoader are NOT modified.
 */

import { randomUUID } from "crypto";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";
import { resolveModuleIdByName } from "../../shared/agents/memory/database/moduleScope.js";
import { resolveEmailId } from "../../shared/agents/memory/database/userContext.js";
import type { DynamicCharacterProfile } from "../world_builder/types.js";
import {
  loadDynamicGameState,
} from "../state/DynamicGameStateLoader.js";
import {
  initialMultiplayerDynamicGameState,
  MultiplayerDynamicGameStateManager,
  type MultiplayerPlayerState,
  type MultiplayerDynamicGameState,
} from "./MultiplayerDynamicGameState.js";

// =============================================
// Helper: load one player character from the DB
// =============================================

async function loadPlayerCharacterProfile(
  characterId: string
): Promise<DynamicCharacterProfile | null> {
  const prisma = getPrismaClient();
  const character = await prisma.character.findFirst({
    where: { characterId, isNpc: false },
    select: {
      characterId: true,
      name: true,
      attributes: true,
      status: true,
      skills: true,
      inventory: true,
      notes: true,
      occupation: true,
      age: true,
      gender: true,
      appearance: true,
      personality: true,
      background: true,
    },
  });

  if (!character) return null;

  const parsedAttributes = character.attributes as any;
  const parsedStatus = character.status as any;
  const parsedSkillsRaw = (character.skills || {}) as any;
  const parsedInventory = (character.inventory || []) as any;

  let parsedNotes: any = {};
  try {
    parsedNotes =
      typeof character.notes === "string" ? JSON.parse(character.notes) : {};
  } catch {
    parsedNotes = {};
  }

  const parsedSkills: Record<string, number> = {};
  for (const [skillName, skillData] of Object.entries(parsedSkillsRaw)) {
    if (
      typeof skillData === "object" &&
      skillData !== null &&
      "value" in skillData
    ) {
      parsedSkills[skillName] = (skillData as any).value;
    } else {
      parsedSkills[skillName] = typeof skillData === "number" ? skillData : 0;
    }
  }

  return {
    id: character.characterId,
    name: character.name,
    attributes: parsedAttributes,
    status: parsedStatus,
    skills: parsedSkills,
    inventory: parsedInventory,
    notes: character.notes || "",
    actionLog: [],
    occupation: character.occupation || undefined,
    age: character.age || undefined,
    gender: character.gender || parsedNotes.gender || undefined,
    appearance: character.appearance || parsedNotes.appearance || undefined,
    personality: character.personality || undefined,
    backstory: character.background || parsedNotes.backstory || undefined,
    era: parsedNotes.era || undefined,
    residence: parsedNotes.residence || undefined,
    birthplace: parsedNotes.birthplace || undefined,
    ideology: parsedNotes.ideology || undefined,
    significantPeople: parsedNotes.people || undefined,
    gear: parsedNotes.gear || undefined,
    weapons: parsedNotes.weapons || undefined,
    derivedAttributes: {
      MOV: parsedStatus.mov || undefined,
      BUILD:
        parsedStatus.build !== undefined ? String(parsedStatus.build) : undefined,
      DB: parsedStatus.damageBonus || undefined,
      ARMOR: undefined,
    },
  };
}

// =============================================
// initializeMultiplayerGameState
// =============================================

export interface MultiplayerGameInitParams {
  /** The multiplayer room ID */
  roomId: string;
  /** A new session ID to associate with this multiplayer game */
  sessionId: string;
  /** Module name (from MultiplayerRoom.moduleName) */
  moduleName: string;
  /** Players to include — must have characterId set */
  players: Array<{ userId: string; characterId: string }>;
  /** Email of the host (used for module scope resolution) */
  hostEmailId?: string;
  /** Initial game day (default 1) */
  gameDay?: number;
  /** Initial game time in HH:MM (default "08:00") */
  timeOfDay?: string;
}

export async function initializeMultiplayerGameState(
  db: CoCDatabase | CoCDatabaseAdapter,
  params: MultiplayerGameInitParams
): Promise<MultiplayerDynamicGameState> {
  const { roomId, sessionId, moduleName, players } = params;

  console.log(
    `[MultiplayerLoader] Initialising game for room ${roomId}, module "${moduleName}", ${players.length} player(s)`
  );

  // 1. Load world data using the existing single-player loader (database first, then files)
  const resolvedEmailId = resolveEmailId(params.hostEmailId);
  const worldState = await loadDynamicGameState(db, moduleName, resolvedEmailId);

  if (!worldState) {
    throw new Error(
      `[MultiplayerLoader] Failed to load module "${moduleName}" — is it loaded into the database?`
    );
  }

  // 2. Load each player's character profile
  const playerStates: MultiplayerPlayerState[] = [];
  const initialSceneRoomId = randomUUID();

  for (const p of players) {
    const profile = await loadPlayerCharacterProfile(p.characterId);
    if (!profile) {
      throw new Error(
        `[MultiplayerLoader] Character ${p.characterId} not found for player ${p.userId}`
      );
    }
    playerStates.push({
      playerId: p.userId,
      characterId: p.characterId,
      characterName: profile.name,
      profile,
      currentSceneRoomId: initialSceneRoomId,
      staminaState: {
        minutesSinceLastRest: 0,
        fatigueActive: false,
      },
      revealedNpcClueIds: [],
      revealedNpcSecretKeys: [],
      revealedScenarioClueIds: [],
      damagedScenarioClueIds: [],
    });
  }

  // 3. Build the initial multiplayer state
  const state = initialMultiplayerDynamicGameState({
    roomId,
    sessionId,
    moduleName,
    players: playerStates,
    initialSceneRoomId,
    gameDay: params.gameDay,
    timeOfDay: params.timeOfDay,
  });

  // 4. Copy world data from worldState into the multiplayer state
  state.moduleDigest = worldState.moduleDigest;
  state.keeperGuidance = worldState.keeperGuidance;
  state.moduleLimitations = worldState.moduleLimitations;
  state.macroScene = worldState.macroScene;
  state.truthTimeline = worldState.truthTimeline;
  state.knowledgeMatrix = worldState.knowledgeMatrix;
  state.redHerrings = worldState.redHerrings;
  state.mythosEvents = worldState.mythosEvents;
  state.endState = worldState.endState;
  state.scenarioOutlines = worldState.scenarioOutlines;
  state.npcCharacters = worldState.npcCharacters;
  state.globalTrigger = worldState.globalTrigger;

  // Carry over the game time that the single-player world loader resolved
  // (worldState already has the correct timeOfDay from the module's initialGameTime)
  if (!params.timeOfDay) {
    state.timeOfDay = worldState.timeOfDay;
    state.scenarioTimeState.sceneStartTime = worldState.timeOfDay;
  }

  console.log(
    `[MultiplayerLoader] Game state ready — sceneRoom ${initialSceneRoomId}, ` +
    `players: ${playerStates.map((p) => p.characterName).join(", ")}`
  );

  return state;
}

// =============================================
// In-memory store for active multiplayer sessions
// =============================================

class MultiplayerGameSessionStore {
  private static _instance: MultiplayerGameSessionStore | null = null;
  /** Map<roomId, MultiplayerDynamicGameStateManager> */
  private sessions = new Map<string, MultiplayerDynamicGameStateManager>();

  static getInstance(): MultiplayerGameSessionStore {
    if (!MultiplayerGameSessionStore._instance) {
      MultiplayerGameSessionStore._instance = new MultiplayerGameSessionStore();
    }
    return MultiplayerGameSessionStore._instance;
  }

  set(roomId: string, manager: MultiplayerDynamicGameStateManager): void {
    this.sessions.set(roomId, manager);
  }

  get(roomId: string): MultiplayerDynamicGameStateManager | undefined {
    return this.sessions.get(roomId);
  }

  has(roomId: string): boolean {
    return this.sessions.has(roomId);
  }

  delete(roomId: string): void {
    this.sessions.delete(roomId);
  }
}

export const multiplayerSessionStore = MultiplayerGameSessionStore.getInstance();

// =============================================
// Convenience: initialise and register in store
// =============================================

export async function createAndStoreMultiplayerSession(
  db: CoCDatabase | CoCDatabaseAdapter,
  params: MultiplayerGameInitParams
): Promise<MultiplayerDynamicGameStateManager> {
  const state = await initializeMultiplayerGameState(db, params);
  const manager = new MultiplayerDynamicGameStateManager(state);
  multiplayerSessionStore.set(params.roomId, manager);
  return manager;
}
