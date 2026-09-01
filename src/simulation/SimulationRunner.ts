import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { PrismaClient } from "@prisma/client";
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
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
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
  type PlaybackStatus,
  type SimulationConfig,
  type SimulationEvent,
  type SimulationState,
  type SimulationStatus,
  type StopReason,
} from "./types.js";

const ONE_MINUTE_MS = 60_000;
const TICK_ENGINE_PERSISTED_KEY = "_tickEngine";

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

  constructor(params: {
    config: SimulationConfig;
    dgsm: DynamicGameStateManager;
    language: string;
    memoryManager?: NpcMemoryManager;
    prisma: PrismaClient;
  }) {
    this.config = params.config;
    this.sessionId = params.config.sessionId;
    this.dgsm = params.dgsm;
    this.language = params.language;
    this.memoryManager = params.memoryManager;
    this.prisma = params.prisma;

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
  }

  async saveRuntime(): Promise<void> {
    const gameState = this.dgsm.serialize();
    if (this.tickEngine) {
      gameState[TICK_ENGINE_PERSISTED_KEY] = this.tickEngine.serialize();
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
    const event = this.emitStateChange();
    await this.persistAndBroadcastEvents([event]);
    await this.saveRuntime();

    if (typeof this.getPendingDisplayStartTime() === "number") {
      this.scheduleNextTick();
      return;
    }

    await this.executeTick();
    await this.handlePostTickTransition();
  }

  async pause(): Promise<void> {
    if (this.state !== "running" && this.state !== "initializing") return;
    this.shouldPause = true;

    if (!this.tickInProgress) {
      this.clearScheduledTick();
      this.state = "paused";
      const event = this.emitStateChange();
      await this.persistAndBroadcastEvents([event]);
      await this.saveRuntime();
    }
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    return this.start();
  }

  async step(ticks = 1): Promise<void> {
    if (this.state !== "paused") return;

    for (let i = 0; i < ticks; i++) {
      if (this.isTerminal()) break;
      await this.executeTick();
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

  private isTerminal(): boolean {
    return this.state === "stopped" || this.state === "completed";
  }

  private scheduleNextTick(): void {
    if (this.state !== "running" && this.state !== "initializing") return;

    const delay = this.getNextTickDelayMs();
    this.intervalId = setTimeout(async () => {
      this.intervalId = null;
      await this.executeTick();
      await this.handlePostTickTransition();
    }, delay);
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

    const subsystemRegistry = createDefaultSubsystemRegistry();
    const scriptedEvents = this.moduleName
      ? loadScriptedEventsForModule(this.moduleName)
      : [];

    const engine = createTickEngine({
      dgsm: this.dgsm,
      subsystemRegistry,
      scriptedEvents,
      tickDurationMinutes: 1,
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
      language: this.language,
      // Buffered here and flushed once per tick: one row per character per
      // tick, written in a single createMany rather than a query per paragraph.
      onPerception: (entry) => this.pendingPerceptions.push(entry),
      onPerceptionCompacted: (entry) =>
        this.pendingPerceptionSummaries.push(entry),
    });

    this.wireEngineEvents(engine);

    this.tickEngine = engine;
    this.npcController = controller;
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
    engine.on("tickCompleted", (_report: TickReport) => {
      // Reserved for future per-tick aggregations (e.g., damage summaries).
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
          data: { narrative: p.narrative },
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
