// src/roleSim/npcActionController.ts
//
// Phase E variant — engine-event-driven only (no perception path). Subscribes
// to TickEngine completion events and asks the role-sim agent what's next for
// the affected NPC. The renderer follow-on adds the perception path
// (`decide(npcId, opts?: { perceivedFacts? })` + `onRendered()`).
//
// Stateless: the engine is the source of truth for which actions are in
// flight. On session restart the controller re-runs `bootstrap()` for any
// alive NPC the engine has no in-flight handle for.

import type { TickEngine } from "../engine/core/tickEngine.js";
import type { ActionHandle, CharacterAction } from "../engine/core/types.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../planning/NPCPlanningAgent.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { RoleSimAgent, RoleSimContext } from "./agent.js";

const MAX_TOOL_LOOP_ITERATIONS = 5;

export interface NpcActionControllerDeps {
  engine: TickEngine;
  agent: RoleSimAgent;
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  /** Used to fetch long-term intent for context building. */
  planningAgent: NPCPlanningAgent;
  sessionId: string;
  /** Module id required by NpcMemoryManager.add when writing plan entries. */
  moduleId: string;
}

export class NpcActionController {
  private readonly engine: TickEngine;
  private readonly agent: RoleSimAgent;
  private readonly memory: NpcMemoryManager;
  private readonly dgsm: DynamicGameStateManager;
  private readonly planningAgent: NPCPlanningAgent;
  private readonly sessionId: string;
  private readonly moduleId: string;
  private readonly activeHandles = new Map<string, ActionHandle>();

  constructor(deps: NpcActionControllerDeps) {
    this.engine = deps.engine;
    this.agent = deps.agent;
    this.memory = deps.memory;
    this.dgsm = deps.dgsm;
    this.planningAgent = deps.planningAgent;
    this.sessionId = deps.sessionId;
    this.moduleId = deps.moduleId;

    this.engine.on("actionCompleted", (a: CharacterAction) => {
      this.activeHandles.delete(a.handleId);
      void this.decide(a.characterId);
    });
    this.engine.on("actionInterrupted", (a: CharacterAction) => {
      this.activeHandles.delete(a.handleId);
      void this.decide(a.characterId);
    });
    this.engine.on("actionCancelled", (a: CharacterAction) => {
      this.activeHandles.delete(a.handleId);
      void this.decide(a.characterId);
    });
  }

  async bootstrap(): Promise<void> {
    const alive = this.dgsm
      .getState()
      .npcCharacters.filter((n) => this.dgsm.isNpcAlive(n.id));
    for (const npc of alive) {
      await this.decide(npc.id);
    }
  }

  async decide(npcId: string): Promise<void> {
    if (!this.dgsm.isNpcAlive(npcId)) return;
    // Skip if engine already has an in-flight step for this NPC. Prevents
    // duplicate submission when bootstrap runs against NPCs whose previously
    // submitted action is still active.
    if (this.hasActiveHandle(npcId)) return;

    const ctx = await this.buildContext(npcId);
    if (!ctx) return;

    for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
      const decision = await this.agent.decideNext(ctx);
      switch (decision.tool) {
        case "act": {
          const handle = await this.engine.submitAction(decision.input);
          this.activeHandles.set(handle.id, handle);
          return;
        }
        case "interrupt": {
          this.engine.interruptAction(decision.handle, decision.reason);
          return;
        }
        case "plan": {
          await this.memory.add({
            npcId,
            sessionId: this.sessionId,
            moduleId: this.moduleId,
            type: "plan",
            content: decision.planText,
            gameDay: ctx.currentTime.day,
            gameTime: ctx.currentTime.tickTime,
          });
          ctx.recentMemory = await this.loadRecentMemory(
            npcId,
            ctx.currentTime.day
          );
          continue;
        }
        case "wait":
          return;
      }
    }
    console.warn(
      `[NpcActionController] tool loop exceeded for ${npcId} (max ${MAX_TOOL_LOOP_ITERATIONS} iterations)`
    );
  }

  private hasActiveHandle(npcId: string): boolean {
    for (const h of this.activeHandles.values()) {
      if (h.characterId === npcId) return true;
    }
    return false;
  }

  private async buildContext(
    npcId: string
  ): Promise<RoleSimContext | undefined> {
    const profile = this.dgsm.getNpcProfile(npcId);
    if (!profile) return undefined;

    const day = this.dgsm.getGameDay();
    const tickTime = this.dgsm.getTickTime();
    const position = this.dgsm.getCharacterPosition(npcId);
    const currentScene = position ? this.dgsm.resolveLocationId(position) : "";

    const longTermIntent = await this.planningAgent
      .getLongTermIntent(this.sessionId, npcId)
      .catch(() => "");
    const recentMemory = await this.loadRecentMemory(npcId, day);

    return {
      npcId,
      currentTime: { day, tickTime },
      npcProfile: profile,
      currentScene,
      recentMemory,
      longTermIntent,
    };
  }

  private async loadRecentMemory(
    npcId: string,
    gameDay: number
  ): Promise<RoleSimContext["recentMemory"]> {
    const rows = await this.memory.getAllForDay(npcId, this.sessionId, gameDay);
    return rows.map((r) => ({
      type: r.type,
      content: r.content,
      gameDay: r.gameDay,
      gameTime: r.gameTime,
    }));
  }
}
