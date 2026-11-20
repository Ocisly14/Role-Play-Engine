import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { NpcMemoryType, PrismaClient } from "@prisma/client";
import type { EngineAction } from "../engine/actions/types.js";
import { resolveSkillValue } from "../engine/actions/skillRollService.js";
import {
  type TickEngine,
  createTickEngine,
} from "../engine/core/tickEngine.js";
import type {
  CharacterAction as EngineCharacterAction,
  FeatureEvent,
  TickReport,
} from "../engine/core/types.js";
import { createDefaultSubsystemRegistry } from "../engine/registerDefaults.js";
import { SKILL_CATALOG } from "../engine/rules/skillCatalog.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import { writeRelationship } from "../memory/relationshipWrite.js";
import {
  PlayerBoardError,
  addLink,
  findLink,
  removeLink,
} from "../player/playerBoard.js";
import {
  type MentionLabel,
  type PlayerInput,
  buildPlayerActArgs,
  strangerLabel,
} from "../player/playerCommands.js";
import type { PlayerPort } from "../player/playerPort.js";
import {
  PLAYER_STATE_KEY,
  type PlayerMode,
  type PlayerPending,
  type PlayerState,
  createPlayerState,
  hydratePlayerState,
  isPlayerState,
  switchMode,
} from "../player/playerState.js";
import {
  type VisitTopology,
  type VisitedMap,
  recordPosition,
} from "../player/visitedMap.js";
import { LLMRoleSimAgent } from "../roleSim/llmAgent.js";
import { NpcActionController } from "../roleSim/npcActionController.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import {
  datePart,
  diffDays,
  makeDateTime,
  timePart,
} from "../state/gameClock.js";
import { loadScriptedEventsForModule } from "../state/moduleLoader.js";
import {
  type CitationScope,
  aliasFor,
  buildPerceivableDirectory,
  isKnownTo,
  knownAs,
  tagsIn,
} from "../state/perceivableDirectory.js";
import { resolvePerceivedLocation } from "../state/perceivedLocation.js";
import type { DynamicNPCProfile } from "../state/types.js";
import { SimulationEventEmitter } from "./SimulationEventEmitter.js";
import {
  injectCharacterIntoState,
  removeCharacterFromState,
  resolveEntryScene,
} from "./characterInjection.js";
import {
  PERCEPTION_COMPACTED_EVENT,
  loadPerceptionHistory,
  persistSimulationEvents,
  persistSimulationRuntime,
} from "./runtimePersistence.js";
import {
  DEFAULT_TICK_INTERVAL_MS,
  type PauseReason,
  type PlaybackStatus,
  type PlayerBoardView,
  type PlayerOptions,
  type PlayerView,
  type SimulationConfig,
  type SimulationEvent,
  type SimulationEventType,
  type SimulationState,
  type SimulationStatus,
  type StopReason,
} from "./types.js";

const ONE_MINUTE_MS = 60_000;
const TICK_ENGINE_PERSISTED_KEY = "_tickEngine";

type PlayerCommandResult =
  | { ok: true; unknownHandles: string[] }
  | { ok: false; reason: string };
/** The wake gate's held occurrences (design §6.1): saved so a restart never
 *  drops what a sleeping character has yet to perceive. */
export const PENDING_DELIVERY_KEY = "_pendingDelivery";

function alignToMinuteBoundary(timestampMs: number): number {
  const remainder = timestampMs % ONE_MINUTE_MS;
  return remainder === 0
    ? timestampMs
    : timestampMs + (ONE_MINUTE_MS - remainder);
}

function buildRealTimeStart(
  timestampMs: number,
  bufferMinutes: number
): number {
  return (
    alignToMinuteBoundary(timestampMs) +
    Math.max(0, bufferMinutes) * ONE_MINUTE_MS
  );
}

function formatGameTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export class SimulationRunner {
  private readonly sessionId: string;
  private readonly config: SimulationConfig;
  private readonly dgsm: DynamicGameStateManager;
  private readonly language: string;
  private readonly memoryManager?: NpcMemoryManager;
  private readonly prisma: PrismaClient;

  private moduleName = "";

  private state: SimulationState = "paused";
  private ticksExecuted = 0;
  private stopReason?: StopReason;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private tickInProgress = false;
  private shouldStop = false;
  private shouldPause = false;

  private readonly deadNpcIds: Set<string> = new Set();

  /** Snapshot of the persisted TickEngine state captured during deserialize.
   *  Consumed by `ensureTickEngine()` on first tick. Cleared after use. */
  private pendingTickEngineState: ReturnType<TickEngine["serialize"]> | null =
    null;
  private tickEngine: TickEngine | null = null;
  private npcController: NpcActionController | null = null;

  readonly events: SimulationEventEmitter;
  private readonly collectedEvents: SimulationEvent[] = [];
  private broadcastCallback: ((events: SimulationEvent[]) => void) | null =
    null;

  // ==================== The player ====================

  /** The player's state, or null when this session has no player. Saved
   *  with the runtime under PLAYER_STATE_KEY, so a pause that is waiting on
   *  the player survives a restart. */
  private playerState: PlayerState | null = null;
  /** Held occurrences from a saved runtime, handed to the controller when it
   *  is built. */
  private pendingDeliveryState: unknown = undefined;
  /** Why the runner is paused; null while it runs (and before it ever ran). */
  private pauseReason: PauseReason | null = null;
  /** The player's whole stream, for the view. The controller keeps its own,
   *  possibly compacted, copy for the prompts. */
  private playerPerceptions: PlayerView["perceptions"] = [];
  /** Loading the player's stream back after a restart. Awaited before the
   *  controller is built, so no live paragraph can arrive ahead of it. */
  private playerStreamLoad: Promise<void> | null = null;
  /** The report of the tick being executed, stashed by `tickCompleted`. */
  private lastTickReport: TickReport | null = null;
  /** One tick (and, when scheduled, its post-tick transition) in flight. */
  private tickCycle: Promise<void> | null = null;
  /** Bumped each time a post-tick cycle is claimed. A post-tick waiter that
   *  sees it moved knows another one already ticked and scheduled. */
  private postTickGeneration = 0;
  /** Player operations run one at a time, each between two ticks. */
  private playerOpChain: Promise<void> = Promise.resolve();
  /** The player operation currently holding the world still. */
  private activePlayerOp: Promise<void> | null = null;

  private readonly onAutosaveRequested: (info: {
    characterId: string;
    gameDateTime: string;
    sceneId: string;
  }) => Promise<void>;

  /** What the controller reads and writes the player through. Always handed
   *  over: with no player, `playerId()` is null and every character is an
   *  NPC. */
  private readonly playerPort: PlayerPort = {
    playerId: () => this.playerState?.characterId ?? null,
    get: () => {
      if (!this.playerState) throw new Error("this session has no player");
      return this.playerState;
    },
    set: (next) => {
      this.playerState = next;
    },
    requestPause: (pending) => this.requestPlayerPause(pending),
  };

  constructor(params: {
    config: SimulationConfig;
    dgsm: DynamicGameStateManager;
    language: string;
    memoryManager?: NpcMemoryManager;
    prisma: PrismaClient;
    /** Called once at the end of a tick in which the player's sleep began,
     *  after the runtime was saved. Defaults to doing nothing. Runs INSIDE the
     *  tick cycle: it must not call a player operation (sendAdvice,
     *  setPlayerMode, …) and await it — the operation waits for the tick to
     *  end, and the tick waits for the hook: a deadlock. */
    onAutosaveRequested?: (info: {
      characterId: string;
      gameDateTime: string;
      sceneId: string;
    }) => Promise<void>;
  }) {
    this.config = params.config;
    this.sessionId = params.config.sessionId;
    this.dgsm = params.dgsm;
    this.language = params.language;
    this.memoryManager = params.memoryManager;
    this.prisma = params.prisma;
    this.onAutosaveRequested =
      params.onAutosaveRequested ?? (async () => undefined);

    this.events = new SimulationEventEmitter(this.sessionId, this.dgsm);

    this.initializeDeadNpcIdsFromState();
  }

  getStatus(): SimulationStatus {
    const gameState = this.dgsm.getState();
    // Phase E: weather lookup via the legacy `getFeatureState("weather")` was
    // removed (Phase D). External weather snapshot will be reintroduced when
    // the renderer ships and exposes the environment read path. Until then,
    // status omits the field.
    return {
      state: this.state,
      currentDateTime: gameState.gameDateTime,
      ticksExecuted: this.ticksExecuted,
      stopReason: this.stopReason,
    };
  }

  getPlaybackStatus(): PlaybackStatus {
    const gameState = this.dgsm.getState();
    const displayStartTime = this.getPendingDisplayStartTime();
    const timeUntilStart =
      typeof displayStartTime === "number"
        ? Math.max(0, displayStartTime - Date.now())
        : 0;

    return {
      buffered: 0,
      displayTick: this.ticksExecuted,
      simulationTick: this.ticksExecuted,
      isPlaying: this.state === "running" && timeUntilStart === 0,
      displayStartTime,
      timeUntilStart,
      displayGameDateTime: gameState.gameDateTime,
    };
  }

  async getCurrentNpcActions(): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    for (const npc of this.dgsm.getState().npcCharacters) {
      if (!this.dgsm.isNpcAlive(npc.id)) {
        result[npc.id] = null;
        continue;
      }
      const active = (this.tickEngine?.getActorActions(npc.id) ?? []).find(
        (a) => a.status === "active"
      );
      result[npc.id] = active?.command.description ?? null;
    }
    return result;
  }

  getDgsm(): DynamicGameStateManager {
    return this.dgsm;
  }

  getModuleName(): string {
    return this.moduleName;
  }

  setModuleName(name: string): void {
    this.moduleName = name;
  }

  getModulePath(): string | null {
    if (!this.moduleName) return null;
    return path.join(process.cwd(), "data", "Mods", this.moduleName);
  }

  setBroadcastCallback(cb: (events: SimulationEvent[]) => void): void {
    this.broadcastCallback = cb;
  }

  updateTickInterval(ms: number): void {
    this.config.tickIntervalMs = ms;

    if (
      !this.config.syncRealTime &&
      this.state === "running" &&
      !this.tickInProgress
    ) {
      this.clearScheduledTick();
      this.scheduleNextTick();
    }
  }

  updateMaxDays(maxDays: number): void {
    this.config.maxDays = Math.max(1, Math.floor(maxDays));
  }

  enableRealTimeSync(bufferMinutes = 0): {
    displayStartTime: number;
    gameDateTime: string;
  } {
    const startWall = buildRealTimeStart(Date.now(), bufferMinutes);
    const gameTime = formatGameTime(startWall);
    const gameDateTime = makeDateTime(
      datePart(this.dgsm.getGameDateTime()),
      gameTime
    );
    this.dgsm.setGameClock({ gameDateTime });

    this.config.syncRealTime = true;
    this.config.realTimeBufferMinutes = Math.max(0, bufferMinutes);
    this.config.displayStartTime = startWall;
    this.config.tickIntervalMs = ONE_MINUTE_MS;

    if (this.state === "running" && !this.tickInProgress) {
      this.clearScheduledTick();
      this.scheduleNextTick();
    }

    return { displayStartTime: startWall, gameDateTime };
  }

  hydrateFromRuntime(params: {
    state: SimulationState;
    ticksExecuted: number;
    stopReason?: StopReason;
    persistedTickEngineState?: ReturnType<TickEngine["serialize"]>;
    /** `gameState[PENDING_DELIVERY_KEY]` of the saved runtime. */
    persistedPendingDelivery?: unknown;
    /** `gameState[PLAYER_STATE_KEY]` of the saved runtime. Adopted only when
     *  it is a well-formed PlayerState. */
    persistedPlayerState?: unknown;
  }): void {
    this.state =
      params.state === "running" || params.state === "initializing"
        ? "paused"
        : params.state;
    this.ticksExecuted = params.ticksExecuted;
    this.stopReason = params.stopReason;
    this.shouldPause = false;
    this.shouldStop = false;
    this.tickInProgress = false;
    this.clearScheduledTick();
    this.initializeDeadNpcIdsFromState();
    if (params.persistedTickEngineState) {
      this.pendingTickEngineState = params.persistedTickEngineState;
    }
    if (params.persistedPendingDelivery !== undefined) {
      this.pendingDeliveryState = params.persistedPendingDelivery;
    }

    if (params.persistedPlayerState !== undefined) {
      if (isPlayerState(params.persistedPlayerState)) {
        this.playerState = hydratePlayerState(params.persistedPlayerState);
      } else {
        console.warn(
          `[SimulationRunner] ${this.sessionId}: saved player state is malformed; the session continues without a player`
        );
        this.playerState = null;
      }
    }
    const player = this.playerState;
    if (player) {
      // A player who died without the pause being recorded (a crash between
      // the two) is dead all the same.
      if (
        !this.dgsm.isNpcAlive(player.characterId) &&
        player.pending?.kind !== "dead"
      ) {
        this.playerState = this.withDeath(player);
      }
      this.playerPerceptions = [];
      this.playerStreamLoad = this.loadPlayerStream(player.characterId);
    }

    // Loaded paused, a question still waiting is still the player's to
    // answer — and answering it resumes the world, as it would have before
    // the restart. Anything else stays paused until someone resumes it.
    const pending = this.playerState?.pending ?? null;
    this.pauseReason =
      this.state !== "paused"
        ? null
        : pending?.kind === "dead"
          ? "dead"
          : pending
            ? "player"
            : "manual";
  }

  async saveRuntime(): Promise<void> {
    const gameState = this.dgsm.serialize();
    if (this.tickEngine) {
      gameState[TICK_ENGINE_PERSISTED_KEY] = this.tickEngine.serialize();
    } else if (this.pendingTickEngineState) {
      // Saved before the first tick of a resumed session: the engine has not
      // been rebuilt yet, and its queue must not be dropped from the row.
      gameState[TICK_ENGINE_PERSISTED_KEY] = this.pendingTickEngineState;
    }
    if (this.playerState) {
      gameState[PLAYER_STATE_KEY] = this.playerState;
    }
    // Optional calls: a controller test double need not implement the
    // wake-gate buffer.
    const pendingDelivery = this.npcController?.serializePendingDelivery?.();
    if (pendingDelivery !== undefined) {
      gameState[PENDING_DELIVERY_KEY] = pendingDelivery;
    } else if (this.pendingDeliveryState !== undefined) {
      gameState[PENDING_DELIVERY_KEY] = this.pendingDeliveryState;
    }
    await persistSimulationRuntime({
      prisma: this.prisma,
      sessionId: this.sessionId,
      tick: this.ticksExecuted,
      simulationState: this.state,
      stopReason: this.stopReason,
      language: this.language,
      moduleName: this.moduleName,
      config: this.config,
      gameState,
    });
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "initializing") return;
    if (this.state === "stopped" || this.state === "completed") return;

    this.state = "initializing";
    this.shouldStop = false;
    this.shouldPause = false;
    this.pauseReason = null;
    const event = this.emitStateChange();
    await this.persistAndBroadcastEvents([event]);
    await this.saveRuntime();

    if (typeof this.getPendingDisplayStartTime() === "number") {
      this.scheduleNextTick();
      return;
    }

    await this.runTickCycle(true);
  }

  async pause(): Promise<void> {
    // Pressed while the world waits on the player: it now stays paused after
    // they answer, until someone resumes it.
    if (this.state === "paused" && this.pauseReason === "player") {
      this.pauseReason = "manual";
      return;
    }
    if (this.state !== "running" && this.state !== "initializing") return;
    this.shouldPause = true;
    this.pauseReason = "manual";

    if (!this.tickInProgress) {
      this.clearScheduledTick();
      this.state = "paused";
      const event = this.emitStateChange();
      await this.persistAndBroadcastEvents([event]);
      await this.saveRuntime();
    }
  }

  /** ▶ from outside. Refused while the world waits on the player — a dead
   *  player's town does not run on without them (load or start anew), and a
   *  waiting question or decision is answered, which resumes the world by
   *  itself. `step()` stays the debug way past either. */
  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    const pending = this.playerState?.pending ?? null;
    if (pending?.kind === "dead") throw new Error("player is dead");
    if (pending) throw new Error("the player has not answered yet");
    return this.start();
  }

  async step(ticks = 1): Promise<void> {
    if (this.state !== "paused") return;

    for (let i = 0; i < ticks; i++) {
      if (this.isTerminal()) break;
      await this.runTickCycle(false);
    }
  }

  async stop(): Promise<void> {
    this.shouldStop = true;

    if (!this.tickInProgress) {
      await this.finalize("manual");
    }
  }

  async injectCharacter(
    profile: DynamicNPCProfile,
    intent: string
  ): Promise<void> {
    // The injected character IS the player, and a session has one.
    if (this.playerState) {
      throw new Error("a player character already exists");
    }
    if (this.state !== "paused") {
      throw new Error(
        `Cannot inject character while simulation is ${this.state}. Pause first.`
      );
    }

    const entrySceneId = profile.residence
      ? resolveEntryScene(this.dgsm, profile.residence)
      : null;
    if (!entrySceneId) {
      throw new Error(
        `Cannot resolve entry scene for residence "${profile.residence}" — it must name a scene or road in this module.`
      );
    }

    injectCharacterIntoState(this.dgsm, profile, entrySceneId);

    const gameState = this.dgsm.getState();
    const player = createPlayerState(profile.id);
    this.playerState = {
      ...player,
      // Where they walk in is the first place they have been.
      visited: recordPosition(
        player.visited,
        this.dgsm.getCharacterPosition(profile.id),
        this.visitTopology(),
        gameState.gameDateTime
      ),
    };
    this.playerPerceptions = [];
    this.playerStreamLoad = null;
    if (this.memoryManager) {
      await this.memoryManager.add({
        npcId: profile.id,
        sessionId: this.sessionId,
        moduleId: this.config.moduleId,
        type: "long_term_intent",
        content: intent,
        gameDateTime: gameState.gameDateTime,
      });
    }

    await this.saveRuntime();
  }

  async removeCharacter(characterId: string): Promise<void> {
    if (this.state !== "paused") {
      throw new Error(
        `Cannot remove character while simulation is ${this.state}. Pause first.`
      );
    }

    await removeCharacterFromState(
      this.dgsm,
      this.prisma,
      this.sessionId,
      characterId
    );
    if (this.playerState?.characterId === characterId) {
      this.playerState = null;
      this.playerPerceptions = [];
      this.playerStreamLoad = null;
      if (this.pauseReason === "player" || this.pauseReason === "dead") {
        this.pauseReason = "manual";
      }
    }
    await this.saveRuntime();
  }

  async updateIntent(characterId: string, intent: string): Promise<void> {
    if (this.state !== "paused") {
      throw new Error(
        `Cannot update intent while simulation is ${this.state}. Pause first.`
      );
    }

    const gameState = this.dgsm.getState();
    const npc = gameState.npcCharacters.find((n) => n.id === characterId);
    if (!npc) {
      throw new Error(`Character "${characterId}" not found in game state.`);
    }

    if (this.memoryManager) {
      await this.memoryManager.add({
        npcId: characterId,
        sessionId: this.sessionId,
        moduleId: this.config.moduleId,
        type: "long_term_intent",
        content: intent,
        gameDateTime: gameState.gameDateTime,
      });
    }

    await this.saveRuntime();
  }

  getInjectedCharacters(): DynamicNPCProfile[] {
    const gameState = this.dgsm.getState();
    return gameState.npcCharacters.filter(
      (npc) => npc.isPlayerInjected === true
    );
  }

  // ==================== The player: public surface ====================

  hasPlayer(): boolean {
    return this.playerState !== null;
  }

  getPlayerView(): PlayerView | null {
    const player = this.playerState;
    if (!player) return null;
    const live = this.livePlayerAction(player.characterId);
    const profile = this.dgsm.getNpcProfile(player.characterId);
    return {
      state: this.publicPlayerState(player),
      alive: this.dgsm.isNpcAlive(player.characterId),
      currentAction: live
        ? {
            description: live.command.description,
            progressMinutes: live.progressMinutes,
            ...(live.resolvedDurationTicks !== undefined
              ? { resolvedDurationTicks: live.resolvedDurationTicks }
              : {}),
          }
        : null,
      perceptions: this.playerPerceptions.slice(),
      paused: this.state === "paused",
      options: this.getPlayerOptions() ?? { exits: [], mentions: [] },
      learnedLanguages: Object.keys(profile?.languages?.learned ?? {}),
      skillValues: Object.fromEntries(
        SKILL_CATALOG.flatMap(({ name }) => {
          const skill = resolveSkillValue(name, profile?.skills ?? {});
          return skill ? [[name, skill.value] as const] : [];
        })
      ),
    };
  }

  getPlayerOptions(scope = this.playerCitationScope()): PlayerOptions | null {
    const player = this.playerState;
    if (!player) return null;
    const actorId = player.characterId;
    const here = resolvePerceivedLocation(
      this.dgsm.getCharacterPosition(actorId),
      this.dgsm,
      actorId,
      scope.noticed
    );
    const exits = [...new Set(here?.adjacentIds)].map(
      (id): MentionLabel => ({
        handle: id,
        label:
          this.dgsm.getScene(id)?.name ?? this.dgsm.getRoad(id)?.name ?? id,
        kind: "scene",
      })
    );
    const directory = buildPerceivableDirectory(actorId, this.dgsm, scope);
    const mentions: MentionLabel[] = [];
    for (const [handle, id] of directory.characterHandles) {
      const label = this.playerCharacterLabel(actorId, id, handle);
      if (label) mentions.push(label);
    }
    for (const id of directory.items) {
      const item = this.dgsm.getItem(id) ?? this.dgsm.getVehicle(id);
      if (item) mentions.push({ handle: id, label: item.name, kind: "item" });
    }
    return { exits, mentions };
  }

  async submitPlayerCommand(input: PlayerInput): Promise<PlayerCommandResult> {
    return this.playerOp<PlayerCommandResult>(async () => {
      const player = this.requireLivePlayer();
      if (player.mode !== "manual")
        throw new Error("commands are for manual mode");
      if (player.dialogue.at(-1)?.status === "waiting") {
        return {
          ok: false,
          reason: "the current exchange is still waiting for a reply",
        };
      }
      const { controller } = await this.ensureTickEngine();
      const scope = this.playerCitationScope();
      const options = this.getPlayerOptions(scope);
      if (!options) throw new Error("this session has no player");
      const labels = new Map<string, MentionLabel>();
      if (input.kind === "move" || input.kind === "act") {
        for (const exit of options.exits) labels.set(exit.handle, exit);
      }
      if (input.kind === "say" || input.kind === "act") {
        for (const mention of options.mentions) {
          if (input.kind === "act" || mention.kind === "character") {
            labels.set(mention.handle, mention);
          }
        }
        // A person can walk out between composition and submission. Keep the
        // handles the player has already seen, including a pre-rename alias.
        for (const id of this.playerBoardPeople(player)) {
          const label = this.playerCharacterLabel(player.characterId, id);
          if (!label) continue;
          labels.set(label.handle, label);
          const alias = aliasFor(player.characterId, id);
          labels.set(alias, { ...label, handle: alias });
        }
      }
      const built = buildPlayerActArgs(input, {
        labels,
        nativeLanguages:
          this.dgsm.getNpcProfile(player.characterId)?.languages?.native ?? [],
        language: this.playerLanguage(),
      });
      if (!built.ok) return built;
      if (built.unknownHandles.length > 0) {
        // The builder preserves unknown tokens for the caller. An explicit
        // reference in the play UI must still resolve before dispatch.
        return {
          ok: false,
          reason: `unknown handle: ${built.unknownHandles[0]}`,
        };
      }
      const receipt = await controller.submitPlayerCommand(
        built.rawArgs,
        scope
      );
      if (!receipt.ok) return receipt;
      const dialogue =
        input.kind === "say" && !built.rawArgs.skillId
          ? [
              ...player.dialogue,
              {
                id: receipt.actionId,
                gameDateTime: this.dgsm.getGameDateTime(),
                location: this.playerLocation(player.characterId),
                words: input.words.trim(),
                status: "waiting" as const,
                replies: [],
              },
            ]
          : player.dialogue;
      this.playerState = { ...player, pending: null, dialogue };
      return { ok: true, unknownHandles: built.unknownHandles };
    });
  }

  async getPlayerBoard(): Promise<PlayerBoardView | null> {
    await this.playerStreamLoad;
    const initial = this.playerState;
    if (!initial) return null;
    const npcId = initial.characterId;
    const rows =
      this.playerBoardPeople(initial).size > 0
        ? await this.prisma.npcMemory.findMany({
            where: { sessionId: this.sessionId, npcId, type: "relationship" },
            orderBy: [{ gameDateTime: "asc" }, { id: "asc" }],
            select: { content: true, metadata: true },
          })
        : [];
    const player = this.playerState;
    if (player?.characterId !== npcId) return null;

    const notes = new Map<string, string[]>();
    for (const { metadata, content } of rows) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        continue;
      const id = metadata.targetId;
      if (typeof id !== "string") continue;
      const list = notes.get(id) ?? [];
      list.push(content);
      notes.set(id, list);
    }
    const handles = new Map<string, string>();
    const people: PlayerBoardView["people"] = [];
    for (const id of this.playerBoardPeople(player)) {
      const person = this.playerCharacterLabel(npcId, id);
      if (!person) continue;
      const name = knownAs(this.dgsm, npcId, id);
      handles.set(id, person.handle);
      people.push({
        handle: person.handle,
        label: person.label,
        ...(name !== undefined ? { knownAs: name } : {}),
        notes: notes.get(id) ?? [],
        firstMet: Object.hasOwn(player.met, id) ? player.met[id] : null,
      });
    }
    const links = player.boardLinks.flatMap((link) => {
      const a = handles.get(link.a);
      const b = handles.get(link.b);
      return a && b ? [{ id: link.id, a, b, label: link.label }] : [];
    });
    return { people, links };
  }

  namePerson(handle: string, name: string): Promise<void> {
    return this.writePlayerRelationship(handle, "knownAs", name);
  }

  notePerson(handle: string, note: string): Promise<void> {
    return this.writePlayerRelationship(handle, "content", note);
  }

  async linkPeople(
    aHandle: string,
    bHandle: string,
    label: string
  ): Promise<{ id: string }> {
    return this.playerOp(async () => {
      const player = this.requireLivePlayer();
      const a = this.requireBoardPerson(player, aHandle);
      const b = this.requireBoardPerson(player, bHandle);
      const links = addLink(player.boardLinks, a, b, label);
      const link = findLink(links, a, b, label.trim());
      if (!link) throw new Error("relationship link was not created");
      if (links !== player.boardLinks)
        this.playerState = { ...player, boardLinks: links };
      return { id: link.id };
    });
  }

  async unlinkPeople(linkId: string): Promise<void> {
    await this.playerOp(async () => {
      const player = this.requireLivePlayer();
      const links = removeLink(player.boardLinks, linkId);
      if (links !== player.boardLinks)
        this.playerState = { ...player, boardLinks: links };
    });
  }

  /** Delegated: the friend speaks — an answer when a question is waiting,
   *  otherwise words the character reads next tick (the world is neither
   *  paused nor resumed for them). Manual mode has no one to advise. */
  async sendAdvice(text: string): Promise<void> {
    if (text.trim() === "") throw new Error("empty advice");
    await this.playerOp(async () => {
      const player = this.requireLivePlayer();
      if (player.mode !== "delegated") {
        throw new Error("advice is for delegated mode");
      }
      if (player.pending?.kind === "consult") {
        await this.answerConsult(text);
        return;
      }
      this.playerState = {
        ...player,
        friendLog: [
          ...player.friendLog,
          { gameDateTime: this.dgsm.getGameDateTime(), answer: text.trim() },
        ],
        forceWake: true,
      };
    });
  }

  /** "Go on": the current action, if any, runs on; nothing is submitted. */
  async continuePlayer(): Promise<void> {
    await this.playerOp(async () => {
      const pending = this.requireLivePlayer().pending;
      await this.resolvePlayer({ kind: "continue" }, pending);
      // A question let go unanswered still happened: the character remembers
      // asking it, and that no answer came.
      const player = this.playerState;
      if (pending?.kind === "consult" && player) {
        this.playerState = {
          ...player,
          friendLog: [
            ...player.friendLog,
            {
              gameDateTime: this.dgsm.getGameDateTime(),
              question: pending.question,
              answer: "(no answer)",
            },
          ],
        };
      }
    });
  }

  /** The friend answers the question the character asked. */
  async answerFriend(text: string): Promise<void> {
    if (text.trim() === "") throw new Error("empty answer");
    await this.playerOp(async () => {
      await this.answerConsult(text);
    });
  }

  async setPlayerMode(mode: PlayerMode): Promise<void> {
    await this.playerOp(async () => {
      // To delegated, a decision waiting on the player is the character's
      // now: `switchMode` clears it and wakes them, and the world — when it
      // was paused for the player — resumes as after any answer.
      let next = switchMode(this.requireLivePlayer(), mode);
      // The friend's unprompted words were for the delegated character; the
      // player now speaks for themselves.
      if (mode === "manual" && next.forceWake) {
        next = { ...next, forceWake: false };
      }
      this.playerState = next;
    });
  }

  /** The player edits their character's memories directly — the same rows
   *  the character writes with `writeMemory`. */
  async editPlayerMemory(
    op:
      | { op: "add"; type: NpcMemoryType; content: string }
      | { op: "replace"; memoryId: string; content: string }
      | { op: "delete"; memoryId: string }
  ): Promise<void> {
    await this.playerOp(async () => {
      const player = this.requireLivePlayer();
      const memory = this.memoryManager;
      if (!memory) throw new Error("this session has no memory store");
      const npcId = player.characterId;
      switch (op.op) {
        case "add": {
          const content = op.content.trim();
          if (content === "") throw new Error("empty memory");
          // `writeMemory` refuses these too: a view of someone needs to say
          // who, and the relationship graph is written alongside it.
          if (op.type === "relationship") {
            throw new Error(
              "a relationship memory needs the person it is about; write it in play"
            );
          }
          const position = this.dgsm.getCharacterPosition(npcId);
          await memory.add({
            npcId,
            sessionId: this.sessionId,
            moduleId: this.config.moduleId,
            type: op.type,
            content,
            gameDateTime: this.dgsm.getGameDateTime(),
            ...(position
              ? { location: this.dgsm.resolveLocationId(position) }
              : {}),
          });
          return;
        }
        case "replace": {
          const content = op.content.trim();
          if (content === "") throw new Error("empty memory");
          const ok = await memory.reviseOwn({
            memoryId: op.memoryId,
            sessionId: this.sessionId,
            npcId,
            content,
            // As `writeMemory`'s replace stamps it.
            metadata: { revisedAt: this.dgsm.getGameDateTime() },
          });
          if (!ok) throw new Error(`memory "${op.memoryId}" not found`);
          return;
        }
        case "delete": {
          const ok = await memory.retractOwn({
            memoryId: op.memoryId,
            sessionId: this.sessionId,
            npcId,
          });
          if (!ok) throw new Error(`memory "${op.memoryId}" not found`);
          return;
        }
      }
    });
  }

  // ==================== The player: internals ====================

  /** Run one player operation between two ticks: wait for the tick in
   *  flight, hold the next one off while `fn` runs, then save — the answer
   *  and whatever the controller did with it must survive a restart. Resumes
   *  the world afterwards only when it was paused for the player and nothing
   *  new is waiting on them; a world someone paused by hand stays paused. */
  private async playerOp<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.playerOpChain;
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    this.playerOpChain = prev.then(() => mine);
    await prev;

    let resume = false;
    let result: T;
    try {
      while (this.tickCycle) {
        await this.tickCycle.catch(() => undefined);
      }
      // Claimed in the same synchronous step as the last check above, so no
      // tick can start in between.
      this.activePlayerOp = mine;
      if (this.playerStreamLoad) await this.playerStreamLoad;
      if (this.state === "stopped" || this.state === "completed") {
        throw new Error("simulation has ended");
      }

      const events: SimulationEvent[] = [];
      const collect = (event: SimulationEvent): void => {
        events.push(event);
      };
      this.events.on("simulation_event", collect);
      const before = this.playerState;
      try {
        result = await fn();
        // The controller paused again while the world was running: stop now,
        // not a tick later.
        if (
          this.shouldPause &&
          (this.state === "running" || this.state === "initializing")
        ) {
          this.shouldPause = false;
          this.clearScheduledTick();
          this.state = "paused";
          this.emitStateChange();
        }
        this.emitPlayerChanges(before);
      } finally {
        this.events.off("simulation_event", collect);
      }
      await this.persistAndBroadcastEvents(events);
      // A paragraph rendered while paused (an empty stream falls back to a
      // fresh render) is flushed now rather than with the next tick.
      await this.persistPerceptions();
      await this.saveRuntime();

      resume =
        this.state === "paused" &&
        this.pauseReason === "player" &&
        this.playerState?.pending === null;
    } finally {
      this.activePlayerOp = null;
      release();
    }
    // Not awaited: the operation is done once its own work is applied and
    // saved. The resumed world's first tick (model calls included) is the
    // world's business, reported through its own events.
    if (resume) {
      void this.start().catch((err) => {
        console.error(
          "[SimulationRunner] resume after the player answered failed:",
          err
        );
      });
    }
    return result;
  }

  private publicPlayerState(player: PlayerState): PlayerView["state"] {
    const { met: _met, boardLinks: _links, ...state } = player;
    return structuredClone(state);
  }

  private playerCitationScope(): CitationScope {
    return (
      this.npcController?.playerCitationScope() ?? {
        knownIds: tagsIn(
          this.playerPerceptions.map((entry) => entry.narrative)
        ),
      }
    );
  }

  private playerLanguage(): "zh" | "en" {
    return this.language.startsWith("zh") ? "zh" : "en";
  }

  private playerCharacterLabel(
    actorId: string,
    id: string,
    handle?: string
  ): MentionLabel | undefined {
    const profile = this.dgsm.getNpcProfile(id);
    if (!profile) return undefined;
    return {
      handle:
        handle ??
        (isKnownTo(this.dgsm, actorId, id) ? id : aliasFor(actorId, id)),
      label:
        knownAs(this.dgsm, actorId, id) ??
        strangerLabel(profile, this.playerLanguage()),
      kind: "character",
    };
  }

  private playerBoardPeople(player: PlayerState): Set<string> {
    const ids = new Set([
      ...Object.keys(player.met),
      ...Object.keys(
        this.dgsm.getState().npcRelationshipGraph[player.characterId] ?? {}
      ),
    ]);
    ids.delete(player.characterId);
    return ids;
  }

  private requireBoardPerson(player: PlayerState, handle: string): string {
    for (const id of this.playerBoardPeople(player)) {
      const label = this.playerCharacterLabel(player.characterId, id);
      if (
        label &&
        (label.handle === handle || aliasFor(player.characterId, id) === handle)
      ) {
        return id;
      }
    }
    throw new PlayerBoardError(
      "person not found on the relationship board",
      404
    );
  }

  private async writePlayerRelationship(
    handle: string,
    field: "knownAs" | "content",
    text: string
  ): Promise<void> {
    const value = text.trim();
    if (!value)
      throw new PlayerBoardError(
        field === "knownAs" ? "empty name" : "empty note"
      );
    await this.playerOp(async () => {
      const player = this.requireLivePlayer();
      const memory = this.memoryManager;
      if (!memory) throw new Error("this session has no memory store");
      const npcId = player.characterId;
      const targetRealId = this.requireBoardPerson(player, handle);
      const position = this.dgsm.getCharacterPosition(npcId);
      await writeRelationship(
        {
          dgsm: this.dgsm,
          memory,
          npcId,
          sessionId: this.sessionId,
          moduleId: this.config.moduleId,
          gameDateTime: this.dgsm.getGameDateTime(),
          ...(position
            ? { location: this.dgsm.resolveLocationId(position) }
            : {}),
        },
        {
          targetRealId,
          targetLabel: this.playerCharacterLabel(npcId, targetRealId)?.label,
          [field]: value,
        }
      );
      // Board edits refresh the public view through the existing player event.
      this.playerState = { ...player };
    });
  }

  private recordPlayerMeetings(
    entries: PlayerView["perceptions"],
    handles: ReadonlyMap<string, string>
  ): void {
    const player = this.playerState;
    if (!player) return;
    const newMeetings = new Map<string, string>();
    for (const entry of entries) {
      for (const handle of tagsIn([entry.narrative])) {
        const id = handles.get(handle);
        if (!id || id === player.characterId || Object.hasOwn(player.met, id))
          continue;
        if (!newMeetings.has(id)) newMeetings.set(id, entry.gameDateTime);
      }
    }
    if (newMeetings.size > 0) {
      this.playerState = {
        ...player,
        met: { ...player.met, ...Object.fromEntries(newMeetings) },
      };
    }
  }

  /** The player, alive. Every operation but the view starts here. */
  private requireLivePlayer(): PlayerState {
    const player = this.playerState;
    if (!player) throw new Error("this session has no player");
    if (
      player.pending?.kind === "dead" ||
      !this.dgsm.isNpcAlive(player.characterId)
    ) {
      throw new Error("player is dead");
    }
    return player;
  }

  /** Hand the answer to the controller, then clear what it answered — only
   *  after it returns and only if it is still the same pause. If the controller
   *  paused again, its new question stays. */
  private async resolvePlayer(
    input: { kind: "continue" } | { kind: "advice" },
    answered: PlayerPending | null
  ): Promise<void> {
    const { controller } = await this.ensureTickEngine();
    await controller.resolvePlayer(input);
    const player = this.playerState;
    if (answered && player && player.pending === answered) {
      this.playerState = { ...player, pending: null };
    }
  }

  private async answerConsult(text: string): Promise<void> {
    const player = this.requireLivePlayer();
    const pending = player.pending;
    if (pending?.kind !== "consult") {
      throw new Error("no question is waiting for an answer");
    }
    this.playerState = {
      ...player,
      friendLog: [
        ...player.friendLog,
        {
          gameDateTime: this.dgsm.getGameDateTime(),
          question: pending.question,
          answer: text.trim(),
        },
      ],
    };
    // The controller reads the answer from `friendLog` while it decides, so
    // the note goes in first; if the decision throws, it comes out again —
    // a retry must not find the same answer twice.
    try {
      await this.resolvePlayer({ kind: "advice" }, pending);
    } catch (err) {
      const now = this.playerState;
      if (now) this.playerState = { ...now, friendLog: player.friendLog };
      throw err;
    }
  }

  /** PlayerPort.requestPause: record what the player must answer, and pause
   *  after this tick when the world is running. A manual pause already
   *  requested keeps its reason — answering must not override it. */
  private requestPlayerPause(pending: PlayerPending): void {
    const player = this.playerState;
    if (!player) return;
    this.playerState = { ...player, pending };
    if (this.state === "running" || this.state === "initializing") {
      this.shouldPause = true;
      if (this.pauseReason === null) this.pauseReason = "player";
    }
  }

  private withDeath(player: PlayerState): PlayerState {
    return {
      ...player,
      forceWake: false,
      pending: { kind: "dead", since: this.dgsm.getGameDateTime() },
    };
  }

  /** Emit `player_state` when the state object changed since `before`, and
   *  `player_pending` when a new question or decision is now waiting. Goes
   *  through the emitter, so whoever is collecting (the tick, or a player
   *  operation) persists and broadcasts it. */
  private emitPlayerChanges(before: PlayerState | null): void {
    const player = this.playerState;
    if (!player || player === before) return;
    const gameDateTime = this.dgsm.getGameDateTime();
    const location = this.playerLocation(player.characterId);
    const pending = player.pending;
    if (pending && pending.kind !== "dead" && pending !== before?.pending) {
      this.events.emitSimulationEvent(
        "player_pending",
        player.characterId,
        location,
        gameDateTime,
        { pending }
      );
    }
    this.events.emitSimulationEvent(
      "player_state",
      player.characterId,
      location,
      gameDateTime,
      { state: this.publicPlayerState(player) }
    );
  }

  private playerLocation(characterId: string): string {
    const position = this.dgsm.getCharacterPosition(characterId);
    return position ? this.dgsm.resolveLocationId(position) : "unknown";
  }

  /** The player's live action (active preferred, else queued). Before the
   *  first tick of a resumed session the engine is not rebuilt yet, so the
   *  saved snapshot answers instead. */
  private livePlayerAction(characterId: string): EngineAction | undefined {
    const actions: ReadonlyArray<EngineAction> = this.tickEngine
      ? this.tickEngine.getActorActions(characterId)
      : (this.pendingTickEngineState?.actions ?? []).filter(
          (a) => a.command.actorId === characterId
        );
    return (
      actions.find((a) => a.status === "active") ??
      actions.find((a) => a.status === "queued")
    );
  }

  /** Roads as the visited map needs them. */
  private visitTopology(): VisitTopology {
    return {
      road: (id) => {
        const road = this.dgsm.getRoad(id);
        return road
          ? { endpointA: road.endpointA, endpointB: road.endpointB }
          : null;
      },
      roadsBetween: (a, b) =>
        (this.dgsm.getTopology()?.sceneToRoads.get(a) ?? [])
          .filter(
            (r) =>
              (r.endpointA === a && r.endpointB === b) ||
              (r.endpointA === b && r.endpointB === a)
          )
          .map((r) => r.id),
    };
  }

  /** Fold the player's position after this tick into their visited map;
   *  `player_map_updated` only when a place or road was added. */
  private recordPlayerVisit(): void {
    const player = this.playerState;
    if (!player) return;
    const before: VisitedMap = player.visited;
    const after = recordPosition(
      before,
      this.dgsm.getCharacterPosition(player.characterId),
      this.visitTopology(),
      this.dgsm.getGameDateTime()
    );
    if (after === before) return;
    this.playerState = { ...player, visited: after };
    const grew =
      Object.keys(after.scenes).length !== Object.keys(before.scenes).length ||
      Object.keys(after.roads).length !== Object.keys(before.roads).length;
    if (!grew) return;
    this.events.emitSimulationEvent(
      "player_map_updated",
      player.characterId,
      this.playerLocation(player.characterId),
      this.dgsm.getGameDateTime(),
      { visited: after }
    );
  }

  /** After the tick's save: when the player's sleep began this tick, ask
   *  for an autosave — once, however many of their actions started. */
  private async requestAutosaveIfAsleep(engine: TickEngine): Promise<void> {
    const player = this.playerState;
    const report = this.lastTickReport;
    if (!player || !report) return;
    const fellAsleep = report.transitions.some(
      (t) =>
        t.actorId === player.characterId &&
        t.to === "active" &&
        engine.getAction(t.actionId)?.command.sleep === true
    );
    if (!fellAsleep) return;

    const info = {
      characterId: player.characterId,
      gameDateTime: this.dgsm.getGameDateTime(),
      sceneId: this.playerLocation(player.characterId),
    };
    try {
      await this.onAutosaveRequested(info);
    } catch (err) {
      console.warn(
        `[SimulationRunner] autosave request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const event = this.events.emitSimulationEvent(
      "player_autosave_requested",
      info.characterId,
      info.sceneId,
      info.gameDateTime,
      { sceneId: info.sceneId }
    );
    await this.persistAndBroadcastEvents([event]);
  }

  /** Broadcast the player's paragraph the moment it is rendered. Built by
   *  hand rather than through the emitter, so neither the tick's nor an
   *  operation's collector picks it up: the paragraph is already stored as
   *  the player's `npc_perceived` row. */
  private broadcastPlayerPerceived(entry: {
    npcId: string;
    gameDateTime: string;
    location: string;
    narrative: string;
  }): void {
    this.playerPerceptions.push({
      gameDateTime: entry.gameDateTime,
      location: entry.location,
      narrative: entry.narrative,
    });
    const type: SimulationEventType = "player_perceived";
    this.broadcastCallback?.([
      {
        id: randomUUID(),
        sessionId: this.sessionId,
        tick: this.ticksExecuted,
        gameDateTime: entry.gameDateTime,
        type,
        actorNpcId: entry.npcId,
        location: entry.location,
        data: { narrative: entry.narrative },
        timestamp: new Date(),
      },
    ]);
  }

  /** The player's whole stream from storage — every paragraph, not the
   *  compacted view the prompts get. Failure leaves the view empty; the
   *  prompts have their own copy. */
  private async loadPlayerStream(characterId: string): Promise<void> {
    try {
      const rows = await this.prisma.simulationEvent.findMany({
        where: {
          sessionId: this.sessionId,
          type: "npc_perceived",
          actorNpcId: characterId,
        },
        orderBy: [{ gameDateTime: "asc" }, { timestamp: "asc" }],
        select: { gameDateTime: true, location: true, data: true },
      });
      const stream: PlayerView["perceptions"] = [];
      for (const r of rows) {
        const data = r.data as {
          narrative?: unknown;
          dialogueOnly?: boolean;
        } | null;
        if (data?.dialogueOnly) continue;
        const narrative = data?.narrative;
        if (typeof narrative !== "string" || narrative === "") continue;
        stream.push({
          gameDateTime: r.gameDateTime,
          location: r.location,
          narrative,
        });
      }
      if (this.playerState?.characterId === characterId) {
        this.playerPerceptions = stream;
        const handles = new Map<string, string>();
        for (const npc of this.dgsm.getState().npcCharacters) {
          handles.set(aliasFor(characterId, npc.id), npc.id);
          if (isKnownTo(this.dgsm, characterId, npc.id))
            handles.set(npc.id, npc.id);
        }
        this.recordPlayerMeetings(stream, handles);
      }
    } catch (err) {
      console.warn(
        `[SimulationRunner] could not load the player's stream: ${String(err)}`
      );
    }
  }

  private isTerminal(): boolean {
    return this.state === "stopped" || this.state === "completed";
  }

  private scheduleNextTick(): void {
    if (this.state !== "running" && this.state !== "initializing") return;

    // Backstop: one timer chain, ever. A timer overwritten here without
    // being cleared would tick on as a second chain.
    this.clearScheduledTick();
    const delay = this.getNextTickDelayMs();
    this.intervalId = setTimeout(async () => {
      this.intervalId = null;
      await this.runTickCycle(true);
    }, delay);
  }

  /** One tick, and with `withTransition` the post-tick transition (pause,
   *  stop, schedule the next). Never starts while a player operation holds
   *  the world still, and is what a player operation waits on — so a
   *  player's answer lands between two ticks, never inside one. */
  private async runTickCycle(withTransition: boolean): Promise<void> {
    const generation = this.postTickGeneration;
    // Wait out whatever holds the world: a player operation, or a tick
    // already in flight (a `step`, when `start()` comes in — skipping it
    // would leave the runner in `initializing` with nothing scheduled).
    for (;;) {
      if (this.activePlayerOp) {
        await this.activePlayerOp;
        continue;
      }
      if (this.tickCycle) {
        await this.tickCycle.catch(() => undefined);
        continue;
      }
      break;
    }
    // While this waited, an operation may have paused the world (the
    // controller asked again) or someone pressed pause or stop. A tick that
    // ran anyway would decide over the player's waiting question.
    if (
      withTransition
        ? this.state !== "running" && this.state !== "initializing"
        : this.state !== "paused"
    ) {
      return;
    }
    // Two post-tick waiters (a timer that came due behind an operation, and
    // a `start()` pressed meanwhile) must not both tick: the first one ran
    // the tick and scheduled the next, so the second is redundant — and
    // running it would start a second timer chain.
    if (withTransition && this.postTickGeneration !== generation) return;
    // A pause or stop requested while this waited is honoured without
    // spending another tick.
    const skipTick = withTransition && (this.shouldStop || this.shouldPause);
    // Claimed in the same synchronous step as the checks above.
    if (withTransition) this.postTickGeneration++;
    const cycle = (async () => {
      if (!skipTick) await this.executeTick();
      if (withTransition) await this.handlePostTickTransition();
    })();
    this.tickCycle = cycle;
    try {
      await cycle;
    } finally {
      if (this.tickCycle === cycle) this.tickCycle = null;
    }
  }

  private getNextTickDelayMs(): number {
    if (!this.config.syncRealTime) {
      return Math.max(
        1,
        this.config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
      );
    }

    const now = Date.now();
    const displayStartTime = this.getPendingDisplayStartTime();
    if (typeof displayStartTime === "number") {
      return Math.max(1, displayStartTime - now);
    }

    const remainder = now % ONE_MINUTE_MS;
    return remainder === 0 ? ONE_MINUTE_MS : ONE_MINUTE_MS - remainder;
  }

  private clearScheduledTick(): void {
    if (this.intervalId !== null) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  private async handlePostTickTransition(): Promise<void> {
    if (this.shouldStop) {
      await this.finalize("manual");
      return;
    }

    if (this.shouldPause) {
      this.shouldPause = false;
      this.state = "paused";
      const event = this.emitStateChange();
      await this.persistAndBroadcastEvents([event]);
      await this.saveRuntime();
      return;
    }

    if (this.state === "initializing") {
      this.state = "running";
      const event = this.emitStateChange();
      await this.persistAndBroadcastEvents([event]);
      await this.saveRuntime();
    }

    if (this.state === "running") {
      this.scheduleNextTick();
    }
  }

  /**
   * Lazily construct the TickEngine + NpcActionController on first tick.
   * Async because scripted events are loaded from disk; module name is set
   * after the runner is constructed (`setModuleName`), so we cannot do this
   * in the constructor.
   */
  private async ensureTickEngine(): Promise<{
    engine: TickEngine;
    controller: NpcActionController;
  }> {
    if (this.tickEngine && this.npcController) {
      return { engine: this.tickEngine, controller: this.npcController };
    }

    // The player's stream must be back before anything new is appended to it.
    if (this.playerStreamLoad) {
      await this.playerStreamLoad;
      this.playerStreamLoad = null;
    }

    const subsystemRegistry = createDefaultSubsystemRegistry();
    const scriptedEvents = this.moduleName
      ? loadScriptedEventsForModule(this.moduleName)
      : [];

    const engine = createTickEngine({
      dgsm: this.dgsm,
      subsystemRegistry,
      scriptedEvents,
      tickDurationMinutes: 1,
      narrationLanguage: this.language,
      persistedState: this.pendingTickEngineState ?? undefined,
    });

    this.pendingTickEngineState = null;

    const agent = new LLMRoleSimAgent({
      memory: this.memoryManager as NpcMemoryManager,
      dgsm: this.dgsm,
      sessionId: this.sessionId,
      moduleId: this.config.moduleId,
      language: this.language,
    });
    const controller = new NpcActionController({
      engine,
      agent,
      memory: this.memoryManager as NpcMemoryManager,
      dgsm: this.dgsm,
      sessionId: this.sessionId,
      moduleId: this.config.moduleId,
      language: this.language,
      // Buffered here and flushed once per tick: one row per character per
      // tick, written in a single createMany rather than a query per paragraph.
      onPerception: (entry) => {
        this.pendingPerceptions.push(entry);
        if (entry.npcId === this.playerState?.characterId) {
          const { characterHandles } = buildPerceivableDirectory(
            entry.npcId,
            this.dgsm,
            {
              knownIds: new Set(),
            }
          );
          this.recordPlayerMeetings([entry], characterHandles);
          if (!entry.dialogueOnly) this.broadcastPlayerPerceived(entry);
        }
      },
      onPerceptionCompacted: (entry) =>
        this.pendingPerceptionSummaries.push(entry),
      player: this.playerPort,
    });

    this.wireEngineEvents(engine);

    this.tickEngine = engine;
    this.npcController = controller;
    controller.restorePendingDelivery?.(this.pendingDeliveryState);
    this.pendingDeliveryState = undefined;
    // Before the first decide(): a character resumed with an empty stream
    // reintroduces the room as if they had just walked in, and their own
    // prompt loses the day they lived.
    await this.restorePerceptions(controller);
    return { engine, controller };
  }

  /**
   * Subscribe SimulationEventEmitter outputs to TickEngine event channels.
   * Each engine event is translated into a `SimulationEvent` for the UI.
   * Wired once per engine instance.
   */
  private wireEngineEvents(engine: TickEngine): void {
    engine.on("actionCompleted", (a: EngineCharacterAction) => {
      this.events.actionsToEvents([a], "completed");
    });
    engine.on("actionCancelled", (a: EngineCharacterAction) => {
      // UI emits "interrupted" for cancellations too — they're indistinguishable
      // from a user-visible standpoint (action stopped before natural end).
      this.events.actionsToEvents([a], "interrupted");
    });
    engine.on("featureEvent", (e: FeatureEvent) => {
      const gameState = this.dgsm.getState();
      this.events.emitSimulationEvent(
        "feature_triggered",
        e.characterId ?? "system",
        e.sceneId ?? "global",
        gameState.gameDateTime,
        { eventType: e.type, ...(e.data ?? {}) }
      );
    });
    engine.on("tickCompleted", (report: TickReport) => {
      // Read after the save, for the player's sleep (`requestAutosaveIfAsleep`).
      this.lastTickReport = report;
    });
  }

  private async executeTick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;

    const emittedEvents: SimulationEvent[] = [];
    const collectTickEvent = (event: SimulationEvent): void => {
      emittedEvents.push(event);
    };
    let isCollecting = true;
    this.events.on("simulation_event", collectTickEvent);

    try {
      this.ticksExecuted++;
      this.events.setTick(this.ticksExecuted);

      const gameState = this.dgsm.getState();
      const dateBefore = datePart(gameState.gameDateTime);

      const { engine } = await this.ensureTickEngine();
      this.lastTickReport = null;
      const playerBefore = this.playerState;

      // Phase F: per-tick polling moved into NpcActionController.processTickReport
      // (driven by `tickCompleted`). One-time bootstrap happens via
      // controller.bootstrap() the first time ensureTickEngine constructs the
      // controller — see ensureTickEngine for the wiring.

      await engine.tick();

      if (datePart(this.dgsm.getGameDateTime()) !== dateBefore) {
        const stateAfter = this.dgsm.getState();
        this.events.emitSimulationEvent(
          "day_transition",
          "system",
          "global",
          stateAfter.gameDateTime,
          {
            previousDate: dateBefore,
            newDate: datePart(stateAfter.gameDateTime),
          }
        );
        // Nothing else happens on a day boundary. The end-of-day diary is
        // gone: it was the last thing written on a character's behalf, and
        // what they keep of a day is now only what they chose to write.
      }

      await this.checkDerivedEvents();

      this.recordPlayerVisit();
      this.emitPlayerChanges(playerBefore);

      const stateAfterTick = this.dgsm.getState();
      const currentActions = await this.getCurrentNpcActions();

      this.events.emitSimulationEvent(
        "npc_position_snapshot",
        "system",
        "global",
        stateAfterTick.gameDateTime,
        {
          positions: { ...stateAfterTick.characterPositions },
          currentActions,
          displayIntervalMs: this.getEffectiveTickIntervalMs(),
          // Phase E: weather snapshot omitted — renderer follow-on restores it.
          weather: "clear",
        }
      );

      this.shouldStopAfterTick(emittedEvents);
      this.collectedEvents.push(...emittedEvents);

      if (isCollecting) {
        this.events.off("simulation_event", collectTickEvent);
        isCollecting = false;
      }

      await this.persistAndBroadcastEvents(emittedEvents);
      // Separate from the broadcast path on purpose: these are per-character
      // paragraphs, and pushing every one of them to every client would swamp
      // the socket for a view that is not per-character anyway.
      await this.persistPerceptions();
      await this.saveRuntime();
      await this.requestAutosaveIfAsleep(engine);
    } catch (error) {
      console.error(
        `[SimulationRunner] Error during tick ${this.ticksExecuted}:`,
        error
      );

      if (isCollecting) {
        this.events.off("simulation_event", collectTickEvent);
        isCollecting = false;
      }

      this.clearScheduledTick();
      this.state = "paused";
      try {
        const event = this.emitStateChange();
        await this.persistAndBroadcastEvents([event]);
        await this.saveRuntime();
      } catch (persistError) {
        console.error(
          "[SimulationRunner] Failed to persist paused state:",
          persistError
        );
      }
    } finally {
      if (isCollecting) {
        this.events.off("simulation_event", collectTickEvent);
      }
      this.tickInProgress = false;
    }
  }

  private async checkDerivedEvents(): Promise<void> {
    const gameState = this.dgsm.getState();

    for (const npc of gameState.npcCharacters) {
      if (this.deadNpcIds.has(npc.id)) continue;
      if (this.dgsm.isNpcAlive(npc.id)) continue;

      this.deadNpcIds.add(npc.id);

      // (1) Interrupt any in-flight engine action(s) for this NPC — the
      // Engine resolves the interruption next tick (proper transition, no
      // silent drop).
      if (this.tickEngine) {
        for (const action of this.tickEngine.getActorActions(npc.id)) {
          if (action.status === "active" || action.status === "queued") {
            this.tickEngine.requestInterruption(action.id, "actor died");
          }
        }
      }

      // (2) Write death event memory (Decision 26). Use scene/road
      // *name* in the memory text so it reads naturally to the agent.
      const position = gameState.characterPositions[npc.id];
      const locationId = position
        ? this.dgsm.resolveLocationId(position)
        : "unknown";
      const locationName =
        locationId !== "unknown"
          ? (this.dgsm.getScene(locationId)?.name ?? locationId)
          : "unknown";
      if (this.memoryManager) {
        await this.memoryManager.add({
          npcId: npc.id,
          sessionId: this.sessionId,
          moduleId: this.config.moduleId,
          // System-authored: the character cannot record their own death.
          type: "general",
          content: `[${datePart(gameState.gameDateTime)}] Died at ${timePart(gameState.gameDateTime)} in ${locationName}`,
          gameDateTime: gameState.gameDateTime,
        });
      }

      // (3) UI event keeps `location` as the ID for backward compatibility.
      this.events.emitSimulationEvent(
        "npc_death",
        npc.id,
        locationId,
        gameState.gameDateTime,
        {
          npcName: npc.name,
          hp: npc.status.hp ?? 0,
        }
      );

      // (4) The player: the world stops — `decide()` skips the dead, so
      // without this it would run on.
      const player = this.playerState;
      if (player && player.characterId === npc.id) {
        this.playerState = this.withDeath(player);
        if (this.state === "running" || this.state === "initializing") {
          this.shouldPause = true;
        }
        this.pauseReason = "dead";
        this.events.emitSimulationEvent(
          "player_died",
          npc.id,
          locationId,
          gameState.gameDateTime,
          { npcName: npc.name }
        );
      }
    }
  }

  private initializeDeadNpcIdsFromState(): void {
    this.deadNpcIds.clear();
    for (const npc of this.dgsm.getState().npcCharacters) {
      if (!this.dgsm.isNpcAlive(npc.id)) {
        this.deadNpcIds.add(npc.id);
      }
    }
  }

  private shouldStopAfterTick(currentTickEvents: SimulationEvent[]): void {
    const gameState = this.dgsm.getState();

    if (
      this.config.maxDays !== undefined &&
      diffDays(
        gameState.gameDateTime,
        gameState.moduleSetup?.startDate ?? gameState.gameDateTime
      ) >= this.config.maxDays
    ) {
      this.transitionToTerminalState("max_days");
      return;
    }

    if (this.config.stopEvents && this.config.stopEvents.length > 0) {
      const recentTypes = [
        ...this.collectedEvents.slice(-100).map((event) => event.type),
        ...currentTickEvents.map((event) => event.type),
      ];
      const triggered = this.config.stopEvents.some((eventType) =>
        recentTypes.includes(eventType as SimulationEvent["type"])
      );
      if (triggered) {
        this.transitionToTerminalState("event_triggered");
      }
    }
  }

  private async finalize(reason: StopReason): Promise<void> {
    this.clearScheduledTick();
    const event = this.transitionToTerminalState(reason);
    await this.persistAndBroadcastEvents([event]);
    await this.saveRuntime();
  }

  private emitStateChange(): SimulationEvent {
    const gameState = this.dgsm.getState();
    const playbackStatus = this.getPlaybackStatus();

    return this.events.emitSimulationEvent(
      "simulation_state_changed",
      "system",
      "global",
      gameState.gameDateTime,
      {
        state: this.state,
        ticksExecuted: this.ticksExecuted,
        stopReason: this.stopReason,
        displayStartTime: playbackStatus.displayStartTime,
        timeUntilStart: playbackStatus.timeUntilStart,
      }
    );
  }

  private transitionToTerminalState(reason: StopReason): SimulationEvent {
    this.stopReason = reason;
    this.state = reason === "manual" ? "stopped" : "completed";
    return this.emitStateChange();
  }

  /** Paragraphs rendered since the last flush. Persisted, never broadcast. */
  private pendingPerceptions: Array<{
    npcId: string;
    gameDateTime: string;
    location: string;
    narrative: string;
    dialogueOnly?: boolean;
  }> = [];

  /** Condensed accounts written since the last flush. Same treatment. */
  private pendingPerceptionSummaries: Array<{
    npcId: string;
    gameDateTime: string;
    location: string;
    narrative: string;
    coversThroughGameDateTime: string;
  }> = [];

  /** Hand a freshly built controller the paragraphs this session already
   *  produced. Failure is non-fatal: the run continues with characters who
   *  simply do not remember having looked around, which is worse narration but
   *  not a broken tick. */
  private async restorePerceptions(
    controller: NpcActionController
  ): Promise<void> {
    try {
      const prior = await loadPerceptionHistory(this.prisma, this.sessionId);
      if (prior.length > 0) {
        controller.restorePerceptionHistory(prior);
        console.log(
          `[SimulationRunner] restored ${prior.length} rendered paragraphs for ${this.sessionId}`
        );
      }
    } catch (err) {
      console.warn(
        `[SimulationRunner] could not restore perception history: ${String(err)}`
      );
    }
  }

  /** Write the tick's rendered paragraphs as `npc_perceived` rows. They ride
   *  the SimulationEvent table rather than a table of their own: it is already
   *  the per-session, per-tick, append-only stream, indexed on
   *  (sessionId, gameDateTime) and cascade-deleted with the session. */
  private async persistPerceptions(): Promise<void> {
    const pending = this.pendingPerceptions;
    this.pendingPerceptions = [];
    if (pending.length > 0) {
      await persistSimulationEvents(
        this.prisma,
        pending.map((p) => ({
          id: randomUUID(),
          sessionId: this.sessionId,
          tick: this.ticksExecuted,
          gameDateTime: p.gameDateTime,
          type: "npc_perceived" as const,
          actorNpcId: p.npcId,
          location: p.location,
          data: {
            narrative: p.narrative,
            ...(p.dialogueOnly ? { dialogueOnly: true } : {}),
          },
          timestamp: new Date(),
        }))
      );
    }

    const summaries = this.pendingPerceptionSummaries;
    if (summaries.length === 0) return;
    this.pendingPerceptionSummaries = [];
    // Written alongside the paragraphs, never instead of them: the log keeps
    // every minute the character lived, and the summary is an additional row
    // saying "from here back, this is what they would still tell you".
    await persistSimulationEvents(
      this.prisma,
      summaries.map((s) => ({
        id: randomUUID(),
        sessionId: this.sessionId,
        tick: this.ticksExecuted,
        gameDateTime: s.gameDateTime,
        type: PERCEPTION_COMPACTED_EVENT,
        actorNpcId: s.npcId,
        location: s.location,
        data: {
          narrative: s.narrative,
          coversThrough: s.coversThroughGameDateTime,
        },
        timestamp: new Date(),
      }))
    );
  }

  private async persistEvents(events: SimulationEvent[]): Promise<void> {
    if (events.length === 0) return;
    await persistSimulationEvents(this.prisma, events);
  }

  private async persistAndBroadcastEvents(
    events: SimulationEvent[]
  ): Promise<void> {
    if (events.length === 0) return;
    await this.persistEvents(events);
    this.broadcastCallback?.(events);
  }

  private getEffectiveTickIntervalMs(): number {
    return this.config.syncRealTime
      ? ONE_MINUTE_MS
      : (this.config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  }

  private getPendingDisplayStartTime(): number | undefined {
    const displayStartTime = this.config.syncRealTime
      ? this.config.displayStartTime
      : undefined;
    if (typeof displayStartTime !== "number") return undefined;
    return displayStartTime > Date.now() ? displayStartTime : undefined;
  }
}
