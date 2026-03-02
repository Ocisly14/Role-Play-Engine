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
import {
  resolveModuleIdByName,
  scopeIdByModule,
  stripModuleScope,
} from "../../shared/agents/memory/database/moduleScope.js";
import { resolveEmailId } from "../../shared/agents/memory/database/userContext.js";
import { NPCLoader } from "../../shared/agents/character/npcloader/index.js";
import type { NPCProfile } from "../../shared/agents/models/gameTypes.js";
import type {
  DynamicCharacterProfile,
  DynamicNPCProfile,
  DynamicScenarioSnapshot,
} from "../world_builder/types.js";
import type {
  ScenarioClue,
  ScenarioCondition,
} from "../../shared/agents/models/scenarioTypes.js";
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
// Helpers: NPC conversion + ID normalisation
// (mirrors single-player DynamicGameStateLoader)
// =============================================

function convertNPCProfileToDynamic(npc: NPCProfile): DynamicNPCProfile {
  const { currentLocation, ...rest } = npc;
  return rest as DynamicNPCProfile;
}

function normalizeIdToModuleScope(id: string, moduleId: string | null): string {
  if (!moduleId) return id;
  return scopeIdByModule(stripModuleScope(id), moduleId);
}

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
// Helper: build a DynamicScenarioSnapshot from a Prisma row
// (mirrors single-player DynamicGameStateLoader.buildSnapshotFromRow)
// =============================================

