import type { PrismaClient } from "@prisma/client";
import type {
  SimulationConfig,
  SimulationEvent,
  SimulationState,
  SimulationStatus,
  StopReason,
} from "./types.js";
import { DEFAULT_TICK_INTERVAL_MS } from "./types.js";
import { SimulationEventEmitter } from "./SimulationEventEmitter.js";
import { runSimulationTick } from "../dynamicBasicAgent/npcPlanning/tickProcessor.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { NPCPlanningAgent } from "../dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import type { GameEngineRegistry } from "../engine/registry.js";
import type { ExecutionContext } from "../engine/types.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicNPCProfile } from "../state/types.js";
import {
  injectCharacterIntoState,
  removeCharacterFromState,
  resolveEntryScene,
  upsertIntent,
} from "./characterInjection.js";

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

  // --- State tracking ---
  private state: SimulationState = "paused";
  private ticksExecuted: number = 0;
  private stopReason?: StopReason;
  private intervalId: ReturnType<typeof setTimeout> | null = null;
  private tickInProgress: boolean = false;
  private shouldStop: boolean = false;
  private shouldPause: boolean = false;

  // --- NPC tracking ---
  private readonly deadNpcIds: Set<string> = new Set();
  private readonly modifiedCharacterIds: Set<string> = new Set();

  // --- Events ---
  readonly events: SimulationEventEmitter;
  private readonly collectedEvents: SimulationEvent[] = [];

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

  async start(): Promise<void> {
    if (this.state === "running") return;
    if (this.state === "stopped" || this.state === "completed") return;

    this.state = "running";
    this.shouldStop = false;
    this.shouldPause = false;
    this.emitStateChange();

    this.scheduleNextTick();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.shouldPause = true;

    // If no tick is in progress, transition immediately
    if (!this.tickInProgress) {
      this.clearScheduledTick();
      this.state = "paused";
      this.emitStateChange();
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
  async step(ticks: number = 1): Promise<void> {
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

    for (let i = 0; i < ticks; i++) {
      // executeTick() may mutate this.state — use helper to avoid TS narrowing
      if (this.isTerminal()) break;
      await this.executeTick();
    }
  }

  stop(): void {
    this.shouldStop = true;

    if (!this.tickInProgress) {
      this.finalize("manual");
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

    // 1. Inject into game state (npcCharacters, npcStats, npcLocations, etc.)
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
  }

  /**
   * Return all player-injected characters currently in the simulation.
   */
  getInjectedCharacters(): DynamicNPCProfile[] {
    const gameState = this.dgsm.getState();
    return gameState.npcCharacters.filter((npc) => npc.isPlayerInjected === true);
  }

  // ===== Private helpers =====

  /** Check whether the simulation has reached a terminal state. */
  private isTerminal(): boolean {
    return this.state === "stopped" || this.state === "completed";
  }

  // ===== Private tick execution =====

  private scheduleNextTick(): void {
    if (this.state !== "running") return;

    const interval = this.config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.intervalId = setTimeout(async () => {
      await this.executeTick();

      // After tick, check if we should pause/stop or schedule the next tick
      if (this.shouldStop) {
        this.finalize("manual");
      } else if (this.shouldPause) {
        this.shouldPause = false;
        this.state = "paused";
        this.emitStateChange();
      } else if (this.state === "running") {
        this.scheduleNextTick();
      }
    }, interval);
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
      const events = this.events.actionsToEvents(
        tickResult.actions,
        dayBefore
      );
      this.collectedEvents.push(...events);

      // Handle day transition
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
      this.checkDerivedEvents();

      // Check end conditions
      if (this.shouldStopAfterTick()) {
        return; // finalize was already called inside shouldStopAfterTick
      }
    } catch (error) {
      console.error(
        `[SimulationRunner] Error during tick ${this.ticksExecuted}:`,
        error
      );
      // Auto-pause on error
      this.clearScheduledTick();
      this.state = "paused";
      this.emitStateChange();
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Check for derived events that emerge from state changes:
   * - NPC deaths (hp <= 0)
   * - All knowledge discovered
   */
  private checkDerivedEvents(): void {
    const gameState = this.dgsm.getState();

    // --- NPC Deaths ---
    for (const npc of gameState.npcCharacters) {
      if (this.deadNpcIds.has(npc.id)) continue;

      const stats = gameState.npcStats[npc.id];
      if (stats && stats.hp <= 0) {
        this.deadNpcIds.add(npc.id);

        const location = gameState.npcLocations[npc.id] ?? "unknown";
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
        this.collectedEvents.push(event);
      }
    }

    // --- All Knowledge Discovered ---
    // Collect all truth event IDs from knowledge matrix
    const allTruthEventIds = new Set<string>();
    for (const holder of gameState.knowledgeMatrix) {
      for (const eventId of holder.knows) {
        allTruthEventIds.add(eventId);
      }
    }

    // Check if any NPC has discovered all of them
    if (allTruthEventIds.size > 0) {
      for (const npc of gameState.npcCharacters) {
        const discovered = gameState.npcDiscoveredKnowledge[npc.id] ?? [];
        const allFound = [...allTruthEventIds].every((id) =>
          discovered.includes(id)
        );
        if (allFound) {
          const location = gameState.npcLocations[npc.id] ?? "unknown";
          const event = this.events.emitSimulationEvent(
            "all_clues_discovered",
            npc.id,
            location,
            gameState.gameDay,
            gameState.timeOfDay,
            {
              npcName: npc.name,
              totalClues: allTruthEventIds.size,
            }
          );
          this.collectedEvents.push(event);
        }
      }
    }
  }

  /**
   * Check if the simulation should stop based on configured end conditions.
   * Returns true if stop was triggered (finalize is called internally).
   */
  private shouldStopAfterTick(): boolean {
    const gameState = this.dgsm.getState();

    // Check maxDays
    if (
      this.config.maxDays !== undefined &&
      gameState.gameDay > this.config.maxDays
    ) {
      this.finalize("max_days");
      return true;
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
        this.finalize("event_triggered");
        return true;
      }
    }

    return false;
  }

  /**
   * Finalize the simulation — set terminal state and clean up.
   */
  private finalize(reason: StopReason): void {
    this.clearScheduledTick();
    this.stopReason = reason;
    this.state = reason === "manual" ? "stopped" : "completed";
    this.emitStateChange();
  }

  /**
   * Emit a state change event.
   */
  private emitStateChange(): void {
    const gameState = this.dgsm.getState();
    this.events.emitSimulationEvent(
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
}
