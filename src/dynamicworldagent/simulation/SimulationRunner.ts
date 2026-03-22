import * as path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { NPCPlanningAgent } from "../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import { runSimulationTick } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";
import type { GameEngineRegistry } from "../engine/registry.js";
import type { ExecutionContext } from "../engine/types.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { DynamicNPCProfile } from "../state/types.js";
import { SimulationEventEmitter } from "./SimulationEventEmitter.js";
import {
  injectCharacterIntoState,
  removeCharacterFromState,
  resolveEntryScene,
  upsertIntent,
} from "./characterInjection.js";
import {
  DEFAULT_TICK_INTERVAL_MS,
  type PlaybackStatus,
  type SimulationConfig,
  type SimulationEvent,
  type SimulationState,
  type SimulationStatus,
  type StopReason,
} from "./types.js";
import {
  persistSimulationEvents,
  persistSimulationRuntime,
} from "./runtimePersistence.js";

const ONE_MINUTE_MS = 60_000;

function alignToMinuteBoundary(timestampMs: number): number {
  const remainder = timestampMs % ONE_MINUTE_MS;
  return remainder === 0 ? timestampMs : timestampMs + (ONE_MINUTE_MS - remainder);
}

function buildRealTimeStart(timestampMs: number, bufferMinutes: number): number {
  return alignToMinuteBoundary(timestampMs) + Math.max(0, bufferMinutes) * ONE_MINUTE_MS;
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
  private readonly npcPlanningAgent: NPCPlanningAgent;
  private readonly registry: GameEngineRegistry;
  private readonly ctx: ExecutionContext;
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
  private readonly modifiedCharacterIds: Set<string> = new Set();

  readonly events: SimulationEventEmitter;
  private readonly collectedEvents: SimulationEvent[] = [];
  private broadcastCallback: ((events: SimulationEvent[]) => void) | null = null;

  constructor(params: {
    config: SimulationConfig;
    dgsm: DynamicGameStateManager;
    npcPlanningAgent: NPCPlanningAgent;
    registry: GameEngineRegistry;
    ctx: ExecutionContext;
    language: string;
    memoryManager?: NpcMemoryManager;
    prisma: PrismaClient;
  }) {
    this.config = params.config;
    this.sessionId = params.config.sessionId;
    this.dgsm = params.dgsm;
    this.npcPlanningAgent = params.npcPlanningAgent;
    this.registry = params.registry;
    this.ctx = params.ctx;
    this.language = params.language;
    this.memoryManager = params.memoryManager;
    this.prisma = params.prisma;

    this.events = new SimulationEventEmitter(this.sessionId);

    this.ctx.simulationEmitter = this.events;
    this.ctx.runtime = this.npcPlanningAgent.getRuntime();
    this.ctx.language = this.language;
    this.ctx.memoryManager = this.memoryManager;
  }

  getStatus(): SimulationStatus {
    const gameState = this.dgsm.getState();
    const weatherStates = this.dgsm.getFeatureState("weather") as
      | Record<string, { weatherType?: string; intensity?: number }>
      | undefined;
    let weather: string | undefined;
    if (weatherStates) {
      const firstRegion = Object.values(weatherStates)[0];
      if (firstRegion?.weatherType) {
        weather = firstRegion.weatherType;
      }
    }
    return {
      state: this.state,
      currentDay: gameState.gameDay,
      currentTime: gameState.timeOfDay,
      ticksExecuted: this.ticksExecuted,
      stopReason: this.stopReason,
      weather,
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
      displayGameDay: gameState.gameDay,
      displayGameTime: gameState.timeOfDay,
    };
  }

  async getCurrentNpcActions(): Promise<Record<string, string | null>> {
    const gameState = this.dgsm.getState();
    return this.npcPlanningAgent.getCurrentNpcActions(
      this.sessionId,
      gameState.gameDay,
      gameState.timeOfDay
    );
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

    if (!this.config.syncRealTime && this.state === "running" && !this.tickInProgress) {
      this.clearScheduledTick();
      this.scheduleNextTick();
    }
  }

  updateMaxDays(maxDays: number): void {
    this.config.maxDays = Math.max(1, Math.floor(maxDays));
  }

  enableRealTimeSync(bufferMinutes = 0): {
    displayStartTime: number;
    gameTime: string;
  } {
    const startWall = buildRealTimeStart(Date.now(), bufferMinutes);
    const gameTime = formatGameTime(startWall);
    this.dgsm.setGameClock({ timeOfDay: gameTime });

    this.config.syncRealTime = true;
    this.config.realTimeBufferMinutes = Math.max(0, bufferMinutes);
    this.config.displayStartTime = startWall;
    this.config.tickIntervalMs = ONE_MINUTE_MS;

    if (this.state === "running" && !this.tickInProgress) {
      this.clearScheduledTick();
      this.scheduleNextTick();
    }

    return { displayStartTime: startWall, gameTime };
  }

  hydrateFromRuntime(params: {
    state: SimulationState;
    ticksExecuted: number;
    stopReason?: StopReason;
  }): void {
    this.state = params.state === "running" ? "paused" : params.state;
    this.ticksExecuted = params.ticksExecuted;
    this.stopReason = params.stopReason;
    this.shouldPause = false;
    this.shouldStop = false;
    this.tickInProgress = false;
    this.clearScheduledTick();
  }

  async saveRuntime(): Promise<void> {
    await persistSimulationRuntime({
      prisma: this.prisma,
      sessionId: this.sessionId,
      tick: this.ticksExecuted,
      simulationState: this.state,
      stopReason: this.stopReason,
      language: this.language,
      moduleName: this.moduleName,
      config: this.config,
      gameState: this.dgsm.serialize(),
    });
  }

  async start(): Promise<void> {
    if (this.state === "running") return;
    if (this.state === "stopped" || this.state === "completed") return;

    this.state = "running";
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
    if (this.state !== "running") return;
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

    if (this.modifiedCharacterIds.size > 0) {
      for (const charId of this.modifiedCharacterIds) {
        await this.npcPlanningAgent.reviseSchedule(
          this.dgsm,
          this.sessionId,
          charId,
          "Player updated character intent",
          this.language
        );
      }
      this.modifiedCharacterIds.clear();
    }

    return this.start();
  }

  async step(ticks = 1): Promise<void> {
    if (this.state !== "paused") return;

    if (this.modifiedCharacterIds.size > 0) {
      for (const charId of this.modifiedCharacterIds) {
        await this.npcPlanningAgent.reviseSchedule(
          this.dgsm,
          this.sessionId,
          charId,
          "Player updated character intent",
          this.language
        );
      }
      this.modifiedCharacterIds.clear();
    }

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

  async injectCharacter(profile: DynamicNPCProfile, intent: string): Promise<void> {
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
        `Cannot resolve entry scene for residence "${profile.residence}". Check scenarioOutlines.`
      );
    }

    injectCharacterIntoState(this.dgsm, profile, entrySceneId);

    await upsertIntent(
      this.prisma,
      this.sessionId,
      this.config.moduleId,
      profile.id,
      profile.name,
      intent
    );

    const gameState = this.dgsm.getState();
    await this.npcPlanningAgent.generateSingleNpcSchedule(
      this.dgsm,
      this.sessionId,
      this.config.moduleId,
      profile.id,
      gameState.gameDay,
      this.language
    );
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

    await upsertIntent(
      this.prisma,
      this.sessionId,
      this.config.moduleId,
      characterId,
      npc.name,
      intent
    );

    this.modifiedCharacterIds.add(characterId);
    await this.saveRuntime();
  }

  getInjectedCharacters(): DynamicNPCProfile[] {
    const gameState = this.dgsm.getState();
    return gameState.npcCharacters.filter((npc) => npc.isPlayerInjected === true);
  }

  private isTerminal(): boolean {
    return this.state === "stopped" || this.state === "completed";
  }

  private scheduleNextTick(): void {
    if (this.state !== "running") return;

    const delay = this.getNextTickDelayMs();
    this.intervalId = setTimeout(async () => {
      this.intervalId = null;
      await this.executeTick();
      await this.handlePostTickTransition();
    }, delay);
  }

  private getNextTickDelayMs(): number {
    if (!this.config.syncRealTime) {
      return Math.max(1, this.config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
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

    if (this.state === "running") {
      this.scheduleNextTick();
    }
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
      const dayBefore = gameState.gameDay;

      const tickResult = await runSimulationTick({
        dgsm: this.dgsm,
        npcPlanningAgent: this.npcPlanningAgent,
        sessionId: this.sessionId,
        moduleId: this.config.moduleId,
        language: this.language,
        registry: this.registry,
        ctx: this.ctx,
        memoryManager: this.memoryManager,
      });

      this.events.actionsToEvents(tickResult.actions, dayBefore);

      if (tickResult.dayChanged) {
        const stateAfter = this.dgsm.getState();
        this.events.emitSimulationEvent(
          "day_transition",
          "system",
          "global",
          stateAfter.gameDay,
          stateAfter.timeOfDay,
          {
            previousDay: dayBefore,
            newDay: stateAfter.gameDay,
          }
        );

        await this.npcPlanningAgent.onNewDay(
          this.dgsm,
          this.sessionId,
          this.config.moduleId,
          stateAfter.gameDay,
          this.language,
          this.registry
        );
      }

      this.checkDerivedEvents();

      const stateAfterTick = this.dgsm.getState();
      const currentActions = await this.npcPlanningAgent.getCurrentNpcActions(
        this.sessionId,
        stateAfterTick.gameDay,
        stateAfterTick.timeOfDay
      );
      // Get current weather for snapshot
      const snapshotWeatherStates = this.dgsm.getFeatureState("weather") as
        | Record<string, { weatherType?: string }>
        | undefined;
      const snapshotWeather = snapshotWeatherStates
        ? Object.values(snapshotWeatherStates)[0]?.weatherType
        : undefined;

      this.events.emitSimulationEvent(
        "npc_position_snapshot",
        "system",
        "global",
        stateAfterTick.gameDay,
        stateAfterTick.timeOfDay,
        {
          positions: { ...stateAfterTick.characterPositions },
          currentActions,
          displayIntervalMs: this.getEffectiveTickIntervalMs(),
          weather: snapshotWeather ?? "clear",
        }
      );

      this.shouldStopAfterTick(emittedEvents);
      this.collectedEvents.push(...emittedEvents);

      if (isCollecting) {
        this.events.off("simulation_event", collectTickEvent);
        isCollecting = false;
      }

      await this.persistAndBroadcastEvents(emittedEvents);
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

  private checkDerivedEvents(): void {
    const gameState = this.dgsm.getState();

    for (const npc of gameState.npcCharacters) {
      if (this.deadNpcIds.has(npc.id)) continue;

      const stats = gameState.npcStats[npc.id];
      if (stats && stats.hp <= 0) {
        this.deadNpcIds.add(npc.id);

        const location = (() => {
          const position = gameState.characterPositions[npc.id];
          return position
            ? position.type === "scene"
              ? position.sceneId
              : position.type === "junction"
                ? position.junctionId
                : position.roadId
            : "unknown";
        })();

        this.events.emitSimulationEvent(
          "npc_death",
          npc.id,
          location,
          gameState.gameDay,
          gameState.timeOfDay,
          {
            npcName: npc.name,
            hp: stats.hp,
          }
        );
      }
    }
  }

  private shouldStopAfterTick(currentTickEvents: SimulationEvent[]): void {
    const gameState = this.dgsm.getState();

    if (this.config.maxDays !== undefined && gameState.gameDay > this.config.maxDays) {
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
      gameState.gameDay,
      gameState.timeOfDay,
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

  private async persistEvents(events: SimulationEvent[]): Promise<void> {
    if (events.length === 0) return;
    await persistSimulationEvents(this.prisma, events);
  }

  private async persistAndBroadcastEvents(events: SimulationEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.persistEvents(events);
    this.broadcastCallback?.(events);
  }

  private getEffectiveTickIntervalMs(): number {
    return this.config.syncRealTime
      ? ONE_MINUTE_MS
      : this.config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  private getPendingDisplayStartTime(): number | undefined {
    const displayStartTime = this.config.syncRealTime ? this.config.displayStartTime : undefined;
    if (typeof displayStartTime !== "number") return undefined;
    return displayStartTime > Date.now() ? displayStartTime : undefined;
  }
}
