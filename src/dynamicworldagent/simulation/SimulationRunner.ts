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
import { PlaybackScheduler } from "./PlaybackScheduler.js";
import {
  persistSimulationEvents,
  persistSimulationRuntime,
} from "./runtimePersistence.js";
import type {
  SimulationConfig,
  SimulationEvent,
  SimulationState,
  SimulationStatus,
  StopReason,
} from "./types.js";

export class SimulationRunner {
  // --- Core dependencies ---
  private readonly sessionId: string;
  private readonly config: SimulationConfig;
  private readonly dgsm: DynamicGameStateManager;
  private readonly npcPlanningAgent: NPCPlanningAgent;
  private readonly registry: GameEngineRegistry;
  private readonly ctx: ExecutionContext;
  private readonly language: string;
  private readonly memoryManager?: NpcMemoryManager;
  private readonly prisma: PrismaClient;

  // --- Module metadata ---
  private moduleName = "";

  // --- State tracking ---
  private state: SimulationState = "paused";
  private ticksExecuted = 0;
  private stopReason?: StopReason;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private tickInProgress = false;
  private shouldStop = false;
  private shouldPause = false;

  // --- NPC tracking ---
  private readonly deadNpcIds: Set<string> = new Set();
  private readonly modifiedCharacterIds: Set<string> = new Set();

  // --- Events ---
  readonly events: SimulationEventEmitter;
  private readonly collectedEvents: SimulationEvent[] = [];

  // --- Playback ---
  private playbackScheduler: PlaybackScheduler;

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
    this.playbackScheduler = new PlaybackScheduler({
      displayIntervalMs: params.config.displayIntervalMs ?? params.config.tickIntervalMs ?? 60_000,
      minBufferTicks: params.config.minBufferTicks ?? 5,
      displayStartTime: params.config.displayStartTime,
    });

    // Wire emitter into execution context so handlers can emit npc_moved events
    this.ctx.simulationEmitter = this.events;