async function buildSnapshotFromRow(
  prisma: ReturnType<typeof getPrismaClient>,
  snapshotRow: any,
  scopedModuleId: string
): Promise<DynamicScenarioSnapshot> {
  const snapshotCharacters = await prisma.scenarioCharacter.findMany({
    where: { snapshotId: snapshotRow.snapshotId, moduleId: scopedModuleId },
    select: {
      id: true,
      characterName: true,
      characterRole: true,
      characterStatus: true,
      characterLocation: true,
      characterNotes: true,
    },
  });

  const snapshotClues = await prisma.scenarioClue.findMany({
    where: { snapshotId: snapshotRow.snapshotId, moduleId: scopedModuleId },
    select: {
      clueId: true,
      clueText: true,
      category: true,
      difficulty: true,
      clueLocation: true,
      discoveryMethod: true,
      reveals: true,
      discovered: true,
      discoveryDetails: true,
    },
  });

  const snapshotConditions = await prisma.scenarioCondition.findMany({
    where: { snapshotId: snapshotRow.snapshotId, moduleId: scopedModuleId },
    select: {
      conditionId: true,
      conditionType: true,
      description: true,
      mechanicalEffect: true,
    },
  });

  const sceneImage =
    snapshotRow.sceneImagePath != null &&
    String(snapshotRow.sceneImagePath).trim() !== ""
      ? { path: String(snapshotRow.sceneImagePath).trim() }
      : undefined;

  return {
    id: snapshotRow.snapshotId,
    name: snapshotRow.snapshotName || snapshotRow.scenario?.name,
    location: snapshotRow.location,
    description: snapshotRow.description,
    gameTime: snapshotRow.gameTime || undefined,
    showMap: snapshotRow.showMap === true,
    sceneImage,
    characters: snapshotCharacters.map((char) => ({
      id: char.id,
      name: char.characterName,
      role: char.characterRole,
      status: char.characterStatus,
      location: char.characterLocation || undefined,
      notes: char.characterNotes || undefined,
    })),
    clues: snapshotClues.map((clue) => ({
      id: clue.clueId,
      clueText: clue.clueText,
      category: clue.category as ScenarioClue["category"],
      difficulty: clue.difficulty as ScenarioClue["difficulty"],
      location: clue.clueLocation,
      discoveryMethod: clue.discoveryMethod || undefined,
      reveals: clue.reveals ? (clue.reveals as any[]) : [],
      discovered: clue.discovered === true,
      discoveryDetails: clue.discoveryDetails
        ? (clue.discoveryDetails as any)
        : undefined,
    })),
    conditions: snapshotConditions.map((cond) => ({
      type: cond.conditionType as ScenarioCondition["type"],
      description: cond.description,
      mechanicalEffect: cond.mechanicalEffect || undefined,
    })),
    keeperNotes: snapshotRow.keeperNotes || undefined,
    timeRestriction: snapshotRow.timeRestriction || undefined,
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

  // 4. Resolve module scope ID (needed for NPC loading + snapshot loading + session record)
  const scopedModuleId = await resolveModuleIdByName(moduleName, resolvedEmailId);

  // 5. Copy world data from worldState into the multiplayer state
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
  state.globalTrigger = worldState.globalTrigger;

  // 6. Load NPCs via NPCLoader (mirrors single-player initializeCompleteDynamicGameState)
  const npcLoader = new NPCLoader(db as any, undefined, undefined, {
    emailId: resolvedEmailId,
  });
  const allNPCs = await npcLoader.getAllNPCs();

  state.npcCharacters = allNPCs.map((npc) => {
    const normalizedId = normalizeIdToModuleScope(npc.id, scopedModuleId);
    const dynamicNpc = convertNPCProfileToDynamic(npc);
    return {
      ...dynamicNpc,
      id: normalizedId,
      clues: Array.isArray(dynamicNpc.clues)
        ? dynamicNpc.clues.map((clue) => ({
            ...clue,
            id: normalizeIdToModuleScope(clue.id, scopedModuleId),
          }))
        : [],
      relationships: Array.isArray(dynamicNpc.relationships)
        ? dynamicNpc.relationships.map((rel) => ({
            ...rel,
            targetId: rel.targetId
              ? normalizeIdToModuleScope(rel.targetId, scopedModuleId)
              : rel.targetId,
          }))
        : [],
    };
  });

  console.log(
    `[MultiplayerLoader] Loaded ${state.npcCharacters.length} NPCs from database`
  );

  // Carry over the game time that the single-player world loader resolved
  // (worldState already has the correct timeOfDay from the module's initialGameTime)
  if (!params.timeOfDay) {
    state.timeOfDay = worldState.timeOfDay;
    state.scenarioTimeState.sceneStartTime = worldState.timeOfDay;
  }

  // 7. Create session record in database (required for turns, checkpoints, language updates)
  const prisma = getPrismaClient();
  await prisma.session.upsert({
    where: { sessionId },
    create: {
      sessionId,
      moduleId: scopedModuleId || null,
      emailId: resolvedEmailId || null,
      modName: moduleName,
      status: "active",
      metadata: {},
    },
    update: {
      lastActivityAt: new Date(),
      moduleId: scopedModuleId || undefined,
    },
  });

  console.log(
    `[MultiplayerLoader] Session record created/updated: ${sessionId}`
  );

  // 8. Load baseline scenario snapshots and set initial scenario on the sceneRoom
  //    (mirrors single-player initializeCompleteDynamicGameState logic)
  if (scopedModuleId) {

    const allModuleSnapshots = await prisma.scenarioSnapshot.findMany({
      where: { moduleId: scopedModuleId, isDynamicHistorical: false },
      include: { scenario: { select: { name: true } } },
      orderBy: [{ scenarioId: "asc" }, { createdAt: "asc" }],
    });

    const startSnapshotRow =
      allModuleSnapshots.find((row) => row.initialSnapshot) ||
      allModuleSnapshots[0] ||
      null;

    // Build all snapshots
    for (const snapshotRow of allModuleSnapshots) {
      const snapshot = await buildSnapshotFromRow(prisma, snapshotRow, scopedModuleId);
      const existing = state.updatedDynamicScenarioSnapshots.get(snapshotRow.scenarioId) ?? [];
      existing.push(snapshot);
      state.updatedDynamicScenarioSnapshots.set(snapshotRow.scenarioId, existing);
    }

    // Set the initial scenario on the initial sceneRoom
    if (startSnapshotRow) {
      const initialScenario = await buildSnapshotFromRow(prisma, startSnapshotRow, scopedModuleId);
      const sceneRoom = state.sceneRooms[initialSceneRoomId];
      if (sceneRoom) {
        sceneRoom.currentScenario = initialScenario;
        sceneRoom.scenarioId = startSnapshotRow.scenarioId;
        sceneRoom.scenarioName = startSnapshotRow.snapshotName || startSnapshotRow.scenario?.name || null;
        sceneRoom.snapshotId = startSnapshotRow.snapshotId;
        sceneRoom.snapshotName = startSnapshotRow.snapshotName || null;
      }

      // Parse game time from initial snapshot if not explicitly provided
      if (!params.timeOfDay && startSnapshotRow.gameTime) {
        const timeMatch = String(startSnapshotRow.gameTime).match(/(\d{1,2}:\d{2})/);
        if (timeMatch) {
          state.timeOfDay = timeMatch[1];
          state.scenarioTimeState.sceneStartTime = timeMatch[1];
          if (sceneRoom) {
            sceneRoom.timeOfDay = timeMatch[1];
          }
        }
        const dayMatch = String(startSnapshotRow.gameTime).match(/Day\s*(\d+)/i);
        if (dayMatch) {
          state.gameDay = Number.parseInt(dayMatch[1], 10);
          if (sceneRoom) {
            sceneRoom.gameDay = state.gameDay;
          }
        }
      }

      console.log(
        `[MultiplayerLoader] Initial scenario: ${initialScenario.name} (${initialScenario.location})`
      );
    }

    console.log(
      `[MultiplayerLoader] Loaded ${allModuleSnapshots.length} baseline snapshots across ${state.updatedDynamicScenarioSnapshots.size} scenarios`
    );
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