    // Wire runtime, language, and memoryManager into execution context for LLM-based handlers
    this.ctx.runtime = this.npcPlanningAgent.getRuntime();
    this.ctx.language = this.language;
    this.ctx.memoryManager = this.memoryManager;
  }

  // ===== Public lifecycle =====

  getStatus(): SimulationStatus {
    const gameState = this.dgsm.getState();
    return {
      state: this.state,
      currentDay: gameState.gameDay,
      currentTime: gameState.timeOfDay,
      ticksExecuted: this.ticksExecuted,
      stopReason: this.stopReason,
    };
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

  updateTickInterval(ms: number): void {
    (this.config as { tickIntervalMs?: number }).tickIntervalMs = ms;
    this.playbackScheduler.updateDisplayInterval(ms);
  }

  /**
   * Enable real-time sync mode: override game time to wall-clock + buffer,
   * and recreate the playback scheduler with a displayStartTime gate.
   * Only callable when paused (before start).
   */
  enableRealTimeSync(bufferMinutes = 5): { displayStartTime: number; gameTime: string } {
    const startWall = Date.now() + bufferMinutes * 60_000;
    const startDate = new Date(startWall);
    const hh = String(startDate.getHours()).padStart(2, "0");
    const mm = String(startDate.getMinutes()).padStart(2, "0");
    const gameTime = `${hh}:${mm}`;

    // Update game state
    const gameState = this.dgsm.getState();
    gameState.timeOfDay = gameTime;

    // Update config
    const cfg = this.config as Record<string, unknown>;
    cfg.syncRealTime = true;
    cfg.realTimeBufferMinutes = bufferMinutes;
    cfg.displayStartTime = startWall;
    cfg.displayIntervalMs = 60_000; // Force 1:1 speed

    // Recreate playback scheduler with new displayStartTime
    // Preserve broadcast callback from the old scheduler
    const oldScheduler = this.playbackScheduler;
    this.playbackScheduler = new PlaybackScheduler({
      displayIntervalMs: 60_000,
      minBufferTicks: this.config.minBufferTicks ?? 5,
      displayStartTime: startWall,
    });
    // Re-wire the broadcast callback (set externally via wireEventListener)
    const cb = oldScheduler.getBroadcastCallback();
    if (cb) this.playbackScheduler.setBroadcastCallback(cb);
    oldScheduler.destroy();

    return { displayStartTime: startWall, gameTime };
  }

  getPlaybackScheduler(): PlaybackScheduler {
    return this.playbackScheduler;
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
    await this.persistEvents([this.emitStateChange()]);
    await this.saveRuntime();

    this.scheduleNextTick();
  }

  async pause(): Promise<void> {
    if (this.state !== "running") return;
    this.shouldPause = true;
    this.playbackScheduler.pausePlayback();

    // If no tick is in progress, transition immediately
    if (!this.tickInProgress) {
      this.clearScheduledTick();
      this.state = "paused";
      await this.persistEvents([this.emitStateChange()]);
      await this.saveRuntime();
    }
    // Otherwise, the current tick will observe shouldPause after completing
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;

    // Drain modifiedCharacterIds — revise schedule for each
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

  /**
   * Execute a fixed number of ticks synchronously (step mode).
   * Only callable when paused.
   */
  async step(ticks = 1): Promise<void> {
    if (this.state !== "paused") return;

    // Drain modifiedCharacterIds before stepping
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

    // Step mode: bypass playback buffer, deliver events immediately
    this.playbackScheduler.setImmediateMode(true);
    try {
      for (let i = 0; i < ticks; i++) {
        if (this.isTerminal()) break;
        await this.executeTick();
      }
    } finally {
      this.playbackScheduler.setImmediateMode(false);
    }
  }

  async stop(): Promise<void> {
    this.shouldStop = true;

    if (!this.tickInProgress) {
      await this.finalize("manual");
    }
    // Otherwise, the current tick will observe shouldStop after completing
  }

  // ===== Character injection =====

  /**
   * Inject a player-created character into the simulation.
   * Only callable when state is "paused" (or before start).
   */
  async injectCharacter(
    profile: DynamicNPCProfile,
    intent: string
  ): Promise<void> {
    if (this.state !== "paused") {
      throw new Error(
        `Cannot inject character while simulation is ${this.state}. Pause first.`
      );
    }

    // Resolve entry scene from residence (macro location ID)
    const entrySceneId = profile.residence
      ? resolveEntryScene(this.dgsm, profile.residence)
      : null;
    if (!entrySceneId) {
      throw new Error(
        `Cannot resolve entry scene for residence "${profile.residence}". Check scenarioOutlines.`
      );
    }

    // 1. Inject into game state (npcCharacters, npcStats, characterPositions, etc.)
    injectCharacterIntoState(this.dgsm, profile, entrySceneId);

    // 2. Upsert long-term intent (deterministic ID, no LLM call)
    await upsertIntent(
      this.prisma,
      this.sessionId,
      this.config.moduleId,
      profile.id,
      profile.name,
      intent
    );

    // 3. Generate day-1 schedule (one LLM call)
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

  /**
   * Remove a player-injected character from the simulation.
   * Only callable when paused.
   */
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

  /**
   * Update the long-term intent for a character.
   * Only callable when paused. Schedule revision happens on resume().
   */
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

    // Mark for schedule revision on resume
    this.modifiedCharacterIds.add(characterId);
    await this.saveRuntime();
  }

  /**
   * Return all player-injected characters currently in the simulation.
   */
  getInjectedCharacters(): DynamicNPCProfile[] {
    const gameState = this.dgsm.getState();
    return gameState.npcCharacters.filter(
      (npc) => npc.isPlayerInjected === true
    );
  }

  // ===== Private helpers =====

  /** Check whether the simulation has reached a terminal state. */
  private isTerminal(): boolean {
    return this.state === "stopped" || this.state === "completed";
  }

  // ===== Private tick execution =====

  private scheduleNextTick(): void {
    if (this.state !== "running") return;

    // Fast tick: use simulationDelayMs (default 50ms) to yield the event loop,
    // instead of the old tickIntervalMs which matched real-time pace.
    const delay = this.config.simulationDelayMs ?? 50;
    this.intervalId = setTimeout(async () => {
      await this.executeTick();

      // After tick, check if we should pause/stop or schedule the next tick
      if (this.shouldStop) {
        await this.finalize("manual");
      } else if (this.shouldPause) {
        this.shouldPause = false;
        this.state = "paused";
        this.playbackScheduler.pausePlayback();
        await this.persistEvents([this.emitStateChange()]);
        await this.saveRuntime();
      } else if (this.state === "running") {
        this.scheduleNextTick();
      }
    }, delay);
  }

  private clearScheduledTick(): void {
    if (this.intervalId !== null) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  private async executeTick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;

    try {
      this.ticksExecuted++;
      this.events.setTick(this.ticksExecuted);

      const gameState = this.dgsm.getState();
      const dayBefore = gameState.gameDay;

      // Run a single simulation tick
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

      // Convert actions to simulation events
      const events = this.events.actionsToEvents(tickResult.actions, dayBefore);
      this.collectedEvents.push(...events);
      const pendingEvents = [...events];

      // Handle day transition
      if (tickResult.dayChanged) {
        const stateAfter = this.dgsm.getState();
        const dayEvent = this.events.emitSimulationEvent(
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
        pendingEvents.push(dayEvent);
        this.collectedEvents.push(dayEvent);

        // Let the planning agent handle new-day procedures
        await this.npcPlanningAgent.onNewDay(
          this.dgsm,
          this.sessionId,
          this.config.moduleId,
          stateAfter.gameDay,
          this.language,
          this.registry
        );
      }

      // Check derived events (NPC deaths, all clues discovered)
      const derivedEvents = this.checkDerivedEvents();
      this.collectedEvents.push(...derivedEvents);
      pendingEvents.push(...derivedEvents);

      // Emit NPC position snapshot (every tick)
      const stateAfterTick = this.dgsm.getState();
      const snapshotEvent = this.events.emitSimulationEvent(
        "npc_position_snapshot",
        "system",
        "global",
        stateAfterTick.gameDay,
        stateAfterTick.timeOfDay,
        {
          positions: { ...stateAfterTick.characterPositions },
          displayIntervalMs: this.config.displayIntervalMs ?? this.config.tickIntervalMs ?? 60_000,
        }
      );
      pendingEvents.push(snapshotEvent);

      // Check end conditions
      const stopEvent = this.shouldStopAfterTick();
      if (stopEvent) {
        pendingEvents.push(stopEvent);
      }

      await this.persistEvents(pendingEvents);

      // Enqueue events into playback scheduler for rate-limited broadcast
      this.playbackScheduler.enqueue(pendingEvents, this.ticksExecuted);

      await this.saveRuntime();
    } catch (error) {
      console.error(
        `[SimulationRunner] Error during tick ${this.ticksExecuted}:`,
        error
      );
      // Auto-pause on error
      this.clearScheduledTick();
      this.state = "paused";
      try {
        await this.persistEvents([this.emitStateChange()]);
        await this.saveRuntime();
      } catch (persistError) {
        console.error(
          "[SimulationRunner] Failed to persist paused state:",
          persistError
        );
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Check for derived events that emerge from state changes:
   * - NPC deaths (hp <= 0)
   * - All knowledge discovered
   */
  private checkDerivedEvents(): SimulationEvent[] {
    const gameState = this.dgsm.getState();
    const derivedEvents: SimulationEvent[] = [];

    // --- NPC Deaths ---
    for (const npc of gameState.npcCharacters) {
      if (this.deadNpcIds.has(npc.id)) continue;

      const stats = gameState.npcStats[npc.id];
      if (stats && stats.hp <= 0) {
        this.deadNpcIds.add(npc.id);

        const location = (() => {
          const p = gameState.characterPositions[npc.id];
          return p
            ? p.type === "scene"
              ? p.sceneId
              : p.type === "junction"
                ? p.junctionId
                : p.roadId
            : "unknown";
        })();
        const event = this.events.emitSimulationEvent(
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
        derivedEvents.push(event);
      }
    }

    return derivedEvents;
  }

  /**
   * Check if the simulation should stop based on configured end conditions.
   * Returns true if stop was triggered (finalize is called internally).
   */
  private shouldStopAfterTick(): SimulationEvent | null {
    const gameState = this.dgsm.getState();

    // Check maxDays
    if (
      this.config.maxDays !== undefined &&
      gameState.gameDay > this.config.maxDays
    ) {
      return this.transitionToTerminalState("max_days");
    }

    // Check stop events
    if (this.config.stopEvents && this.config.stopEvents.length > 0) {
      const recentTypes = this.collectedEvents
        .slice(-100) // Check the most recent events for performance
        .map((e) => e.type);
      const triggered = this.config.stopEvents.some((ev) =>
        recentTypes.includes(ev as any)
      );
      if (triggered) {
        return this.transitionToTerminalState("event_triggered");
      }
    }

    return null;
  }

  /**
   * Finalize the simulation — set terminal state and clean up.
   */
  private async finalize(reason: StopReason): Promise<void> {
    this.clearScheduledTick();
    this.playbackScheduler.destroy();
    const event = this.transitionToTerminalState(reason);
    await this.persistEvents([event]);
    await this.saveRuntime();
  }

  /**
   * Emit a state change event.
   */
  private emitStateChange(): SimulationEvent {
    const gameState = this.dgsm.getState();
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
      }
    );
  }

  private transitionToTerminalState(reason: StopReason): SimulationEvent {
    this.stopReason = reason;
    this.state = reason === "manual" ? "stopped" : "completed";
    return this.emitStateChange();
  }

  private async persistEvents(events: SimulationEvent[]): Promise<void> {
    await persistSimulationEvents(this.prisma, events);
  }
}
